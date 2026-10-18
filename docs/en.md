# LibreNMS

Bring your [LibreNMS](https://www.librenms.org/) network monitoring into
Gladys: each device LibreNMS monitors becomes a Gladys device (online, uptime,
active alerts, health sensors), the ports you choose get their own device
(online, inbound and outbound rate), a "LibreNMS" device counts the devices
down and the alerts, and your scenes react when a device or a port goes down,
comes back, or when an alert is raised or cleared. A scene can also
acknowledge the alerts of a device, and a dashboard widget shows what is
wrong.

The integration reads the LibreNMS API on your local network, with an API
token. Nothing goes through a cloud.

Tested against a real LibreNMS 26.9.1 (official Docker image), with an SNMP
agent stopped and started again: device down and back, alert raised,
acknowledged and cleared. Health sensors of real hardware and the link of a
real switch port going down were checked only through the shape of the API
answers. Feedback welcome:
[github.com/guim31/gladys-librenms/issues](https://github.com/guim31/gladys-librenms/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- LibreNMS with its API (any recent version), reachable from the Gladys
  machine (the address of its web interface).
- A LibreNMS user for Gladys. The **global-read** role is enough to read; the
  acknowledgement scene action needs a role that may update alerts (admin).

## Getting started

### 1. Create an API token

In LibreNMS, open the cog menu → **API → API Settings**, click **Create API
access token**, choose the user, add a description and copy the token.

### 2. Configure the integration

In Gladys, open the configuration of the integration:

- **LibreNMS address**: the address you open LibreNMS with, e.g.
  `http://192.168.1.2:8000` or `https://librenms.example.com`. A page copied
  from the browser (`…/devices`) works too.
- **API token**: the token of step 1.
- **Device groups (optional)**: names of LibreNMS device groups, separated by
  commas. Empty: every device neither disabled nor ignored.
- **Ports to follow (optional)**: `device:port` pairs separated by commas, the
  device by its host name (or system name, or display name), the port by its
  name in LibreNMS, e.g. `switch:ge-0/0/1, nas:eth0`. `device:*` follows every
  port of the device that is administratively up. 20 ports at most.
- **Refresh interval**: 30 seconds to 5 minutes (1 minute by default).
- **Allow acknowledging from scenes**: untick to turn the acknowledgement
  action off.
- **Accept self-signed certificates**: for an `https://` address whose
  certificate your browser does not trust either.
- **Language of the names**: language of the feature names and of the scene
  results.

Save, then click **Test the connection**: it shows the LibreNMS version, the
number of devices, of devices down, of active alerts, and the followed ports
that were not found.

### 3. Add the devices

Open the **Discover** tab of the integration and add the devices and ports to
follow, and the "LibreNMS" device for the totals. The scene triggers work for
every device, added to Gladys or not.

## The devices

Each **device** of LibreNMS:

| Feature        | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| Online         | 1 up, 0 down, as LibreNMS sees it (ping, SNMP)                              |
| Uptime         | in days (SNMP devices only)                                                 |
| Active alerts  | number of active alerts, acknowledged ones included                         |
| Health sensors | up to 10: temperatures, fans (rpm), load, power, voltage, current, humidity |

The health sensors are the ones LibreNMS discovered on the device, named as in
LibreNMS; temperatures first.

Each **followed port**:

- Online: 1 when the link is up
- Inbound rate, in Mbit/s
- Outbound rate, in Mbit/s

The **LibreNMS** device:

- Devices down
- Active alerts
- Critical alerts

Values are sent to Gladys only when they change, and every 6 hours otherwise.
While a device is down, its uptime and its ports keep their last values and
its badge shows it unreachable.

## Dashboard

The **LibreNMS overview** widget shows three tiles — the devices down, the
active alerts, the ones not acknowledged yet — and a list: the devices down
first, then the alerts, the most severe first (rule, device, ✓ once
acknowledged). Ten rows at most. **Refresh** reads LibreNMS again. In its
settings, choose devices to show only theirs (empty: every device).

## Scenes

### Triggers

- **A device goes down**: LibreNMS sees a device down. Filter: devices (empty:
  any). Variables: device name, host name, reason (`icmp`, `snmp`).
- **A device is back**: a device seen down is up again, with the duration in
  minutes.
- **An alert is raised**: a LibreNMS alert rule matches a device. Filters:
  devices, severities (Warning, Critical, OK). Variables: device name, alert
  rule, severity (in words and as a key), rule id, alert id.
- **An alert is cleared**: an alert is over, with the same filters and
  variables, plus its duration in minutes.
- **A followed port goes down**: a followed port loses its link (not when the
  administrator shuts it, nor while its device is down). Variables: device
  name, port, port description, status. Filter on the port devices.
- **A followed port is back**: the link is up again, with the duration in
  minutes.
- **LibreNMS no longer answers**: the API fails to answer twice in a row
  (variables: LibreNMS address, error).

What is already there when the integration starts is not announced. A change
that happens while Gladys or the integration restarts is announced once at the
next read. Acknowledging an alert neither clears nor raises it again.

### Actions

- **Acknowledge the alerts of a device**: acknowledges the active alerts of
  the device in LibreNMS, with a note in their history (empty: "Acknowledged
  from Gladys"). LibreNMS notifies again if an alert gets worse. Returns the
  number acknowledged. Turn it off with "Allow acknowledging from scenes".
- **Read the network status**: counts and lists the devices down and the
  active alerts, of one device or of all, for the next actions: devices down
  (number and names), alerts, not acknowledged, critical, highest severity,
  and the list "device: rule".

### Scene ideas

- **The router is down**: trigger "A device goes down" on the router → turn
  the hallway lamp red and send `{{triggerEvent.data.name}} is down`.
- **Critical alerts only**: trigger "An alert is raised", severity Critical →
  message `{{triggerEvent.data.name}}: {{triggerEvent.data.rule}}`.
- **The uplink of the switch**: follow `switch:ge-0/0/1`, trigger "A followed
  port goes down" → message, and "A followed port is back" → "Back after
  {{triggerEvent.data.duration_minutes}} min".
- **Seen from the couch**: a dashboard button runs "Acknowledge the alerts of
  a device" on the NAS.

## Troubleshooting

- **"API token refused"**: check the token in API Settings (not disabled) and
  that its user still exists.
- **"LibreNMS does not answer"**: check the address from the Gladys machine.
  `localhost` is the integration container itself: use the IP address of the
  LibreNMS machine.
- **"No LibreNMS API at this address"** or **"the address redirects"**: the
  address does not lead to LibreNMS; `/api/v0` must answer at its root (or
  under its sub-path).
- **"Certificate refused"**: tick "Accept self-signed certificates", or use
  the `http://` address on the local network.
- **"No device group with these names"**: the names must match LibreNMS.
- **A device is missing**: it is disabled or ignored in LibreNMS, outside the
  device groups, or the user of the token cannot see it.
- **A port is not found**: "Test the connection" lists the pairs it could not
  match; use the port name LibreNMS shows (ifName).
- **The acknowledgement is refused**: the user of the token needs a role that
  may update alerts (admin). A global-read user gets an error.
- **A value lags behind**: LibreNMS polls its devices every 5 minutes; a
  shorter refresh interval only catches changes sooner.

## Limits

- One LibreNMS server per integration.
- No processor and memory usage: the API gives them device by device, which
  would multiply the requests; the "load" sensors are kept when LibreNMS has
  them.
- At most 10 health sensors per device, 20 followed ports, 30 scene events per
  read (an outage can bring dozens of devices down at once; the rest follows
  at the next reads).
- Fan speeds have no unit in Gladys: "(rpm)" ends their name.
- No quota on the LibreNMS API: each read sends four or five requests (one
  more per device group), whatever the number of devices.

Not affiliated with LibreNMS.
