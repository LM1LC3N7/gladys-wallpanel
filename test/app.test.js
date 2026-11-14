// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, a fake broker, a virtual clock
// that moves (each read 1 µs, timers fired by advance()).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import {
  BASE,
  CONFIG,
  DEVICE,
  F,
  MINUTE,
  PASSWORD,
  SECOND,
  STATE,
  commandsOf,
  createdTablet,
  deliverTablet,
  settle,
  setup,
  statesOf,
  statusText,
  until,
  within,
} from './helpers/app.js';

const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

test('Discovery: a tablet from its topics, commands on screen and brightness only', async () => {
  const { gladys, mqtt, clock } = await setup();
  assert.deepEqual(mqtt.last.subscriptions, [
    'wallpanel/+/state',
    'wallpanel/+/sensor/+',
    'wallpanel/+/connection',
  ]);
  deliverTablet(mqtt.last);
  await clock.advance(3 * SECOND);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE());
  assert.equal(device.name, 'WallPanel kitchen');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    [
      'screen',
      'brightness',
      'url',
      'battery',
      'charging',
      'light',
      'temperature',
      'pressure',
      'humidity',
    ],
    'magneticField never read',
  );
  for (const f of device.features) {
    const writable = ['screen', 'brightness'].includes(f.external_id.split(':').at(-1));
    assert.equal(f.read_only, !writable, f.external_id);
    assert.equal(f.has_feedback, writable, f.external_id);
  }
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(gladys), /1 WallPanel tablet/);
  assert.equal(mqtt.last.published.length, 0, 'nothing published without a command');
});

test('a tablet heard only on its connection topic is listed with its commands', async () => {
  const { gladys, mqtt, clock } = await setup();
  mqtt.last.deliver('wallpanel/hall/connection', 'online', { retain: true });
  await clock.advance(3 * SECOND);
  const [device] = gladys.fake.discoveredDevices;
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['screen', 'brightness'],
  );
});

test('live values of created features are sent; the URL without query; measurements spaced', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverTablet(mqtt.last);
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('screen')), 1);
  assert.equal(gladys.fake.lastState(F('brightness')), 120);
  assert.equal(gladys.fake.lastState(F('url')), 'http://gladys.local/dashboard');
  assert.equal(gladys.fake.lastState(F('battery')), 39);
  assert.equal(gladys.fake.lastState(F('charging')), 1);
  assert.equal(gladys.fake.lastState(F('light')), 920);
  assert.equal(gladys.fake.lastState(F('temperature')), 24);
  assert.equal(gladys.fake.lastState(F('pressure')), 1011.6);
  assert.equal(gladys.fake.lastState(F('humidity')), 45.5);
  // Every state is dated by Gladys (no created_at: a live value starts scenes).
  assert.ok(gladys.fake.states.every((s) => s.created_at === undefined));
  // A new light every second: sent at most every 10 s.
  for (let i = 0; i < 8; i += 1) {
    mqtt.last.deliver(`${BASE()}sensor/light`, JSON.stringify({ unit: 'lx', value: 100 + i }));
    await clock.advance(SECOND);
  }
  assert.equal(statesOf(gladys, F('light')).length, 1);
  await clock.advance(3 * SECOND);
  assert.equal(statesOf(gladys, F('light')).length, 2);
  assert.equal(gladys.fake.lastState(F('light')), 107);
  // The screen goes off: sent at once, never spaced.
  mqtt.last.deliver(`${BASE()}state`, JSON.stringify({ ...STATE, screenOn: false }));
  await clock.advance(SECOND);
  assert.equal(gladys.fake.lastState(F('screen')), 0);
  const secret = JSON.stringify([gladys.fake.states, gladys.fake.requests]);
  assert.ok(!secret.includes('token=abc'), 'the query of the URL never leaves');
});

