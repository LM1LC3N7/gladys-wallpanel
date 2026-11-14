// -----------------------------------------------------------------------------
// The integration: one connection to the MQTT broker of the user, where the
// WallPanel tablets publish (WallPanel repository, website/docs/remote-control);
// each tablet turned into a Gladys device (src/tablet.js), its values sent
// within the Gladys rate limit (src/publisher.js), its commands (screen,
// brightness, scene actions) published on its command topic, the transport
// badge and the "Test the connection" button. index.js only wires the SDK
// handlers (src/handlers.js).
//
// Freshness:
//   - a state or sensor value arriving live is current: sent at once
//     (measurements spaced by 10 s per feature);
//   - a RETAINED state or sensor value (WallPanel never retains them: another
//     tool did, maybe long ago) is never read;
//   - the `connection` topic (retained by WallPanel, its last will says
//     "offline") only sets the badge, the status and the refusal of commands;
//   - a reconnection to Gladys never sends a value again (Gladys has them); a
//     device created later gets the values read in the last 2 h, dated
//     (created_at: no scene starts on them).
//
// Commands: QoS 0, never retained, so a tablet offline never runs them late;
// refused (nothing sent) while the broker is not connected, while WallPanel
// says the tablet is offline, or beyond 30 per minute and tablet. WallPanel
// answers nothing on MQTT: a command handed to the broker is "sent", the
// tablet's next state shows what it did. The spoken texts and the URLs sent
// are never logged.
//
// Failures (lessons of the previous waves, as gladys-teslamate):
//   - credentials refused by the broker: the client stops, a stop persisted
//     in /data, next tries 15 min, 1 h, 6 h then every 24 h, never in a loop;
//     saving other credentials or "Test the connection" tries again;
//   - broker unreachable: mqtt.js tries again every 10 s, then every minute;
//   - a CONNECT with credentials closed or left unanswered once the transport
//     opened, twice in a row: counted like refused credentials;
//   - messages bounded before they are read (src/mqtt.js);
//   - the configuration unreadable from Gladys: tried again, spaced, without end;
//   - a reconnection to Gladys keeps the MQTT client and the stop, and only
//     re-sends the status, the Discovery and the badges.
// Clocks: `now` (wall) dates the states and what /data keeps; `monotonic`
// paces the stop after a refusal, the test cooldown, the command budget, the
// age of the values and the publisher.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, credentialsKey, normalizeConfig, topicPrefix } from './config.js';
import { DEVICE_TYPE, LIMITS, SCENE_ACTIONS, TIMINGS } from './constants.js';
import { COMMAND, T, TEST, age } from './i18n.js';
import { connectBroker, errorReason, isProtocolRefusal, isRefusal } from './mqtt.js';
import { StatePublisher } from './publisher.js';
import { authWait, fileStore, normalizeMemory, serializeMemory } from './store.js';
import {
  FEATURES,
  brightnessValue,
  browseUrl,
  buildDevice,
  isTabletId,
  parseObject,
  parseTopic,
  readSensor,
  readState,
  speechText,
  wakeSeconds,
} from './tablet.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The text of a payload, or undefined (too large, not UTF-8). */
function payloadText(payload) {
  if (!payload || payload.length > LIMITS.payloadBytes) {
    return undefined;
  }
  try {
    return decoder.decode(payload);
  } catch {
    return undefined;
  }
}

/** The topic filters of the tablets under a prefix ("wallpanel/"). */
export const subscriptions = (prefix) => [
  `${prefix}+/state`,
  `${prefix}+/sensor/+`,
  `${prefix}+/connection`,
];

/** The binary features whose every transition matters (a scene on a motion). */
const TRANSITIONS = new Set(['motion', 'face']);

/** A command refused before anything left: its reason, in the configured language. */
class NotSent extends Error {
  constructor(reason, language) {
    const text = COMMAND.notSent(reason);
    super(language === 'en' ? text.en : text.fr);
    this.name = 'NotSent';
    this.reason = reason;
  }
}

/** How long /data may take to answer at start: past it, no stop is known. */
const STORE_TIMEOUT = 5000;
/** /data unreadable at start: read again this often, at most MEMORY_TRIES times. */
const MEMORY_RETRY = 10_000;
const MEMORY_TRIES = 6;
/** Failed connection attempts in a row before the slow pace. */
const RECONNECT_SLOW_AFTER = 3;

