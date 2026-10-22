# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.0.0] - 2026-10-18

### Added

- LibreNMS devices in Gladys, from the Discover tab: online, uptime, active
  alerts and up to 10 health sensors (temperatures, fans, load, power,
  voltage, current, humidity) per device; a "LibreNMS" device with the devices
  down, the active alerts and the critical ones.
- Followed ports (`device:port` in the configuration): online, inbound and
  outbound rate in Mbit/s.
- A filter on LibreNMS device groups.
- Scene triggers: a device goes down / is back, an alert is raised / cleared
  (filters on devices and severities), a followed port goes down / is back,
  LibreNMS no longer answers. Kept across restarts: nothing missed, nothing
  repeated.
- Scene actions: acknowledge the alerts of a device (can be turned off), read
  the network status (devices down, alerts, names) for a message.
- Dashboard widget "LibreNMS overview": devices down, alerts, not
  acknowledged, and the list of what is wrong.
- "Test the connection" action, documentation in English, French, German and
  Spanish.

[Unreleased]: https://github.com/guim31/gladys-librenms/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-librenms/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-librenms/releases/tag/v1.0.0
