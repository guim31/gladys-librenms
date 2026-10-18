// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One LibreNMS server. The address typed by the user is the one of its web
// interface, often copied from the browser (`http://192.0.2.5/devices`): the
// API is always `/api/v0` at the root of that site, or of its sub-path.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds. LibreNMS
// itself polls the equipment every 5 minutes; device status (ping) can be
// faster when its fast ping is on.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  librenms_url: '',
  api_token: '',
  device_groups: '',
  ports: '',
  poll_interval: '60',
  allow_acknowledge: true,
  allow_self_signed: false,
  language: 'fr',
};

// Ports followed, at most: one Gladys device each.
export const MAX_PORTS = 20;

const API_PATH = '/api/v0';

// Pages of the web interface found at the root of a LibreNMS site. Their
// arguments hold an `=` (`/device/device=1/tab=ports/`): a page segment is cut
// only when everything after it is such arguments, so an installation under
// `/apps/librenms` keeps its sub-path.
const UI_PAGES = new Set(
  'devices device ports port alerts alert alert-rules health overview dashboard eventlog settings login apps maps graphs search bills wireless inventory outages poller syslog graylog device-groups port-groups users about'.split(
    ' ',
  ),
);

function stripPage(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const api = segments.findIndex(
    (segment, index) => segment.toLowerCase() === 'api' && segments[index + 1] === 'v0',
  );
  if (api >= 0) {
    return segments.slice(0, api);
  }
  for (let index = 0; index < segments.length; index += 1) {
    if (
      UI_PAGES.has(segments[index].toLowerCase()) &&
      segments.slice(index + 1).every((segment) => segment.includes('='))
    ) {
      return segments.slice(0, index);
    }
  }
  return segments;
}

/**
 * Parse the address typed by the user into the base URL of the API: a bare
 * host (`192.0.2.5:8000`), a page of the web interface
 * (`https://librenms.example.com/devices/`), or the API URL itself. HTTP by
 * default.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]/api/v0`, null when unusable
 */
export function parseApiUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  const segments = stripPage(url.pathname.replace(/\/index\.php$/i, ''));
  const path = segments.length ? `/${segments.join('/')}` : '';
  return `${url.origin}${path}${API_PATH}`;
}

/** The address shown to the user: host and path, without scheme nor API path. */
export const hostOf = (apiUrl) =>
  apiUrl.replace(/^https?:\/\//, '').replace(new RegExp(`${API_PATH}$`), '');

/** A comma (or new line) separated list, trimmed, without blanks nor duplicates. */
export function parseList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[\n,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The ports to follow: `equipment:port` entries, the equipment by host name,
 * system name or display name, the port by ifName (`switch:ge-0/0/1`), `*` for
 * every port of the equipment that is administratively up. The last colon
 * splits (an IPv6 equipment address holds colons).
 * @returns {Array<{ device: string, port: string }>}
 */
export function parsePorts(raw) {
  const seen = new Set();
  const ports = [];
  for (const entry of parseList(raw)) {
    const at = entry.lastIndexOf(':');
    if (at <= 0 || at === entry.length - 1) {
      continue;
    }
    const device = entry.slice(0, at).trim();
    const port = entry.slice(at + 1).trim();
    const key = `${device.toLowerCase()}:${port.toLowerCase()}`;
    if (device && port && !seen.has(key)) {
      seen.add(key);
      ports.push({ device, port });
    }
  }
  return ports;
}

const isTrue = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const typed = text('librenms_url');
  const apiUrl = parseApiUrl(typed);
  return {
    apiUrl,
    invalidUrl: Boolean(typed) && !apiUrl,
    // A pasted token often carries a trailing space or new line.
    apiToken: text('api_token'),
    deviceGroups: parseList(source.device_groups),
    ports: parsePorts(source.ports),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    allowAcknowledge:
      source.allow_acknowledge === undefined || source.allow_acknowledge === null
        ? DEFAULT_CONFIG.allow_acknowledge
        : isTrue(source.allow_acknowledge),
    allowSelfSigned: isTrue(source.allow_self_signed),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
