/**
 * Default values for settings, keybinds and HUD state, plus the per-screen
 * defaults (transition, input mode, music) the store uses.
 */
import type {
  BindAction,
  EmoteSlot,
  HudState,
  Keybinds,
  PadBindAction,
  PadBinds,
  ScreenId,
  Settings,
  TransitionKind,
} from './types.ts';

/** Default keyboard/mouse bindings (SPEC §4.2). */
export const DEFAULT_KEYBINDS: Keybinds = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space', ''],
  dive: ['ControlLeft', 'Mouse0'],
  grab: ['ShiftLeft', 'Mouse2'],
  emoteWheel: ['KeyE', ''],
  emote1: ['Digit1', ''],
  emote2: ['Digit2', ''],
  emote3: ['Digit3', ''],
  emote4: ['Digit4', ''],
  spectatePrev: ['KeyQ', ''],
  spectateNext: ['KeyE', ''],
  pause: ['Escape', ''],
  pushToTalk: ['KeyV', ''],
};

/** Human labels for rebindable actions, in settings display order. */
export const BIND_ACTION_LABELS: Record<BindAction, string> = {
  moveForward: 'Move forward',
  moveBack: 'Move back',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  jump: 'Jump',
  dive: 'Dive',
  grab: 'Grab',
  emoteWheel: 'Emote wheel',
  emote1: 'Emote 1',
  emote2: 'Emote 2',
  emote3: 'Emote 3',
  emote4: 'Emote 4',
  spectatePrev: 'Spectate previous',
  spectateNext: 'Spectate next',
  pause: 'Menu',
  pushToTalk: 'Push to talk',
};

/**
 * Default controller mapping (standard layout): A jump, X/B dive, RT/RB grab,
 * Y emote wheel, D-pad emotes, Start menu, LB/RB spectate. RB sits on both
 * grab and spectate next because spectating only starts once the Tumbler is
 * out of the round.
 */
export const DEFAULT_PAD_BINDS: PadBinds = {
  jump: [0, -1],
  dive: [2, 1],
  grab: [7, 5],
  emoteWheel: [3, -1],
  emote1: [12, -1],
  emote2: [15, -1],
  emote3: [13, -1],
  emote4: [14, -1],
  pause: [9, -1],
  spectatePrev: [4, -1],
  spectateNext: [5, -1],
  pushToTalk: [8, -1],
};

/** Human labels for remappable controller actions, in settings display order. */
export const PAD_BIND_ACTION_LABELS: Record<PadBindAction, string> = {
  jump: 'Jump',
  dive: 'Dive',
  grab: 'Grab',
  emoteWheel: 'Emote wheel',
  emote1: 'Emote 1',
  emote2: 'Emote 2',
  emote3: 'Emote 3',
  emote4: 'Emote 4',
  pause: 'Menu',
  spectatePrev: 'Spectate previous',
  spectateNext: 'Spectate next',
  pushToTalk: 'Push to talk',
};

/** Default settings. */
export const DEFAULT_SETTINGS: Settings = {
  graphics: { quality: 'auto', resolutionScale: 1, fpsCap: 60, shadows: true, postFx: true, showFps: false },
  controls: {
    mouseSensitivity: 1,
    invertY: false,
    mouseLock: true,
    toggleGrab: false,
    vibration: true,
    touchLayout: 'right',
    touchButtonScale: 1,
    keybinds: DEFAULT_KEYBINDS,
    padBinds: DEFAULT_PAD_BINDS,
  },
  audio: { master: 0.9, music: 0.7, sfx: 0.9, ui: 0.8, announcer: 0.9, muteUnfocused: true },
  accessibility: {
    colorBlind: 'off',
    reduceMotion: false,
    reduceFlashing: false,
    reduceShake: false,
    captions: false,
    spokenAnnouncer: false,
    uiScale: 1,
    highContrastHud: false,
  },
  gameplay: {
    nameplates: true,
    streamerMode: false,
    showPing: true,
    autoSpectate: true,
    eliminationReplay: true,
    botTags: true,
    chatFilter: true,
    showChat: true,
    region: 'auto',
    analytics: null,
  },
  // Voice is strictly opt-in: nothing here may switch it on or play anyone by default.
  voice: {
    enabled: false,
    introSeen: false,
    mode: 'ptt',
    threshold: 0.45,
    inputDeviceId: '',
    volume: 0.9,
    relayOnly: false,
    teamVoice: false,
    noiseSuppression: true,
    echoCancellation: true,
    streamerHideNames: true,
    streamerMute: false,
    peerVolume: {},
    peerMuted: {},
  },
};

