// -----------------------------------------------------------------------------
// LibreNMS REST client (API v0, `X-Auth-Token` header). Checked against
// LibreNMS 26.9.1 (test/fixtures/librenms/).
//
// One read (snapshot) = four requests, five with ports followed, whatever the
// number of equipment: `system` (the version, once an hour), `devices`,
// `alerts`, `resources/sensors`, and `ports` (only the columns used); plus
// one `devicegroups/<name>` per group of the filter.
//
// The device list returns every column of the `devices` table, SNMP
// community and credentials included: only the fields used here are kept,
// the rest never leaves this file.
//
// Errors are thrown as LibreNMSError with a `kind` (ERROR_KINDS): the hub and
// the texts know what to tell the user from it.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer, timeout, 502/503/504 of a reverse proxy
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // token refused (401)
  FORBIDDEN: 'forbidden', // token accepted, request not allowed (403)
  TOKEN_MISSING: 'token_missing', // no token in the configuration
  NOT_LIBRENMS: 'not_librenms', // something answers, but not the LibreNMS API
  REDIRECT: 'redirect', // HTTP redirected (to HTTPS, to a login page)
  GROUPS: 'groups', // none of the configured device groups exists
  HTTP: 'http', // anything else
});

export class LibreNMSError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message for the logs (never a token)
   * @param {object} [extra] e.g. { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'LibreNMSError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
  // An https:// address on a plain HTTP server.
  'EPROTO',
]);
const isTlsError = (code) => TLS_CODES.has(code) || /^ERR_SSL_/.test(code ?? '');

// Active alert states (LibreNMS\Enum\AlertState): 0 is a cleared alert.
export const ALERT_STATES = Object.freeze({
  ACTIVE: 1,
  ACKNOWLEDGED: 2,
  WORSE: 3,
  BETTER: 4,
  CHANGED: 5,
});
const ACTIVE_STATES = Object.values(ALERT_STATES).join(',');

// Rule severities, from the least to the most severe.
export const SEVERITIES = ['ok', 'warning', 'critical'];

// Health sensor classes kept on the equipment devices (src/devices.js).
export const SENSOR_CLASSES = [
  'temperature',
  'fanspeed',
  'load',
  'power',
  'voltage',
  'current',
  'humidity',
];

const PORT_COLUMNS = [
  'port_id',
  'device_id',
  'ifName',
  'ifAlias',
  'ifDescr',
  'ifOperStatus',
  'ifAdminStatus',
  'ifInOctets_rate',
  'ifOutOctets_rate',
  'ifInErrors_rate',
  'ifOutErrors_rate',
];

const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const number = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const id = (value) => {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
};

/** The fields of a `devices` row the integration uses, nothing else. */
export function toDevice(row) {
  const hostname = text(row.hostname);
  return {
    id: id(row.device_id),
    hostname,
    sysName: text(row.sysName),
    // `display` is the name shown in LibreNMS; it may be unset or a template.
    name: text(row.display) || text(row.sysName) || hostname,
    up: Number(row.status) === 1,
    reason: text(row.status_reason),
    uptime: number(row.uptime),
    snmp: Number(row.snmp_disable) !== 1,
    os: text(row.os),
    hardware: text(row.hardware),
  };
}

export function toAlert(row) {
  const state = Number(row.state);
  return {
    id: id(row.id),
    deviceId: id(row.device_id),
    ruleId: id(row.rule_id),
    rule: text(row.name) || `#${text(row.rule_id)}`,
    severity: SEVERITIES.includes(row.severity) ? row.severity : 'critical',
    acknowledged: state === ALERT_STATES.ACKNOWLEDGED,
    state,
  };
}

export function toSensor(row) {
  return {
    id: id(row.sensor_id),
    deviceId: id(row.device_id),
    sensorClass: text(row.sensor_class),
    name: text(row.sensor_descr),
    value: number(row.sensor_current),
    deleted: Number(row.sensor_deleted) === 1,
  };
}

export function toPort(row) {
  return {
    id: id(row.port_id),
    deviceId: id(row.device_id),
    name: text(row.ifName) || text(row.ifDescr),
    alias: text(row.ifAlias),
    up: row.ifOperStatus === 'up',
    adminUp: row.ifAdminStatus === 'up',
    operStatus: text(row.ifOperStatus),
    inRate: number(row.ifInOctets_rate),
    outRate: number(row.ifOutOctets_rate),
    inErrors: number(row.ifInErrors_rate),
    outErrors: number(row.ifOutErrors_rate),
  };
}