test('motion and face: every transition reaches Gladys, a short true included', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver(`${BASE()}sensor/motion`, '{"value":true}');
  mqtt.last.deliver(`${BASE()}sensor/motion`, '{"value":false}');
  mqtt.last.deliver(`${BASE()}sensor/face`, '{"value":true}');
  await clock.advance(3 * SECOND);
  assert.deepEqual(
    statesOf(gladys, F('motion')).map((s) => s.state),
    [1, 0],
  );
  assert.deepEqual(
    statesOf(gladys, F('face')).map((s) => s.state),
    [1],
  );
  const names = gladys.fake.discoveredDevices[0].features.map((f) => f.category);
  assert.ok(names.includes('motion-sensor') && names.includes('presence-sensor'));
});

test('retained states and sensors are old: never read; text never a number, unknown never 0', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock, logger } = await setup({ devices: [device] });
  deliverTablet(mqtt.last, { retain: true });
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.states.length, 0);
  assert.ok(logger.lines.some((l) => /retained state message was ignored/.test(l)));
  mqtt.last.deliver(`${BASE()}sensor/battery`, '{"unit":"%","value":""}');
  mqtt.last.deliver(`${BASE()}sensor/temperature`, '{"unit":"°C","value":"hot"}');
  mqtt.last.deliver(`${BASE()}state`, '{"brightness":"","screenOn":null}');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, 0);
});

test('created after the values arrived: the recent ones sent dated, the old ones never', async () => {
  const { gladys, mqtt, clock } = await setup();
  const readAt = clock.now();
  deliverTablet(mqtt.last, { sensors: { battery: { value: 50 } } });
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.states.length, 0, 'nothing created yet');
  const device = createdTablet({ features: ['battery', 'screen', 'brightness', 'url'] });
  gladys.fake.devices.push(device);
  await gladys.fake.deviceCreated(device);
  await clock.advance(2 * SECOND);
  const battery = statesOf(gladys, F('battery'));
  assert.equal(battery.length, 1);
  assert.equal(battery[0].state, 50);
  const dated = Date.parse(battery[0].created_at);
  assert.ok(Math.abs(dated - readAt) < 10, 'dated when read: no scene starts on it');
  // Another tablet read 3 h before its creation: nothing.
  deliverTablet(mqtt.last, { tablet: 'hall', sensors: { battery: { value: 60 } } });
  await clock.advance(3 * 60 * MINUTE);
  const hall = createdTablet({ tablet: 'hall', features: ['battery'] });
  gladys.fake.devices.push(hall);
  await gladys.fake.deviceCreated(hall);
  await clock.advance(2 * SECOND);
  assert.equal(statesOf(gladys, F('battery', 'hall')).length, 0);
});

test('a reconnection to Gladys sends no value again', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverTablet(mqtt.last);
  await clock.advance(2 * SECOND);
  const count = gladys.fake.states.length;
  assert.ok(count >= 9);
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(5 * SECOND);
  assert.equal(gladys.fake.states.length, count);
  assert.equal(mqtt.clients.length, 1, 'the MQTT client kept');
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'Discovery sent again');
});

test('commands: screen and brightness on the command topic, QoS 0, never retained', async () => {
  const device = createdTablet();
  const { gladys, mqtt } = await setup({ devices: [device] });
  const screen = featureOf(device, 'screen');
  const brightness = featureOf(device, 'brightness');
  assert.equal((await within(gladys.fake.setValue(device, screen, 1))).success, true);
  assert.equal((await within(gladys.fake.setValue(device, screen, 0))).success, true);
  assert.equal((await within(gladys.fake.setValue(device, brightness, 0))).success, true);
  assert.equal((await within(gladys.fake.setValue(device, brightness, 300))).success, true);
  assert.equal((await within(gladys.fake.setValue(device, brightness, 99.6))).success, true);
  assert.deepEqual(commandsOf(mqtt.last), [
    {
      topic: 'wallpanel/kitchen/command',
      payload: { wake: true },
      options: { qos: 0, retain: false },
    },
    {
      topic: 'wallpanel/kitchen/command',
      payload: { wake: false },
      options: { qos: 0, retain: false },
    },
    {
      topic: 'wallpanel/kitchen/command',
      payload: { brightness: 1 },
      options: { qos: 0, retain: false },
    },
    {
      topic: 'wallpanel/kitchen/command',
      payload: { brightness: 255 },
      options: { qos: 0, retain: false },
    },
    {
      topic: 'wallpanel/kitchen/command',
      payload: { brightness: 100 },
      options: { qos: 0, retain: false },
    },
  ]);
  // Gladys shows what the tablet reports, never an assumed value.
  assert.equal(gladys.fake.states.length, 0);
});

