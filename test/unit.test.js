// -----------------------------------------------------------------------------
// The pure parts: configuration, topics and payloads, the MQTT size guard,
// the publisher budget, the /data memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, parseBrokerUrl, parsePrefix, topicPrefix } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { age } from '../src/i18n.js';
import { MAX_PACKET, PacketGuard, errorReason, isRefusal } from '../src/mqtt.js';
import { StatePublisher } from '../src/publisher.js';
import { authWait, fileStore, normalizeMemory } from '../src/store.js';
import {
  FEATURES,
  brightnessValue,
  browseUrl,
  displayedUrl,
  parseObject,
  parseTopic,
  readSensor,
  readState,
  speechText,
  strictNumber,
  wakeSeconds,
} from '../src/tablet.js';
import { testClock } from './helpers/clock.js';

test('broker address: completed, bounded, never credentials inside', () => {
  assert.deepEqual(parseBrokerUrl('192.168.1.20'), {
    url: 'mqtt://192.168.1.20',
    host: '192.168.1.20',
    port: 1883,
    tls: false,
  });
  assert.equal(parseBrokerUrl('mqtts://broker.lan').port, 8883);
  assert.equal(parseBrokerUrl('mqtt://[fd00::1]:1884').host, 'fd00::1');
  assert.equal(parseBrokerUrl('ssl://b:8884').tls, true);
  for (const [raw, error] of [
    ['', 'empty'],
    [undefined, 'empty'],
    ['http://b', 'invalid'],
    ['ws://b', 'invalid'],
    ['mqtt://b/path', 'invalid'],
    ['mqtt://u:p@b', 'credentials'],
    ['0.0.0.0', 'invalid'],
    ['224.0.0.1', 'invalid'],
    ['255.255.255.255', 'invalid'],
    ['b\r\nc', 'invalid'],
    ['x'.repeat(301), 'invalid'],
  ]) {
    assert.equal(parseBrokerUrl(raw).error, error, String(raw));
  }
});

test('prefix: one to three safe topic levels, wallpanel by default', () => {
  assert.deepEqual(parsePrefix(''), { prefix: 'wallpanel' });
  assert.deepEqual(parsePrefix(undefined), { prefix: 'wallpanel' });
  assert.deepEqual(parsePrefix(' /home/tablets/ '), { prefix: 'home/tablets' });
  assert.deepEqual(parsePrefix('a/b/c'), { prefix: 'a/b/c' });
  for (const bad of [
    'a/b/c/d',
    '+',
    '#',
    'a/+',
    'a.b',
    'a//b',
    'a b',
    'a:b',
    'é',
    'x'.repeat(101),
  ]) {
    assert.equal(parsePrefix(bad).error, 'prefix', bad);
  }
  assert.equal(topicPrefix(normalizeConfig({ broker_url: 'b' })), 'wallpanel/');
  assert.equal(
    topicPrefix(normalizeConfig({ broker_url: 'b', topic_prefix: 'home/tablets' })),
    'home/tablets/',
  );
});

test('configuration: safe defaults, strict booleans, no password without user', () => {
  const c = normalizeConfig({ broker_url: 'b' });
  assert.equal(c.verifyCertificate, true);
  assert.equal(c.language, 'fr');
  assert.equal(normalizeConfig({ broker_url: 'b', verify_certificate: 0 }).verifyCertificate, true);
  assert.equal(
    normalizeConfig({ broker_url: 'b', verify_certificate: 'false' }).verifyCertificate,
    false,
  );
  assert.equal(
    normalizeConfig({ broker_url: 'b', password: 'p' }).problem,
    'password_without_user',
  );
  assert.equal(
    normalizeConfig({ broker_url: 'b', username: 'u', password: 'p\n' }).problem,
    'control',
  );
  assert.equal(normalizeConfig({ broker_url: 'b', topic_prefix: 'a/#' }).problem, 'prefix');
  assert.equal(normalizeConfig(null).problem, 'empty');
});

test('topics: state, sensor/<name>, connection of a safe tablet level; nothing else', () => {
  const p = 'wallpanel/';
  assert.deepEqual(parseTopic('wallpanel/kitchen/state', p), {
    tabletId: 'kitchen',
    kind: 'state',
  });
  assert.deepEqual(parseTopic('wallpanel/k-1_A/connection', p), {
    tabletId: 'k-1_A',
    kind: 'connection',
  });
  assert.deepEqual(parseTopic('wallpanel/kitchen/sensor/battery', p), {
    tabletId: 'kitchen',
    kind: 'sensor',
    sensor: 'battery',
  });
  for (const topic of [
    'wallpanel/kitchen/command',
    'wallpanel/kitchen/state/x',
    'wallpanel/kitchen/sensor',
    'wallpanel/kitchen/sensor/a/b',
    'wallpanel/kitchen/sensor/a1',
    'wallpanel/kit.chen/state',
    'wallpanel/kit:chen/state',
    'wallpanel//state',
    `wallpanel/${'k'.repeat(65)}/state`,
    'other/kitchen/state',
    'wallpanel/state',
  ]) {
    assert.equal(parseTopic(topic, p), undefined, topic);
  }
});

