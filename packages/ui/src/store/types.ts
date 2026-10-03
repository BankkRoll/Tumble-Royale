/**
 * Data contract between the game (non-React loop) and the UI overlay.
 *
 * Every type here is plain serialisable data so the client can build it from
 * server messages, API responses or mocks. The UI never imports runtime code
 * from `@tumble/sim` or three.js; only `@tumble/shared` types.
 */
import type { RoundType, ThemeId } from '@tumble/shared';

export type { RoundType, ThemeId };

// -----------------------------------------------------------------------------
// Screens & navigation
// -----------------------------------------------------------------------------

/** Every full-screen state the overlay can show. See docs/design/SCREENS.md §13. */
export type ScreenId =
  | 'boot'
  | 'splash'
  | 'welcome'
  | 'tutorialPrompt'
  | 'menu'
  | 'matchmaking'
  | 'matchFound'
  | 'preShow'
  | 'showIntro'
  | 'roundLoading'
  | 'roundIntro'
  | 'rules'
  | 'round'
  | 'roundResults'
  | 'betweenRounds'
  | 'finalHype'
  | 'victory'
  | 'winnerCam'
  | 'playerWall'
  | 'rewards'
  | 'customLobby'
  | 'matchHistory';

/** All screen ids, in flow order. */
export const SCREEN_IDS: readonly ScreenId[] = [
  'boot',
  'splash',
  'welcome',
  'tutorialPrompt',
  'menu',
  'matchmaking',
  'matchFound',
  'preShow',
  'showIntro',
  'roundLoading',
  'roundIntro',
  'rules',
  'round',
  'roundResults',
  'betweenRounds',
  'finalHype',
  'victory',
  'winnerCam',
  'playerWall',
  'rewards',
  'customLobby',
  'matchHistory',
];

/** Main menu tabs. */
export type MenuTab =
  'play' | 'locker' | 'store' | 'pass' | 'challenges' | 'profile' | 'leaderboards' | 'news';

/** Menu tabs in display order. */
export const MENU_TABS: readonly MenuTab[] = [
  'play',
  'locker',
  'store',
  'pass',
  'challenges',
  'profile',
  'leaderboards',
  'news',
];

/** Side sheets / drop-downs layered over any screen. */
export type OverlayId = 'none' | 'settings' | 'friends' | 'notifications';

/** How a screen change is presented. */
export type TransitionKind = 'none' | 'fade' | 'wipe';

/** Options for `setScreen`. */
export interface SetScreenOptions {
  /** Defaults to the screen's natural transition (see `DEFAULT_TRANSITIONS`). */
  transition?: TransitionKind;
  /**
   * Keep the Tumble Wipe covering the screen after the swap until
   * `releaseWipe()` is called. Used while a round chunk loads.
   */
  hold?: boolean;
}

/** Progress of the Tumble Wipe. */
export type WipePhase = 'idle' | 'covering' | 'covered' | 'revealing';

/** Directions the gamepad / keyboard can drive menu focus with. */
export type NavDirection = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'tabPrev' | 'tabNext';

// -----------------------------------------------------------------------------
// Players & appearance
// -----------------------------------------------------------------------------

/** Body pattern ids understood by the CSS avatar and the 3D material. */
export type PatternId =
  'plain' | 'stripes' | 'dots' | 'checker' | 'zigzag' | 'stars' | 'gradient' | 'galaxy' | 'camo';

/** A Tumbler's colours. Hex strings (`#rrggbb`). */
export interface TumblerColors {
  primary: string;
  secondary: string;
  /** Face plate tint; defaults to cream. */
  tertiary?: string;
  pattern: PatternId;
}

/** Face expressions the CSS avatar can draw. */
export type FaceExpression =
  'happy' | 'grin' | 'scared' | 'dizzy' | 'sad' | 'cheer' | 'sleepy' | 'determined';

