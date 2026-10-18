// -----------------------------------------------------------------------------
// The LibreNMS hub: reads the server on a timer of the container (the
// interval chosen in the configuration), publishes the states of the added
// devices when they change, fires the scene events (equipment down or back,
// alert raised or cleared, followed port down or back), and holds the views
// the widget and the scene actions read. (Adapted from guim31/gladys-zabbix.)
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every equipment, added to Gladys or not.
//
// What was already seen is kept in /data (src/store.js): a change that
// happened while the integration or Gladys restarted is still announced,
// once. The very first read only records.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  buildEquipmentDevice,
  buildPortDevice,
  buildServerDevice,
  equipmentIds,
  equipmentValues,
  parseEquipmentId,
  parsePortId,
  portIds,
  portValues,
  serverIds,
  serverValues,
} from './devices.js';
import { ERROR_KINDS, LibreNMSClient, LibreNMSError, SEVERITIES } from './librenms/client.js';
import { MAX_PORTS, hostOf } from './config.js';
import { FailureLog } from './logs.js';
import { CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick, severityName } from './texts.js';

const logger = createLogger({ name: 'librenms-hub' });

export const WIDGET_KEY = 'overview';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  DEVICE_DOWN: 'device_down',
  DEVICE_UP: 'device_up',
  ALERT_RAISED: 'alert_raised',
  ALERT_CLEARED: 'alert_cleared',
  PORT_DOWN: 'port_down',
  PORT_UP: 'port_up',
  UNREACHABLE: 'server_unreachable',
});

export const HUB_TIMINGS = {
  // A server that fails once is read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Failures in a row before the server counts as unreachable (scene event).
  downAfterFailures: 2,
  // A scene action or the widget reads LibreNMS again when the last read is older.
  freshMs: 15_000,
  // The version is read again this often (LibreNMS upgraded in place).
  detectEveryMs: 3600_000,
  // An unchanged value is sent again this often: Gladys marks a value older
  // than 48 h as outdated.
  heartbeatMs: 6 * 3600_000,
};

// Scene events per read, at most: Gladys accepts 300 per minute, and a
// network outage can bring dozens of equipment down at once. The rest waits
// for the next reads.
export const MAX_EVENTS_PER_READ = 30;

const MAX_STATES_PER_REQUEST = 100;
// States per minute, at most (Gladys accepts 300): the changes first, then
// the heartbeats; the rest goes at the next read.
export const MAX_STATES_PER_MINUTE = 200;

const signature = (config) =>
  JSON.stringify([config.apiUrl, config.apiToken, config.allowSelfSigned]);
// What decides which equipment and alerts are seen: another scope does not
// clear the alerts of the previous one. The token is part of it (another
// user sees other equipment), hashed: /data never holds it.
const scopeOf = (config) =>
  JSON.stringify([
    config.apiUrl,
    [...config.deviceGroups].map((group) => group.toLowerCase()).sort(),
    createHash('sha256').update(config.apiToken).digest('hex').slice(0, 16),
  ]);

const emptySaved = (scope = null) => ({ scope, primed: false, alerts: {}, devices: {}, ports: {} });
const minutesSince = (now, since) =>
  typeof since === 'number' ? Math.max(0, Math.round((now - since) / 60_000)) : 0;
const lower = (value) => value.toLowerCase();

