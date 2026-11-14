// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the status of the
// integration, the answers of the button and of the commands. None of them
// ever carries the password of the broker, a spoken text or a URL sent.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const PACKET_KB = Math.round(LIMITS.packetBytes / 1024);

const both = (en, fr) => ({ en, fr });

/** "45 s", "5 min", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Feature names, by language (the keys of src/tablet.js FEATURES). */
export const FEATURE_NAMES = {
  en: {
    screen: 'Screen awake',
    brightness: 'Screen brightness',
    url: 'Page displayed',
    battery: 'Battery',
    charging: 'Charging',
    light: 'Light',
    temperature: 'Temperature',
    pressure: 'Pressure',
    humidity: 'Humidity',
    motion: 'Motion (camera)',
    face: 'Face detected (camera)',
  },
  fr: {
    screen: 'Écran réveillé',
    brightness: "Luminosité de l'écran",
    url: 'Page affichée',
    battery: 'Batterie',
    charging: 'En charge',
    light: 'Luminosité ambiante',
    temperature: 'Température',
    pressure: 'Pression',
    humidity: 'Humidité',
    motion: 'Mouvement (caméra)',
    face: 'Visage détecté (caméra)',
  },
};

const PROBLEMS = {
  empty: both(
    'Type the address of the MQTT broker your tablets publish to.',
    "Saisissez l'adresse du broker MQTT où publient vos tablettes.",
  ),
  invalid: both(
    'The broker address is not valid: an IP address or a name, or mqtt://address:port, mqtts://address:port.',
    "L'adresse du broker n'est pas valide : une adresse IP ou un nom, ou mqtt://adresse:port, mqtts://adresse:port.",
  ),
  credentials: both(
    'Type the user name and the password in their own fields, not in the broker address.',
    "Saisissez l'utilisateur et le mot de passe dans leurs champs, pas dans l'adresse du broker.",
  ),
  prefix: both(
    'The topic prefix is not valid: one to three levels of letters, digits, _ and - (wallpanel by default).',
    "Le préfixe des sujets n'est pas valide : un à trois niveaux de lettres, nombres, _ et - (wallpanel par défaut).",
  ),
  control: both(
    'The user name or the password holds a line break or a control character.',
    "L'utilisateur ou le mot de passe contient un retour à la ligne ou un caractère de contrôle.",
  ),
  password_without_user: both(
    'A password without a user name: type the user name of the broker too.',
    "Un mot de passe sans utilisateur : saisissez aussi l'utilisateur du broker.",
  ),
};

/** Status texts (multi-language objects for setConnectionStatus). */
export const T = {
  problem: (key) => PROBLEMS[key] ?? PROBLEMS.invalid,
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys: next try in ${wait}.`,
      `La configuration n'a pas pu être lue dans Gladys : nouvel essai dans ${wait}.`,
    ),
  connecting: both('Connecting to the MQTT broker...', 'Connexion au broker MQTT...'),
  unreachable: (reason, wait = '10 s') =>
    both(
      `MQTT broker unreachable (${reason}): next try in ${wait}.`,
      `Broker MQTT injoignable (${reason}) : nouvel essai dans ${wait}.`,
    ),
  dataUnreadable: (wait) =>
    both(
      `The state of the integration in /data could not be read: next try in ${wait}.`,
      `L'état de l'intégration dans /data n'a pas pu être lu : nouvel essai dans ${wait}.`,
    ),
  lost: both(
    'Connection to the MQTT broker lost: reconnecting.',
    'Connexion au broker MQTT perdue : reconnexion.',
  ),
  refused: (reason, wait) =>
    both(
      `The MQTT broker refused the connection (${reason}): no new try before ${wait}. Check the user name and the password, or press "Test the connection".`,
      `Le broker MQTT a refusé la connexion (${reason}) : pas de nouvel essai avant ${wait}. Vérifiez l'utilisateur et le mot de passe, ou appuyez sur « Tester la connexion ».`,
    ),
  stopped: (wait) =>
    both(
      `Stopped after a refusal of the credentials: next try in ${wait}, or press "Test the connection".`,
      `Arrêté après un refus des identifiants : nouvel essai dans ${wait}, ou appuyez sur « Tester la connexion ».`,
    ),
  waiting: (prefix) =>
    both(
      `Connected to the broker, waiting for the tablets (topics ${prefix}...).`,
      `Connecté au broker, en attente des tablettes (sujets ${prefix}...).`,
    ),
  noData: (prefix) =>
    both(
      `Connected to the broker, but no WallPanel tablet on ${prefix}... Check the MQTT settings of WallPanel: same broker, base topic ${prefix}<name>/ (see the guide).`,
      `Connecté au broker, mais aucune tablette WallPanel sur ${prefix}... Vérifiez les réglages MQTT de WallPanel : même broker, sujet de base ${prefix}<nom>/ (voir le guide).`,
    ),
  connected: (tablets, { protocol3 = false, offline = 0, capped = 0 } = {}) => {
    const en = [`Connected: ${tablets} WallPanel tablet(s).`];
    const fr = [`Connecté : ${tablets} tablette(s) WallPanel.`];
    if (offline > 0) {
      en.push(`${offline} offline (WallPanel says so on its connection topic).`);
      fr.push(`${offline} hors ligne (WallPanel le dit sur son sujet connection).`);
    }
    if (capped > 0) {
      en.push(`${capped} other tablet(s) ignored (${LIMITS.tablets} at most).`);
      fr.push(`${capped} autre(s) tablette(s) ignorée(s) (${LIMITS.tablets} au plus).`);
    }
    if (protocol3) {
      en.push(
        `The broker speaks MQTT 3.1.1 only: messages over ${PACKET_KB} KB cut the connection.`,
      );
      fr.push(
        `Le broker ne parle que MQTT 3.1.1 : un message de plus de ${PACKET_KB} Ko coupe la connexion.`,
      );
    }
    return both(en.join(' '), fr.join(' '));
  },
};

