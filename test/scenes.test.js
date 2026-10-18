// Scene actions: acknowledging the alerts of a device (and its refusals),
// reading the network status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CONFIG, createWorld, equipmentDevice } from './helpers/world.js';

async function world(t, options) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

test('acknowledge the alerts of a device: in LibreNMS, with the note, then read again', async (t) => {
  const w = await world(t);
  w.librenms.setDown(1);
  w.librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Disk 90%' });
  w.librenms.raise(2, { rule_id: 3, severity: 'warning', name: 'Disk 90%' });
  w.clock.advance(60_000); // the last read is stale: the action reads again
  const ack = await w.fake.sceneAction('acknowledge_alerts', {
    device: equipmentDevice(w.gladys, '1'),
    note: 'On it',
  });
  assert.deepEqual(ack.data.outputs, { acknowledged: 2 });
  assert.deepEqual(
    w.librenms.alerts.map((alert) => [alert.device_id, alert.state]),
    [
      [1, 2],
      [1, 2],
      [2, 1],
    ],
  );
  assert.equal(w.librenms.alerts[0].note, 'On it');
  assert.ok(
    w.hub.data.alerts.filter((alert) => alert.deviceId === '1').every((a) => a.acknowledged),
  );
  // Nothing left to acknowledge: no request.
  const before = w.librenms.calls.filter((call) => call.method === 'PUT').length;
  const again = await w.fake.sceneAction('acknowledge_alerts', {
    device: equipmentDevice(w.gladys, '1'),
  });
  assert.deepEqual(again.data.outputs, { acknowledged: 0 });
  assert.equal(w.librenms.calls.filter((call) => call.method === 'PUT').length, before);
});

test('acknowledging: turned off, an unknown device, a read-only role', async (t) => {
  const off = await world(t, { config: { ...BASE_CONFIG, allow_acknowledge: false } });
  const refused = await off.fake.sceneAction('acknowledge_alerts', {
    device: equipmentDevice(off.gladys, '1'),
  });
  assert.equal(refused.success, false);
  assert.match(refused.error, /turned off/);

  const w = await world(t);
  const unknown = await w.fake.sceneAction('acknowledge_alerts', { device: 'ext:other:device:1' });
  assert.match(unknown.error, /not a LibreNMS device/);
  w.librenms.setDown(1);
  w.librenms.readOnly = true;
  w.clock.advance(60_000);
  const readOnly = await w.fake.sceneAction('acknowledge_alerts', {
    device: equipmentDevice(w.gladys, '1'),
  });
  assert.match(readOnly.error, /needs a role that may update alerts/);
});

test('read the network status, of every device or of one', async (t) => {
  const w = await world(t);
  w.librenms.setDown(2);
  w.librenms.raise(1, { rule_id: 3, severity: 'warning', name: 'Disk 90%' });
  w.clock.advance(60_000);
  const all = await w.fake.sceneAction('get_status', {});
  assert.deepEqual(all.data.outputs, {
    devices_down: 1,
    down_names: 'printer.home.arpa',
    alerts: 2,
    unacknowledged: 2,
    critical: 1,
    highest_severity: 'Critical',
    alert_names:
      'printer.home.arpa: Device Down! Due to no ICMP response., nas.home.arpa: Disk 90%',
  });
  const nas = await w.fake.sceneAction('get_status', { device: equipmentDevice(w.gladys, '1') });
  assert.equal(nas.data.outputs.devices_down, 0);
  assert.equal(nas.data.outputs.highest_severity, 'Warning');
  w.librenms.alerts = [];
  w.clock.advance(60_000);
  const clear = await w.fake.sceneAction('get_status', { device: equipmentDevice(w.gladys, '1') });
  assert.equal(clear.data.outputs.highest_severity, 'No alert');
});

test('LibreNMS silent: the actions fail with a clear message', async (t) => {
  const w = await world(t);
  w.librenms.failWith = Object.assign(new Error('x'), { code: 'EHOSTUNREACH' });
  w.clock.advance(60_000);
  const ack = await w.fake.sceneAction('get_status', {});
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'LibreNMS does not answer');
});
