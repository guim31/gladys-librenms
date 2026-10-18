// The LibreNMS client against the fake LibreNMS (real answers of 26.9.1) and
// against network failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, LibreNMSClient, toDevice } from '../src/librenms/client.js';
import { API_URL, FIXTURE, FakeLibreNMS, TOKEN } from './helpers/fakeLibreNMS.js';

const clientFor = (librenms, token = TOKEN) =>
  new LibreNMSClient({
    url: API_URL,
    token,
    request: (url, options) => librenms.request(url, options),
  });

test('a snapshot reads version, devices, alerts, sensors and ports in five requests', async () => {
  const librenms = new FakeLibreNMS();
  librenms.setDown(2);
  const snapshot = await clientFor(librenms).snapshot({ withPorts: true });
  assert.equal(snapshot.version, '26.9.1');
  assert.deepEqual(
    snapshot.devices.map((device) => [device.id, device.name, device.up, device.snmp]),
    [
      ['2', 'printer.home.arpa', false, false],
      ['1', 'nas.home.arpa', true, true],
    ],
  );
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].severity, 'critical');
  // Deleted sensors and classes not kept ("state") are left out.
  assert.deepEqual(
    snapshot.sensors.map((sensor) => sensor.sensorClass),
    ['temperature', 'temperature', 'temperature', 'fanspeed', 'voltage'],
  );
  assert.deepEqual(
    snapshot.ports.map((port) => [port.name, port.up, port.inRate]),
    [
      ['lo', true, 0],
      ['eth0', true, 115],
    ],
  );
  assert.equal(librenms.calls.length, 5);
  assert.ok(librenms.calls.every((call) => call.method === 'GET'));
});

test('the SNMP community and credentials are not kept', () => {
  const device = toDevice(FIXTURE.devices.devices[1]);
  assert.doesNotMatch(JSON.stringify(device), /community|authpass|cryptopass|never-leak/);
});

test('device groups: their devices only; unknown ones reported, all unknown an error', async () => {
  const librenms = new FakeLibreNMS();
  librenms.groups.Empty = [];
  const snapshot = await clientFor(librenms).snapshot({
    deviceGroups: ['Homelab', 'Empty', 'Nope'],
  });
  assert.deepEqual(
    snapshot.devices.map((device) => device.id),
    ['1'],
  );
  assert.deepEqual(snapshot.missingGroups, ['Nope']);
  await assert.rejects(clientFor(librenms).snapshot({ deviceGroups: ['Nope'] }), {
    kind: ERROR_KINDS.GROUPS,
  });
});

test('errors: refused token, network, certificate, proxy, redirect, not LibreNMS', async () => {
  const librenms = new FakeLibreNMS();
  await assert.rejects(clientFor(librenms, 'wrong').snapshot(), { kind: ERROR_KINDS.AUTH });
  await assert.rejects(clientFor(librenms, '').snapshot(), { kind: ERROR_KINDS.TOKEN_MISSING });
  const failing = (error) =>
    new LibreNMSClient({
      url: API_URL,
      token: TOKEN,
      request: async () => {
        throw error;
      },
    });
  await assert.rejects(failing(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).detect(), {
    kind: ERROR_KINDS.UNREACHABLE,
  });
  await assert.rejects(
    failing(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).detect(),
    { kind: ERROR_KINDS.TLS },
  );
  const answering = (status, body = '') =>
    new LibreNMSClient({
      url: API_URL,
      token: TOKEN,
      request: async () => ({ status, headers: {}, body }),
    });
  await assert.rejects(answering(502).detect(), { kind: ERROR_KINDS.UNREACHABLE });
  // LibreNMS sends the browser to /login when the path is not the API.
  await assert.rejects(answering(302).detect(), { kind: ERROR_KINDS.REDIRECT });
  await assert.rejects(answering(403, '{}').detect(), { kind: ERROR_KINDS.FORBIDDEN });
  await assert.rejects(answering(200, '<html></html>').detect(), {
    kind: ERROR_KINDS.NOT_LIBRENMS,
  });
  await assert.rejects(answering(500, JSON.stringify(FIXTURE.ack_read_only_role)).detect(), {
    kind: ERROR_KINDS.HTTP,
    status: 500,
  });
});

test('acknowledge: PUT alerts/<id> with a note, false when the alert is gone', async () => {
  const librenms = new FakeLibreNMS();
  const id = librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Disk' });
  const client = clientFor(librenms);
  assert.equal(await client.acknowledge(String(id), 'Seen'), true);
  assert.equal(librenms.alerts[0].state, 2);
  const call = librenms.calls.at(-1);
  assert.equal(call.method, 'PUT');
  assert.deepEqual(JSON.parse(call.body), { note: 'Seen', until_clear: false });
  assert.equal(await client.acknowledge('999', 'Seen'), false);
});