/** Answers of the "Test the connection" button. */
export const TEST = {
  tooSoon: both(
    'Wait a few seconds between two tests.',
    'Attendez quelques secondes entre deux tests.',
  ),
  refused: (reason) =>
    both(
      `The broker refused the connection: ${reason}. Check the user name and the password.`,
      `Le broker a refusé la connexion : ${reason}. Vérifiez l'utilisateur et le mot de passe.`,
    ),
  ok: (names) =>
    both(
      `Connected. ${names.length} WallPanel tablet(s) heard: ${names.join(', ')}.`,
      `Connecté. ${names.length} tablette(s) WallPanel entendue(s) : ${names.join(', ')}.`,
    ),
  none: (prefix) =>
    both(
      `Connected to the broker, but no WallPanel tablet on ${prefix}... within 10 s. WallPanel publishes its sensors at its "sensor reading frequency": check its MQTT settings and that sensor publishing is on.`,
      `Connecté au broker, mais aucune tablette WallPanel sur ${prefix}... en 10 s. WallPanel publie ses capteurs à sa « fréquence de lecture » : vérifiez ses réglages MQTT et que la publication des capteurs est active.`,
    ),
};

/** Why a command was not sent (thrown: Gladys shows it, a scene logs it). */
export const COMMAND = {
  notSent: (reason) => both(`Nothing sent: ${reason.en}`, `Rien envoyé : ${reason.fr}`),
  maybeSent: both(
    'Handed to the network, but the broker did not take it within 3 s: the tablet may or may not get it.',
    "Remis au réseau, mais le broker ne l'a pas pris en 3 s : la tablette le recevra peut-être.",
  ),
  reasons: {
    broker: both('the MQTT broker is not connected.', "le broker MQTT n'est pas connecté."),
    offline: both(
      'the tablet is offline (WallPanel said so on its connection topic).',
      "la tablette est hors ligne (WallPanel l'a dit sur son sujet connection).",
    ),
    unknown: both(
      'this tablet is not one of this integration.',
      "cette tablette n'est pas de cette intégration.",
    ),
    readOnly: both('this feature is read only.', 'cette fonctionnalité est en lecture seule.'),
    value: both('the value is not valid.', "la valeur n'est pas valide."),
    flood: both(
      `more than ${LIMITS.commandsPerMinute} commands to this tablet within a minute.`,
      `plus de ${LIMITS.commandsPerMinute} commandes vers cette tablette en une minute.`,
    ),
    speech_empty: both('the text to speak is empty.', 'le texte à dire est vide.'),
    url_empty: both('the URL is empty.', "l'URL est vide."),
    url_invalid: both('the URL is not valid.', "l'URL n'est pas valide."),
    url_scheme: both(
      'only http:// and https:// URLs are sent.',
      'seules les URL http:// et https:// sont envoyées.',
    ),
    url_credentials: both(
      'the URL holds a user name or a password: they would travel in clear on the broker.',
      "l'URL contient un utilisateur ou un mot de passe : ils passeraient en clair sur le broker.",
    ),
    wake_invalid: both(
      `the duration is a whole number of seconds, 1 to ${LIMITS.wakeSeconds}.`,
      `la durée est un nombre entier de secondes, de 1 à ${LIMITS.wakeSeconds}.`,
    ),
  },
};

/** The transport badge of a tablet offline. */
export const OFFLINE = both(
  'WallPanel says this tablet is offline.',
  'WallPanel indique que cette tablette est hors ligne.',
);
