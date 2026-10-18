// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per LibreNMS equipment (the device groups of the
//     configuration, or every active equipment), identity = the LibreNMS
//     device id;
//       online       input/binary, 1 up, 0 down (as LibreNMS sees it)
//       uptime       duration/decimal in days (SNMP equipment only)
//       alerts       counter-sensor/integer, active alerts (acknowledged included)
//       sensor_<id>  up to MAX_SENSORS health sensors (temperature, fans,
//                    load, power, voltage, current, humidity), named after
//                    the LibreNMS sensor;
//   - one device per followed port (configuration `ports`), identity = the
//     LibreNMS port id: online, inbound and outbound rate in Mbit/s;
//   - one "LibreNMS" device: equipment down, active alerts, critical alerts,
//     over the same equipment.
//
// Published with should_poll: false: the integration reads LibreNMS on its
// own timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { SENSOR_CLASSES } from './librenms/client.js';

export const EQUIPMENT_TYPE = 'device';
export const PORT_TYPE = 'port';
export const SERVER_TYPE = 'server';
export const SERVER_ID = 'main';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  ONLINE: 'online',
  UPTIME: 'uptime',
  ALERTS: 'alerts',
  CRITICAL: 'critical_alerts',
  DOWN: 'devices_down',
  IN_RATE: 'in_rate',
  OUT_RATE: 'out_rate',
});
export const sensorKey = (sensorId) => `sensor_${sensorId}`;

// Health sensors per equipment, at most: the first classes of SENSOR_CLASSES
// first (temperatures), then the LibreNMS order.
export const MAX_SENSORS = 10;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.UPTIME]: 'Uptime',
    [FEATURE_KEYS.ALERTS]: 'Active alerts',
    [FEATURE_KEYS.CRITICAL]: 'Critical alerts',
    [FEATURE_KEYS.DOWN]: 'Devices down',
    [FEATURE_KEYS.IN_RATE]: 'Inbound rate',
    [FEATURE_KEYS.OUT_RATE]: 'Outbound rate',
  },
  fr: {
    [FEATURE_KEYS.ONLINE]: 'En ligne',
    [FEATURE_KEYS.UPTIME]: 'Temps de fonctionnement',
    [FEATURE_KEYS.ALERTS]: 'Alertes actives',
    [FEATURE_KEYS.CRITICAL]: 'Alertes critiques',
    [FEATURE_KEYS.DOWN]: 'Équipements hors ligne',
    [FEATURE_KEYS.IN_RATE]: 'Débit entrant',
    [FEATURE_KEYS.OUT_RATE]: 'Débit sortant',
  },
  de: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.UPTIME]: 'Betriebszeit',
    [FEATURE_KEYS.ALERTS]: 'Aktive Alarme',
    [FEATURE_KEYS.CRITICAL]: 'Kritische Alarme',
    [FEATURE_KEYS.DOWN]: 'Geräte offline',
    [FEATURE_KEYS.IN_RATE]: 'Eingehende Rate',
    [FEATURE_KEYS.OUT_RATE]: 'Ausgehende Rate',
  },
  es: {
    [FEATURE_KEYS.ONLINE]: 'En línea',
    [FEATURE_KEYS.UPTIME]: 'Tiempo en funcionamiento',
    [FEATURE_KEYS.ALERTS]: 'Alertas activas',
    [FEATURE_KEYS.CRITICAL]: 'Alertas críticas',
    [FEATURE_KEYS.DOWN]: 'Equipos fuera de línea',
    [FEATURE_KEYS.IN_RATE]: 'Velocidad de entrada',
    [FEATURE_KEYS.OUT_RATE]: 'Velocidad de salida',
  },
};

// Suffix of a fan sensor name: Gladys has no RPM unit.
export const RPM = ' (rpm)';

export const SERVER_NAME = 'LibreNMS';

// Display bounds (the core never applies them on write).
export const MAX_COUNT = 100_000;
const MAX_UPTIME_DAYS = 36_500;
const MAX_RATE_MBPS = 1_000_000;
const SENSOR_BOUND = 1e9;

export const MODEL_EQUIPMENT = 'LibreNMS device';
export const MODEL_PORT = 'LibreNMS port';
export const MODEL_SERVER = 'LibreNMS server';
export const PARAMS = Object.freeze({ HOSTNAME: 'LIBRENMS_HOSTNAME', PORT: 'LIBRENMS_PORT' });

