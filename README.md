# gladys-wallpanel

[Gladys Assistant](https://gladysassistant.com) external integration for
**WallPanel** ([TheTimeWalker/wallpanel-android](https://github.com/TheTimeWalker/wallpanel-android),
Apache-2.0), the Android wall tablet app, over the **local MQTT broker of the
user**: battery, charging, light, temperature, pressure, humidity, camera
motion and face detection, screen awake, brightness and page displayed of
each tablet; commands to wake the screen, set the brightness and, in scenes,
speak a text, show a URL, reload, go home. **Never tested with a real
tablet. Unofficial, not affiliated with WallPanel.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (WallPanelApp)
                                  ├─ src/mqtt.js       mqtt.js client over a guarded socket (packets bounded)
                                  ├─ src/tablet.js     WallPanel topics -> features, strict parsers, commands (pure)
                                  ├─ src/store.js      /data: the stop on refused credentials (no secret)
                                  └─ src/publisher.js  states within 250/min, measurements 10 s apart
```

- **Reads**: subscribes to `<prefix>/+/state`, `<prefix>/+/sensor/+` and
  `<prefix>/+/connection` (prefix `wallpanel` by default), as documented by
  WallPanel (`website/docs/remote-control`). Payloads read strictly; retained
  states and sensors (never WallPanel's) ignored.
- **Commands**: published on `<prefix>/<tablet>/command`, QoS 0, never
  retained; refused with nothing sent while the broker is down, while the
  tablet is offline (its `connection` topic) or beyond 30 per minute and
  tablet. Spoken texts and URLs never logged.
- **Devices**: `ext:<selector>:tablet:<tablet>`; features `<device>:<key>`
  (keys in `src/tablet.js`, frozen); screen and brightness always, the others
  once seen; a created device never loses a feature.
- **Privacy**: the page displayed without query, fragment nor user
  information; no QR code, no image.
- **Failures**: refused credentials stop the client, a stop persisted in
  `/data`, next tries 15 min, 1 h, 6 h, 24 h; an unreachable broker is tried
  every 10 s; the configuration unreadable from Gladys is read again, spaced,
  without end.

Modelled on the sibling integration
[gladys-teslamate](https://github.com/LM1LC3N7/gladys-teslamate) (local MQTT,
guarded socket, refused credentials).

## Development

```bash
npm install
npm test                                        # node --test, no network but 127.0.0.1
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
node scripts/cover.mjs cover.png                # cover.png, plain Node
memcap node scripts/mutants.mjs                 # mutation check of the guards
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never leave the machine: the broker is a fake mqtt.js client
(`test/helpers/fakeMqtt.js`) or a minimal broker on 127.0.0.1
(`test/helpers/broker.js`), Gladys is the SDK's fake, the clock is virtual
(`test/helpers/clock.js`) except in `test/realclock.test.js` and
`test/transport.test.js`.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). WallPanel (Apache-2.0) is neither included nor ported:
only its documented MQTT messages are read and its documented commands sent.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
