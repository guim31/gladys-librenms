// The `overview` widget: within the core budget, devices down then alerts,
// the chosen devices only, the Refresh button.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createDevices, createWorld, equipmentDevice } from './helpers/world.js';

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet('overview', { settings, language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

const budget = (widget) => {
  assert.doesNotThrow(() => validateWidgetContent(widget));
  assert.ok(widget.components.length <= 8);
  assert.ok(widget.components.filter((component) => component.type === 'text').length <= 2);
};

test('all fine: three tiles, one row, the Refresh button', async (t) => {
  const w = await createWorld();
  t.after(() => w.app.stop());
  const widget = await content(w);
  budget(widget);
  assert.deepEqual(
    widget.components.map((component) => component.type),
    ['value', 'value', 'value', 'status', 'button'],
  );
  assert.deepEqual(widget.components[3].items[0], {
    label: 'All fine',
    value: '2 devices',
    icon: 'check-circle',
    color: 'success',
  });
});

test('devices down first, then the alerts, the most severe first; capped at ten rows', async (t) => {
  const w = await createWorld();
  t.after(() => w.app.stop());
  w.librenms.setDown(2);
  for (let rule = 10; rule < 25; rule += 1) {
    w.librenms.raise(1, { rule_id: rule, severity: 'warning', name: `Rule ${rule}` });
  }
  w.librenms.alerts[0].state = 2;
  await w.hub.pollAll();
  const widget = await content(w, {}, 'fr');
  budget(widget);
  assert.deepEqual(
    widget.components.slice(0, 3).map((tile) => tile.value),
    [1, 16, 15],
  );
  const rows = widget.components[3].items;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], {
    label: 'printer.home.arpa',
    value: 'hors ligne (icmp,snmp)',
    icon: 'x-circle',
    color: 'danger',
  });
  assert.equal(rows[1].icon, 'alert-octagon', 'the critical alert next');
  assert.equal(rows.at(-1).value, '+8');
});

test('the chosen devices only; the refresh reads LibreNMS again', async (t) => {
  const w = await createWorld();
  t.after(() => w.app.stop());
  await createDevices(w);
  w.librenms.setDown(2);
  await w.hub.pollAll();
  const widget = await content(w, { devices: [equipmentDevice(w.gladys, '1')] });
  assert.equal(widget.components[0].value, 0);
  const reads = w.librenms.calls.length;
  const ack = await w.fake.widgetAction('overview', 'refresh', {});
  assert.equal(ack.success, true);
  assert.ok(w.librenms.calls.length > reads);
});

test('not configured, or LibreNMS silent: a text', async (t) => {
  const empty = await createWorld({ config: {} });
  t.after(() => empty.app.stop());
  assert.match((await content(empty)).components[0].text, /Enter the address/);
  const w = await createWorld();
  t.after(() => w.app.stop());
  w.librenms.failWith = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
  await w.hub.pollAll();
  const widget = await content(w);
  budget(widget);
  assert.ok(
    widget.components.some(
      (component) => component.text === '192.0.2.10:8000: LibreNMS does not answer',
    ),
  );
});