export const equipmentIds = (gladys, deviceId) => gladys.externalIds(EQUIPMENT_TYPE, deviceId);
export const portIds = (gladys, portId) => gladys.externalIds(PORT_TYPE, portId);
export const serverIds = (gladys) => gladys.externalIds(SERVER_TYPE, SERVER_ID);

/** The LibreNMS id behind a device external id of the given type, null otherwise. */
function parseId(gladys, type, externalId) {
  const prefix = gladys.externalIds(type, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const rest = externalId.slice(prefix.length);
  return /^\d+$/.test(rest) ? rest : null;
}
export const parseEquipmentId = (gladys, externalId) => parseId(gladys, EQUIPMENT_TYPE, externalId);
export const parsePortId = (gladys, externalId) => parseId(gladys, PORT_TYPE, externalId);

const readOnly = { read_only: true, has_feedback: false, keep_history: true };

function counter(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    ...readOnly,
    min: 0,
    max: MAX_COUNT,
  };
}

function binary(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.INPUT,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    ...readOnly,
    min: 0,
    max: 1,
  };
}

function rate(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.DATARATE,
    type: DEVICE_FEATURE_TYPES.DATARATE.RATE,
    unit: DEVICE_FEATURE_UNITS.MEGABITS_PER_SECOND,
    ...readOnly,
    min: 0,
    max: MAX_RATE_MBPS,
  };
}

// Category, type, unit and bounds per LibreNMS sensor class.
const SENSOR_FEATURES = {
  temperature: {
    category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: -100,
    max: 200,
  },
  humidity: {
    category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
  },
  load: {
    category: DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR,
    type: DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
  },
  power: {
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
    unit: DEVICE_FEATURE_UNITS.WATT,
    min: 0,
    max: 1_000_000,
  },
  voltage: {
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
    unit: DEVICE_FEATURE_UNITS.VOLT,
    min: -100_000,
    max: 100_000,
  },
  current: {
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
    unit: DEVICE_FEATURE_UNITS.AMPERE,
    min: -10_000,
    max: 10_000,
  },
  fanspeed: {
    category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
    type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
    min: 0,
    max: SENSOR_BOUND,
  },
};

/** The health sensors shown on an equipment, in a stable order. */
export function keptSensors(sensors) {
  return [...sensors]
    .sort(
      (a, b) =>
        SENSOR_CLASSES.indexOf(a.sensorClass) - SENSOR_CLASSES.indexOf(b.sensorClass) ||
        Number(a.id) - Number(b.id),
    )
    .slice(0, MAX_SENSORS);
}

function sensorFeature(sensor, externalId, takenNames) {
  const suffix = sensor.sensorClass === 'fanspeed' ? RPM : '';
  const base = (sensor.name || sensor.sensorClass).slice(0, 40 - suffix.length - 4);
  let name = `${base}${suffix}`;
  for (let n = 2; takenNames.has(name); n += 1) {
    name = `${base} ${n}${suffix}`; // two sensors of the same name on one equipment
  }
  takenNames.add(name);
  const { unit, ...shape } = SENSOR_FEATURES[sensor.sensorClass];
  return { name, external_id: externalId, ...shape, ...(unit ? { unit } : {}), ...readOnly };
}

/**
 * The discovery payload of an equipment.
 * @param {object} gladys SDK client
 * @param {object} device see toDevice() in src/librenms/client.js
 * @param {object[]} sensors its health sensors
 * @param {string} language feature names language
 */
export function buildEquipmentDevice(gladys, device, sensors = [], language = 'en') {
  const ids = equipmentIds(gladys, device.id);
  const names = NAMES[language] ?? NAMES.en;
  const features = [binary(names[FEATURE_KEYS.ONLINE], ids.feature(FEATURE_KEYS.ONLINE))];
  if (device.snmp) {
    features.push({
      name: names[FEATURE_KEYS.UPTIME],
      external_id: ids.feature(FEATURE_KEYS.UPTIME),
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.DAYS,
      ...readOnly,
      min: 0,
      max: MAX_UPTIME_DAYS,
    });
  }
  features.push(counter(names[FEATURE_KEYS.ALERTS], ids.feature(FEATURE_KEYS.ALERTS)));
  const takenNames = new Set(features.map((feature) => feature.name));
  for (const sensor of keptSensors(sensors)) {
    features.push(sensorFeature(sensor, ids.feature(sensorKey(sensor.id)), takenNames));
  }
  return {
    name: device.name.slice(0, 255),
    external_id: ids.device,
    model: (device.hardware || MODEL_EQUIPMENT).slice(0, 255),
    should_poll: false,
    params: [{ name: PARAMS.HOSTNAME, value: device.hostname.slice(0, 255) }],
    features,
  };
}

