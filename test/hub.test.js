// The hub against the fake LibreNMS: discovery, states of the added devices
// only, scene events (equipment down and back, alerts raised and cleared,
// followed ports down and back, kept across a restart), the server
// unreachable, heartbeat, the reading timer, and quiet logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS, sensorKey } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  BASE_CONFIG,
  FakeLibreNMS,
  TOKEN,
  createClock,
  createDevices,
  createWorld,
  equipmentDevice,
  equipmentFeature,
  portFeature,
  serverFeature,
} from './helpers/world.js';

const NAS = '1';
const PRINTER = '2';
const ETH0 = '2';

/** The lines written at `LOG_LEVEL=info` from now on (the SDK logger reads it per line). */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const keys = (w) => w.fake.sceneEvents.map((event) => event.key);

test('discovery: the server device and one device per active equipment, sorted by name', async (t) => {
  const w = await world(t);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['LibreNMS', 'nas.home.arpa', 'printer.home.arpa'],
  );
  const nas = w.fake.discoveredDevices[1];
  assert.equal(nas.model, 'Generic x86 64-bit');
  // SNMP equipment: uptime and its health sensors (deleted and "state" ones left out).
  assert.deepEqual(
    nas.features.map((feature) => feature.name),
    [
      'Online',
      'Uptime',
      'Active alerts',
      'Package id 0',
      'Core 0',
      'Core 0 2',
      'fan1 (rpm)',
      'Vcore',
    ],
  );
  // Ping only: neither uptime nor sensors.
  assert.deepEqual(
    w.fake.discoveredDevices[2].features.map((feature) => feature.name),
    ['Online', 'Active alerts'],
  );
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  // Nothing is published for a device not added: Gladys would drop it.
  assert.equal(w.fake.states.length, 0);
});

test('the SNMP community and credentials never leave the client', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, ports: 'nas:eth0' } });
  await createDevices(w);
  const everything = JSON.stringify([w.fake.discoveredDevices, w.fake.states, w.hub.data]);
  assert.doesNotMatch(everything, /community-must-never-leak|authpass|cryptopass/);
});

test('a device group filter keeps its equipment; an unknown group is a connection error', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, device_groups: 'Homelab' } });
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['LibreNMS', 'nas.home.arpa'],
  );
  w.librenms.setDown(Number(PRINTER));
  await createDevices(w);
  // The server counts the filtered equipment only.
  assert.equal(w.fake.lastState(serverFeature(w.gladys, FEATURE_KEYS.DOWN)), 0);
  assert.equal(w.fake.lastState(serverFeature(w.gladys, FEATURE_KEYS.ALERTS)), 0);
  await w.fake.configUpdated({ ...BASE_CONFIG, device_groups: 'Nope' });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /no device group/);
});

test('added devices get every state, then only the changes', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, ports: 'nas.home.arpa:eth0' } });
  await createDevices(w);
  const state = (id, key) => w.fake.lastState(equipmentFeature(w.gladys, id, key));
  assert.equal(state(NAS, FEATURE_KEYS.ONLINE), 1);
  assert.equal(state(NAS, FEATURE_KEYS.UPTIME), 9.96);
  assert.equal(state(NAS, FEATURE_KEYS.ALERTS), 0);
  assert.equal(state(NAS, sensorKey(1)), 47.5);
  assert.equal(state(NAS, sensorKey(5)), 0.91);
  assert.equal(state(PRINTER, FEATURE_KEYS.UPTIME), undefined, 'ping only');
  assert.equal(w.fake.lastState(portFeature(w.gladys, ETH0, FEATURE_KEYS.ONLINE)), 1);
  // 115 bytes per second = 0.00092 Mbit/s.
  assert.equal(w.fake.lastState(portFeature(w.gladys, ETH0, FEATURE_KEYS.IN_RATE)), 0.001);
  assert.equal(w.fake.lastState(serverFeature(w.gladys, FEATURE_KEYS.DOWN)), 0);

  const before = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, before, 'nothing changed, nothing sent');

  w.librenms.setDown(Number(NAS));
  await w.hub.pollAll();
  assert.equal(state(NAS, FEATURE_KEYS.ONLINE), 0);
  assert.equal(state(NAS, FEATURE_KEYS.ALERTS), 1);
  assert.equal(w.fake.lastState(serverFeature(w.gladys, FEATURE_KEYS.DOWN)), 1);
  assert.equal(w.fake.lastState(serverFeature(w.gladys, FEATURE_KEYS.CRITICAL)), 1);
  // Down: the uptime and the port keep their last values, the badge says unreachable.
  assert.equal(state(NAS, FEATURE_KEYS.UPTIME), 9.96);
  const badges = Object.fromEntries(
    w.fake.transports.map((entry) => [entry.device_external_id, entry.transport]),
  );
  assert.equal(badges[equipmentDevice(w.gladys, NAS)], 'unreachable');
  assert.equal(badges[equipmentDevice(w.gladys, PRINTER)], 'local');
});