/** Default emote wheel: four emotes then four quick pings. */
export const DEFAULT_EMOTES: EmoteSlot[] = [
  { id: 'wave', label: 'Wave', icon: '👋' },
  { id: 'dance', label: 'Wiggle', icon: '💃' },
  { id: 'laugh', label: 'Giggle', icon: '😂' },
  { id: 'flex', label: 'Flex', icon: '💪' },
  { id: 'ping:go', label: 'Go here!', icon: '📍' },
  { id: 'ping:watch', label: 'Watch out!', icon: '⚠️' },
  { id: 'ping:nice', label: 'Nice!', icon: '👍' },
  { id: 'ping:gg', label: 'GG!', icon: '🤝' },
];

/** Initial HUD values. */
export const DEFAULT_HUD: HudState = {
  roundType: 'race',
  timeLeft: -1,
  timeTotal: 0,
  overtime: false,
  qualified: 0,
  qualifyTarget: 0,
  eliminated: 0,
  alive: 0,
  objective: '',
  localStatus: 'playing',
  grab: { mode: 'none', name: '', meter: 0 },
  progress: 0,
  leaders: [],
  teams: [],
  ping: -1,
  fps: 0,
  localColor: '#ff4f9a',
  place: 0,
  score: 0,
  scoreGoal: 0,
  controlsHint: true,
  device: 'keyboard',
  emotes: DEFAULT_EMOTES,
};

/** Natural transition into each screen when `setScreen` omits one. */
export const DEFAULT_TRANSITIONS: Record<ScreenId, TransitionKind> = {
  boot: 'none',
  splash: 'wipe',
  welcome: 'wipe',
  tutorialPrompt: 'fade',
  menu: 'wipe',
  matchmaking: 'none',
  matchFound: 'none',
  preShow: 'wipe',
  showIntro: 'fade',
  roundLoading: 'wipe',
  roundIntro: 'wipe',
  rules: 'fade',
  round: 'fade',
  roundResults: 'wipe',
  betweenRounds: 'fade',
  finalHype: 'fade',
  victory: 'fade',
  winnerCam: 'fade',
  playerWall: 'wipe',
  rewards: 'wipe',
  matchHistory: 'fade',
};

/**
 * Screens where the keyboard drives menus. Everywhere else keys belong to the
 * Tumbler, so the UI must not swallow arrows/space.
 */
export const MENU_INPUT_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'splash',
  'welcome',
  'tutorialPrompt',
  'menu',
  'matchmaking',
  'roundResults',
  'victory',
  'winnerCam',
  'playerWall',
  'rewards',
  'matchHistory',
]);

/** Music track requested when a screen becomes active (`undefined` = leave as is). */
export const SCREEN_MUSIC: Partial<Record<ScreenId, string>> = {
  welcome: 'music.menu',
  menu: 'music.menu',
  matchmaking: 'music.matchmaking',
  preShow: 'music.preshow',
  showIntro: 'music.intro',
  roundResults: 'music.results',
  betweenRounds: 'music.results',
  finalHype: 'music.final',
  victory: 'music.victory',
  winnerCam: 'music.victory',
  playerWall: 'music.wall',
  rewards: 'music.rewards',
};