test('numbers: strict, never "" read as 0; units checked, never converted', () => {
  assert.equal(strictNumber('2.05'), 2.05);
  assert.equal(strictNumber(-9), -9);
  for (const bad of [
    '',
    ' ',
    '1e3',
    '0x10',
    ' 1',
    '1 ',
    '1,5',
    'Infinity',
    '.5',
    '5.',
    NaN,
    null,
    true,
  ]) {
    assert.equal(strictNumber(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(readSensor('battery', { unit: '%', value: '39', charging: true }), {
    battery: { state: 39 },
    charging: { state: 1 },
  });
  assert.deepEqual(
    readSensor('battery', { value: -1, charging: false }),
    {
      charging: { state: 0 },
    },
    '-1: no level known',
  );
  assert.deepEqual(readSensor('battery', { value: '39.5' }), {}, 'an integer, never a decimal');
  assert.deepEqual(readSensor('battery', { value: '' }), {}, 'empty is unknown, never 0');
  assert.deepEqual(readSensor('battery', { value: 101 }), {});
  assert.deepEqual(readSensor('light', { unit: 'lx', value: 920.04 }), { light: { state: 920 } });
  assert.deepEqual(readSensor('light', { unit: 'fc', value: 92 }), {}, 'another unit: unknown');
  assert.deepEqual(
    readSensor('light', { value: 92 }),
    { light: { state: 92 } },
    'no unit: as documented',
  );
  assert.deepEqual(readSensor('temperature', { unit: '°C', value: '-12.56' }), {
    temperature: { state: -12.6 },
  });
  assert.deepEqual(readSensor('temperature', { unit: '°F', value: '70' }), {});
  assert.deepEqual(readSensor('pressure', { unit: 'hPa', value: '1011.58' }), {
    pressure: { state: 1011.6 },
  });
  assert.deepEqual(readSensor('pressure', { unit: 'hPa', value: '0' }), {}, 'out of range');
  assert.deepEqual(readSensor('humidity', { unit: '%', value: 45 }), { humidity: { state: 45 } });
  assert.deepEqual(readSensor('motion', { value: true }), { motion: { state: 1 } });
  assert.deepEqual(readSensor('face', { value: 'false' }), { face: { state: 0 } });
  assert.deepEqual(readSensor('motion', { value: 1 }), {}, 'a boolean only');
  assert.deepEqual(readSensor('magneticField', { unit: 'uT', value: '1' }), {});
  assert.deepEqual(readSensor('qrcode', { value: 'secret' }), {});
  assert.deepEqual(
    readSensor('battery', JSON.parse('{"__proto__":{"value":50}}')),
    {},
    'never an inherited key',
  );
  assert.deepEqual(readSensor('battery', Object.create({ value: 50 })), {}, 'inherited value');
  assert.deepEqual(readState(Object.create({ screenOn: true })), {}, 'inherited state');
});

test('state: screen, brightness, page shown without query, fragment nor password', () => {
  assert.deepEqual(
    readState({
      currentUrl: 'https://user:pw@ha.local:8123/lovelace/0?auth=TOKEN#x',
      screenOn: false,
      brightness: 255,
      camera: true,
    }),
    {
      screen: { state: 0 },
      brightness: { state: 255 },
      url: { text: 'https://ha.local:8123/lovelace/0' },
    },
  );
  assert.deepEqual(readState({ screenOn: 'yes', brightness: 256 }), {});
  assert.deepEqual(readState({ brightness: 12.5 }), {});
  assert.deepEqual(readState({ brightness: '12' }), { brightness: { state: 12 } });
  assert.deepEqual(displayedUrl('file:///android_asset/index.html?x=1'), {
    text: 'file:///android_asset/index.html',
  });
  assert.deepEqual(displayedUrl('about:blank'), { text: 'about:blank' });
  assert.deepEqual(displayedUrl(''), { text: '' });
  assert.equal(displayedUrl('not a url'), undefined);
  assert.equal(displayedUrl('http://a/\u0000'), undefined);
  assert.equal(displayedUrl(42), undefined);
  assert.equal(displayedUrl(`http://a/${'p'.repeat(500)}`).text.length, 200);
  assert.equal(parseObject('[1]'), undefined);
  assert.equal(parseObject('null'), undefined);
  assert.equal(parseObject('{"a":'), undefined);
  assert.deepEqual(parseObject(' {"a":1}'), { a: 1 });
});

test('commands: bounded values, safe texts and URLs', () => {
  assert.equal(brightnessValue(0), 1, 'WallPanel takes 1..255');
  assert.equal(brightnessValue(-5), 1);
  assert.equal(brightnessValue(254.6), 255);
  assert.equal(brightnessValue(9999), 255);
  assert.equal(brightnessValue(NaN), undefined);
  assert.equal(brightnessValue('12'), undefined);
  assert.equal(speechText('  Hello\r\nworld\u0000 '), 'Hello world');
  assert.equal(speechText(' \n '), undefined);
  assert.equal(speechText(12), undefined);
  assert.equal([...speechText('é'.repeat(600))].length, 500);
  assert.deepEqual(browseUrl(' https://gladys.local/dashboard?x=1 '), {
    url: 'https://gladys.local/dashboard?x=1',
  });
  assert.deepEqual(browseUrl('http://u:p@host/'), { error: 'url_credentials' });
  assert.deepEqual(browseUrl('javascript:alert(1)'), { error: 'url_scheme' });
  assert.deepEqual(browseUrl('file:///sdcard/x'), { error: 'url_scheme' });
  assert.deepEqual(browseUrl('ftp://cam.local/x'), { error: 'url_scheme' });
  assert.deepEqual(browseUrl('intent://cam.local/#Intent;end'), { error: 'url_scheme' });
  assert.deepEqual(browseUrl(''), { error: 'url_empty' });
  assert.deepEqual(browseUrl(undefined), { error: 'url_empty' });
  assert.deepEqual(browseUrl('http://a/\nb'), { error: 'url_invalid' });
  assert.deepEqual(browseUrl(`http://a/${'p'.repeat(2001)}`), { error: 'url_invalid' });
  assert.deepEqual(wakeSeconds(undefined), { seconds: undefined });
  assert.deepEqual(wakeSeconds(''), { seconds: undefined });
  assert.deepEqual(wakeSeconds(180), { seconds: 180 });
  assert.deepEqual(wakeSeconds('180'), { seconds: 180 });
  for (const bad of [0, -1, 1.5, 86_401, 'abc', ' ', true]) {
    assert.deepEqual(wakeSeconds(bad), { error: 'wake_invalid' }, String(bad));
  }
  assert.equal(FEATURES.screen.writable && FEATURES.brightness.writable, true);
  assert.deepEqual(
    Object.keys(FEATURES).filter((k) => FEATURES[k].writable),
    ['screen', 'brightness'],
  );
});

test('PacketGuard: a packet announced over the limit cuts before it is read', async () => {
  const guard = new PacketGuard(1024);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e));
  // A small PUBLISH, then a header announcing 2 MB: the small one passes, then the cut.
  const small = Buffer.from([0x30, 0x03, 0x00, 0x01, 0x61]);
  const big = Buffer.from([0x30, 0x80, 0x80, 0x80, 0x01]);
  guard.write(Buffer.concat([small, big]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Buffer.concat(out), small);
  assert.equal(errors[0]?.code, 'PACKET_TOO_LARGE');
  assert.equal(MAX_PACKET, 64 * 1024);
});

test('PacketGuard: split headers and bodies are followed across chunks', async () => {
  const guard = new PacketGuard(1024);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e));
  const body = Buffer.alloc(200, 1);
  const packet = Buffer.concat([Buffer.from([0x30, 0xc8, 0x01]), body]);
  for (let i = 0; i < packet.length; i += 7) {
    guard.write(packet.subarray(i, i + 7));
  }
  guard.write(Buffer.from([0x30, 0xff]));
  guard.write(Buffer.from([0xff, 0xff, 0xff]));
  await new Promise((r) => setImmediate(r));
  assert.equal(Buffer.concat(out).length, packet.length + 2);
  assert.equal(errors[0]?.code, 'PACKET_TOO_LARGE', 'malformed length');
});

