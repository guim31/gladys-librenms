// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, severities in
// scene variables and outputs, scene action messages. Four languages, the
// four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './librenms/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the address of your LibreNMS and an API token in the configuration.',
    fr: "Saisissez l'adresse de votre LibreNMS et un jeton d'API dans la configuration.",
    de: 'Gib die Adresse deines LibreNMS und ein API-Token in der Konfiguration ein.',
    es: 'Introduzca la dirección de su LibreNMS y un token de API en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:8000',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:8000',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:8000',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:8000',
  },
};

// One short explanation per error kind (src/librenms/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'LibreNMS does not answer',
    fr: 'LibreNMS ne répond pas',
    de: 'LibreNMS antwortet nicht',
    es: 'LibreNMS no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API token refused',
    fr: "jeton d'API refusé",
    de: 'API-Token abgelehnt',
    es: 'token de API rechazado',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'the token user may not do this: give it a role that can',
    fr: "l'utilisateur du jeton n'en a pas le droit : donnez-lui un rôle qui le permet",
    de: 'der Token-Benutzer darf das nicht: Gib ihm eine passende Rolle',
    es: 'el usuario del token no tiene permiso: asígnele un rol que lo permita',
  },
  [ERROR_KINDS.TOKEN_MISSING]: {
    en: 'an API token is needed: Settings → API → API Settings in LibreNMS',
    fr: "un jeton d'API est nécessaire : Settings → API → API Settings dans LibreNMS",
    de: 'ein API-Token ist nötig: Settings → API → API Settings in LibreNMS',
    es: 'se necesita un token de API: Settings → API → API Settings en LibreNMS',
  },
  [ERROR_KINDS.NOT_LIBRENMS]: {
    en: 'no LibreNMS API at this address',
    fr: "pas d'API LibreNMS à cette adresse",
    de: 'keine LibreNMS-API unter dieser Adresse',
    es: 'no hay ninguna API de LibreNMS en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.GROUPS]: {
    en: 'no device group with these names',
    fr: "aucun groupe d'équipements de ce nom",
    de: 'keine Gerätegruppe mit diesen Namen',
    es: 'ningún grupo de equipos con estos nombres',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// Severity names of the LibreNMS alert rules (src/librenms/client.js SEVERITIES).
export const SEVERITY_TEXT = {
  ok: { en: 'OK', fr: 'OK', de: 'OK', es: 'OK' },
  warning: { en: 'Warning', fr: 'Avertissement', de: 'Warnung', es: 'Advertencia' },
  critical: { en: 'Critical', fr: 'Critique', de: 'Kritisch', es: 'Crítica' },
};

export const NO_ALERT_TEXT = {
  en: 'No alert',
  fr: 'Aucune alerte',
  de: 'Kein Alarm',
  es: 'Ninguna alerta',
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    devices: (count) => `${count} device(s)`,
    down: (count) => `${count} down`,
    alerts: (count) => `${count} alert(s)`,
    ports: (count) => `${count} port(s) followed`,
    unmatched: (names) => `port(s) not found: ${names}`,
    missing: (names) => `unknown group(s): ${names}`,
  },
  fr: {
    ok: 'OK',
    devices: (count) => `${count} équipement(s)`,
    down: (count) => `${count} hors ligne`,
    alerts: (count) => `${count} alerte(s)`,
    ports: (count) => `${count} port(s) suivi(s)`,
    unmatched: (names) => `port(s) introuvable(s) : ${names}`,
    missing: (names) => `groupe(s) inconnu(s) : ${names}`,
  },
  de: {
    ok: 'OK',
    devices: (count) => `${count} Gerät(e)`,
    down: (count) => `${count} offline`,
    alerts: (count) => `${count} Alarm(e)`,
    ports: (count) => `${count} Port(s) verfolgt`,
    unmatched: (names) => `Port(s) nicht gefunden: ${names}`,
    missing: (names) => `unbekannte Gruppe(n): ${names}`,
  },
  es: {
    ok: 'OK',
    devices: (count) => `${count} equipo(s)`,
    down: (count) => `${count} fuera de línea`,
    alerts: (count) => `${count} alerta(s)`,
    ports: (count) => `${count} puerto(s) seguido(s)`,
    unmatched: (names) => `puerto(s) no encontrado(s): ${names}`,
    missing: (names) => `grupo(s) desconocido(s): ${names}`,
  },
};

// Scene action messages (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No LibreNMS is configured.',
    fr: "Aucun LibreNMS n'est configuré.",
    de: 'Kein LibreNMS ist konfiguriert.',
    es: 'No hay ningún LibreNMS configurado.',
  },
  unknownDevice: {
    en: 'This device is not a LibreNMS device.',
    fr: "Cet appareil n'est pas un équipement LibreNMS.",
    de: 'Dieses Gerät ist kein LibreNMS-Gerät.',
    es: 'Este dispositivo no es un equipo de LibreNMS.',
  },
  acknowledgeDisabled: {
    en: 'Acknowledging is turned off in the configuration of the integration.',
    fr: "L'acquittement est désactivé dans la configuration de l'intégration.",
    de: 'Das Bestätigen ist in der Konfiguration der Integration ausgeschaltet.',
    es: 'El reconocimiento está desactivado en la configuración de la integración.',
  },
  acknowledgeRefused: {
    en: 'LibreNMS refused to acknowledge: the token user needs a role that may update alerts.',
    fr: "LibreNMS a refusé l'acquittement : l'utilisateur du jeton doit pouvoir modifier les alertes.",
    de: 'LibreNMS hat das Bestätigen abgelehnt: Der Token-Benutzer muss Alarme ändern dürfen.',
    es: 'LibreNMS rechazó el reconocimiento: el usuario del token debe poder modificar las alertas.',
  },
  defaultNote: {
    en: 'Acknowledged from Gladys',
    fr: 'Acquitté depuis Gladys',
    de: 'In Gladys bestätigt',
    es: 'Reconocido desde Gladys',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
export const severityName = (severity, language) =>
  SEVERITY_TEXT[severity] ? pick(SEVERITY_TEXT[severity], language) : pick(NO_ALERT_TEXT, language);