/** Optional hat for the CSS avatar (simple silhouettes only). */
export type AvatarHat = 'none' | 'crown' | 'cone' | 'cap' | 'bow' | 'antenna' | 'tophat';

/** A participant shown in results, the player wall, lobbies, etc. */
export interface ShowPlayer {
  id: number;
  name: string;
  colors: TumblerColors;
  hat?: AvatarHat;
  isBot: boolean;
  /** True for the player at this keyboard. */
  isLocal?: boolean;
  /** True for members of the local player's party. */
  isParty?: boolean;
  /** Team index in team rounds, else -1/undefined. */
  team?: number;
}

// -----------------------------------------------------------------------------
// Boot / connection / dialogs / toasts
// -----------------------------------------------------------------------------

/** Boot loader progress. */
export interface BootState {
  /** 0..1 real byte/progress fraction. */
  progress: number;
  label: string;
  /** Shown instead of the bar when set. */
  error?: string;
}

/** Network status. `reconnecting` shows the curtain overlay. */
export interface ConnectionState {
  status: 'online' | 'connecting' | 'reconnecting' | 'offline';
  attempt?: number;
  maxAttempts?: number;
  message?: string;
}

/** A modal dialog. Buttons emit `dialogResult` with the button id. */
export interface DialogSpec {
  /** Caller-chosen id echoed in the `dialogResult` intent. */
  id: string;
  kind: 'confirm' | 'error' | 'info' | 'purchase';
  title: string;
  body?: string;
  /** Error code chip, e.g. `E-NET-04`. */
  code?: string;
  /** Defaults to OK (info/error) or Confirm/Cancel (confirm). */
  buttons?: DialogButton[];
  /** Icon emoji/glyph shown in the dialog header. */
  icon?: string;
}

/** A dialog button. */
export interface DialogButton {
  id: string;
  label: string;
  variant?: ButtonVariant;
  /** The button focused when the dialog opens (the safe option). */
  autofocus?: boolean;
}

/** Visual variants of the chunky button. */
export type ButtonVariant = 'primary' | 'go' | 'secondary' | 'ghost' | 'danger' | 'premium' | 'mint';

/** Toast kinds; `social` toasts can carry actions. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'reward' | 'social';

/** Input for `pushToast`. */
export interface ToastInput {
  kind?: ToastKind;
  title: string;
  body?: string;
  /** Emoji / glyph. */
  icon?: string;
  /** 0 = sticky until dismissed. Default 4000. */
  durationMs?: number;
  /** `feed` = compact in-round event line on the left. Defaults by screen. */
  variant?: 'card' | 'feed';
  /** Buttons; clicking emits `toastAction`. */
  actions?: { id: string; label: string }[];
  /** Accent colour (e.g. the player's colour for feed lines). */
  color?: string;
}

/** A live toast. */
export interface Toast extends ToastInput {
  id: number;
  kind: ToastKind;
  variant: 'card' | 'feed';
  createdAt: number;
}

/** A notification bell entry. */
export interface NotificationItem {
  id: string;
  kind: 'invite' | 'friendRequest' | 'news' | 'reward';
  title: string;
  body?: string;
  /** Epoch ms. */
  time: number;
  read?: boolean;
}

// -----------------------------------------------------------------------------
// Account, economy, cosmetics
// -----------------------------------------------------------------------------

/** Cosmetic rarity, lowest to highest. */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

/** Rarities in ascending order. */
export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** Customisation slots (SPEC §5). */
export type CosmeticSlot =
  | 'colors'
  | 'pattern'
  | 'face'
  | 'upper'
  | 'lower'
  | 'headwear'
  | 'back'
  | 'emote'
  | 'celebration'
  | 'victory'
  | 'nameplate'
  | 'banner'
  | 'trail'
  | 'footsteps';

/** Slots in locker display order. */
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = [
  'colors',
  'pattern',
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'emote',
  'celebration',
  'victory',
  'nameplate',
  'banner',
  'trail',
  'footsteps',
];

