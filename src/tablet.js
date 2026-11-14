// -----------------------------------------------------------------------------
// A WallPanel tablet, as Gladys sees it: which documented WallPanel MQTT topic
// (WallPanel repository, website/docs/remote-control: "MQTT Sensors", "MQTT
// and HTTP commands") feeds which feature, how its JSON payload is read, the
// device built from it, and the commands sent back.
//
// Topics of a tablet whose base topic is "<prefix>/<tablet>/":
//   - <prefix>/<tablet>/state       {"currentUrl", "screenOn", "brightness", "camera"}
//   - <prefix>/<tablet>/sensor/<s>  {"value", "unit", ...}: battery, light,
//     temperature, pressure, humidity, motion, face (magneticField and
//     qrcode are never read)
//   - <prefix>/<tablet>/connection  "online" / "offline" (retained, last will)
//   - <prefix>/<tablet>/command     what Gladys sends (never read)
//
// Only the documented payloads are read, nothing of WallPanel's code is used.
// Every value is checked strictly: a number is a JSON number or a decimal
// text (never '' read as 0), a boolean is true or false, a value out of its
// range, of an unexpected shape or in another unit is UNKNOWN (nothing
// published, the last value stays). The battery level -1 (Android's "no
// level") is out of the 0..100 range: unknown.
// The displayed URL is published WITHOUT its query, fragment and user
// information (a dashboard URL may carry a token): scheme, host and path.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, LIMITS } from './constants.js';
import { FEATURE_NAMES } from './i18n.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A strict decimal text: optional sign, digits, optional decimals. Never '' nor ' 1'. */
const NUMBER = /^-?\d{1,9}(\.\d{1,17})?$/;

/** A JSON number, or a decimal text (WallPanel's docs show both): else undefined. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  return typeof value === 'string' && NUMBER.test(value) ? Number(value) : undefined;
}

/** true / false (or their texts): else undefined. */
export function strictBoolean(value) {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return undefined;
}

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  const r = Math.round(value * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
};

/** A measurement in its range, rounded; undefined otherwise. */
const measure =
  ({ min, max, decimals = 1, integer = false }) =>
  (raw) => {
    const value = strictNumber(raw);
    if (value === undefined || value < min || value > max) {
      return undefined;
    }
    if (integer && !Number.isInteger(value)) {
      return undefined;
    }
    return { state: round(value, decimals) };
  };

const binary = (raw) => {
  const value = strictBoolean(raw);
  return value === undefined ? undefined : { state: value ? 1 : 0 };
};

/**
 * The URL a tablet displays, as published to Gladys: for http(s), scheme,
 * host and path only, never a query, a fragment nor user information; for
 * any other scheme (file:, data:, about:...), the scheme alone. Bounded to
 * LIMITS.urlText.
 */
export function displayedUrl(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.payloadBytes || CONTROL.test(raw)) {
    return undefined;
  }
  const text = raw.trim();
  if (text === '') {
    return { text: '' };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, data:, javascript:...: their content may be anything, the scheme only.
    return { text: url.protocol };
  }
  url.search = '';
  url.hash = '';
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  const shown = url.href;
  return { text: shown.length > LIMITS.urlText ? shown.slice(0, LIMITS.urlText) : shown };
}

const feature = (
  category,
  type,
  { unit, min = 0, max = 1, kind = 'binary', writable = false } = {},
) => ({
  category,
  type,
  unit,
  min,
  max,
  kind,
  writable,
});

/**
 * Feature key (frozen, part of the external id) -> where it is read
 * (`state` field or `sensor` name and field), its Gladys category/type/unit
 * and its parser. `kind`: 'measurement' (throttled), 'binary', 'level',
 * 'text'. `writable`: Gladys may command it. `always`: in every device (the
 * commands work before any state is read).
 */