test('commands refused with nothing sent: read only, odd value, another device, broker down, offline', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  const refused = async (promise, pattern) => {
    const ack = await within(promise);
    assert.equal(ack.success, false);
    assert.match(ack.error, pattern);
  };
  await refused(gladys.fake.setValue(device, featureOf(device, 'battery'), 1), /lecture seule/);
  await refused(gladys.fake.setValue(device, featureOf(device, 'screen'), 2), /pas valide/);
  await refused(gladys.fake.setValue(device, featureOf(device, 'screen'), NaN), /pas valide/);
  const other = { ...device, external_id: 'ext:other:tablet:kitchen' };
  await refused(gladys.fake.setValue(other, featureOf(device, 'screen'), 1), /pas de cette/);
  mqtt.last.deliver('wallpanel/kitchen/connection', 'offline', { retain: true });
  await settle();
  await refused(gladys.fake.setValue(device, featureOf(device, 'screen'), 1), /hors ligne/);
  await refused(gladys.fake.sceneAction('speak', { tablet: DEVICE(), text: 'Hi' }), /hors ligne/);
  assert.match(statusText(gladys), /1 offline/);
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  mqtt.last.deliver('wallpanel/kitchen/connection', 'online', { retain: true });
  await settle();
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  mqtt.last.close();
  await settle();
  await refused(gladys.fake.setValue(device, featureOf(device, 'screen'), 1), /broker MQTT/);
  assert.equal(mqtt.last.published.length, 0, 'nothing ever sent');
});

test('a live message from a tablet said offline brings it back online', async () => {
  const device = createdTablet();
  const { gladys, mqtt } = await setup({ devices: [device] });
  mqtt.last.deliver('wallpanel/kitchen/connection', 'offline', { retain: true });
  mqtt.last.deliver('wallpanel/kitchen/state', JSON.stringify(STATE));
  await settle();
  assert.equal(
    (await within(gladys.fake.setValue(device, featureOf(device, 'screen'), 1))).success,
    true,
  );
});

test('commands: answered under 3.5 s, "maybe sent" when the broker does not take it, never a success', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock, app } = await setup({ devices: [device] });
  mqtt.last.holdPublish = true;
  const start = clock.elapsed;
  const pending = gladys.fake.setValue(device, featureOf(device, 'screen'), 1);
  await settle();
  await clock.advance(3 * SECOND);
  const ack = await within(pending);
  assert.equal(ack.success, false);
  assert.match(ack.error, /recevra peut-être/);
  assert.ok(clock.elapsed - start < 3500);
  mqtt.last.holdPublish = false;
  mqtt.last.failPublish = true;
  const failed = await within(gladys.fake.setValue(device, featureOf(device, 'screen'), 1));
  assert.match(failed.error, /Rien envoyé/);
  mqtt.last.failPublish = false;
  mqtt.last.throwOnPublish = true;
  const thrown = await within(gladys.fake.setValue(device, featureOf(device, 'screen'), 1));
  assert.match(thrown.error, /Rien envoyé/);
  // A command still waiting when the app stops: answered at once, no timer left.
  mqtt.last.throwOnPublish = false;
  mqtt.last.holdPublish = true;
  const last = gladys.fake.setValue(device, featureOf(device, 'screen'), 1);
  await settle();
  app.stop();
  assert.match((await within(last)).error, /peut-être/);
  assert.equal(clock.pending, 0);
});