/** A cosmetic item from the catalog. */
export interface CosmeticItem {
  id: string;
  name: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  description?: string;
  /** Emoji / glyph used as a placeholder icon. */
  icon: string;
  /** Two colours for the card art gradient. */
  art: [string, string];
  owned: boolean;
  set?: string;
}

/** Equipped item ids per slot (`emote` holds up to 4). */
export interface Loadout {
  name: string;
  colors: TumblerColors;
  items: Partial<Record<Exclude<CosmeticSlot, 'colors' | 'pattern' | 'emote'>, string>>;
  emotes: string[];
}

/** Inventory + loadouts. */
export interface InventoryData {
  items: CosmeticItem[];
  loadouts: Loadout[];
  activeLoadout: number;
}

/** Currency used by a store offer. */
export type Currency = 'gumballs' | 'gems';

/** A purchasable store entry. */
export interface StoreOffer {
  id: string;
  item: CosmeticItem;
  currency: Currency;
  price: number;
  /** Struck-through original price. */
  originalPrice?: number;
  featured?: boolean;
  /** Bundle contents; `item` is the hero. */
  bundle?: CosmeticItem[];
  tag?: string;
}

/** Store rotation. */
export interface StoreData {
  featured: StoreOffer[];
  daily: StoreOffer[];
  /** Epoch ms when daily picks rotate. */
  rotationEndsAt: number;
}

/** One Season Pass reward. */
export interface PassReward {
  item?: CosmeticItem;
  /** Currency or XP-type rewards. */
  currency?: { kind: Currency | 'xp'; amount: number };
  claimed: boolean;
}

/** One tier of the Season Pass. */
export interface PassTier {
  tier: number;
  free?: PassReward;
  premium?: PassReward;
}

/** Season Pass state. */
export interface SeasonPassData {
  seasonName: string;
  seasonNumber: number;
  /** Epoch ms. */
  endsAt: number;
  currentTier: number;
  /** 0..1 progress into the next tier. */
  tierProgress: number;
  premium: boolean;
  premiumPrice: number;
  tiers: PassTier[];
}

/** A daily/weekly challenge. */
export interface Challenge {
  id: string;
  cadence: 'daily' | 'weekly';
  title: string;
  icon: string;
  progress: number;
  goal: number;
  reward: { kind: Currency | 'xp' | 'stars'; amount: number };
  claimed: boolean;
  canReroll: boolean;
}

/** Challenge board. */
export interface ChallengesData {
  list: Challenge[];
  /** Epoch ms. */
  dailyResetsAt: number;
  weeklyResetsAt: number;
}

/** Ranked tiers (SPEC §12). */
export type RankTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'champion' | 'crown';

/** Ranked ladder standing. */
export interface RankInfo {
  tier: RankTier;
  /** 1..3 (I–III); ignored for crown league. */
  division: number;
  rp: number;
  /** RP needed to promote. */
  rpToNext: number;
  placementsLeft?: number;
}

/** Profile + stats for the profile card and top bar. */
export interface ProfileData {
  id: string;
  name: string;
  tag: string;
  level: number;
  xp: number;
  xpToNext: number;
  gumballs: number;
  gems: number;
  crowns: number;
  colors: TumblerColors;
  hat?: AvatarHat;
  isGuest: boolean;
  rank?: RankInfo;
  stats: {
    shows: number;
    finals: number;
    roundsQualified: number;
    bestStreak: number;
    favouriteRound?: string;
  };
  showcase?: CosmeticItem[];
  linkedProviders?: ('discord' | 'google' | 'email')[];
}

/** One leaderboard row. */
export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  value: number;
  colors: TumblerColors;
  isSelf?: boolean;
}

/** Leaderboard ids. */
export type LeaderboardId = 'crowns' | 'ranked' | 'weekly' | 'friends';

