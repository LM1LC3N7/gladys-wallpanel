# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-14

### Added

- WallPanel tablets read from the local MQTT broker of the user: battery,
  charging, light, temperature, pressure, humidity, camera motion and face
  detection, screen awake, screen brightness and page displayed (http/https
  without query, fragment nor user information; any other scheme as the
  scheme alone).
- Commands: wake the screen or let it sleep, screen brightness (1 to 255);
  scene actions to speak a text, show a URL (http/https only), reload the
  page, go back to the home page and wake the screen for a time. QoS 0, never
  retained; refused with nothing sent while the broker is down, while the
  tablet is offline or beyond 30 commands a minute per tablet.
- Topic prefix option (`wallpanel` by default); at most 30 tablets.
- Retained states and sensors ignored; values read in the last 2 h sent dated
  to a device created later; every motion and face transition sent.
- Refused credentials: a stop persisted in `/data`, next tries 15 min, 1 h,
  6 h, then every 24 h; messages bounded before they are read (MQTT 5
  `maximumPacketSize` and a guard on the socket); MQTT 3.1.1 fallback.
- "Test the connection" button naming the tablets heard.

[Unreleased]: https://github.com/LM1LC3N7/gladys-wallpanel/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-wallpanel/releases/tag/v0.1.1
