// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake LibreNMS, a temporary
// /data and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests read LibreNMS with
// `world.hub.pollAll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { equipmentIds, portIds, serverIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { API_URL, FakeLibreNMS, TOKEN } from './fakeLibreNMS.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const BASE_CONFIG = {
  librenms_url: 'http://192.0.2.10:8000/',
  api_token: TOKEN,
  language: 'en',
};

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = 1792160000_000) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  librenms = new FakeLibreNMS(),
  config = BASE_CONFIG,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-librenms-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: (url, options) => {
      if (!url.startsWith(`${API_URL}/`)) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }
      return librenms.request(url, options);
    },
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, librenms, app, hub: app.hub, clock, dataDir };
}

export const equipmentDevice = (gladys, id) => equipmentIds(gladys, id).device;
export const equipmentFeature = (gladys, id, key) => equipmentIds(gladys, id).feature(key);
export const portFeature = (gladys, id, key) => portIds(gladys, id).feature(key);
export const serverFeature = (gladys, key) => serverIds(gladys).feature(key);

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

export { API_URL, FakeLibreNMS, TOKEN };
