# LibreNMS for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for
[LibreNMS](https://www.librenms.org/), the open-source network monitoring
system: your monitored devices, their alerts and the ports you choose become
Gladys devices, and your scenes react when a device or a port goes down,
comes back, or when an alert is raised or cleared. Local only: the integration
reads the LibreNMS API on your network, nothing goes through a cloud.

## Features

- **One device per LibreNMS device** (every device neither disabled nor
  ignored, or the device groups you choose): online, uptime, active alerts,
  and up to 10 health sensors (temperatures, fans, load, power, voltage,
  current, humidity).
- **Followed ports** (`switch:ge-0/0/1`, `nas:*`): online, inbound and
  outbound rate in Mbit/s.
- **A "LibreNMS" device**: the devices down, the active alerts, the critical
  ones.
- **Scene triggers**: a device goes down / is back, an alert is raised /
  cleared (filters: devices, severities), a followed port goes down / is
  back, LibreNMS no longer answers.
- **Scene actions**: acknowledge the alerts of a device (with a note, can be
  turned off), read the network status (devices down, alerts, names).
- **Widget**: the devices down and the active alerts, the most severe first.
- Feature names, messages and documentation in English, French, German and
  Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- LibreNMS with its API, reachable from the Gladys machine, and an API token
  (cog menu → API → API Settings). The global-read role is enough to read;
  acknowledging needs a role that may update alerts (admin).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-librenms` (or
   install **LibreNMS** from the catalog once it is listed).
2. In **Configuration**, enter the address of LibreNMS
   (`http://192.168.1.2:8000`, `https://librenms.example.com`…) and the API
   token. Save, then click **Test the connection**.
3. Open the **Discover** tab and add the devices and ports to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

The container reads LibreNMS on its own timer (30 seconds to 5 minutes, 1
minute by default) with four or five requests, whatever the number of devices:
the device list, the active alerts, the health sensors and, when ports are
followed, the port list. States are published only when they change (and every
6 hours otherwise); what was already announced is kept in `/data`, so a
restart neither repeats nor misses a scene event. LibreNMS itself polls its
devices every 5 minutes: a shorter interval only sees its changes sooner.

## Checked on a real LibreNMS

LibreNMS 26.9.1 (official Docker image, MariaDB, Redis), with an SNMP agent
and a ping-only device: discovery, states, the agent stopped then started
again (device down, alert raised, acknowledged from the scene action, device
back, alert cleared), a global-read token refused when acknowledging, the
Docker image under the Gladys sandbox constraints. Not checked on real
hardware: health sensors of a real device (inserted in the database for the
test) and the link of a real switch port going down. Feedback welcome in the
[issues](https://github.com/guim31/gladys-librenms/issues).

## Limitations

- One LibreNMS server per integration.
- No processor nor memory usage (the API gives them device by device).
- At most 10 health sensors per device, 20 followed ports, 30 scene events
  per read.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the fake Gladys of the SDK and an in-memory LibreNMS
(`test/helpers/fakeLibreNMS.js`) seeded with real answers. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- Started from the official
  [integration template](https://github.com/GladysAssistant/integration-template-js)
  and the [integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
  of Gladys Assistant (Apache-2.0).
- Built on the [LibreNMS API documentation](https://docs.librenms.org/API/);
  no LibreNMS code (GPL-3.0) is copied, the integration only calls its API.
  There is no Home Assistant LibreNMS integration to start from.
- Architecture shared with
  [gladys-zabbix](https://github.com/guim31/gladys-zabbix).
- Cover: the official LibreNMS logo (`html/images/librenms_logo_dark.svg` of
  the [LibreNMS repository](https://github.com/librenms/librenms), GPL-3.0).

## Disclaimer

Not affiliated with the LibreNMS project.

## License

[Apache-2.0](LICENSE)