/** One past show for match history. */
export interface MatchHistoryEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  playlist: string;
  rounds: { name: string; type: RoundType; qualified: boolean }[];
  result: 'crown' | 'final' | 'eliminated';
  xp: number;
}

/** A News tab card. */
export interface NewsItem {
  id: string;
  title: string;
  body: string;
  tag: string;
  art: [string, string];
  icon: string;
}

// -----------------------------------------------------------------------------
// Social
// -----------------------------------------------------------------------------

/** Friend presence. */
export type Presence = 'online' | 'inShow' | 'inMenu' | 'offline';

/** A friend / recent player. */
export interface Friend {
  id: string;
  name: string;
  tag: string;
  presence: Presence;
  colors: TumblerColors;
  recent?: boolean;
}

/** A party member slot. */
export interface PartyMember {
  id: string;
  name: string;
  colors: TumblerColors;
  ready: boolean;
  isLeader: boolean;
  isSelf: boolean;
}

/** Party state (max 4). */
export interface PartyState {
  code: string;
  members: PartyMember[];
  maxSize: number;
}

/** A selectable playlist. */
export interface Playlist {
  id: string;
  name: string;
  description: string;
  players: number;
  /** Team size, 1 = solo. */
  teamSize: 1 | 2 | 4;
  art: [string, string];
  icon: string;
  /** Epoch ms for limited-time playlists. */
  endsAt?: number;
  ranked?: boolean;
}

/** Custom lobby options (`createCustom`). */
export interface CustomLobbyOptions {
  rounds: string[];
  bots: boolean;
  maxPlayers: number;
  timerScale: number;
  spectators: boolean;
  isPrivate: boolean;
}

/** Custom lobby state after create/join. */
export interface CustomLobbyState {
  code: string;
  isHost: boolean;
  players: { id: string; name: string; colors: TumblerColors }[];
  options: CustomLobbyOptions;
}

/** A selectable round for the custom lobby picker. */
export interface RoundCatalogEntry {
  id: string;
  name: string;
  type: RoundType;
}

// -----------------------------------------------------------------------------
// Matchmaking & show flow
// -----------------------------------------------------------------------------

/** Matchmaking queue status. */
export interface QueueState {
  status: 'idle' | 'searching' | 'found';
  /** Epoch ms when the search started. */
  startedAt: number;
  playersFound: number;
  playersNeeded: number;
  /** Estimated seconds remaining, -1 = unknown. */
  etaSec: number;
  region: string;
}

/** Pre-show waiting platform info. */
export interface PreShowInfo {
  showName: string;
  roundCount: number;
  playersJoined: number;
  maxPlayers: number;
  /** Epoch ms when the show starts. */
  startsAt: number;
  /** Recent join names (newest last); the UI animates additions. */
  joinFeed: string[];
}

/** Show intro card ("Round 1 of 5"). */
export interface ShowIntroInfo {
  showName: string;
  roundIndex: number;
  roundCount: number;
}

/** Everything the flyover title card, rules card and loading screen need. */
export interface RoundIntroInfo {
  roundId: string;
  name: string;
  type: RoundType;
  theme: ThemeId;
  /** One line, e.g. "Reach the finish line!" */
  objective: string;
  /** Rules card steps (max 3). */
  rules: { icon: string; text: string }[];
  tips: string[];
  /** 0-based. */
  roundIndex: number;
  roundCount: number;
  isFinal: boolean;
  playerCount: number;
  /** How many qualify (or survive); 1 for finals. */
  qualifyTarget: number;
}

/** Local player's fate this round. */
export type LocalStatus = 'playing' | 'qualified' | 'eliminated' | 'spectating';

/** A race-progress marker. */
export interface ProgressMarker {
  id: number;
  name: string;
  color: string;
  /** 0..1 along the course. */
  progress: number;
}

/** Team score pill. */
export interface TeamScore {
  name: string;
  color: string;
  score: number;
  isMine: boolean;
}

/** An emote / quick-ping wheel slot. */
export interface EmoteSlot {
  id: string;
  label: string;
  icon: string;
}

