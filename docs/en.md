# WallPanel for Gladys

[WallPanel](https://github.com/TheTimeWalker/wallpanel-android) is a free
Android app (Apache-2.0) that turns a tablet into a wall dashboard: it shows a
web page (your Gladys dashboard, for example) full screen and publishes the
sensors of the tablet on MQTT. This integration reads what WallPanel publishes
on **your** MQTT broker and sends it the commands its documentation
describes, on your local network: nothing goes through the Internet.

What Gladys gets, per tablet:

- **read**: battery level, charging, ambient light, temperature, pressure,
  humidity (the sensors the tablet has), motion and face detected by the
  camera (when turned on in WallPanel), screen awake, screen brightness, page
  displayed;
- **commands**: wake the screen or let it sleep, set the brightness, and, in
  scenes, speak a text, show a URL, reload the page, go back to the home
  page, wake the screen for a given time.

Never tested with a real tablet: only with a fake broker and a fake Gladys,
from the WallPanel documentation (`website/docs/remote-control` of its
repository). Unofficial, not affiliated with WallPanel.

## Before you start

1. An MQTT broker on your network (Mosquitto, or the one of the Gladys MQTT
   integration), reachable from the Gladys machine (port 1883, or 8883 in TLS).
2. In WallPanel, **Settings → MQTT**: turn MQTT on, type the address of the
   broker (and its user name and password if it asks for them). Keep the base
   topic `wallpanel/<name>/` and give each tablet its own name (`kitchen`,
   `hall`...): `wallpanel/kitchen/`. The name is letters, digits, `_` and `-`.
3. In WallPanel, **Settings → Sensors**: turn sensor publishing on (battery,
   light...), and **Settings → Camera** for motion and face detection.
4. For the brightness: WallPanel's "use screen brightness" setting must be on,
   and Android must let WallPanel change the system settings.

Quick check from a machine of the network:
`mosquitto_sub -h <broker> -t 'wallpanel/#' -v` must print the sensors and the
state of the tablet.

## Settings

| Setting                       | Role                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT broker address           | The IP address or name of the broker (port 1883), or `mqtts://address:8883` in TLS.                                                                                               |
| User name, Password           | Those of the broker, if it asks for them. The password is kept by Gladys in its database, never shown again, sent only to your broker. A password without a user name is refused. |
| Verify the TLS certificate    | On by default; turn off only for a broker with a self-signed certificate on your local network.                                                                                   |
| Topic prefix                  | Empty: `wallpanel`. Only if the base topics of your tablets start otherwise: `home/tablets` for `home/tablets/kitchen/` (one to three levels).                                    |
| Language of the feature names | French or English.                                                                                                                                                                |

The **Test the connection** button connects to the broker with the saved
settings, listens for 10 s and names the tablets heard. WallPanel publishes
its sensors at its own reading frequency: a tablet that says nothing within
10 s is not listed (look again in the Discovery tab later). Two tests are at
least 10 s apart.

## Adding a tablet

The tablets appear in the Discovery tab once they published something (their
sensors, their state, or their `connection` topic, which the broker keeps).
Click "Add to Gladys". A tablet always has "Screen awake" and "Screen
brightness" (the commands work before anything is read), plus the features it
published a value for.

The id of a tablet is the name in its base topic: `tablet:kitchen` for
`wallpanel/kitchen/`. Renaming the base topic in WallPanel therefore makes a
new device. At most 30 tablets are followed.

## Features

| Feature                | Gladys type              | Read from                                 |
| ---------------------- | ------------------------ | ----------------------------------------- |
| Screen awake           | switch, can be commanded | `state` → `screenOn`                      |
| Screen brightness      | dimmer 1 to 255          | `state` → `brightness`                    |
| Page displayed         | text                     | `state` → `currentUrl`, without its query |
| Battery                | battery, %               | `sensor/battery` → `value`                |
| Charging               | battery charging         | `sensor/battery` → `charging`             |
| Ambient light          | light sensor, lux        | `sensor/light`                            |
| Temperature            | temperature, °C          | `sensor/temperature`                      |
| Pressure               | pressure, hPa            | `sensor/pressure`                         |
| Humidity               | humidity, %              | `sensor/humidity`                         |
| Motion (camera)        | motion sensor            | `sensor/motion`                           |
| Face detected (camera) | presence sensor          | `sensor/face`                             |

Not read: the magnetic field (no Gladys type), the QR codes (their content can
be anything), the camera state.

The **page displayed** is shown without what follows `?` or `#`, nor a user
name or password: a dashboard URL may carry a token. Only the scheme, the
address and the path reach Gladys.

A value out of its range, empty, of another unit than the documented one
(°F, for example), or not readable is unknown: nothing is published, the last
value stays. A battery level of -1 (Android: "no level") is unknown. The
measurements (battery, light, temperature, pressure, humidity) reach Gladys
at most every 10 s per feature; the screen, the brightness, the page, the
motion and the face at once, every change of the motion and of the face
included (a short "true" is not lost).

WallPanel never keeps its states and sensors on the broker ("retained"): a
retained state or sensor message was left by another tool, maybe long ago,
and is never read. When Gladys adds a tablet later, the values read in the
last 2 hours are sent, dated when they were read (they start no scene).

## Commands

From the device page or a scene:

- **Screen awake** on: WallPanel wakes the screen until its own inactivity
  time; off: WallPanel lets the screen sleep again at the end of the Android
  display timeout (the screen does not go off at once).
- **Screen brightness**: 1 to 255 (0 is sent as 1, the lowest WallPanel
  takes; above 255, 255).

In scenes ("Integrations" actions):

- **Speak a text on a WallPanel tablet**: the voice of the tablet (Android's
  text-to-speech) says the text, 500 characters at most (line breaks become
  spaces).
- **Show a URL on a WallPanel tablet**: `http://` or `https://` only; a URL
  with a user name or a password is refused (it would travel in clear on the
  broker).
- **Reload the page**, **Back to the home page** (the launch URL set in
  WallPanel).
- **Wake the screen**, for a number of seconds (1 to 86,400), or empty for
  WallPanel's inactivity time.

Each command is published on `wallpanel/<name>/command`, not "retained" and
in QoS 0: a broker such as Mosquitto (default settings) does not keep it for
a tablet offline, which therefore does not run it later.
WallPanel answers nothing on MQTT: a command handed to the broker counts as
sent, and the next state of the tablet shows what it did. Gladys shows what
the tablet reports, never an assumed value.

A command is refused, with **nothing sent**, when:

- the MQTT broker is not connected;
- WallPanel said the tablet is offline (its `connection` topic, "offline");
- more than 30 commands went to that tablet within a minute (a looping
  scene);
- the value is not valid (see above).

When the broker does not take a command within 3 s, the answer says the
tablet may or may not get it. The texts spoken and the URLs sent are never
written in the logs (only the kind of command).

## Status and badges

The integration status says whether the broker is reached, how many tablets
are heard and how many are offline. The badge of a tablet is "unreachable"
while the broker is not connected or while WallPanel says the tablet is
offline.

## When something goes wrong

- **The broker refused the connection**: check the user name and the
  password. Gladys stops trying for 15 min, then 1 h, 6 h and every 24 h
  (kept across a restart); saving other credentials or pressing "Test the
  connection" tries again at once.
- **Broker unreachable**: tried again every 10 s, then every minute after 3
  failures in a row.
- **Connected, but no tablet**: check that the tablet uses the same broker,
  that its base topic starts with the prefix (`wallpanel/` by default), and
  that sensor publishing is on.
- **The brightness does not change**: turn on "use screen brightness" in
  WallPanel and allow it to change the system settings in Android.
- A message larger than 64 KB cuts the connection to the broker (it is never
  read); with MQTT 5 (Mosquitto), the broker does not even send it.

## Privacy

The broker password is never written in the logs, the status or `/data`.
`/data` only keeps the pause after a refusal of the credentials. The camera
of the tablet is never turned on by Gladys; only what WallPanel publishes
(motion, face: true or false) is read, never an image.