test('commands: at most 30 a minute per tablet, the others still served', async () => {
  const kitchen = createdTablet();
  const hall = createdTablet({ tablet: 'hall' });
  const { gladys, mqtt, clock } = await setup({ devices: [kitchen, hall] });
  for (let i = 0; i < LIMITS.commandsPerMinute; i += 1) {
    assert.equal(
      (await gladys.fake.sceneAction('reload_page', { tablet: DEVICE() })).success,
      true,
    );
  }
  const flood = await gladys.fake.sceneAction('reload_page', { tablet: DEVICE() });
  assert.match(flood.error, /plus de 30 commandes/);
  assert.equal(
    (await gladys.fake.sceneAction('reload_page', { tablet: DEVICE('hall') })).success,
    true,
  );
  assert.equal(mqtt.last.published.length, LIMITS.commandsPerMinute + 1);
  await clock.advance(MINUTE);
  assert.equal((await gladys.fake.sceneAction('reload_page', { tablet: DEVICE() })).success, true);
});

test('scene actions: speak, URL, reload, home page, wake; texts and URLs never logged', async () => {
  const device = createdTablet();
  const { gladys, mqtt, logger } = await setup({ devices: [device] });
  const run = (key, fields) =>
    within(gladys.fake.sceneAction(key, { tablet: DEVICE(), ...fields }));
  assert.equal((await run('speak', { text: 'Dinner\nis ready' })).success, true);
  assert.equal((await run('show_url', { url: 'https://gladys.local/cam?key=K3Y' })).success, true);
  assert.equal((await run('reload_page', {})).success, true);
  assert.equal((await run('show_home_page', {})).success, true);
  assert.equal((await run('wake_screen', {})).success, true);
  assert.equal((await run('wake_screen', { seconds: 180 })).success, true);
  assert.deepEqual(
    commandsOf(mqtt.last).map((c) => c.payload),
    [
      { speak: 'Dinner is ready' },
      { url: 'https://gladys.local/cam?key=K3Y' },
      { reload: true },
      { relaunch: true },
      { wake: true },
      { wake: true, wakeTime: 180 },
    ],
  );
  for (const [key, fields, pattern] of [
    ['speak', { text: '  ' }, /vide/],
    ['show_url', { url: 'javascript:alert(1)' }, /http/],
    ['show_url', { url: 'http://admin:pw@cam/' }, /mot de passe/],
    ['wake_screen', { seconds: 0 }, /entier/],
    ['speak', { tablet: 'ext:test-integration:tablet:a.b', text: 'x' }, /pas de cette/],
    ['speak', { tablet: undefined, text: 'x' }, /pas de cette/],
  ]) {
    const ack = await run(key, fields);
    assert.equal(ack.success, false, key);
    assert.match(ack.error, pattern, key);
  }
  assert.equal(mqtt.last.published.length, 6, 'a refused action sends nothing');
  const logs = logger.lines.join('\n');
  assert.ok(!logs.includes('Dinner') && !logs.includes('K3Y'), 'never the text nor the URL');
  assert.match(logs, /Command sent to the tablet kitchen: speak/);
});

test('a scene on 5 tablets reaches the 5 of them', async () => {
  const tablets = ['t1', 't2', 't3', 't4', 't5'];
  const devices = tablets.map((tablet) => createdTablet({ tablet }));
  const { gladys, mqtt } = await setup({ devices });
  const acks = await within(
    Promise.all(
      tablets.map((t) => gladys.fake.sceneAction('speak', { tablet: DEVICE(t), text: 'Go' })),
    ),
  );
  assert.ok(acks.every((a) => a.success));
  assert.deepEqual(
    mqtt.last.published.map((p) => p.topic).sort(),
    tablets.map((t) => `wallpanel/${t}/command`),
  );
});

