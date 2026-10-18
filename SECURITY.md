# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the LibreNMS API token is a `secret` field of the Gladys
  configuration. The integration reads it from Gladys at startup, keeps it in
  memory, sends it only to the LibreNMS address of the configuration (the
  `X-Auth-Token` header), and never writes it to `/data` nor to the logs. A
  token has the rights of its LibreNMS user: the global-read role is enough,
  the acknowledgement scene action (which can be turned off) needs a role
  that may update alerts.
- **SNMP credentials**: the LibreNMS device list carries the SNMP community
  and credentials of every device. The client keeps only the fields it uses
  (id, names, status, uptime, hardware): they never reach Gladys, `/data` nor
  the logs.
- **Stored in `/data`**: `librenms-state.json`, what was already announced
  (alert ids with their device, rule and severity; device and port up/down
  states with their time), so that a restart neither repeats nor misses a
  scene event. No secret; the scope key holds a hash of the token, not the
  token.
- **Network**: requests go only to the LibreNMS address typed in the
  configuration, in HTTP or HTTPS. HTTPS certificates are verified unless the
  user ticks "Accept self-signed certificates"; the integration opens no port
  and calls no cloud service.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
LibreNMS itself, and the devices it monitors.