/** HUD state. Updated with `setHud(partial)` at ≤ 10–15 Hz. */
export interface HudState {
  roundType: RoundType;
  /** Seconds left, -1 untimed. */
  timeLeft: number;
  /** Seconds the round lasts; for the timer ring. */
  timeTotal: number;
  overtime: boolean;
  qualified: number;
  qualifyTarget: number;
  eliminated: number;
  /** Players still in the round (survival counter). */
  alive: number;
  objective: string;
  localStatus: LocalStatus;
  /** Local race progress 0..1. */
  progress: number;
  /** Leaders shown on the race bar (top 3 recommended). */
  leaders: ProgressMarker[];
  teams: TeamScore[];
  ping: number;
  fps: number;
  /** Local player's colour for the progress marker. */
  localColor: string;
  /** Local place / score in hunts. */
  place: number;
  score: number;
  /** Controls hint visible (the game hides it after first input). */
  controlsHint: boolean;
  /** Last device used: drives glyphs. */
  device: 'keyboard' | 'gamepad' | 'touch';
  /** Wheel slots (4 emotes + quick pings). */
  emotes: EmoteSlot[];
}

/** Stamp kinds for `showStamp`. */
export type StampKind =
  | 'qualified'
  | 'eliminated'
  | 'roundOver'
  | 'timeUp'
  | 'go'
  | 'overtime'
  | 'final'
  | 'victory'
  | 'teamWin'
  | 'teamLose';

/** A queued stamp. */
export interface StampEntry {
  id: number;
  kind: StampKind;
  /** Override the stamp text. */
  text?: string;
  /** Subtitle under the stamp. */
  sub?: string;
}

/** Who you're watching. */
export interface SpectateInfo {
  player: ShowPlayer;
  /** e.g. "3rd" / "Score 12". */
  detail: string;
  qualified: boolean;
  index: number;
  count: number;
}

/** One cell of the round results grid. */
export interface ResultsEntry {
  player: ShowPlayer;
  qualified: boolean;
  /** Finish place (race) or survival order; 0 = n/a. */
  place: number;
}

/** Round results payload. */
export interface RoundResults {
  roundName: string;
  roundType: RoundType;
  roundIndex: number;
  entries: ResultsEntry[];
}

/** Between-rounds tease. */
export interface BetweenRoundsInfo {
  remainingBefore: number;
  remaining: number;
  roundIndex: number;
  roundCount: number;
  next: { name: string; type: RoundType; isFinal: boolean };
}

/** Victory / winner-cam payload. */
export interface VictoryInfo {
  winner: ShowPlayer;
  isLocalWinner: boolean;
  crownsBefore: number;
  crownsAfter: number;
  showName: string;
}

/** Finalists for the FINAL ROUND hype card. */
export interface FinalHypeInfo {
  roundName: string;
  finalists: ShowPlayer[];
}

// -----------------------------------------------------------------------------
// Player wall
// -----------------------------------------------------------------------------

/** One round of the show for the player wall recap. */
export interface ShowRoundSummary {
  roundId: string;
  name: string;
  type: RoundType;
  /** Players eliminated in this round. */
  eliminatedIds: number[];
}

/** Whole-show recap fed to the player wall. */
export interface ShowSummary {
  showName: string;
  /** In lobby join order (wall cell order). */
  players: ShowPlayer[];
  rounds: ShowRoundSummary[];
  /** Winner id; -1 if nobody won (everyone eliminated in the final). */
  winnerId: number;
  /** Seed for comedic randomness (drop order, spins). */
  seed: number;
}

/** Options for `setPlayerWall`. */
export interface PlayerWallOptions {
  /** The 3D scene renders the wall; the DOM only shows banners/counter/skip. */
  render3D: boolean;
  /** Auto-continue to rewards this many ms after `wallEnd` (0 = never). */
  autoContinueMs: number;
}

