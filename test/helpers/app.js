// The app against the SDK's fake Gladys, a fake broker and a virtual clock.

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WallPanelApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { FEATURE_KEYS, buildDevice } from '../../src/tablet.js';
import { testClock, settle } from './clock.js';
import { fakeConnector } from './fakeMqtt.js';

export { settle };

export const SELECTOR = 'test-integration';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const PASSWORD = 'S3cr3t-Pa55word!';
export const CONFIG = { broker_url: '192.168.1.20', username: 'gladys', password: PASSWORD };
export const TABLET = 'kitchen';
export const DEVICE = (tablet = TABLET) => `ext:${SELECTOR}:tablet:${tablet}`;
export const F = (key, tablet = TABLET) => `${DEVICE(tablet)}:${key}`;
export const BASE = (tablet = TABLET, prefix = 'wallpanel') => `${prefix}/${tablet}/`;

/** What WallPanel publishes, as in its docs (website/docs/remote-control/sensors.md). */
export const STATE = {
  currentUrl: 'http://gladys.local/dashboard?token=abc#top',
  screenOn: true,
  camera: false,
  brightness: 120,
};
export const SENSORS = {
  battery: { unit: '%', value: '39', acPlugged: false, usbPlugged: true, charging: true },
  light: { unit: 'lx', value: '920', id: 'Light sensor' },
  temperature: { unit: '°C', value: '24' },
  pressure: { unit: 'hPa', value: '1011.584716796875' },
  humidity: { unit: '%', value: 45.5 },
  magneticField: { unit: 'uT', value: '-1780.699951171875' },
};

/** A tablet publishing: its state, then each sensor (live by default). */
export function deliverTablet(
  client,
  { tablet = TABLET, state = STATE, sensors = SENSORS, retain = false, prefix } = {},
) {
  const base = BASE(tablet, prefix);
  if (state) {
    client.deliver(`${base}state`, JSON.stringify(state), { retain });
  }
  for (const [name, payload] of Object.entries(sensors ?? {})) {
    client.deliver(`${base}sensor/${name}`, JSON.stringify(payload), { retain });
  }
}

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`,
      );
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child() {
      return this;
    },
  };
}

/** A created device of a tablet, as Gladys keeps it. */
export function createdTablet({ tablet = TABLET, features = FEATURE_KEYS, language = 'fr' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevice(gladys, { tabletId: tablet, features: new Set(features) }, language);
}

export async function setup({
  config = CONFIG,
  devices = [],
  store = memoryStore(),
  clock = testClock({ start: Date.parse('2026-03-01T12:00:00Z') }),
  open = true,
  getConfig,
} = {}) {
  const logger = memoryLogger();
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices, logger });
  if (getConfig) {
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = () => getConfig(original);
  }
  const mqtt = fakeConnector();
  const app = new WallPanelApp({
    gladys,
    logger,
    connect: mqtt.connect,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  if (open && mqtt.last) {
    mqtt.last.open();
    await settle();
  }
  return { gladys, app, mqtt, clock, store, logger };
}

/** Lets the event loop turn until `condition()` holds (bounded: throws after 200 turns). */
export async function until(condition, what = 'condition') {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) {
      return;
    }
    await settle(1);
  }
  throw new Error(`never: ${what}`);
}

/** A promise bounded in real time: a test fails, it never hangs. */
export function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The states Gladys received for a feature. */
export const statesOf = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id);

/** The last status message (English). */
export const statusText = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';

/** The commands the app published (topic and parsed payload). */
export const commandsOf = (client) =>
  client.published.map((p) => ({
    topic: p.topic,
    payload: JSON.parse(p.payload),
    options: p.options,
  }));
