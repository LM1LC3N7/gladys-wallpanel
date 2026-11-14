// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their scenes and
// configuration) and the tuning of the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Manifest `scene_actions` keys (forever: a renamed key breaks the scenes using it). */
export const SCENE_ACTIONS = {
  SPEAK: 'speak',
  SHOW_URL: 'show_url',
  RELOAD: 'reload_page',
  HOME: 'show_home_page',
  WAKE: 'wake_screen',
};

/** The `type` part of the external ids: ext:<selector>:tablet:<base topic level> (forever). */
export const DEVICE_TYPE = 'tablet';

/** The prefix of the WallPanel base topics when the configuration has none. */
export const DEFAULT_PREFIX = 'wallpanel';

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin for the other paths. */
  statesPerMinute: 250,
  /** The largest MQTT packet accepted from the broker (WallPanel messages are a few hundred bytes). */
  packetBytes: 64 * 1024,
  /** A payload read as a value: the state JSON (with its URL) stays well under this. */
  payloadBytes: 4096,
  /** Tablets followed at once. */
  tablets: 30,
  /** The tablet level of a base topic (wallpanel/<tablet>/). */
  tabletId: 64,
  /** The prefix typed in the configuration (one to three topic levels). */
  prefix: 100,
  /** The displayed URL published to Gladys (scheme, host and path only). */
  urlText: 200,
  /** A text spoken by the tablet (scene action). */
  speech: 500,
  /** A URL sent to the tablet (scene action). */
  url: 2000,
  /** The longest screen wake asked in a scene (seconds): 24 h. */
  wakeSeconds: 86_400,
  /** Commands sent to one tablet within a minute (a looping scene never floods it). */
  commandsPerMinute: 30,
};

export const TIMINGS = {
  /** Broker connection timeout. */
  connectTimeout: 10 * SECOND,
  /** Delay between two reconnection attempts to an unreachable broker. */
  reconnectPeriod: 10 * SECOND,
  /** ...and this often after a few failed attempts in a row. */
  reconnectSlow: MINUTE,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** A measurement (light, battery, temperature...) is sent at most this often per feature. */
  measurementInterval: 10 * SECOND,
  /** An unchanged value pushed again by the tablet is re-sent after this long. */
  stateHeartbeat: 30 * MINUTE,
  /** A new tablet or feature is published to Discovery after this pause. */
  discoveryDebounce: 2 * SECOND,
  /** No WallPanel message this long after the subscription: the status says so. */
  noDataAfter: 60 * SECOND,
  /** How long the connection test listens for the tablets. */
  testListen: 10 * SECOND,
  /** Two connection tests at least this far apart. */
  testCooldown: 10 * SECOND,
  /** A value read is sent to a device created later only if it is younger than this. */
  catchUpMaxAge: 2 * HOUR,
  /** How long a command waits for the socket to take it before answering "maybe sent". */
  commandWrite: 3 * SECOND,
  /** After refused credentials: the next tries (the last one repeats). */
  authRetry: [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  /** The configuration could not be read from Gladys: next tries (the last one repeats). */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE],
};
