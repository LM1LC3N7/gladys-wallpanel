# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for WallPanel (the Android wall
tablet app): a Node.js service (Node 22+, ESM, no build step) that runs in its
own sandboxed Docker container, reads the MQTT topics WallPanel publishes on
the broker of the user and publishes its documented commands (`mqtt`), and
talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner (memcap on this VM)
node --test test/app.test.js              # one file
node --test --test-name-pattern "speak"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js, handlers before connect())
src/handlers.js                   the SDK handlers -> WallPanelApp (also used by the tests)
src/app.js                        broker connection, messages, commands, Discovery, status, test button
src/tablet.js                     WallPanel topics -> features, strict parsers, buildDevice, commands (pure)
src/mqtt.js                       mqtt.js over a guarded socket (PacketGuard), MQTT 5 maximumPacketSize
src/publisher.js                  states within 250/min, measurements 10 s apart (monotonic clock)
src/store.js                      /data/wallpanel-state.json: the stop after refused credentials only
src/config.js, src/constants.js   configuration (DEFAULT_CONFIG mirrors the manifest), keys, timings
src/i18n.js                       feature names, statuses (en/fr)
scripts/mutants.mjs + .json       mutation check of the guards (not in the image, not in CI)
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, SDK fake Gladys, fake broker, broker on 127.0.0.1, virtual clock
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Commands.** Only the commands WallPanel documents, published on
  `<prefix>/<tablet>/command`, QoS 0, never retained, from `sendCommand` only
  (`test/manifest.test.js` counts the `.publish(` calls). Never `eval`,
  `audio`, `camera`, `settings` nor `clearCache` without a decision of the
  maintainer. Never log a spoken text nor a URL sent.
- **Privacy.** The page displayed is published without query, fragment nor
  user information; QR codes and images are never read.
- **Freshness.** A retained state or sensor is never read (WallPanel never
  retains them); only `connection` is read retained.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave 127.0.0.1.
