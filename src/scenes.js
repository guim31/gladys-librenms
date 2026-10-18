// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this equipment down?" or "does it have alerts?" are already scene
// conditions on the device features. These two actions do what a condition
// cannot:
//   - acknowledge the alerts of an equipment from a scene (a dashboard
//     button, a "seen" reply), with a note in their LibreNMS history — can be
//     turned off in the configuration;
//   - put the situation in words for a message ("Switch: Port status
//     up/down, …"), across every equipment, added to Gladys or not.
// Both read LibreNMS again when the last read is older than 15 seconds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS, SEVERITIES } from './librenms/client.js';
import { ACTION_TEXT, ERROR_TEXT, pick, severityName } from './texts.js';

const logger = createLogger({ name: 'librenms-scenes' });

// Entries listed in the `names` outputs, at most (the rest is counted).
export const MAX_LISTED = 20;
export const MAX_NOTE_LENGTH = 1000;

function assertReadable(hub) {
  const language = hub.config?.language;
  if (!hub.client) {
    throw new Error(pick(ACTION_TEXT.noServer, language));
  }
  if (hub.error || !hub.data) {
    throw new Error(pick(ERROR_TEXT[hub.error?.kind ?? ERROR_KINDS.UNREACHABLE], language));
  }
}

const listed = (labels) =>
  labels.length > MAX_LISTED
    ? `${labels.slice(0, MAX_LISTED).join(', ')}, +${labels.length - MAX_LISTED}`
    : labels.join(', ');

export const SCENE_ACTIONS = {
  async acknowledge_alerts(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.client) {
      throw new Error(pick(ACTION_TEXT.noServer, language));
    }
    if (!hub.config.allowAcknowledge) {
      throw new Error(pick(ACTION_TEXT.acknowledgeDisabled, language));
    }
    await hub.refreshIfStale();
    assertReadable(hub);
    const device = hub.findDevice(fields.device);
    if (!device) {
      throw new Error(pick(ACTION_TEXT.unknownDevice, language));
    }
    const pending = hub.alertsOf(device.id).filter((alert) => !alert.acknowledged);
    if (pending.length === 0) {
      return { acknowledged: 0 };
    }
    const typed = typeof fields.note === 'string' ? fields.note.trim() : '';
    const note = (typed || pick(ACTION_TEXT.defaultNote, language)).slice(0, MAX_NOTE_LENGTH);
    let acknowledged = 0;
    try {
      for (const alert of pending) {
        if (await hub.client.acknowledge(alert.id, note)) {
          acknowledged += 1;
        }
      }
    } catch (err) {
      logger.warn(
        `Acknowledging the alerts of ${device.name} failed after ${acknowledged}: ${err.message}`,
      );
      await hub.pollAll({ fresh: true }); // show the ones acknowledged before the failure
      // A read-only role gets a 403, or a bare HTTP 500 (LibreNMS 26.9.1).
      if (err.kind === ERROR_KINDS.FORBIDDEN || err.status === 500) {
        throw new Error(pick(ACTION_TEXT.acknowledgeRefused, language), { cause: err });
      }
      throw new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, language), { cause: err });
    }
    logger.info(`${acknowledged} alert(s) of ${device.name} acknowledged`);
    await hub.pollAll({ fresh: true });
    return { acknowledged };
  },

  async get_status(hub, { fields = {} }) {
    const language = hub.config?.language;
    await hub.refreshIfStale();
    assertReadable(hub);
    let devices = [...hub.data.devices.values()];
    let alerts = hub.data.alerts;
    if (fields.device) {
      const device = hub.findDevice(fields.device);
      if (!device) {
        throw new Error(pick(ACTION_TEXT.unknownDevice, language));
      }
      devices = [device];
      alerts = hub.alertsOf(device.id);
    }
    const down = devices.filter((device) => !device.up).map((device) => device.name);
    const highest = alerts.reduce(
      (worst, alert) => Math.max(worst, SEVERITIES.indexOf(alert.severity)),
      -1,
    );
    return {
      devices_down: down.length,
      down_names: listed(down.sort((a, b) => a.localeCompare(b))),
      alerts: alerts.length,
      unacknowledged: alerts.filter((alert) => !alert.acknowledged).length,
      critical: alerts.filter((alert) => alert.severity === 'critical').length,
      highest_severity: severityName(SEVERITIES[highest], language),
      alert_names: listed(hub.sortedAlerts(alerts).map((alert) => hub.alertLabel(alert, language))),
    };
  },
};