export class LibreNMSHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/librenms/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    this.signature = null;
    /** Last successful read: devices by id, alerts, sensors, followed ports. */
    this.data = null;
    this.error = null;
    this.failures = 0;
    this.down = false;
    this.readAt = 0;
    this.detectedAt = 0;
    this.polling = null;
    this.generation = 0;
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = emptySaved();
    this.pollTimer = null;
    this.retryTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.failureLog = new FailureLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    const map = (value) => (value && typeof value === 'object' ? value : {});
    this.saved = {
      scope: typeof saved.scope === 'string' ? saved.scope : null,
      primed: saved.primed === true,
      alerts: map(saved.alerts),
      devices: map(saved.devices),
      ports: map(saved.ports),
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config?.language !== config.language;
    const portsChanged = JSON.stringify(this.config?.ports) !== JSON.stringify(config.ports);
    this.config = config;
    if (this.signature !== signature(config)) {
      this.generation += 1; // a read in progress for the old server is ignored
      this.signature = signature(config);
      this.client = config.apiUrl
        ? new LibreNMSClient({
            url: config.apiUrl,
            token: config.apiToken,
            insecure: config.allowSelfSigned,
            request: this.request,
          })
        : null;
      this.data = null;
      this.error = null;
      this.failures = 0;
      this.down = false;
      this.readAt = 0;
      clearTimeout(this.retryTimer);
    }
    const scope = scopeOf(config);
    if (this.saved.scope !== scope) {
      this.generation += 1; // a read in progress for the old scope is ignored
      this.saved = emptySaved(scope);
      this.store.save(this.saved);
    }
    if (languageChanged || portsChanged) {
      this.discovered = null;
      if (portsChanged) {
        this.generation += 1; // the ports are part of the read
      }
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.failureLog.recover('poll', 'Reading LibreNMS works again');
      } catch (err) {
        this.failureLog.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading LibreNMS ------------------------------------------------------

  async pollAll({ publish = false, fresh = false } = {}) {
    const changed = await this.poll({ fresh });
    await this.afterChanges(changed, { publish });
  }

  /** Gladys asks for a refresh (onPoll): read now. */
  async pollDevice() {
    await this.pollAll();
  }

  /** Read again when the last read is older than `freshMs` (scene actions, widget). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollAll();
    }
  }

  /**
   * Read LibreNMS and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll({ fresh = false } = {}) {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (this.polling && (fresh || this.pollingGeneration !== this.generation)) {
      // A read started before an acknowledgement or a new configuration:
      // read again once it is over.
      return this.polling.catch(() => {}).then(() => this.poll());
    }
    if (!this.polling) {
      this.pollingGeneration = this.generation;
      this.polling = this.read().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  async read() {
    const { generation, client } = this;
    if (this.now() - this.detectedAt >= this.timings.detectEveryMs) {
      client.reset();
      this.detectedAt = this.now();
    }
    try {
      const snapshot = await client.snapshot({
        deviceGroups: this.config.deviceGroups,
        withPorts: this.config.ports.length > 0,
      });
      return generation === this.generation ? await this.applySuccess(snapshot) : false;
    } catch (caught) {
      // An answer of an unexpected shape (a list member that is not a list…).
      const err = caught.kind ? caught : new LibreNMSError(ERROR_KINDS.HTTP, caught.message);
      client.reset(); // read the version again: LibreNMS may have been upgraded
      return generation === this.generation ? await this.applyFailure(err) : false;
    }
  }

  serverName() {
    return hostOf(this.config.apiUrl);
  }

  /** The followed ports among the ports read, in the order of the configuration. */
  followedPorts(devices, ports) {
    const wanted = this.config.ports;
    if (wanted.length === 0) {
      return { ports: [], unmatched: [] };
    }
    const byName = new Map();
    for (const device of devices.values()) {
      for (const name of [device.hostname, device.sysName, device.name]) {
        if (name && !byName.has(lower(name))) {
          byName.set(lower(name), device);
        }
      }
    }
    const chosen = new Map();
    const unmatched = [];
    for (const entry of wanted) {
      const device = byName.get(lower(entry.device));
      const matches = device
        ? ports.filter(
            (port) =>
              port.deviceId === device.id &&
              (entry.port === '*' ? port.adminUp : lower(port.name) === lower(entry.port)),
          )
        : [];
      if (matches.length === 0) {
        unmatched.push(`${entry.device}:${entry.port}`);
      }
      for (const port of matches) {
        chosen.set(port.id, port);
      }
    }
    // Beyond the cap (`device:*`), the ports already followed stay first, then
    // by id: the list does not shuffle when a port is enabled again.
    const followed = (port) => port.id in this.saved.ports;
    const kept = [...chosen.values()]
      .sort((a, b) => Number(followed(b)) - Number(followed(a)) || Number(a.id) - Number(b.id))
      .slice(0, MAX_PORTS);
    if (chosen.size > kept.length) {
      unmatched.push(`+${chosen.size - kept.length} (max ${MAX_PORTS})`);
    }
    return { ports: kept, unmatched };
  }

  async applySuccess({ version, devices, alerts, sensors, ports, missingGroups }) {
    const previous = this.data;
    let widgetChanged = this.error !== null || previous === null;
    if (this.error) {
      logger.info(`LibreNMS ${this.serverName()} answers again`);
    }
    if (version !== previous?.version) {
      logger.info(`LibreNMS ${version} at ${this.serverName()}: ${devices.length} device(s)`);
    }
    const missing = missingGroups.join(', ');
    if (missing && missing !== previous?.missingGroups.join(', ')) {
      logger.warn(`Unknown device group(s): ${missing}`);
    }
    const byId = new Map(devices.map((device) => [device.id, device]));
    const followed = this.followedPorts(byId, ports);
    const unmatched = followed.unmatched.join(', ');
    if (unmatched && unmatched !== previous?.unmatchedPorts.join(', ')) {
      logger.warn(`Port(s) not found in LibreNMS: ${unmatched}`);
    }
    this.error = null;
    this.failures = 0;
    this.down = false;
    this.readAt = this.now();
    this.data = {
      version,
      devices: byId,
      alerts,
      sensors,
      ports: new Map(followed.ports.map((port) => [port.id, port])),
      unmatchedPorts: followed.unmatched,
      missingGroups,
    };
    if (
      previous &&
      JSON.stringify([previous.alerts, [...previous.devices.values()].map((d) => [d.id, d.up])]) !==
        JSON.stringify([alerts, devices.map((d) => [d.id, d.up])])
    ) {
      widgetChanged = true;
    }
    await this.transitions();
    await this.publishStates();
    return widgetChanged;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`LibreNMS ${this.serverName()}: ${err.message}`);
    }
    // Only silence counts as unreachable: a refused token is a configuration
    // problem, reported by the connection status.
    if (err.kind !== ERROR_KINDS.UNREACHABLE) {
      this.failures = 0;
      return wasError !== err.kind;
    }
    this.failures += 1;
    if (this.failures === 1) {
      this.scheduleRetry();
    }
    if (!this.down && this.failures >= this.timings.downAfterFailures) {
      this.down = true;
      await this.fireEvent(TRIGGERS.UNREACHABLE, {
        server: this.serverName(),
        error: pick(ERROR_TEXT[err.kind], this.config.language),
      });
    }
    return wasError !== err.kind;
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.pollAll()
        .then(() => this.failureLog.recover('retry'))
        .catch((err) => this.failureLog.fail('retry', `Retry failed: ${err.message}`, 'error'));
    }, this.timings.retryMs);
    this.retryTimer.unref?.();
  }

  // --- Scene events ------------------------------------------------------------

  /**
   * Compare with what was already seen; fire the scene events. A change is
   * recorded only once Gladys accepted its event (Gladys restarting, a burst
   * beyond the cap: sent at a next read). The end of an alert is announced
   * only if its start was.
   */
  async transitions() {
    const primed = this.saved.primed;
    const now = this.now();
    const events = [
      ...this.deviceEvents(primed, now),
      ...this.alertEvents(primed, now),
      ...this.portEvents(primed, now),
    ];
    this.saved.primed = true;

    const sent = events.slice(0, MAX_EVENTS_PER_READ);
    if (events.length > sent.length) {
      logger.warn(`${events.length - sent.length} change(s) left for the next read`);
    }
    for (const { key, data, commit } of sent) {
      logger.debug(`${key}: ${JSON.stringify(data)}`);
      if (!(await this.fireEvent(key, data))) {
        break; // Gladys refuses: keep the order, try again at the next read
      }
      commit();
    }
    this.store.save(this.saved);
  }

  /** Equipment that went down or came back. */
  deviceEvents(primed, now) {
    const known = this.saved.devices;
    const events = [];
    for (const device of this.data.devices.values()) {
      const entry = known[device.id];
      if (!entry || !primed) {
        known[device.id] = { up: device.up, since: now };
        continue;
      }
      if (entry.up === device.up) {
        continue;
      }
      const key = device.up ? TRIGGERS.DEVICE_UP : TRIGGERS.DEVICE_DOWN;
      const data = {
        device: equipmentIds(this.gladys, device.id).device,
        name: device.name,
        hostname: device.hostname,
      };
      if (device.up) {
        data.duration_minutes = minutesSince(now, entry.since);
      } else {
        data.reason = device.reason || '-';
      }
      events.push({
        key,
        data,
        commit: () => {
          known[device.id] = { up: device.up, since: now };
        },
      });
    }
    // Equipment that left the scope (removed, disabled, ignored): forgotten.
    for (const id of Object.keys(known)) {
      if (!this.data.devices.has(id)) {
        delete known[id];
      }
    }
    return events;
  }

  /** Alerts raised or cleared. LibreNMS keeps one alert id per rule and equipment. */
  alertEvents(primed, now) {
    const known = this.saved.alerts;
    const current = new Map(this.data.alerts.map((alert) => [alert.id, alert]));
    const events = [];
    for (const alert of current.values()) {
      let entry = known[alert.id];
      if (!entry) {
        entry = {
          deviceId: alert.deviceId,
          name: this.deviceName(alert.deviceId),
          rule: alert.rule,
          ruleId: alert.ruleId,
          severity: alert.severity,
          since: now,
          // The alerts already there at the first read are not announced.
          announced: !primed,
        };
        known[alert.id] = entry;
      }
      if (!entry.announced) {
        events.push({
          key: TRIGGERS.ALERT_RAISED,
          data: this.alertEvent(alert.id, entry),
          commit: () => {
            entry.announced = true;
          },
        });
      }
    }
    for (const [alertId, entry] of Object.entries(known)) {
      if (current.has(alertId)) {
        continue;
      }
      // Its device left the scope (disabled, ignored, out of the groups): the
      // alert may well be active still, it is forgotten, not "cleared".
      if (!this.data.devices.has(entry.deviceId)) {
        delete known[alertId];
        continue;
      }
      if (entry.announced === false) {
        delete known[alertId]; // never announced: its end is not either
        continue;
      }
      events.push({
        key: TRIGGERS.ALERT_CLEARED,
        data: {
          ...this.alertEvent(alertId, entry),
          duration_minutes: minutesSince(now, entry.since),
        },
        commit: () => {
          delete known[alertId];
        },
      });
    }
    return events;
  }

  alertEvent(alertId, entry) {
    return {
      device: equipmentIds(this.gladys, entry.deviceId).device,
      severity: entry.severity,
      severity_name: severityName(entry.severity, this.config.language),
      name: entry.name,
      rule: entry.rule,
      rule_id: entry.ruleId ?? '',
      alert_id: alertId,
    };
  }

  /**
   * Followed ports that went down or came back. A port administratively down
   * (shut on purpose) is not "down", and the ports of a down equipment keep
   * the values of its last poll: no event then.
   */
  portEvents(primed, now) {
    const known = this.saved.ports;
    const events = [];
    for (const port of this.data.ports.values()) {
      const device = this.data.devices.get(port.deviceId);
      if (!device?.up) {
        continue;
      }
      const state = !port.adminUp ? 'admin' : port.up ? 'up' : 'down';
      const entry = known[port.id];
      if (!entry || !primed) {
        known[port.id] = { state, since: now };
        continue;
      }
      // Only up → down and down → up are events; a port shut or opened by
      // the administrator is recorded silently.
      const event =
        (entry.state === 'up' && state === 'down') || (entry.state === 'down' && state === 'up');
      if (!event) {
        if (entry.state !== state) {
          known[port.id] = { state, since: now };
        }
        continue;
      }
      const data = {
        device: portIds(this.gladys, port.id).device,
        name: device.name,
        port: port.name,
        alias: port.alias || port.name,
      };
      if (state === 'up') {
        data.duration_minutes = minutesSince(now, entry.since);
      } else {
        data.status = port.operStatus || 'down';
      }
      events.push({
        key: state === 'up' ? TRIGGERS.PORT_UP : TRIGGERS.PORT_DOWN,
        data,
        commit: () => {
          known[port.id] = { state, since: now };
        },
      });
    }
    for (const id of Object.keys(known)) {
      if (!this.data.ports.has(id)) {
        delete known[id];
      }
    }
    return events;
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.failureLog.recover('event', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.failureLog.fail('event', `Scene event refused: ${err.message}`);
      return false;
    }
  }

  // --- Devices -----------------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  alertsOf(deviceId) {
    return (this.data?.alerts ?? []).filter((alert) => alert.deviceId === deviceId);
  }

  sensorsOf(deviceId) {
    return (this.data?.sensors ?? []).filter((sensor) => sensor.deviceId === deviceId);
  }

  discoveredDevices() {
    if (!this.data) {
      return [];
    }
    const language = this.config.language;
    const byName = (a, b) => a.name.localeCompare(b.name);
    const devices = [...this.data.devices.values()].sort(byName);
    const ports = [...this.data.ports.values()].map((port) =>
      buildPortDevice(this.gladys, port, this.data.devices.get(port.deviceId), language),
    );
    return [
      buildServerDevice(this.gladys, language),
      ...devices.map((device) =>
        buildEquipmentDevice(this.gladys, device, this.sensorsOf(device.id), language),
      ),
      ...ports.sort(byName),
    ];
  }

  /** Publish the Discovery list when it changed (an equipment added, renamed…). */
  async publishDevices({ force = false } = {}) {
    // Nothing read yet: keep the list Gladys has (an empty list only once
    // the address is removed from the configuration).
    if (!this.data && (!force || this.client)) {
      return;
    }
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.failureLog.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.failureLog.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read LibreNMS, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.publishDevices({ force: true });
  }

  /** The values of one Gladys device, null when it is not one of the last read. */
  valuesOf(externalId) {
    if (externalId === serverIds(this.gladys).device) {
      return serverValues(this.gladys, [...this.data.devices.values()], this.data.alerts);
    }
    const device = this.data.devices.get(parseEquipmentId(this.gladys, externalId));
    if (device) {
      return equipmentValues(
        this.gladys,
        device,
        this.alertsOf(device.id),
        this.sensorsOf(device.id),
      );
    }
    const port = this.data.ports.get(parsePortId(this.gladys, externalId));
    return port ? portValues(this.gladys, port, this.data.devices.get(port.deviceId)) : null;
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (!this.data) {
      return;
    }
    const values = this.valuesOf(device.external_id);
    if (!values) {
      return;
    }
    await this.sendStates(values, { force: true });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Publishing to Gladys ----------------------------------------------------

  allDeviceIds() {
    return [
      serverIds(this.gladys).device,
      ...[...this.data.devices.keys()].map((id) => equipmentIds(this.gladys, id).device),
      ...[...this.data.ports.keys()].map((id) => portIds(this.gladys, id).device),
    ];
  }

  /** The states of the added devices that changed (or are due for a heartbeat). */
  async publishStates() {
    const values = [];
    for (const externalId of this.allDeviceIds()) {
      if (this.isCreated(externalId)) {
        values.push(...this.valuesOf(externalId));
      }
    }
    await this.sendStates(values);
  }

  /** The share of MAX_STATES_PER_MINUTE of one read, at the configured interval. */
  statesPerRead() {
    const interval = this.config?.pollIntervalMs ?? 60_000;
    return Math.max(1, Math.floor((MAX_STATES_PER_MINUTE * Math.min(interval, 60_000)) / 60_000));
  }

  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const known = values.filter(({ value }) => value !== null); // unknown: the last value stands
    const changed = known.filter(
      ({ externalId, value }) => force || this.published.get(externalId) !== value,
    );
    const due = known.filter(
      ({ externalId, value }) =>
        !force &&
        this.published.get(externalId) === value &&
        now - (this.publishedAt.get(externalId) ?? 0) >= this.timings.heartbeatMs,
    );
    const states = [...changed, ...due]
      .slice(0, force ? Infinity : this.statesPerRead())
      .map(({ externalId, value }) => ({ device_feature_external_id: externalId, state: value }));
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      const batch = states.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(batch);
        for (const state of batch) {
          this.published.set(state.device_feature_external_id, state.state);
          this.publishedAt.set(state.device_feature_external_id, now);
        }
        this.failureLog.recover('states', 'States accepted again');
      } catch (err) {
        this.failureLog.fail('states', `States refused: ${err.message}`);
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /**
   * The badge of the added devices: "local", "unreachable" while LibreNMS is,
   * and for an equipment LibreNMS sees down (and its followed ports).
   */
  async publishTransports() {
    if (!this.data || this.readAt === 0) {
      return;
    }
    const failing = this.error !== null;
    const transportOf = (externalId) => {
      const device =
        this.data.devices.get(parseEquipmentId(this.gladys, externalId)) ??
        this.data.devices.get(this.data.ports.get(parsePortId(this.gladys, externalId))?.deviceId);
      return failing || device?.up === false
        ? DEVICE_TRANSPORTS.UNREACHABLE
        : DEVICE_TRANSPORTS.LOCAL;
    };
    const entries = this.allDeviceIds()
      .filter((id) => this.isCreated(id))
      .map((id) => ({ external_id: id, transport: transportOf(id) }))
      .filter((entry) => this.transports.get(entry.external_id) !== entry.transport);
    for (let at = 0; at < entries.length; at += MAX_STATES_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.failureLog.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.failureLog.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { apiUrl, invalidUrl } = this.config;
    if (!apiUrl) {
      return {
        connected: false,
        message: invalidUrl ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noServer,
      };
    }
    if (!this.error) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noServer)) {
      message[language] = pick(ERROR_TEXT[this.error.kind], language);
    }
    return { connected: false, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.failureLog.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.failureLog.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions, report) -----------------------------------

  /** The equipment of a device external id (an equipment or one of its ports), null when unknown. */
  findDevice(externalId) {
    const id =
      parseEquipmentId(this.gladys, externalId) ??
      this.data?.ports.get(parsePortId(this.gladys, externalId))?.deviceId;
    return id ? (this.data?.devices.get(id) ?? null) : null;
  }

  deviceName(deviceId) {
    return this.data?.devices.get(deviceId)?.name ?? `#${deviceId}`;
  }

  /** An alert in a list: "Equipment: rule". */
  alertLabel(alert, language) {
    return labelled(this.deviceName(alert.deviceId), alert.rule, language);
  }

  /** Alerts sorted for display: most severe first, not acknowledged first, then by id. */
  sortedAlerts(alerts = this.data?.alerts ?? []) {
    const rank = (alert) => SEVERITIES.indexOf(alert.severity);
    return [...alerts].sort(
      (a, b) =>
        rank(b) - rank(a) ||
        Number(a.acknowledged) - Number(b.acknowledged) ||
        Number(b.id) - Number(a.id),
    );
  }

  /** "Test the connection": read now, one line. */
  async testConnection() {
    await this.pollAll({ publish: true, fresh: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected || !this.data) {
        message[language] = labelled(
          this.config.apiUrl ? this.serverName() : 'LibreNMS',
          pick(status.message ?? ERROR_TEXT[ERROR_KINDS.UNREACHABLE], language),
          language,
        );
        continue;
      }
      const devices = [...this.data.devices.values()];
      const parts = [
        text.ok,
        `LibreNMS ${this.data.version}`,
        text.devices(devices.length),
        text.down(devices.filter((device) => !device.up).length),
        text.alerts(this.data.alerts.length),
      ];
      if (this.config.ports.length) {
        parts.push(text.ports(this.data.ports.size));
      }
      if (this.data.unmatchedPorts.length) {
        parts.push(text.unmatched(this.data.unmatchedPorts.join(', ')));
      }
      if (this.data.missingGroups.length) {
        parts.push(text.missing(this.data.missingGroups.join(', ')));
      }
      message[language] = labelled(this.serverName(), parts.join(', '), language);
    }
    return message;
  }
}
