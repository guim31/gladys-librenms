// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `overview`.
//
// The use case: a glance at the wall tablet tells whether the network is
// fine, and if not, what is wrong where. So the widget shows the equipment
// down, the active alerts and how many are not acknowledged yet, then one row
// per equipment down and per alert — the down equipment first, then the
// most severe alerts.
//
// Every equipment by default, or the ones chosen in the widget settings
// (devices added to Gladys). The figures are sent as values, not bound to
// device features: the widget works before any device is added.
//
// Budget (8 components, 2 texts): three tiles, one status list of ten rows at
// most, one text while LibreNMS does not answer, and a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, labelled, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  configure: {
    en: 'Enter the address of your LibreNMS and an API token in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre LibreNMS et un jeton d'API dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines LibreNMS und ein API-Token in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su LibreNMS y un token de API en la configuración de la integración.',
  },
  down: { en: 'Down', fr: 'Hors ligne', de: 'Offline', es: 'Fuera de línea' },
  alerts: { en: 'Alerts', fr: 'Alertes', de: 'Alarme', es: 'Alertas' },
  unacknowledged: {
    en: 'Not acknowledged',
    fr: 'Non acquittées',
    de: 'Unbestätigt',
    es: 'Sin reconocer',
  },
  offline: { en: 'down', fr: 'hors ligne', de: 'offline', es: 'fuera de línea' },
  allClear: { en: 'All fine', fr: 'Tout va bien', de: 'Alles in Ordnung', es: 'Todo bien' },
  devices: { en: 'devices', fr: 'équipements', de: 'Geräte', es: 'equipos' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'LibreNMS read again.',
    fr: 'LibreNMS relu.',
    de: 'LibreNMS neu gelesen.',
    es: 'LibreNMS leído de nuevo.',
  },
};

const SEVERITY_STYLE = {
  ok: { icon: 'info', color: WIDGET_COLORS.INFO },
  warning: { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  critical: { icon: 'alert-octagon', color: WIDGET_COLORS.DANGER },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const refreshButton = (language) => ({
  type: 'button',
  label: pick(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

/** The equipment the widget shows: the chosen devices, or null for every one. */
export function chosenDevices(hub, settings) {
  const chosen = [settings?.devices ?? []].flat().filter((id) => typeof id === 'string' && id);
  // Chosen equipment that left the scope shows nothing, not every one.
  return chosen.length > 0 ? new Set(chosen.map((id) => hub.findDevice(id)?.id)) : null;
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: pick(TEXT.configure, language) }],
    };
  }
  const error = hub.error
    ? {
        type: 'text',
        variant: 'body',
        text: labelled(hub.serverName(), pick(ERROR_TEXT[hub.error.kind], language), language),
      }
    : null;
  if (!hub.data) {
    return { ttl_seconds: 30, components: [error, refreshButton(language)].filter(Boolean) };
  }

  const scope = chosenDevices(hub, settings);
  const devices = [...hub.data.devices.values()].filter((device) => !scope || scope.has(device.id));
  const down = devices.filter((device) => !device.up).sort((a, b) => a.name.localeCompare(b.name));
  const alerts = hub.sortedAlerts(
    hub.data.alerts.filter((alert) => !scope || scope.has(alert.deviceId)),
  );
  const unacknowledged = alerts.filter((alert) => !alert.acknowledged).length;
  const critical = alerts.some((alert) => alert.severity === 'critical');

  const components = [
    {
      type: 'value',
      value: down.length,
      label: pick(TEXT.down, language),
      icon: 'server',
      color: down.length > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
    {
      type: 'value',
      value: alerts.length,
      label: pick(TEXT.alerts, language),
      icon: 'alert-triangle',
      color: critical
        ? WIDGET_COLORS.DANGER
        : alerts.length > 0
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.SUCCESS,
    },
    {
      type: 'value',
      value: unacknowledged,
      label: pick(TEXT.unacknowledged, language),
      icon: 'bell',
      color: unacknowledged > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (error) {
    components.push(error);
  }

  const rows = [
    ...down.map((device) => ({
      label: fit(device.name, 40),
      value: fit(
        device.reason
          ? `${pick(TEXT.offline, language)} (${device.reason})`
          : pick(TEXT.offline, language),
        40,
      ),
      icon: 'x-circle',
      color: WIDGET_COLORS.DANGER,
    })),
    ...alerts.map((alert) => ({
      label: fit(alert.rule, 40),
      // The icon and colour carry the severity; ✓: acknowledged.
      value: fit(`${hub.deviceName(alert.deviceId)}${alert.acknowledged ? ' ✓' : ''}`, 40),
      ...(SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.critical),
    })),
  ];
  let items;
  if (rows.length === 0) {
    items = [
      {
        label: pick(TEXT.allClear, language),
        value: `${devices.length} ${pick(TEXT.devices, language)}`,
        icon: 'check-circle',
        color: WIDGET_COLORS.SUCCESS,
      },
    ];
  } else {
    items = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1) : rows;
    if (rows.length > items.length) {
      items.push({
        label: pick(TEXT.more, language),
        value: `+${rows.length - items.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  components.push({ type: 'status', items });
  components.push(refreshButton(language));

  // Something wrong moves fast: refresh sooner.
  return { ttl_seconds: rows.length > 0 || error ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollAll({ fresh: true });
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