test('a custom prefix: its own topics, the same ids', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({
    config: { ...CONFIG, topic_prefix: 'home/tablets' },
    devices: [device],
  });
  assert.deepEqual(mqtt.last.subscriptions, [
    'home/tablets/+/state',
    'home/tablets/+/sensor/+',
    'home/tablets/+/connection',
  ]);
  deliverTablet(mqtt.last, { prefix: 'home/tablets' });
  mqtt.last.deliver('wallpanel/kitchen/state', JSON.stringify({ ...STATE, brightness: 1 }));
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('brightness')), 120, 'another prefix never read');
  await gladys.fake.setValue(device, featureOf(device, 'screen'), 1);
  assert.equal(mqtt.last.published[0].topic, 'home/tablets/kitchen/command');
});

test(`at most ${LIMITS.tablets} tablets, said in the status`, async () => {
  const { gladys, mqtt, clock } = await setup();
  for (let i = 0; i < LIMITS.tablets + 2; i += 1) {
    mqtt.last.deliver(`wallpanel/t${i}/connection`, 'online');
  }
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, LIMITS.tablets);
  assert.match(statusText(gladys), /2 other tablet\(s\) ignored/);
});

test('an odd message (too large, not UTF-8, not JSON) is ignored, the others still read', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver(`${BASE()}state`, Buffer.from([0xff, 0xfe]));
  mqtt.last.deliver(`${BASE()}state`, `{"currentUrl":"${'a'.repeat(5000)}"}`);
  mqtt.last.deliver(`${BASE()}sensor/light`, 'not json');
  mqtt.last.deliver(`${BASE()}sensor/light`, '[1,2]');
  mqtt.last.deliver(`${BASE()}sensor/light`, '{"value":5}');
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F('light')), 5);
  // A readable value in a payload over 4 KB: never read.
  await clock.advance(10 * SECOND);
  mqtt.last.deliver(`${BASE()}sensor/light`, `{"value":7,"pad":"${'a'.repeat(4100)}"}`);
  await clock.advance(2 * SECOND);
  assert.ok(statesOf(gladys, F('light')).every((s) => s.state !== 7));
});

test('Transport badge: unreachable when the broker is lost', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  deliverTablet(mqtt.last);
  await clock.advance(3 * SECOND);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  mqtt.last.close();
  await settle();
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.match(statusText(gladys), /lost/);
});

