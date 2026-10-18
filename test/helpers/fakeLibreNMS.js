// -----------------------------------------------------------------------------
// An in-memory LibreNMS, built from the real answers of LibreNMS 26.9.1
// (test/fixtures/librenms/). It answers the requests of src/librenms/client.js
// the way LibreNMS does: X-Auth-Token checked (401 "Unauthenticated."), lists
// answered 404 with `status: "error"` when empty, `PUT alerts/<id>` setting
// the state to acknowledged. The tests change its lists to play a scenario.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/librenms/librenms-26.9.1.json', import.meta.url), 'utf8'),
);

export const TOKEN = '1|testTokenForTheFakeLibreNMSxxxxxxxxxxxxxxxxxxx';
export const API_URL = 'http://192.0.2.10:8000/api/v0';

const clone = (value) => structuredClone(value);
const json = (status, body) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export class FakeLibreNMS {
  constructor() {
    this.version = FIXTURE.system.system[0].local_ver;
    this.devices = clone(FIXTURE.devices.devices);
    this.alerts = [];
    this.sensors = clone(FIXTURE.sensors.sensors);
    this.ports = clone(FIXTURE.ports.ports);
    this.groups = { Homelab: [1] };
    /** Every request received: { method, path, body }. */
    this.calls = [];
    /** Set to an Error with a `code` to simulate a network failure. */
    this.failWith = null;
    /** Set to a status to answer every request with it. */
    this.answerStatus = null;
    /** Answer `PUT alerts/<id>` as a read-only role does (HTTP 500). */
    this.readOnly = false;
  }

  device(id) {
    return this.devices.find((device) => device.device_id === id);
  }

  /** Take an equipment down (as the LibreNMS ping and poller see it), with its alert. */
  setDown(id, { alert = true } = {}) {
    Object.assign(this.device(id), { status: 0, status_reason: 'icmp,snmp' });
    if (alert) {
      this.raise(id, {
        rule_id: 1,
        severity: 'critical',
        name: 'Device Down! Due to no ICMP response.',
      });
    }
  }

  setUp(id) {
    Object.assign(this.device(id), { status: 1, status_reason: '' });
    this.alerts = this.alerts.filter((alert) => !(alert.device_id === id && alert.rule_id === 1));
  }

  /** Raise an alert of the shape of the fixture; one alert id per rule and equipment. */
  raise(deviceId, { rule_id, severity, name }) {
    const id = deviceId * 100 + rule_id;
    this.alerts = this.alerts.filter((alert) => alert.id !== id);
    this.alerts.push({
      ...clone(FIXTURE.alerts_active.alerts[0]),
      id,
      device_id: deviceId,
      hostname: this.device(deviceId).hostname,
      rule_id,
      severity,
      name,
      state: 1,
    });
    return id;
  }

  clear(alertId) {
    this.alerts = this.alerts.filter((alert) => alert.id !== alertId);
  }

  async request(url, { method = 'GET', body = '', headers = {} } = {}) {
    if (this.failWith) {
      throw this.failWith;
    }
    const target = new URL(url);
    const path = target.pathname.replace(/^\/api\/v0\//, '');
    this.calls.push({ method, path: `${path}${target.search}`, body });
    if (this.answerStatus) {
      return { status: this.answerStatus, headers: {}, body: '<html>Bad gateway</html>' };
    }
    if (headers['x-auth-token'] !== TOKEN) {
      return json(401, FIXTURE.unauthenticated);
    }
    const query = target.searchParams;
    if (method === 'GET' && path === 'system') {
      return json(200, {
        ...FIXTURE.system,
        system: [{ ...FIXTURE.system.system[0], local_ver: this.version }],
      });
    }
    if (method === 'GET' && path === 'devices') {
      const devices =
        query.get('type') === 'active'
          ? this.devices.filter((device) => !device.ignore && !device.disabled)
          : this.devices;
      return json(200, { status: 'ok', devices: clone(devices), count: devices.length });
    }
    if (method === 'GET' && path.startsWith('devicegroups/')) {
      const name = decodeURIComponent(path.slice('devicegroups/'.length));
      if (!(name in this.groups)) {
        return json(404, FIXTURE.devicegroup_missing);
      }
      const ids = this.groups[name];
      if (ids.length === 0) {
        return json(404, { status: 'error', message: `No devices found in group ${name}` });
      }
      return json(200, {
        status: 'ok',
        devices: ids.map((id) => ({ device_id: id })),
        count: ids.length,
      });
    }
    if (method === 'GET' && path === 'alerts') {
      const states = (query.get('state') ?? '1').split(',').map(Number);
      const alerts = this.alerts.filter((alert) => states.includes(alert.state));
      return json(200, { status: 'ok', alerts: clone(alerts), count: alerts.length });
    }
    if (method === 'PUT' && path.startsWith('alerts/')) {
      if (this.readOnly) {
        return json(500, FIXTURE.ack_read_only_role);
      }
      const alert = this.alerts.find((entry) => String(entry.id) === path.slice('alerts/'.length));
      if (!alert) {
        return json(200, FIXTURE.ack_unknown);
      }
      alert.state = 2;
      alert.note = JSON.parse(body).note;
      return json(200, FIXTURE.ack_ok);
    }
    if (method === 'GET' && path === 'resources/sensors') {
      return this.sensors.length === 0
        ? json(404, FIXTURE.sensors_none)
        : json(200, { status: 'ok', sensors: clone(this.sensors), count: this.sensors.length });
    }
    if (method === 'GET' && path === 'ports') {
      const columns = (query.get('columns') ?? 'port_id,ifName').split(',');
      const ports = this.ports.map((port) =>
        Object.fromEntries(columns.map((column) => [column, port[column] ?? null])),
      );
      return json(200, { status: 'ok', ports });
    }
    return json(404, { status: 'error', message: 'Not found' });
  }
}