export const FEATURES = {
  screen: {
    from: { state: 'screenOn' },
    parse: binary,
    always: true,
    ...feature(C.SWITCH, T.SWITCH.BINARY, { writable: true }),
  },
  brightness: {
    from: { state: 'brightness' },
    parse: measure({ min: 0, max: 255, decimals: 0, integer: true }),
    always: true,
    ...feature(C.SWITCH, T.SWITCH.DIMMER, { min: 1, max: 255, kind: 'level', writable: true }),
  },
  url: {
    from: { state: 'currentUrl' },
    parse: displayedUrl,
    ...feature(C.TEXT, T.TEXT.TEXT, { kind: 'text' }),
  },
  battery: {
    from: { sensor: 'battery', field: 'value', unit: '%' },
    parse: measure({ min: 0, max: 100, decimals: 0, integer: true }),
    ...feature(C.BATTERY, T.BATTERY.INTEGER, { unit: U.PERCENT, max: 100, kind: 'measurement' }),
  },
  charging: {
    from: { sensor: 'battery', field: 'charging' },
    parse: binary,
    ...feature(C.BATTERY, T.BATTERY.CHARGING),
  },
  light: {
    from: { sensor: 'light', field: 'value', unit: 'lx' },
    parse: measure({ min: 0, max: 200_000, decimals: 1 }),
    ...feature(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.LUX,
      max: 200_000,
      kind: 'measurement',
    }),
  },
  temperature: {
    from: { sensor: 'temperature', field: 'value', unit: '°C' },
    parse: measure({ min: -40, max: 85, decimals: 1 }),
    ...feature(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.CELSIUS,
      min: -40,
      max: 85,
      kind: 'measurement',
    }),
  },
  pressure: {
    from: { sensor: 'pressure', field: 'value', unit: 'hPa' },
    parse: measure({ min: 300, max: 1200, decimals: 1 }),
    ...feature(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.HECTO_PASCAL,
      min: 300,
      max: 1200,
      kind: 'measurement',
    }),
  },
  humidity: {
    from: { sensor: 'humidity', field: 'value', unit: '%' },
    parse: measure({ min: 0, max: 100, decimals: 1 }),
    ...feature(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.PERCENT,
      max: 100,
      kind: 'measurement',
    }),
  },
  motion: {
    from: { sensor: 'motion', field: 'value' },
    parse: binary,
    ...feature(C.MOTION_SENSOR, T.SENSOR.BINARY),
  },
  face: {
    from: { sensor: 'face', field: 'value' },
    parse: binary,
    ...feature(C.PRESENCE_SENSOR, T.SENSOR.BINARY),
  },
};

/** The order of the features in a device (the one of FEATURES). */
export const FEATURE_KEYS = Object.keys(FEATURES);

/** The features read from the `state` topic. */
export const STATE_FEATURES = FEATURE_KEYS.filter((key) => FEATURES[key].from.state);

/** Sensor name -> the features read from it. */
export const SENSOR_FEATURES = new Map();
for (const key of FEATURE_KEYS) {
  const name = FEATURES[key].from.sensor;
  if (name) {
    SENSOR_FEATURES.set(name, [...(SENSOR_FEATURES.get(name) ?? []), key]);
  }
}