export class LibreNMSClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL of the API (`…/api/v0`)
   * @param {string} [options.token] API token, '' for none
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, token = '', insecure = false, request = httpRequest, timeoutMs = 20_000 }) {
    this.url = url;
    this.token = token;
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.version = null;
  }

  /** Forget the version: read again at the next snapshot (LibreNMS upgraded). */
  reset() {
    this.version = null;
  }

  /**
   * One API call. LibreNMS answers `{ status: "ok" | "error", message, … }`;
   * a 404 with `status: "error"` is an empty result for some lists, which
   * the callers tell apart by the message.
   * @param {string} path below /api/v0, with its query string
   * @param {{ method?: string, body?: object }} [options]
   * @returns {Promise<{ status: number, data: object }>}
   * @throws {LibreNMSError}
   */
  async call(path, { method = 'GET', body } = {}) {
    if (!this.token) {
      throw new LibreNMSError(ERROR_KINDS.TOKEN_MISSING, 'No API token in the configuration');
    }
    const headers = { 'x-auth-token': this.token, accept: 'application/json' };
    if (body) {
      headers['content-type'] = 'application/json';
    }
    let response;
    try {
      response = await this.request(`${this.url}/${path}`, {
        method,
        body: body ? JSON.stringify(body) : '',
        headers,
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (isTlsError(err.code)) {
        throw new LibreNMSError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      if (!err.code) {
        // The server answers, but not as expected (an answer too large…).
        throw new LibreNMSError(ERROR_KINDS.HTTP, err.message);
      }
      throw new LibreNMSError(ERROR_KINDS.UNREACHABLE, `${err.code}`);
    }

    const { status } = response;
    const where = `${method} ${path.split('?')[0]}`;
    if (status >= 300 && status < 400) {
      throw new LibreNMSError(ERROR_KINDS.REDIRECT, `${where}: redirected (HTTP ${status})`, {
        status,
      });
    }
    if ([502, 503, 504].includes(status)) {
      // A reverse proxy in front of a stopped LibreNMS.
      throw new LibreNMSError(ERROR_KINDS.UNREACHABLE, `HTTP ${status}`, { status });
    }
    if (status === 401) {
      throw new LibreNMSError(ERROR_KINDS.AUTH, `${where}: token refused (HTTP 401)`, { status });
    }
    if (status === 403) {
      throw new LibreNMSError(ERROR_KINDS.FORBIDDEN, `${where}: not allowed (HTTP 403)`, {
        status,
      });
    }
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || !['ok', 'error'].includes(data.status)) {
      throw new LibreNMSError(
        status === 200 || status === 404 ? ERROR_KINDS.NOT_LIBRENMS : ERROR_KINDS.HTTP,
        `${where}: not a LibreNMS API answer (HTTP ${status})`,
        { status },
      );
    }
    if (data.status === 'error' && status !== 404) {
      throw new LibreNMSError(
        ERROR_KINDS.HTTP,
        `${where}: ${text(data.message).slice(0, 200)} (HTTP ${status})`,
        { status },
      );
    }
    return { status, data };
  }

  /** A list member of an answer, [] when LibreNMS says there is none (404). */
  async list(path, member) {
    const { data } = await this.call(path);
    if (data.status === 'error') {
      return [];
    }
    if (!Array.isArray(data[member])) {
      throw new LibreNMSError(ERROR_KINDS.NOT_LIBRENMS, `${path}: no "${member}" list`);
    }
    return data[member];
  }

  /** The LibreNMS version, read once (again after reset()). */
  async detect() {
    if (this.version) {
      return this.version;
    }
    const { data } = await this.call('system');
    const version = data.system?.[0]?.local_ver;
    if (data.status !== 'ok' || typeof version !== 'string') {
      throw new LibreNMSError(ERROR_KINDS.NOT_LIBRENMS, 'No version in /system');
    }
    this.version = version;
    return version;
  }

  /**
   * The device ids of the groups, by name or id.
   * @returns {Promise<{ ids: Set<string>|null, missing: string[] }>} ids null: no filter
   */
  async groupDeviceIds(groups) {
    if (groups.length === 0) {
      return { ids: null, missing: [] };
    }
    const ids = new Set();
    const missing = [];
    for (const group of groups) {
      const { data } = await this.call(`devicegroups/${encodeURIComponent(group)}`);
      if (data.status === 'error') {
        // "Device group not found", or "No devices found in group …".
        if (/not found/i.test(text(data.message)) && !/no devices/i.test(text(data.message))) {
          missing.push(group);
        }
        continue;
      }
      for (const row of Array.isArray(data.devices) ? data.devices : []) {
        const deviceId = id(row.device_id);
        if (deviceId) {
          ids.add(deviceId);
        }
      }
    }
    if (missing.length === groups.length) {
      throw new LibreNMSError(ERROR_KINDS.GROUPS, `Unknown device group(s): ${missing.join(', ')}`);
    }
    return { ids, missing };
  }

  /**
   * Everything the integration shows, in one go.
   * @param {object} options
   * @param {string[]} options.deviceGroups names (or ids) of device groups, [] for all
   * @param {boolean} options.withPorts read the ports too
   */
  async snapshot({ deviceGroups = [], withPorts = false } = {}) {
    const version = await this.detect();
    const { ids, missing } = await this.groupDeviceIds(deviceGroups);
    // `active`: neither disabled nor ignored, as on the LibreNMS overview.
    const devices = (await this.list('devices?type=active', 'devices'))
      .map(toDevice)
      .filter((device) => device.id && (!ids || ids.has(device.id)));
    const inScope = new Set(devices.map((device) => device.id));
    const alerts = (await this.list(`alerts?state=${ACTIVE_STATES}`, 'alerts'))
      .map(toAlert)
      .filter((alert) => alert.id && inScope.has(alert.deviceId));
    const sensors = (await this.list('resources/sensors', 'sensors'))
      .map(toSensor)
      .filter(
        (sensor) =>
          sensor.id &&
          !sensor.deleted &&
          inScope.has(sensor.deviceId) &&
          SENSOR_CLASSES.includes(sensor.sensorClass),
      );
    const ports = withPorts
      ? (await this.list(`ports?columns=${PORT_COLUMNS.join(',')}`, 'ports'))
          .map(toPort)
          .filter((port) => port.id && inScope.has(port.deviceId))
      : [];
    return { version, devices, alerts, sensors, ports, missingGroups: missing };
  }

  /**
   * Acknowledge one alert, with a note in its history. `until_clear: false`:
   * LibreNMS notifies again if the alert gets worse.
   * @returns {Promise<boolean>} false when LibreNMS has no such alert any more
   */
  async acknowledge(alertId, note) {
    const { data } = await this.call(`alerts/${encodeURIComponent(alertId)}`, {
      method: 'PUT',
      body: { note, until_clear: false },
    });
    return data.status === 'ok' && !/no alert/i.test(text(data.message));
  }
}