/** The discovery payload of a followed port. */
export function buildPortDevice(gladys, port, device, language = 'en') {
  const ids = portIds(gladys, port.id);
  const names = NAMES[language] ?? NAMES.en;
  const alias = port.alias && port.alias !== port.name ? ` (${port.alias})` : '';
  return {
    name: `${device.name} ${port.name}${alias}`.slice(0, 255),
    external_id: ids.device,
    model: MODEL_PORT,
    should_poll: false,
    params: [
      { name: PARAMS.HOSTNAME, value: device.hostname.slice(0, 255) },
      { name: PARAMS.PORT, value: port.name.slice(0, 255) },
    ],
    features: [
      binary(names[FEATURE_KEYS.ONLINE], ids.feature(FEATURE_KEYS.ONLINE)),
      rate(names[FEATURE_KEYS.IN_RATE], ids.feature(FEATURE_KEYS.IN_RATE)),
      rate(names[FEATURE_KEYS.OUT_RATE], ids.feature(FEATURE_KEYS.OUT_RATE)),
    ],
  };
}

/** The discovery payload of the "LibreNMS" device. */
export function buildServerDevice(gladys, language = 'en') {
  const ids = serverIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: SERVER_NAME,
    external_id: ids.device,
    model: MODEL_SERVER,
    should_poll: false,
    features: [
      counter(names[FEATURE_KEYS.DOWN], ids.feature(FEATURE_KEYS.DOWN)),
      counter(names[FEATURE_KEYS.ALERTS], ids.feature(FEATURE_KEYS.ALERTS)),
      counter(names[FEATURE_KEYS.CRITICAL], ids.feature(FEATURE_KEYS.CRITICAL)),
    ],
  };
}

const round = (value, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Feature values of an equipment (null: nothing to publish, the last value stands).
 * @returns {Array<{ externalId: string, value: number|null }>}
 */
export function equipmentValues(gladys, device, alerts, sensors = []) {
  const ids = equipmentIds(gladys, device.id);
  const values = [{ externalId: ids.feature(FEATURE_KEYS.ONLINE), value: device.up ? 1 : 0 }];
  if (device.snmp) {
    values.push({
      externalId: ids.feature(FEATURE_KEYS.UPTIME),
      // Down, LibreNMS keeps the last uptime: nothing new to say.
      value: device.up && device.uptime !== null ? round(device.uptime / 86_400) : null,
    });
  }
  values.push({ externalId: ids.feature(FEATURE_KEYS.ALERTS), value: alerts.length });
  for (const sensor of keptSensors(sensors)) {
    // Down, LibreNMS keeps the last reading: not sent again as fresh.
    values.push({
      externalId: ids.feature(sensorKey(sensor.id)),
      value: device.up ? round(sensor.value) : null,
    });
  }
  return values;
}

/** Feature values of a port; rates in Mbit/s (LibreNMS gives bytes per second). */
export function portValues(gladys, port, device) {
  const ids = portIds(gladys, port.id);
  // LibreNMS does not poll a down equipment: its ports keep their last values.
  const known = device?.up !== false;
  const mbps = (octets) => (known && octets !== null ? round((octets * 8) / 1e6, 3) : null);
  return [
    { externalId: ids.feature(FEATURE_KEYS.ONLINE), value: known ? (port.up ? 1 : 0) : null },
    { externalId: ids.feature(FEATURE_KEYS.IN_RATE), value: mbps(port.inRate) },
    { externalId: ids.feature(FEATURE_KEYS.OUT_RATE), value: mbps(port.outRate) },
  ];
}

/** Feature values of the server device. */
export function serverValues(gladys, devices, alerts) {
  const ids = serverIds(gladys);
  return [
    {
      externalId: ids.feature(FEATURE_KEYS.DOWN),
      value: devices.filter((device) => !device.up).length,
    },
    { externalId: ids.feature(FEATURE_KEYS.ALERTS), value: alerts.length },
    {
      externalId: ids.feature(FEATURE_KEYS.CRITICAL),
      value: alerts.filter((alert) => alert.severity === 'critical').length,
    },
  ];
}