/** The tablet level of a base topic: letters, digits, `_` and `-` (never a dot nor `:`). */
export const isTabletId = (level) =>
  typeof level === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.tabletId}}$`).test(level);

/**
 * "<prefix><tablet>/state" -> { tabletId, kind: 'state' },
 * "<prefix><tablet>/sensor/<name>" -> { tabletId, kind: 'sensor', sensor },
 * "<prefix><tablet>/connection" -> { tabletId, kind: 'connection' };
 * anything else (command, deeper levels, an odd tablet level) -> undefined.
 */
export function parseTopic(topic, prefix) {
  if (typeof topic !== 'string' || !topic.startsWith(prefix)) {
    return undefined;
  }
  const rest = topic.slice(prefix.length).split('/');
  if (!isTabletId(rest[0])) {
    return undefined;
  }
  if (rest.length === 2 && (rest[1] === 'state' || rest[1] === 'connection')) {
    return { tabletId: rest[0], kind: rest[1] };
  }
  if (rest.length === 3 && rest[1] === 'sensor' && /^[A-Za-z]{1,40}$/.test(rest[2])) {
    return { tabletId: rest[0], kind: 'sensor', sensor: rest[2] };
  }
  return undefined;
}

/** A JSON object payload, or undefined (not JSON, not an object, an inherited key...). */
export function parseObject(text) {
  if (!text.trimStart().startsWith('{')) {
    return undefined;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

/** The `state` payload -> { featureKey: value } of the fields readable. */
export function readState(object) {
  const values = {};
  for (const key of STATE_FEATURES) {
    const raw = own(object, FEATURES[key].from.state);
    if (raw !== undefined) {
      const value = FEATURES[key].parse(raw);
      if (value !== undefined) {
        values[key] = value;
      }
    }
  }
  return values;
}

/**
 * A `sensor/<name>` payload -> { featureKey: value }. A payload announcing
 * another unit than the documented one is unknown (never converted blindly).
 */
export function readSensor(name, object) {
  const values = {};
  for (const key of SENSOR_FEATURES.get(name) ?? []) {
    const { field, unit } = FEATURES[key].from;
    const announced = own(object, 'unit');
    if (unit && announced !== undefined && announced !== null && announced !== unit) {
      continue;
    }
    const raw = own(object, field);
    if (raw === undefined) {
      continue;
    }
    const value = FEATURES[key].parse(raw);
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * The Gladys device of a tablet: the features always there and those of
 * the values seen (in the FEATURES order), names in the configured language.
 */
export function buildDevice(gladys, { tabletId, features }, language) {
  const ids = gladys.externalIds(DEVICE_TYPE, tabletId);
  const names = FEATURE_NAMES[language === 'en' ? 'en' : 'fr'];
  return {
    name: `WallPanel ${tabletId}`,
    external_id: ids.device,
    model: 'WallPanel',
    should_poll: false,
    params: [{ name: 'WALLPANEL_TABLET', value: tabletId }],
    features: FEATURE_KEYS.filter((key) => FEATURES[key].always || features.has(key)).map((key) => {
      const f = FEATURES[key];
      return {
        name: names[key],
        external_id: ids.feature(key),
        category: f.category,
        type: f.type,
        ...(f.unit ? { unit: f.unit } : {}),
        min: f.min,
        max: f.max,
        read_only: !f.writable,
        // The tablet publishes its state back: Gladys shows what it reports.
        has_feedback: f.writable,
        keep_history: f.kind !== 'text',
      };
    }),
  };
}

// --- Commands (website/docs/remote-control/commands.md) -------------------------

/** A text spoken by the tablet: control characters made spaces, trimmed, bounded. */
export function speechText(raw) {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const text = raw.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (text === '') {
    return undefined;
  }
  return [...text].slice(0, LIMITS.speech).join('');
}

/**
 * A URL the tablet may browse to: http or https only, with a host, no user
 * information (a password would travel in clear on the broker), no control
 * character, bounded. Returns the URL as typed (normalized), or an error key.
 */
export function browseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { error: 'url_empty' };
  }
  if (text.length > LIMITS.url || CONTROL.test(text)) {
    return { error: 'url_invalid' };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'url_invalid' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { error: 'url_scheme' };
  }
  if (url.username || url.password) {
    return { error: 'url_credentials' };
  }
  return { url: url.href };
}

/** The brightness WallPanel takes: an integer 1..255 (0 and below sent as 1). */
export function brightnessValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(255, Math.max(1, Math.round(value)));
}

/** A screen wake duration in seconds: empty = WallPanel's own inactivity time. */
export function wakeSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { seconds: undefined };
  }
  const value = strictNumber(typeof raw === 'number' ? raw : String(raw).trim());
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > LIMITS.wakeSeconds) {
    return { error: 'wake_invalid' };
  }
  return { seconds: value };
}