/** Timeline event emitted while the wall plays (also exported as a pure schedule). */
export type PlayerWallEvent =
  | { type: 'wallStart'; t: number }
  | { type: 'cellsIn'; t: number }
  | { type: 'roundBanner'; t: number; roundIndex: number }
  | { type: 'cellFlash'; t: number; roundIndex: number; playerIds: number[] }
  | { type: 'trapdoorOpen'; t: number; roundIndex: number; playerIds: number[] }
  | {
      type: 'cellDrop';
      t: number;
      roundIndex: number;
      playerId: number;
      spin: number;
      drift: number;
      hang: boolean;
    }
  | { type: 'counter'; t: number; roundIndex: number; from: number; to: number }
  | { type: 'roundEnd'; t: number; roundIndex: number }
  | { type: 'winnerFocus'; t: number; playerId: number }
  | { type: 'crownDrop'; t: number; playerId: number }
  | { type: 'winnerReveal'; t: number; playerId: number }
  | { type: 'wallEnd'; t: number }
  | { type: 'skip'; t: number };

// -----------------------------------------------------------------------------
// Rewards
// -----------------------------------------------------------------------------

/** A level snapshot. */
export interface LevelSnapshot {
  level: number;
  xp: number;
  xpToNext: number;
}

/** End-of-show rewards. */
export interface RewardsSummary {
  xpLines: { label: string; xp: number }[];
  levelFrom: LevelSnapshot;
  /** Intermediate levels assume `levelTo.xpToNext` per level. */
  levelTo: LevelSnapshot;
  gumballs: number;
  crowns: number;
  pass?: { tierFrom: number; tierTo: number; progressFrom: number; progressTo: number };
  unlocks: CosmeticItem[];
  ranked?: { from: RankInfo; to: RankInfo; delta: number };
  challenges?: { title: string; from: number; to: number; goal: number }[];
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

/** Rebindable actions. */
export type BindAction =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'jump'
  | 'dive'
  | 'grab'
  | 'emoteWheel'
  | 'emote1'
  | 'emote2'
  | 'emote3'
  | 'emote4'
  | 'spectatePrev'
  | 'spectateNext'
  | 'pause';

/** `KeyboardEvent.code` (or `Mouse0`…`Mouse4`) per action: [primary, secondary]. */
export type Keybinds = Record<BindAction, [string, string]>;

/** Colour-blind palettes. */
export type ColorBlindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';

/** Graphics quality presets. */
export type QualityPreset = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

/** All user settings. Changes emit `settingsChange`. */
export interface Settings {
  graphics: {
    quality: QualityPreset;
    /** 0.5..1 render scale. */
    resolutionScale: number;
    fpsCap: 30 | 60 | 120 | 0;
    shadows: boolean;
    postFx: boolean;
    showFps: boolean;
  };
  controls: {
    mouseSensitivity: number;
    invertY: boolean;
    toggleGrab: boolean;
    vibration: boolean;
    touchLayout: 'right' | 'left';
    touchButtonScale: number;
    keybinds: Keybinds;
  };
  audio: {
    master: number;
    music: number;
    sfx: number;
    ui: number;
    announcer: number;
    muteUnfocused: boolean;
  };
  accessibility: {
    colorBlind: ColorBlindMode;
    reduceMotion: boolean;
    reduceFlashing: boolean;
    reduceShake: boolean;
    captions: boolean;
    /** Read announcer lines aloud (text-to-speech). Off by default; never enabled automatically. */
    spokenAnnouncer: boolean;
    /** 0.8..1.4 multiplier on every UI size. */
    uiScale: number;
    highContrastHud: boolean;
  };
  gameplay: {
    nameplates: boolean;
    streamerMode: boolean;
    showPing: boolean;
    autoSpectate: boolean;
    chatFilter: boolean;
    region: string;
  };
}

/** Settings section ids. */
export type SettingsSection = keyof Settings | 'account';