test('a device added later receives everything at once, and the widget is refreshed', async (t) => {
  const w = await world(t);
  const nas = w.fake.discoveredDevices.find((device) => device.name === 'nas.home.arpa');
  await w.fake.deviceCreated(nas);
  assert.equal(w.fake.lastState(equipmentFeature(w.gladys, NAS, FEATURE_KEYS.ONLINE)), 1);
  assert.ok(w.fake.widgetRefreshes.includes('overview'));
  // "Update" (onDeviceUpdated) sends everything again too.
  const count = w.fake.states.length;
  await w.fake.deviceUpdated(nas);
  assert.ok(w.fake.states.length > count);
});

test('scene events: the first read records, then down and back, alert raised and cleared', async (t) => {
  const clock = createClock();
  const librenms = new FakeLibreNMS();
  librenms.raise(2, { rule_id: 7, severity: 'warning', name: 'Already there' });
  const w = await world(t, { clock, librenms });
  assert.deepEqual(w.fake.sceneEvents, [], 'what is already there is not announced');

  w.librenms.setDown(Number(NAS));
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.DEVICE_DOWN,
      data: {
        device: equipmentDevice(w.gladys, NAS),
        name: 'nas.home.arpa',
        hostname: 'nas.home.arpa',
        reason: 'icmp,snmp',
      },
    },
    {
      key: TRIGGERS.ALERT_RAISED,
      data: {
        device: equipmentDevice(w.gladys, NAS),
        severity: 'critical',
        severity_name: 'Critical',
        name: 'nas.home.arpa',
        rule: 'Device Down! Due to no ICMP response.',
        rule_id: '1',
        alert_id: '101',
      },
    },
  ]);

  clock.advance(12 * 60_000);
  w.librenms.setUp(Number(NAS));
  await w.hub.pollAll();
  assert.deepEqual(keys(w).slice(2), [TRIGGERS.DEVICE_UP, TRIGGERS.ALERT_CLEARED]);
  assert.equal(w.fake.sceneEvents[2].data.duration_minutes, 12);
  assert.equal(w.fake.sceneEvents[3].data.duration_minutes, 12);
  assert.equal(w.fake.sceneEvents.length, 4);
});

test('an acknowledged alert is neither cleared nor raised again', async (t) => {
  const w = await world(t);
  const id = w.librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Disk 90%' });
  await w.hub.pollAll();
  w.librenms.alerts[0].state = 2;
  await w.hub.pollAll();
  w.librenms.alerts[0].state = 3; // worse
  await w.hub.pollAll();
  assert.deepEqual(keys(w), [TRIGGERS.ALERT_RAISED]);
  w.librenms.clear(id);
  await w.hub.pollAll();
  assert.deepEqual(keys(w), [TRIGGERS.ALERT_RAISED, TRIGGERS.ALERT_CLEARED]);
});

test('followed ports: down and back, not when shut by the administrator nor when the equipment is down', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, ports: 'nas:*' } });
  assert.deepEqual(
    w.fake.discoveredDevices.slice(-2).map((device) => device.name),
    ['nas.home.arpa eth0', 'nas.home.arpa lo'],
  );
  const eth0 = w.librenms.ports.find((port) => port.ifName === 'eth0');
  eth0.ifOperStatus = 'lowerLayerDown';
  await w.hub.pollAll();
  eth0.ifOperStatus = 'up';
  await w.hub.pollAll();
  assert.deepEqual(keys(w), [TRIGGERS.PORT_DOWN, TRIGGERS.PORT_UP]);
  assert.deepEqual(w.fake.sceneEvents[0].data, {
    device: w.gladys.externalIds('port', ETH0).device,
    name: 'nas.home.arpa',
    port: 'eth0',
    alias: 'eth0',
    status: 'lowerLayerDown',
  });

  // Shut by the administrator: no event, and no "up" when opened again.
  Object.assign(eth0, { ifAdminStatus: 'down', ifOperStatus: 'down' });
  await w.hub.pollAll();
  Object.assign(eth0, { ifAdminStatus: 'up', ifOperStatus: 'up' });
  await w.hub.pollAll();
  // The equipment down: its ports keep their last values, no event.
  w.librenms.setDown(Number(NAS), { alert: false });
  eth0.ifOperStatus = 'down';
  await w.hub.pollAll();
  assert.deepEqual(keys(w), [TRIGGERS.PORT_DOWN, TRIGGERS.PORT_UP, TRIGGERS.DEVICE_DOWN]);
});

test('ports not found are reported by "Test the connection"', async (t) => {
  const w = await world(t, {
    config: { ...BASE_CONFIG, ports: 'nas:eth0, nas:eth9, router:ge-0/0/1' },
  });
  const answer = await w.fake.action('test_connection');
  assert.equal(
    answer.data.message.en,
    '192.0.2.10:8000: OK, LibreNMS 26.9.1, 2 device(s), 0 down, 0 alert(s), 1 port(s) followed, port(s) not found: nas:eth9, router:ge-0/0/1',
  );
});

