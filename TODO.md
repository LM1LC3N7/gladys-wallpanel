# TODO — WallPanel v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-14): tablets from the documented
      WallPanel MQTT topics (state, sensors, connection), Discovery, screen
      and brightness commands, scene actions (speak, show a URL, reload, home
      page, wake for a time), topic prefix, refused credentials stop, MQTT 5
      with 3.1.1 fallback, packet guard, "Test the connection", docs en/fr.
      Tested on a fake broker, a minimal broker on 127.0.0.1 and the SDK's
      fake Gladys (virtual clock, plus a real-clock test).
- [ ] **Milestone 2 — real tablet**: run against a real WallPanel (v0.12.0)
      or recorded `mosquitto_sub -v` dumps from testers; check that the
      sensor values arrive as numbers or texts (both read), the `state`
      published after a `wake` / `brightness` command, the behaviour of
      `wake: false` on the screen state.
- [ ] **Milestone 3 — more**: the REST API of WallPanel (`/api/state`,
      `/api/command`, port 2971) for tablets without MQTT (state and
      commands only: no sensors there); `volume` with an audio URL action
      (`audio`), bounded by an option; QR codes as a scene trigger (opt-in,
      their content can be anything); the camera on/off (privacy: opt-in).
- [ ] **Milestone 4 — first release**: Release workflow, topic, GHCR public.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- WallPanel is Apache-2.0 (LICENSE read at commit 2775abc, release v0.12.0):
  nothing of it is copied; the topics, payloads and commands come from its
  docs (`website/docs/remote-control`), its sources read only to confirm the
  `connection` topic (online/offline, retained last will) and the `state`
  fields.
- MQTT only in v1: the REST API has no sensor (state and commands only), and
  the MQTT broker is what the brief's neighbour (TeslaMate) already uses.
- Identity: `tablet:<level of the base topic>` (`wallpanel/kitchen/` ->
  `tablet:kitchen`), letters, digits, `_` and `-`, 64 at most; the prefix
  (1 to 3 levels, `wallpanel` by default) is not in the id.
- Screen as `switch`/`binary` and brightness as `switch`/`dimmer` (1-255):
  neither is a sensitive action of the rules (no opening, heating...); a
  "turn everything off" only lets the screens sleep. `has_feedback: true`:
  Gladys shows what the tablet reports, the app never publishes an assumed
  value.
- Commands: QoS 0, never retained (a tablet offline never runs one late,
  Mosquitto queues no QoS 0 for an offline persistent session by default);
  refused with nothing sent when the broker is down, when the tablet said
  "offline", or beyond 30 per minute and tablet; answered under 3.5 s ("maybe
  sent" after 3 s without the socket taking it). WallPanel answers nothing:
  handed to the broker = sent.
- Not offered: `eval` (runs JavaScript), `audio` and `volume`, `camera`,
  `settings`, `clearCache`. URLs sent: http/https only, no user information
  (clear on the broker). Spoken text: control characters made spaces, 500
  characters at most.
- Not read: magneticField (no Gladys type), qrcode (content can be anything),
  camera state. Face detection as `presence-sensor`.
- The page displayed published without query, fragment nor user information
  (a dashboard URL may carry a token), 200 characters at most.
- Freshness: retained `state` / `sensor` never read (WallPanel never retains
  them); `connection` read retained (WallPanel's last will). A device created
  later gets the values read in the last 2 h, dated (created_at). Motion and
  face keep every transition (at most 4 waiting).
- Units: only DEVICE_FEATURE_UNITS_BY_CATEGORY (lux, celsius, hPa, percent);
  a payload announcing another unit is unknown, never converted.
- 250 states per minute, measurements 10 s apart per feature; at most 30
  tablets; packets 64 KB, values 4 KB.
- Manifest: `gladys_version >=5.1.0` (scene actions), category `multimedia`;
  no keywords nor countries (worldwide).
- `.github/workflows/ci.yml`: `timeout-minutes: 20` on the jobs (as the
  sibling integrations): the release tag must be set by hand.

## Forum

No dedicated topic: the recap message of the general thread (/t/10385) at
the first release.