test('no WallPanel message: the status says so after a minute', async () => {
  const { gladys, clock } = await setup();
  assert.match(statusText(gladys), /waiting for the tablets/);
  await clock.advance(61 * SECOND);
  assert.match(statusText(gladys), /no WallPanel tablet on wallpanel\//);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('refused credentials: persisted stop, no retry before 15 min, never the password', async () => {
  const store = memoryStore();
  const { gladys, mqtt, clock, logger } = await setup({ store, open: false });
  mqtt.last.refuse(5);
  await settle();
  assert.equal(mqtt.clients.length, 1);
  assert.ok(mqtt.last.ended);
  assert.match(statusText(gladys), /refused.*15 min/);
  assert.equal(store.data.auth.failures, 1);
  await clock.advance(14 * MINUTE);
  assert.equal(mqtt.clients.length, 1, 'no retry before the end of the stop');
  await clock.advance(2 * MINUTE);
  assert.equal(mqtt.clients.length, 2);
  mqtt.last.refuse(5);
  await settle();
  assert.match(statusText(gladys), /1 h/);
  const everything = JSON.stringify([
    store.data,
    gladys.fake.requests,
    gladys.fake.connectionStatuses,
    logger.lines,
  ]);
  assert.ok(!everything.includes(PASSWORD));
});

test('the stop survives a restart; other credentials lift it', async () => {
  const store = memoryStore();
  const first = await setup({ store, open: false });
  first.mqtt.last.refuse(4);
  await settle();
  first.app.stop();
  const clock = first.clock;
  const second = await setup({ store, open: false, clock });
  assert.equal(second.mqtt.clients.length, 0, 'still stopped after the restart');
  assert.match(statusText(second.gladys), /Stopped/);
  await second.gladys.fake.configUpdated({ ...CONFIG, password: 'another' });
  assert.equal(second.mqtt.clients.length, 1, 'new credentials: tried at once');
  second.mqtt.last.open();
  await settle();
  assert.equal(store.data.auth.failures, 0);
});

test('/data unreadable: no connection, read again, never written over', async () => {
  const store = memoryStore();
  let fail = 2;
  const load = store.load.bind(store);
  store.load = () =>
    fail-- > 0 ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : load();
  const { gladys, mqtt, clock } = await setup({ store, open: false });
  assert.equal(mqtt.clients.length, 0);
  assert.match(statusText(gladys), /\/data could not be read/);
  await clock.advance(10 * SECOND);
  assert.equal(mqtt.clients.length, 0);
  await clock.advance(10 * SECOND);
  assert.equal(mqtt.clients.length, 1, 'read at the third try, then connected');
  assert.equal(store.saves, 0);
});

test('a CONNECT swallowed twice with credentials counts as a refusal', async () => {
  const { gladys, mqtt, app } = await setup({ open: false });
  const hooks = mqtt.last.options;
  for (let i = 0; i < 2; i += 1) {
    hooks.onAttempt();
    hooks.onOpen();
    mqtt.last.emit('close');
    await settle();
  }
  assert.match(statusText(gladys), /refused/);
  assert.equal(app.memory.auth.failures, 1);
});

test('MQTT 5 refused: 3.1.1, said in the status', async () => {
  const { gladys, mqtt, clock } = await setup({ open: false });
  mqtt.last.refuse(1);
  await settle();
  assert.equal(mqtt.clients.length, 2);
  assert.equal(mqtt.last.options.protocolVersion, 4);
  mqtt.last.open();
  deliverTablet(mqtt.last);
  await clock.advance(3 * SECOND);
  assert.match(statusText(gladys), /MQTT 3\.1\.1/);
});

test('getConfig failing in connected: retried, spaced, without end, then the start', async () => {
  // Each call: true = answered. The SDK's own resynchronization of connect()
  // comes first (it must succeed, else the SDK closes); then the app's reads.
  const plan = [true, false, false, false];
  const { gladys, mqtt, clock } = await setup({
    open: false,
    getConfig: (original) =>
      plan.length === 0 || plan.shift() ? original() : Promise.reject(new Error('timeout')),
  });
  assert.equal(mqtt.clients.length, 0);
  assert.match(statusText(gladys), /could not be read.*5 s/);
  await clock.advance(5 * SECOND);
  assert.match(statusText(gladys), /15 s/);
  await clock.advance(15 * SECOND);
  assert.match(statusText(gladys), /60 s/);
  assert.equal(mqtt.clients.length, 0);
  await clock.advance(MINUTE);
  assert.equal(mqtt.clients.length, 1, 'started once the configuration was read');
  // Gladys reconnects and the read fails once more: the client is kept, the read retried.
  plan.push(true, false);
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.match(statusText(gladys), /could not be read/);
  await clock.advance(5 * SECOND);
  assert.equal(mqtt.clients.length, 1);
  assert.match(statusText(gladys), /Connecting|waiting|no WallPanel/);
});

test('configuration problems are said, nothing is connected', async () => {
  for (const [config, pattern] of [
    [{ broker_url: '' }, /Type the address/],
    [{ broker_url: 'http://x' }, /not valid/],
    [{ broker_url: 'mqtt://u:p@host' }, /own fields/],
    [{ broker_url: '0.0.0.0' }, /not valid/],
    [{ broker_url: 'host', password: 'p' }, /without a user name/],
    [{ broker_url: 'host', username: 'a\r\nb' }, /control character/],
    [{ broker_url: 'host', topic_prefix: 'a/#' }, /prefix/],
    [{ broker_url: 'host', topic_prefix: 'a/b/c/d' }, /prefix/],
  ]) {
    const { gladys, mqtt } = await setup({ config, open: false });
    assert.equal(mqtt.clients.length, 0, JSON.stringify(config));
    assert.match(statusText(gladys), pattern);
  }
});

test('Test the connection: names the tablets, cooldown, says when nothing comes', async () => {
  const { gladys, mqtt, clock } = await setup();
  const pending = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 2, 'the probe');
  const probe = mqtt.last;
  const again = await within(gladys.fake.action('test_connection', {}));
  assert.match(again.data.message.en, /Wait/);
  assert.equal(mqtt.clients.length, 2, 'a click in the cooldown reaches nothing');
  probe.open();
  deliverTablet(probe);
  deliverTablet(probe, { tablet: 'hall' });
  await clock.advance(11 * SECOND);
  const answer = await within(pending);
  assert.match(answer.data.message.en, /2 WallPanel tablet\(s\) heard: kitchen, hall/);
  assert.ok(probe.ended);
  assert.equal(probe.published.length, 0, 'the test sends no command');
  await clock.advance(11 * SECOND);
  const second = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 3, 'the second probe');
  mqtt.last.open();
  await clock.advance(12 * SECOND);
  assert.match((await within(second)).data.message.en, /no WallPanel tablet/);
});