test('errors: readable, never a password', () => {
  assert.equal(errorReason({ code: 5 }), 'not authorized');
  assert.equal(errorReason({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(
    errorReason(new Error('connect mqtt://user:S3cret@host failed')),
    'connect mqtt://host failed',
  );
  assert.ok(isRefusal({ code: 4 }) && isRefusal({ code: 135 }) && !isRefusal({ code: 3 }));
});

test('publisher: budget per minute and spacing on the monotonic clock', async () => {
  const clock = testClock();
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: console,
    monotonic: clock.monotonic,
    timers: clock.timers,
    budget: 5,
  });
  p.start();
  for (let i = 0; i < 10; i += 1) {
    p.push(`f${i}`, { state: i });
  }
  await clock.advance(1000);
  assert.equal(sent.length, 5, 'the budget');
  await clock.advance(30_000);
  assert.equal(sent.length, 5, 'still within the minute');
  await clock.advance(31_000);
  assert.equal(sent.length, 10);
  // A measurement: at most one per measurementInterval (once the minute is over).
  await clock.advance(61_000);
  p.push('m', { state: 1 }, { throttle: true });
  await clock.advance(1000);
  p.push('m', { state: 2 }, { throttle: true });
  await clock.advance(1000);
  assert.equal(sent.filter((s) => s.device_feature_external_id === 'm').length, 1);
  await clock.advance(TIMINGS.measurementInterval);
  assert.equal(sent.filter((s) => s.device_feature_external_id === 'm').length, 2);
  p.stop();
  assert.equal(clock.pending, 0);
});

test('publisher: a failed send keeps the values, waits, warns once', async () => {
  const clock = testClock();
  let fail = true;
  const sent = [];
  const warnings = [];
  let calls = 0;
  const gladys = {
    publishChangedStates: async (batch) => {
      calls += 1;
      if (fail) {
        throw new Error('503');
      }
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: { warn: (m) => warnings.push(m) },
    monotonic: clock.monotonic,
    timers: clock.timers,
    budget: 100,
  });
  p.start();
  p.push('a', { state: 1 });
  p.push('b', { state: 1 });
  await clock.advance(1000);
  p.push('a', { state: 2 });
  // Gladys down for 20 s: tries spaced 5 s, 10 s..., one warning.
  await clock.advance(20_000);
  assert.ok(warnings.length === 1, `${warnings.length} warnings`);
  assert.ok(calls <= 4, `${calls} tries in 21 s: spaced 5 s, 10 s, 20 s`);
  fail = false;
  await clock.advance(30_000);
  assert.deepEqual(
    sent.map((s) => [s.device_feature_external_id, s.state]).sort(),
    [
      ['a', 2],
      ['b', 1],
    ],
    'every value kept, the newer one wins',
  );
  p.stop();
});

test('publisher: every motion transition is sent, in order, one per round', async () => {
  const clock = testClock();
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: console,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  p.start();
  p.push('m', { state: 1 }, { transitions: true });
  p.push('m', { state: 0 }, { transitions: true });
  p.push('m', { state: 0 }, { transitions: true });
  p.push('m', { state: 1 }, { transitions: true });
  await clock.advance(1000);
  assert.deepEqual(
    sent.map((s) => s.state),
    [1],
  );
  await clock.advance(3000);
  assert.deepEqual(
    sent.map((s) => s.state),
    [1, 0, 1],
    'the same state twice kept once',
  );
  // A plain feature keeps only its last value.
  p.push('s', { state: 1 });
  p.push('s', { state: 0 });
  await clock.advance(1000);
  assert.deepEqual(
    sent.filter((s) => s.device_feature_external_id === 's').map((s) => s.state),
    [0],
  );
  // At most 4 waiting: the oldest ones dropped, the newest kept.
  for (let i = 0; i < 10; i += 1) {
    p.push('q', { state: i % 2 }, { transitions: true });
  }
  await clock.advance(10_000);
  const q = sent.filter((s) => s.device_feature_external_id === 'q').map((s) => s.state);
  assert.equal(q.length, 5);
  assert.equal(q.at(-1), 1);
  p.forget('q');
  p.stop();
});

test('memory: bounded, never a secret, unknown keys dropped', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.deepEqual(normalizeMemory(null, now), { auth: { failures: 0, until: 0 } });
  const m = normalizeMemory(
    { auth: { failures: 3, until: now + 365 * 86400_000 }, password: 'x' },
    now,
  );
  assert.equal(m.auth.until, now + TIMINGS.authRetry.at(-1), 'capped');
  assert.equal(normalizeMemory({ auth: { failures: 2, until: now - 1 } }, now).auth.until, 0);
  assert.equal(
    normalizeMemory(JSON.parse('{"__proto__":{"auth":{"failures":9}}}'), now).auth.failures,
    0,
  );
  assert.equal(authWait(1), 15 * 60_000);
  assert.equal(authWait(99), 24 * 3600_000);
});

test('file store: 0600, atomic, a broken file is read as nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wallpanel-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ auth: { failures: 1, until: 5 } });
  assert.deepEqual(await store.load(), { auth: { failures: 1, until: 5 } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  assert.equal(await store.load(), null, 'not ours: rewritten at the next save');
  await writeFile(path, 'x'.repeat(5000));
  assert.equal(await store.load(), null, 'too large: never read in full');
  // Unreadable is not empty: the read rejects (here EISDIR).
  await assert.rejects(fileStore(dir).load());
});

test('age: seconds, minutes, hours', () => {
  assert.equal(age(5000), '5 s');
  assert.equal(age(15 * 60_000), '15 min');
  assert.equal(age(3600_000), '1 h');
  assert.equal(age(24 * 3600_000), '24 h');
});
