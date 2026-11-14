# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## WallPanel (not included)

<https://github.com/TheTimeWalker/wallpanel-android>, the Android wall
tablet app, is licensed under the Apache License 2.0 (`LICENSE` of its
repository, read on 2026-11-14 at commit 2775abc; latest release v0.12.0).
**No part of WallPanel is included, copied or ported here.** This
integration only reads, as any MQTT client does, the messages a running
WallPanel publishes on the broker of the user, and publishes the commands its
documentation describes (`website/docs/remote-control/` of its repository:
`sensors.md`, `commands.md`, `mqtt-setup.md`). The code was written from that
description; WallPanel's sources were read only to confirm the topics and the
payloads (`connection` topic and its online/offline last will, the `state`
fields).

## Runtime dependencies (npm)

Installed by `npm ci` into the image, not modified, each under its own
licence file in `node_modules`:

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK;
- `mqtt` (mqtt.js, MIT, <https://github.com/mqttjs/MQTT.js>), the MQTT client,
  and its dependencies (MIT, ISC, BSD and Apache-2.0 licences, listed by
  `npm ls --omit=dev --all`).

## Gladys-testkit (tests only)

`test/helpers/clock.js` is a copy of `src/clock.mjs` of gladys-testkit
(Apache-2.0, the same author as this integration), and
`test/fixtures/device.crt` / `test/fixtures/device.key` (a self-signed test
certificate and its key, for the TLS test of `test/transport.test.js`) are
copies of its `certs/device.crt` / `certs/device.key`. None of them is part of
the image.