test('a restart neither repeats nor misses a change', async (t) => {
  const librenms = new FakeLibreNMS();
  const first = await world(t, { librenms });
  const kept = librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Kept' });
  await first.hub.pollAll();
  await first.app.stop();
  assert.equal(first.fake.sceneEvents.length, 1);

  // While the integration was stopped: one alert ends, the printer goes down.
  librenms.clear(kept);
  librenms.setDown(2, { alert: false });
  const second = await world(t, { librenms, dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => [event.key, event.data.alert_id ?? event.data.name]),
    [
      [TRIGGERS.DEVICE_DOWN, 'printer.home.arpa'],
      [TRIGGERS.ALERT_CLEARED, String(kept)],
    ],
  );
});

test('another device group filter records its state without announcing it', async (t) => {
  const librenms = new FakeLibreNMS();
  librenms.setDown(2);
  const w = await world(t, { librenms, config: { ...BASE_CONFIG, device_groups: 'Homelab' } });
  await w.fake.configUpdated({ ...BASE_CONFIG, device_groups: '' });
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('LibreNMS silent twice: one scene event, unreachable badges, then back', async (t) => {
  const w = await world(t);
  await createDevices(w);
  w.librenms.failWith = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [], 'one failure is a blip');
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.UNREACHABLE,
      data: { server: '192.0.2.10:8000', error: 'LibreNMS does not answer' },
    },
  ]);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.ok(w.fake.transports.slice(-3).every((entry) => entry.transport === 'unreachable'));
  w.librenms.failWith = null;
  await w.hub.pollAll();
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.ok(w.fake.transports.slice(-3).every((entry) => entry.transport === 'local'));
});

test('a refused token is a connection error, not "unreachable"', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, api_token: 'wrong' } });
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  assert.match(w.fake.connectionStatus.message.fr, /jeton d'API refusé/);
});

test('an unchanged value is sent again after 6 hours', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await createDevices(w);
  const count = w.fake.states.length;
  clock.advance(6 * 3600_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count * 2);
});

test('the container reads LibreNMS on its own timer, without onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t, { timers: true });
  const reads = () => w.librenms.calls.filter((call) => call.path.startsWith('alerts')).length;
  const first = reads();
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  await w.hub.polling;
  assert.equal(reads(), first + 1);
});

test('a normal cycle writes nothing at the info level; a failure one line each way', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const lines = captureLogs(t);
  const id = w.librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Quiet' });
  await w.hub.pollAll();
  w.librenms.clear(id);
  await w.hub.pollAll();
  await w.hub.rediscover();
  assert.equal(w.fake.sceneEvents.length, 2);
  assert.deepEqual(lines, []);

  w.librenms.failWith = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  for (let read = 0; read < 4; read += 1) {
    await w.hub.pollAll();
  }
  w.librenms.failWith = null;
  await w.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(
    lines.every((line) => !line.includes(TOKEN)),
    'no token in the logs',
  );
});

test('a burst of alerts is capped per read, the rest follows', async (t) => {
  const w = await world(t);
  for (let rule = 1; rule <= 40; rule += 1) {
    w.librenms.raise(1, { rule_id: rule, severity: 'warning', name: `Rule ${rule}` });
  }
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 30);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 40);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 40);
});

test('Gladys refusing the scene events (restarting): sent at a next read, once', async (t) => {
  const w = await world(t);
  const original = w.gladys.publishSceneEvent.bind(w.gladys);
  let refuse = true;
  w.gladys.publishSceneEvent = (key, data) =>
    refuse ? Promise.reject(new Error('ECONNREFUSED')) : original(key, data);
  w.librenms.setDown(2);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 0);
  refuse = false;
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(keys(w), [TRIGGERS.DEVICE_DOWN, TRIGGERS.ALERT_RAISED]);
});

test('a new device group filter during a read: the old read does not prime the new scope', async (t) => {
  const w = await world(t);
  const reading = w.hub.pollAll();
  await w.fake.configUpdated({ ...BASE_CONFIG, device_groups: 'Homelab' });
  await reading;
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['LibreNMS', 'nas.home.arpa'],
  );
});

test('no sensor at all (LibreNMS answers 404): equipment without health features', async (t) => {
  const librenms = new FakeLibreNMS();
  librenms.sensors = [];
  const w = await world(t, { librenms });
  assert.deepEqual(
    w.fake.discoveredDevices[1].features.map((feature) => feature.name),
    ['Online', 'Uptime', 'Active alerts'],
  );
});

test('no configuration: a clear connection status, no request', async (t) => {
  const w = await world(t, { config: {} });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Enter the address/);
  assert.equal(w.librenms.calls.length, 0);
});