export class WallPanelApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'wallpanel' }),
    connect = connectBroker,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.config = normalizeConfig();
    this.rawConfig = {};
    this.connKey = undefined;
    this.credKey = undefined;
    this.memory = undefined;
    /** Monotonic time before which no connection is tried (refused credentials). */
    this.authDue = 0;
    this.client = null;
    this.generation = 0;
    this.started = false;
    this.stopped = false;
    this.protocolVersion = 5;
    this.lastError = undefined;
    this.unanswered = 0;
    this.wasConnected = false;
    this.configTries = 0;
    this.resetTablets();
    /** tabletId -> monotonic times of the commands of the last minute (kept across restarts). */
    this.commandTimes = new Map();
    /** The commands waiting for the socket: answered at once by stop(). */
    this.inFlight = new Set();
    this.created = new Set();
    this.lastStatus = undefined;
    this.lastStatusArgs = undefined;
    this.publishedDevices = undefined;
    /** deviceId -> transport key last published */
    this.transports = new Map();
    this.timersById = {};
    this.warned = new Set();
    this.lastTest = undefined;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
  }

  resetTablets() {
    /** tabletId -> { online: true | false | undefined, features: Set } */
    this.tablets = new Map();
    /** tablet ids seen beyond LIMITS.tablets */
    this.capped = new Set();
    /** featureId -> { value, at (wall ms), mono } : the latest value read live */
    this.latest = new Map();
    this.dataSeen = false;
  }

  // --- Memory (/data) ----------------------------------------------------------

  /**
   * The state of /data, read once: true when known (read, or no file). A
   * read slower than STORE_TIMEOUT or failing (EIO...) is NOT "empty": false
   * is returned and the caller tries again later. One read at a time: a slow
   * read still running is waited for again, never doubled, and its answer
   * counts even when it comes late.
   */
  async loadMemory() {
    if (this.memory) {
      return true;
    }
    if (!this.reading) {
      this.reading = this.store.load().then(
        (raw) => {
          this.reading = undefined;
          this.applyMemory(raw);
          return true;
        },
        (err) => {
          this.reading = undefined;
          this.warnOnce(`data:${err?.code}`, `Reading /data failed: ${err?.code ?? err?.message}`);
          return false;
        },
      );
    }
    let timer;
    const read = await Promise.race([
      this.reading,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), STORE_TIMEOUT);
      }),
    ]);
    this.timers.clearTimeout(timer);
    return read || Boolean(this.memory);
  }

  applyMemory(raw) {
    if (this.memory) {
      return;
    }
    const now = this.now();
    this.memory = normalizeMemory(raw, now);
    this.memoryWritable = true;
    this.authDue =
      this.memory.auth.until > now ? this.monotonic() + (this.memory.auth.until - now) : 0;
  }

  async saveMemory() {
    if (!this.memoryWritable) {
      // /data was never read: writing would overwrite a stop we do not know.
      return;
    }
    try {
      await this.store.save(serializeMemory(this.memory));
    } catch (err) {
      this.logger.warn(`Saving the state in /data failed: ${err.message}`);
    }
  }

  // --- Timers ------------------------------------------------------------------

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation && !this.stopped) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  /** Every timer, but the retry of the configuration read unless `all` (the final stop). */
  clearTimers({ all = true } = {}) {
    const kept = all ? undefined : this.timersById.getConfig;
    for (const [name, id] of Object.entries(this.timersById)) {
      if (name !== 'getConfig' || all) {
        this.timers.clearTimeout(id);
      }
    }
    this.timersById = kept === undefined ? {} : { getConfig: kept };
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Gladys (re)connected: the configuration read (tried again, spaced,
   * without end, while Gladys does not answer), then the status, the
   * Discovery and the badges again, the MQTT client kept when nothing changed.
   */
  async gladysConnected() {
    if (this.stopped) {
      return;
    }
    this.timers.clearTimeout(this.timersById.getConfig);
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped) {
        return;
      }
      const retry = TIMINGS.configRetry;
      const wait = retry[Math.min(this.configTries, retry.length - 1)];
      this.configTries += 1;
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnread(age(wait)), { force: true, remember: false });
      // Its own timer, outside the generations: only the final stop cancels
      // it (clearTimers keeps it), a start() meanwhile never does.
      this.timersById.getConfig = this.timers.setTimeout(() => {
        this.timersById.getConfig = undefined;
        this.gladysConnected().catch((e) => this.logger.error(`getConfig: ${e.message}`));
      }, wait);
      return;
    }
    if (this.stopped) {
      return;
    }
    this.configTries = 0;
    await this.refreshDevices();
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      this.applySoft(next, raw);
      this.publishedDevices = undefined;
      this.transports.clear();
      // The last status again (it was lost with Gladys), then what is known now.
      if (this.lastStatusArgs) {
        await this.setStatus(...this.lastStatusArgs, { force: true });
      }
      await this.updateStatus();
      await this.rebuild({ force: true });
      return;
    }
    await this.start(raw);
  }

  /** Saved by the user: the language applies at once; a new broker, prefix or credentials reconnect. */
  async configUpdated(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      this.applySoft(next, raw);
      await this.rebuild();
      await this.updateStatus();
      return;
    }
    await this.start(raw);
  }

  /** The options that need no reconnection: the language of the feature names. */
  applySoft(next, raw) {
    this.rawConfig = raw ?? {};
    this.config = next;
  }

  isOurs(device) {
    return (
      typeof device?.external_id === 'string' &&
      device.external_id.startsWith(this.gladys.externalId(`${DEVICE_TYPE}:`))
    );
  }

  /** The tablet id of one of our device external ids, or undefined. */
  tabletIdOf(externalId) {
    const prefix = this.gladys.externalId(`${DEVICE_TYPE}:`);
    if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
      return undefined;
    }
    const id = externalId.slice(prefix.length);
    return isTabletId(id) ? id : undefined;
  }

  async start(raw = {}) {
    if (this.stopped) {
      return;
    }
    this.stop({ final: false });
    const generation = this.generation;
    this.started = true;
    this.rawConfig = raw ?? {};
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    this.wasConnected = false;
    this.protocolVersion = 5;
    this.lastError = undefined;
    this.unanswered = 0;
    this.failedAttempts = 0;
    this.resetTablets();
    this.publishedDevices = undefined;
    this.transports.clear();
    this.publisher.clear();
    this.refreshCreated();
    this.publisher.start();
    if (this.config.problem) {
      await this.setStatus(false, T.problem(this.config.problem));
      return;
    }
    if (!(await this.loadMemory())) {
      if (generation !== this.generation) {
        return;
      }
      this.memoryTries = (this.memoryTries ?? 0) + 1;
      if (this.memoryTries < MEMORY_TRIES) {
        await this.setStatus(false, T.dataUnreadable(age(MEMORY_RETRY)));
        this.later('memory', MEMORY_RETRY, () => this.start(this.rawConfig));
        return;
      }
      // Still unreadable after a minute: go on without the stop it may hold,
      // never writing over it (saveMemory stays off until a read succeeds).
      this.logger.warn('/data still unreadable: connecting without its state');
      this.memory = normalizeMemory(null, this.now());
      this.memoryWritable = false;
    }
    if (generation !== this.generation) {
      return;
    }
    const credentials = credentialsKey(this.config);
    if (
      this.credKey !== undefined &&
      credentials !== this.credKey &&
      this.memory.auth.failures > 0
    ) {
      // Other credentials: the stop on the refused ones is lifted.
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
    }
    this.credKey = credentials;
    const wait = this.authDue - this.monotonic();
    if (wait > 0) {
      await this.setStatus(false, T.stopped(age(wait)));
      this.later('auth', wait, () => this.connectNow());
      return;
    }
    await this.connectNow();
  }

  async connectNow() {
    const generation = this.generation;
    await this.setStatus(false, T.connecting);
    if (generation !== this.generation) {
      return;
    }
    // A CONNECT left without CONNACK, armed once the transport opened (only
    // then may the credentials have left), cleared by a CONNACK.
    const UNANSWERED = 'the broker closed the connection without answering';
    let pending;
    let opened = false;
    const hooks = {
      onAttempt: () => {
        pending = undefined;
        opened = false;
      },
      onOpen: () => {
        opened = true;
        pending = UNANSWERED;
      },
    };
    let client;
    try {
      client = this.connect(this.config, { protocolVersion: this.protocolVersion, ...hooks });
    } catch (err) {
      this.lastError = errorReason(err);
      await this.setStatus(false, T.unreachable(this.lastError));
      return;
    }
    this.client = client;
    const current = () => generation === this.generation && this.client === client;
    // The reconnection pace: 10 s, then 60 s after RECONNECT_SLOW_AFTER failed
    // attempts in a row (a wrong address, a broker down for the night).
    let fastPeriod = client.options?.reconnectPeriod;
    this.retryPeriod = fastPeriod ?? TIMINGS.reconnectPeriod;
    client.on('packetreceive', (packet) => {
      if (packet?.cmd === 'connack') {
        pending = undefined;
      }
    });
    client.on('connect', () => {
      if (current()) {
        this.unanswered = 0;
        this.lastError = undefined;
        this.failedAttempts = 0;
        if (client.options && fastPeriod !== undefined) {
          client.options.reconnectPeriod = fastPeriod;
        }
        this.onConnect().catch((err) => this.logger.error(`After connection: ${err.message}`));
      }
    });
    client.on('message', (topic, payload, packet) => {
      if (current()) {
        try {
          this.onMessage(topic, payload, packet);
        } catch (err) {
          // One odd message never stops the others.
          this.warnOnce(`message:${err.message}`, `A message was ignored: ${err.message}`);
        }
      }
    });
    client.on('error', (err) => {
      if (!current()) {
        return;
      }
      let reason = errorReason(err);
      if (err?.message === 'connack timeout' && !opened) {
        reason = 'no answer from the broker at the network level';
      }
      this.lastError = reason;
      if (isRefusal(err)) {
        this.onRefused(reason).catch((e) => this.logger.error(`After a refusal: ${e.message}`));
        return;
      }
      if (isProtocolRefusal(err) && this.protocolVersion === 5) {
        this.onProtocolRefused().catch((e) => this.logger.error(`MQTT 3.1.1: ${e.message}`));
        return;
      }
      if (err?.message === 'connack timeout' && pending) {
        pending = 'no answer from the broker to the connection';
      }
      this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
      this.setStatus(false, T.unreachable(reason, age(this.retryPeriod)));
    });
    client.on('close', () => {
      if (!current()) {
        return;
      }
      if (!this.wasConnected) {
        this.failedAttempts += 1;
        if (this.failedAttempts >= RECONNECT_SLOW_AFTER && client.options) {
          fastPeriod ??= client.options.reconnectPeriod;
          client.options.reconnectPeriod = TIMINGS.reconnectSlow;
          this.retryPeriod = TIMINGS.reconnectSlow;
        }
      }
      if (pending) {
        const reason = pending;
        pending = undefined;
        this.onUnanswered(reason).catch((e) => this.logger.error(`Unanswered: ${e.message}`));
        return;
      }
      if (this.wasConnected) {
        this.wasConnected = false;
        this.timers.clearTimeout(this.timersById.noData);
        this.setStatus(
          false,
          this.lastError ? T.unreachable(this.lastError, age(this.retryPeriod)) : T.lost,
        );
        this.publishAllTransports().catch(() => {});
      }
    });
  }

  /** A CONNECT with credentials closed or unanswered, twice in a row: like a refusal. */
  async onUnanswered(reason) {
    this.lastError = reason;
    this.unanswered += 1;
    if (this.hasCredentials() && this.unanswered >= 2) {
      this.unanswered = 0;
      await this.onRefused(`${reason}, twice`);
      return;
    }
    this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
    await this.setStatus(false, T.unreachable(reason, age(this.retryPeriod)));
  }

  hasCredentials() {
    return Boolean(this.config.username || this.config.password);
  }

  /** The broker does not speak MQTT 5: 3.1.1, with the size guard of src/mqtt.js only. */
  async onProtocolRefused() {
    this.logger.warn('The MQTT broker does not support MQTT 5: using MQTT 3.1.1');
    this.endClient();
    this.protocolVersion = 4;
    await this.connectNow();
  }

  /** The broker refused the credentials: stop, and try again later (persisted). */
  async onRefused(reason) {
    const generation = this.generation;
    this.logger.warn(`MQTT broker refused the connection: ${reason}`);
    this.endClient();
    const failures = this.memory.auth.failures + 1;
    const wait = authWait(failures);
    this.memory.auth = { failures, until: this.now() + wait };
    this.authDue = this.monotonic() + wait;
    await this.saveMemory();
    if (generation !== this.generation) {
      return;
    }
    await this.setStatus(false, T.refused(reason, age(wait)));
    this.later('auth', wait, () => this.connectNow());
  }

  endClient() {
    if (this.client) {
      this.client.removeAllListeners?.();
      this.client.on?.('error', () => {});
      this.client.end(true);
      this.client = null;
    }
  }

  /** `final`: the container stops (handleShutdown); otherwise a restart follows. */
  stop({ final = true } = {}) {
    this.generation += 1;
    // A command still waiting for the old client: answered now, its timer cleared.
    for (const maybe of [...this.inFlight]) {
      maybe();
    }
    this.clearTimers({ all: final });
    this.publisher.stop();
    this.endClient();
    if (final) {
      this.stopped = true;
    }
  }

  /** `remember: false`: a passing status, not the one sent again after a reconnection. */
  async setStatus(connected, message, { force = false, remember = true } = {}) {
    const key = JSON.stringify([connected, message ?? null]);
    if (!force && key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    if (remember) {
      this.lastStatusArgs = [connected, message];
    }
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  warnOnce(key, message) {
    if (this.warned.size < 200 && !this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  async onConnect() {
    const generation = this.generation;
    this.logger.info(
      `Connected to the MQTT broker ${this.config.brokerUrl} (MQTT ${this.protocolVersion === 5 ? '5' : '3.1.1'})`,
    );
    this.wasConnected = true;
    if (this.memory.auth.failures > 0) {
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
    }
    if (generation !== this.generation || !this.client) {
      return;
    }
    // A clean session: subscribe again; the broker sends the retained
    // `connection` of each tablet.
    this.client.subscribe(subscriptions(topicPrefix(this.config)), { qos: 0 }, (err) => {
      if (err) {
        this.logger.warn(`Subscription failed: ${err.message}`);
      }
    });
    this.later('noData', TIMINGS.noDataAfter, () => this.updateStatus());
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /** The status from what is known now. */
  async updateStatus() {
    if (this.config.problem) {
      return this.setStatus(false, T.problem(this.config.problem));
    }
    if (!this.client?.connected) {
      return undefined;
    }
    const prefix = topicPrefix(this.config);
    if (this.tablets.size === 0) {
      return this.setStatus(
        false,
        this.timersById.noData === undefined ? T.noData(prefix) : T.waiting(prefix),
      );
    }
    const offline = [...this.tablets.values()].filter((t) => t.online === false).length;
    return this.setStatus(
      true,
      T.connected(this.tablets.size, {
        offline,
        capped: this.capped.size,
        protocol3: this.protocolVersion !== 5,
      }),
    );
  }

  // --- Messages --------------------------------------------------------------------

  featureId(tabletId, key) {
    return this.gladys.externalIds(DEVICE_TYPE, tabletId).feature(key);
  }

  deviceId(tabletId) {
    return this.gladys.externalIds(DEVICE_TYPE, tabletId).device;
  }

  tabletOf(tabletId) {
    let tablet = this.tablets.get(tabletId);
    if (tablet) {
      return tablet;
    }
    if (this.tablets.size >= LIMITS.tablets) {
      if (this.capped.size < 1000) {
        this.capped.add(tabletId);
      }
      return undefined;
    }
    tablet = { online: undefined, features: new Set() };
    this.tablets.set(tabletId, tablet);
    if (!this.dataSeen) {
      this.dataSeen = true;
      this.timers.clearTimeout(this.timersById.noData);
      this.timersById.noData = undefined;
    }
    this.scheduleRebuild();
    return tablet;
  }

  setOnline(tabletId, tablet, online) {
    if (tablet.online !== online) {
      tablet.online = online;
      this.updateStatus().catch(() => {});
      this.publishAllTransports().catch(() => {});
    }
  }

  onMessage(topic, payload, packet) {
    const info = parseTopic(topic, topicPrefix(this.config));
    if (!info) {
      return;
    }
    const text = payloadText(payload);
    if (text === undefined) {
      this.warnOnce(`payload:${info.kind}`, `A ${info.kind} message was ignored (size, encoding)`);
      return;
    }
    if (info.kind === 'connection') {
      // Retained by WallPanel on purpose (its last will): the latest word of the tablet.
      const word = text.trim();
      if (word !== 'online' && word !== 'offline') {
        return;
      }
      const tablet = this.tabletOf(info.tabletId);
      if (!tablet) {
        this.updateStatus().catch(() => {});
        return;
      }
      this.setOnline(info.tabletId, tablet, word === 'online');
      return;
    }
    if (packet?.retain === true) {
      // WallPanel never retains a state nor a sensor: an old value kept by the broker.
      this.warnOnce(`retained:${info.kind}`, `A retained ${info.kind} message was ignored (old)`);
      return;
    }
    const object = parseObject(text);
    if (object === undefined) {
      this.warnOnce(`json:${info.kind}`, `A ${info.kind} message was ignored (not a JSON object)`);
      return;
    }
    const tablet = this.tabletOf(info.tabletId);
    if (!tablet) {
      this.updateStatus().catch(() => {});
      return;
    }
    // A message published now by the tablet: it is online.
    this.setOnline(info.tabletId, tablet, true);
    const values = info.kind === 'state' ? readState(object) : readSensor(info.sensor, object);
    for (const [key, value] of Object.entries(values)) {
      if (!tablet.features.has(key)) {
        tablet.features.add(key);
        if (!FEATURES[key].always) {
          this.scheduleRebuild();
        }
      }
      this.record(info.tabletId, key, value);
    }
  }

  /** A value read live: sent at once to a created feature. */
  record(tabletId, key, value) {
    const id = this.featureId(tabletId, key);
    this.latest.set(id, { value, at: this.now(), mono: this.monotonic() });
    if (this.created.has(id)) {
      this.publisher.push(id, value, {
        throttle: FEATURES[key].kind === 'measurement',
        transitions: TRANSITIONS.has(key),
      });
    }
  }

  // --- Devices -----------------------------------------------------------------------

  /** The devices of Gladys, read again (their features). */
  async refreshDevices() {
    await this.gladys.getDevices?.().catch(() => undefined);
    this.refreshCreated();
  }

  refreshCreated() {
    this.created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        if (typeof feature.external_id === 'string') {
          this.created.add(feature.external_id);
        }
      }
    }
  }

  scheduleRebuild() {
    this.later('rebuild', TIMINGS.discoveryDebounce, () => this.rebuild());
  }

  /** The tablets heard as Gladys devices (Discovery), then the status and the badges. */
  async rebuild({ force = false } = {}) {
    const devices = [];
    for (const [tabletId, tablet] of this.tablets) {
      devices.push(
        buildDevice(this.gladys, { tabletId, features: tablet.features }, this.config.language),
      );
    }
    const list = this.keepCreatedFeatures(devices);
    const json = JSON.stringify(list);
    if (force || json !== this.publishedDevices) {
      this.publishedDevices = json;
      await this.gladys
        .publishDiscoveredDevices(list)
        .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
    }
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /**
   * A device the user created never loses a feature (the core would show
   * "Update" and drop its history): the features of the created device that
   * the new build lacks are kept as they are.
   */
  keepCreatedFeatures(devices) {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    return devices.map((device) => {
      const old = created.get(device.external_id);
      if (!old) {
        return device;
      }
      const ids = new Set(device.features.map((f) => f.external_id));
      const kept = (old.features ?? [])
        .filter((f) => typeof f.external_id === 'string' && !ids.has(f.external_id))
        .map((f) => {
          const copy = {};
          for (const key of [
            'name',
            'external_id',
            'category',
            'type',
            'unit',
            'min',
            'max',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (f[key] !== undefined && f[key] !== null) {
              copy[key] = f[key];
            }
          }
          return copy;
        });
      return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
    });
  }

  /**
   * The user created (or updated) a device: the values read in the last
   * 2 h are sent, dated when they were read (created_at: no scene starts).
   */
  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    const mono = this.monotonic();
    for (const feature of device?.features ?? []) {
      const id = feature?.external_id;
      const latest = typeof id === 'string' ? this.latest.get(id) : undefined;
      if (!latest || mono - latest.mono > TIMINGS.catchUpMaxAge) {
        continue;
      }
      this.publisher.push(id, {
        ...latest.value,
        created_at: new Date(Math.min(latest.at, this.now())).toISOString(),
      });
    }
    await this.publishAllTransports().catch(() => {});
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (typeof device?.external_id === 'string') {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** Gladys asks for the devices: the list now. */
  async scan() {
    await this.rebuild({ force: true });
  }

  // --- Transport badge -------------------------------------------------------------------

  transportOf(deviceId) {
    if (!this.client?.connected) {
      return { external_id: deviceId, transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const tabletId = this.tabletIdOf(deviceId);
    if (tabletId !== undefined && this.tablets.get(tabletId)?.online === false) {
      return { external_id: deviceId, transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    return { external_id: deviceId, transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishAllTransports() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      if (!this.isOurs(device)) {
        continue;
      }
      const entry = this.transportOf(device.external_id);
      const key = JSON.stringify(entry);
      if (this.transports.get(device.external_id) !== key) {
        this.transports.set(device.external_id, key);
        entries.push(entry);
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Commands ----------------------------------------------------------------------------

  /** Gladys sets a feature: the screen (wake) or the brightness. */
  async setValue(device, feature, value) {
    const language = this.config.language;
    const tabletId = this.tabletIdOf(device?.external_id);
    const deviceId = tabletId === undefined ? undefined : this.deviceId(tabletId);
    const featureId = feature?.external_id;
    if (!deviceId || typeof featureId !== 'string' || !featureId.startsWith(`${deviceId}:`)) {
      throw new NotSent(COMMAND.reasons.unknown, language);
    }
    const key = featureId.slice(deviceId.length + 1);
    if (key === 'screen') {
      if (value !== 0 && value !== 1) {
        throw new NotSent(COMMAND.reasons.value, language);
      }
      // 1: wake the screen (until WallPanel's inactivity time); 0: release the wake.
      return this.sendCommand(tabletId, value === 1 ? { wake: true } : { wake: false });
    }
    if (key === 'brightness') {
      const brightness = brightnessValue(value);
      if (brightness === undefined) {
        throw new NotSent(COMMAND.reasons.value, language);
      }
      return this.sendCommand(tabletId, { brightness });
    }
    throw new NotSent(COMMAND.reasons.readOnly, language);
  }

  /** A scene reached one of the scene actions of the manifest. */
  async sceneAction(key, fields = {}) {
    const language = this.config.language;
    const tabletId = this.tabletIdOf(fields.tablet);
    if (tabletId === undefined) {
      throw new NotSent(COMMAND.reasons.unknown, language);
    }
    let command;
    if (key === SCENE_ACTIONS.SPEAK) {
      const speak = speechText(fields.text);
      if (speak === undefined) {
        throw new NotSent(COMMAND.reasons.speech_empty, language);
      }
      command = { speak };
    } else if (key === SCENE_ACTIONS.SHOW_URL) {
      const url = browseUrl(fields.url);
      if (url.error) {
        throw new NotSent(COMMAND.reasons[url.error], language);
      }
      command = { url: url.url };
    } else if (key === SCENE_ACTIONS.RELOAD) {
      command = { reload: true };
    } else if (key === SCENE_ACTIONS.HOME) {
      command = { relaunch: true };
    } else if (key === SCENE_ACTIONS.WAKE) {
      const wake = wakeSeconds(fields.seconds);
      if (wake.error) {
        throw new NotSent(COMMAND.reasons[wake.error], language);
      }
      command =
        wake.seconds === undefined ? { wake: true } : { wake: true, wakeTime: wake.seconds };
    } else {
      throw new NotSent(COMMAND.reasons.value, language);
    }
    await this.sendCommand(tabletId, command);
    return undefined;
  }

  /**
   * Publishes one command on the tablet's command topic. Refused, with
   * nothing sent, while the broker is not connected, while WallPanel says
   * the tablet is offline, or beyond LIMITS.commandsPerMinute for the
   * tablet. Resolved once the client wrote it to the broker (QoS 0: no
   * answer exists); past TIMINGS.commandWrite, "maybe sent".
   */
  async sendCommand(tabletId, command) {
    const language = this.config.language;
    const client = this.client;
    if (!client?.connected) {
      throw new NotSent(COMMAND.reasons.broker, language);
    }
    if (this.tablets.get(tabletId)?.online === false) {
      throw new NotSent(COMMAND.reasons.offline, language);
    }
    const mono = this.monotonic();
    const times = (this.commandTimes.get(tabletId) ?? []).filter(
      (t) => mono - t < 60_000 && t <= mono,
    );
    if (times.length >= LIMITS.commandsPerMinute) {
      this.commandTimes.set(tabletId, times);
      throw new NotSent(COMMAND.reasons.flood, language);
    }
    times.push(mono);
    this.commandTimes.set(tabletId, times);
    const topic = `${topicPrefix(this.config)}${tabletId}/command`;
    const what = Object.keys(command).join(', ');
    await new Promise((resolve, reject) => {
      let timer;
      let done = false;
      const maybe = () => {
        const text = COMMAND.maybeSent;
        finish(new Error(language === 'en' ? text.en : text.fr));
      };
      const finish = (err) => {
        if (done) {
          return;
        }
        done = true;
        this.timers.clearTimeout(timer);
        this.inFlight.delete(maybe);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      this.inFlight.add(maybe);
      timer = this.timers.setTimeout(maybe, TIMINGS.commandWrite);
      try {
        client.publish(topic, JSON.stringify(command), { qos: 0, retain: false }, (err) =>
          finish(err ? new NotSent(COMMAND.reasons.broker, language) : undefined),
        );
      } catch {
        finish(new NotSent(COMMAND.reasons.broker, language));
      }
    });
    // The keys only: never the text spoken nor the URL.
    this.logger.info(`Command sent to the tablet ${tabletId}: ${what}`);
  }

  // --- The "Test the connection" button ---------------------------------------------------

  async testConnection() {
    // The cooldown first: a burst of clicks never reaches the broker either.
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TIMINGS.testCooldown) {
      return TEST.tooSoon;
    }
    this.lastTest = mono;
    // The saved configuration as it is now (never an older copy).
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig ?? {});
    const config = normalizeConfig(raw);
    if (config.problem) {
      return T.problem(config.problem);
    }
    const prefix = topicPrefix(config);
    const answer = await new Promise((resolve) => {
      let probe;
      let timer;
      let done = false;
      const names = new Set();
      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        this.timers.clearTimeout(timer);
        if (probe) {
          probe.removeAllListeners?.();
          probe.on?.('error', () => {});
          probe.end(true);
        }
        resolve(result);
      };
      let protocolVersion = this.protocolVersion;
      const open = () => {
        try {
          probe = this.connect(config, { protocolVersion });
        } catch (err) {
          finish({ text: T.unreachable(errorReason(err)) });
          return;
        }
        probe.on('error', (err) => {
          if (isProtocolRefusal(err) && protocolVersion === 5) {
            protocolVersion = 4;
            probe.removeAllListeners?.();
            probe.on?.('error', () => {});
            probe.end(true);
            open();
            return;
          }
          const reason = errorReason(err);
          finish({ text: isRefusal(err) ? TEST.refused(reason) : T.unreachable(reason) });
        });
        probe.on('message', (topic) => {
          const info = parseTopic(topic, prefix);
          if (info && names.size < LIMITS.tablets) {
            names.add(info.tabletId);
          }
        });
        probe.on('connect', () => {
          this.timers.clearTimeout(timer);
          timer = this.timers.setTimeout(() => {
            const list = [...names];
            finish({
              text: list.length > 0 ? TEST.ok(list) : TEST.none(prefix),
              reached: true,
            });
          }, TIMINGS.testListen);
          probe.subscribe(subscriptions(prefix), { qos: 0 });
        });
      };
      timer = this.timers.setTimeout(
        () => finish({ text: T.unreachable('timeout') }),
        TIMINGS.connectTimeout + 1000,
      );
      open();
    });
    if (answer.reached && this.memory?.auth.failures > 0) {
      // The credentials work again: the stop is lifted and the integration reconnects.
      this.memory.auth = { failures: 0, until: 0 };
      this.authDue = 0;
      await this.saveMemory();
      await this.start(raw);
    }
    return answer.text;
  }
}
