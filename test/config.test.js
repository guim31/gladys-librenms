import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseApiUrl, parsePorts } from '../src/config.js';

test('the address: a bare host, a page of the web interface, the API itself', () => {
  assert.equal(parseApiUrl('192.0.2.5:8000'), 'http://192.0.2.5:8000/api/v0');
  assert.equal(parseApiUrl(' https://lnms.example.com/ '), 'https://lnms.example.com/api/v0');
  assert.equal(parseApiUrl('http://192.0.2.5/devices/'), 'http://192.0.2.5/api/v0');
  assert.equal(parseApiUrl('http://192.0.2.5/device/device=1/'), 'http://192.0.2.5/api/v0');
  assert.equal(
    parseApiUrl('http://192.0.2.5/librenms/overview'),
    'http://192.0.2.5/librenms/api/v0',
  );
  assert.equal(parseApiUrl('http://192.0.2.5/api/v0/'), 'http://192.0.2.5/api/v0');
  assert.equal(parseApiUrl('http://192.0.2.5/index.php'), 'http://192.0.2.5/api/v0');
});

test('an unusable address is refused, credentials in it too', () => {
  for (const raw of ['', '   ', 'ftp://192.0.2.5', 'http://', 'http://user:pw@192.0.2.5', 42]) {
    assert.equal(parseApiUrl(raw), null, String(raw));
  }
  assert.equal(normalizeConfig({ librenms_url: 'ftp://x' }).invalidUrl, true);
  assert.equal(normalizeConfig({}).invalidUrl, false);
});

test('ports: device:port pairs, the last colon splits, duplicates dropped', () => {
  assert.deepEqual(
    parsePorts('switch:ge-0/0/1, nas:*;SWITCH:GE-0/0/1\n2001:db8::1:eth0, bad, :x, y:'),
    [
      { device: 'switch', port: 'ge-0/0/1' },
      { device: 'nas', port: '*' },
      { device: '2001:db8::1', port: 'eth0' },
    ],
  );
});

test('normalizeConfig: defaults, a trimmed token, unknown choices replaced', () => {
  const config = normalizeConfig({
    librenms_url: '192.0.2.5',
    api_token: ' 1|abc \n',
    device_groups: 'Homelab, Switches,,',
    poll_interval: '7',
    language: 'it',
    allow_acknowledge: 'false',
    allow_self_signed: 'true',
  });
  assert.equal(config.apiToken, '1|abc');
  assert.deepEqual(config.deviceGroups, ['Homelab', 'Switches']);
  assert.equal(config.pollIntervalMs, Number(DEFAULT_CONFIG.poll_interval) * 1000);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowAcknowledge, false);
  assert.equal(config.allowSelfSigned, true);
  assert.equal(normalizeConfig().allowAcknowledge, true);
});