test('Test the connection after a refusal: the stop is lifted when the broker accepts', async () => {
  const { gladys, mqtt, app, clock } = await setup({ open: false });
  mqtt.last.refuse(5);
  await settle();
  assert.equal(app.memory.auth.failures, 1);
  const pending = gladys.fake.action('test_connection', {});
  await until(() => mqtt.clients.length === 2, 'the probe');
  mqtt.last.open();
  await clock.advance(12 * SECOND);
  await within(pending);
  assert.equal(app.memory.auth.failures, 0);
  assert.equal(mqtt.clients.length, 3, 'reconnected at once');
});

test('a deleted device: nothing more sent; stop() leaves no timer', async () => {
  const device = createdTablet();
  const { gladys, mqtt, clock, app } = await setup({ devices: [device] });
  gladys.fake.devices.length = 0;
  await gladys.fake.deviceDeleted(device);
  deliverTablet(mqtt.last);
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, 0);
  app.stop();
  assert.equal(clock.pending, 0, 'no timer after stop()');
  assert.ok(mqtt.last.ended);
});

test('a scan publishes the list now; names follow the language option', async () => {
  const { gladys, mqtt, clock } = await setup({ config: { ...CONFIG, language: 'en' } });
  deliverTablet(mqtt.last);
  await clock.advance(3 * SECOND);
  const before = gladys.fake.requests.length;
  await gladys.fake.scanRequest();
  assert.ok(gladys.fake.requests.length > before);
  const names = gladys.fake.discoveredDevices[0].features.map((f) => f.name);
  assert.ok(names.includes('Screen awake') && names.includes('Battery'));
  await gladys.fake.configUpdated({ ...CONFIG, language: 'fr' });
  await clock.advance(SECOND);
  assert.equal(mqtt.clients.length, 1, 'the language needs no reconnection');
  assert.ok(gladys.fake.discoveredDevices[0].features.some((f) => f.name === 'Batterie'));
});

test('a created feature the build lacks is kept (no "Update")', async () => {
  const device = createdTablet({ features: ['battery', 'humidity'] });
  const { gladys, mqtt, clock } = await setup({ devices: [device] });
  mqtt.last.deliver(`${BASE()}sensor/battery`, '{"value":50}');
  await clock.advance(3 * SECOND);
  const ids = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(ids.includes(F('humidity')));
});

test('the states stay within 250 per minute', async () => {
  const devices = Array.from({ length: 30 }, (_, i) => createdTablet({ tablet: `t${i}` }));
  const { gladys, mqtt, clock } = await setup({ devices });
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < 30; i += 1) {
      mqtt.last.deliver(`wallpanel/t${i}/sensor/motion`, `{"value":${round % 2 === 0}}`);
      mqtt.last.deliver(
        `wallpanel/t${i}/state`,
        JSON.stringify({ ...STATE, brightness: round + 1, screenOn: round % 2 === 0 }),
      );
    }
    await clock.advance(5 * SECOND);
  }
  assert.ok(gladys.fake.states.length <= 250, `${gladys.fake.states.length} states`);
});
