/**
 * Data contract between the game (non-React loop) and the UI overlay.
 *
 * Every type here is plain serialisable data so the client can build it from
 * server messages, API responses or mocks. The UI never imports runtime code
 * from `@tumble/sim` or three.js; only `@tumble/shared` types.
 */
import type { LobbyGameKind, RoundType, TeamShape, ThemeId } from '@tumble/shared';

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
export type OverlayId =
  'none' | 'settings' | 'friends' | 'notifications' | 'privateShow' | 'joinCode' | 'inGameMenu';

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
  /** Account id (online humans): names open the player card. */
  userId?: string;
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
  /** `lost`: every reconnect attempt failed; the curtain offers Try again and Leave. */
  status: 'online' | 'connecting' | 'reconnecting' | 'lost' | 'offline';
  /** Current reconnect attempt (1-based). */
  attempt?: number;
  maxAttempts?: number;
  /** Epoch ms of the next reconnect attempt (curtain countdown). */
  nextAttemptAt?: number;
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
  /** Inline Accept/Decline (friend request) or Join/Decline (party invite) buttons. */
  action?: { kind: 'friendRequest'; userId: string } | { kind: 'partyInvite'; userId: string; code: string };
  /** Set once the action was taken ("Accepted", "Declined"…); hides the buttons. */
  resolved?: string;
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

/** What kind of locker item a cosmetic is, as shown on store, pass and locker cards. */
export const SLOT_NAMES: Readonly<Record<CosmeticSlot, string>> = {
  colors: 'Skin colours',
  pattern: 'Skin pattern',
  face: 'Face',
  upper: 'Top',
  lower: 'Bottoms',
  headwear: 'Hat',
  back: 'Back item',
  emote: 'Emote',
  celebration: 'Celebration',
  victory: 'Victory pose',
  nameplate: 'Nameplate',
  banner: 'Banner',
  trail: 'Trail',
  footsteps: 'Footsteps',
};

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
  /** What the item looks like, for previews drawn on the player's own Tumbler. */
  look?: ItemLook;
}

/**
 * Render facts a preview needs (from the content catalog). Wearable tints may
 * say primary / secondary / 	ertiary to follow the wearer's colours.
 */
export type ItemLook =
  | { kind: 'skin'; colors?: [string, string, string]; pattern?: PatternId }
  | { kind: 'wearable'; tint: string[]; hat?: AvatarHat }
  | { kind: 'face'; iris: string; accessory?: string; tint?: string }
  | { kind: 'pose'; clip: string }
  | { kind: 'nameplate'; plate: Omit<ProfileNameplate, 'name'> }
  | { kind: 'banner'; banner: Omit<ProfileBanner, 'name'> }
  | { kind: 'trail'; effect: string; colors: string[] }
  | { kind: 'footsteps'; pack: string };

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
  /** Bundle display name (bundles only). */
  title?: string;
  /** Bundle blurb (bundles only). */
  blurb?: string;
}

/** A Gem pack for real money (shown only when the account API sells them). */
export interface GemPackOffer {
  id: string;
  name: string;
  gems: number;
  /** Localised price label, e.g. "$4.99". */
  price: string;
}

/** Store rotation. */
export interface StoreData {
  featured: StoreOffer[];
  daily: StoreOffer[];
  /** Epoch ms when daily picks rotate. */
  rotationEndsAt: number;
  /** Gem packs (online accounts), listed in the Gems shop. */
  gemPacks?: GemPackOffer[];
  /**
   * What buying a pack does, as reported by the account API:
   * - `enabled`: real checkout (the server has Stripe keys);
   * - `test`: the development API's fake provider credits instantly, so packs
   *   are buyable but labelled "Test purchase (dev)";
   * - `comingSoon` (or absent): no provider — packs are read-only.
   */
  gemCheckout?: 'enabled' | 'test' | 'comingSoon';
  /** This week's Crown Shard shop. */
  shardShop?: ShardShopData;
  /** This week's discounted picks. */
  weekly?: StoreOffer[];
  /** Epoch ms when the weekly picks restock. */
  weeklyEndsAt?: number;
  /** Bundles (`bundle:<id>` offers); the hero bundle is flagged `featured`. */
  bundles?: StoreOffer[];
  /** Every item for sale at list price (browsable catalog). */
  catalog?: StoreOffer[];
}

/** Store tab sections. */
export type StoreSection = 'today' | 'week' | 'catalog' | 'shards';

/** A Crown Shard shop offer. */
export interface ShardOffer {
  /** Offer id (`shards:<item id>`); buying emits `purchase` with it. */
  id: string;
  item: CosmeticItem;
  /** Price in Crown Shards. */
  price: number;
}

/** The weekly Crown Shard shop. */
export interface ShardShopData {
  offers: ShardOffer[];
  /** Epoch ms when the shelf restocks. */
  rotationEndsAt: number;
  /** Shards that combine into one Crown (prices are always below this). */
  shardsPerCrown: number;
}

/** One Season Pass reward. */
export interface PassReward {
  item?: CosmeticItem;
  /** Currency or XP-type rewards. */
  currency?: { kind: Currency | 'xp' | 'crownShards'; amount: number };
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
  /** The season after this one, for "Season N+1 starts in …". */
  nextSeason?: { number: number; name: string; /** Epoch ms. */ startsAt: number };
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
  /** What the challenge counts (drives the illustrated icon), e.g. `racesQualified`. */
  metric?: string;
  /** Secondary reward shown beside the main one (e.g. XP on a Gumball challenge). */
  bonus?: { kind: Currency | 'xp'; amount: number };
  /** Free Gems paid on claim (weekly challenges). */
  gems?: number;
}

/** Challenge board. */
export interface ChallengesData {
  list: Challenge[];
  /** Epoch ms. */
  dailyResetsAt: number;
  weeklyResetsAt: number;
  /** Swaps left today (undefined = swapping unavailable, e.g. offline). */
  rerollsLeft?: number;
  /** Swaps granted per day. */
  rerollsPerDay?: number;
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
  /**
   * Set for a Tumbler only met in offline shows: just what this device saw.
   * The card shows these facts and hides level, XP, rank and lifetime stats,
   * which are unknown for them.
   */
  metOffline?: MetOfflineInfo;
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
    /** Crowns won (defaults to `ProfileData.crowns`). */
    wins?: number;
    roundsPlayed?: number;
    /** Gameplay totals, when tracked. */
    totals?: { jumps?: number; dives?: number; grabs?: number; emotes?: number };
    /** Best race finishing times, fastest first. */
    bestTimes?: { round: string; timeSec: number }[];
    /** Most played rounds with qualify counts. */
    rounds?: { name: string; type: RoundType; played: number; qualified: number }[];
    /** Last shows, newest first (for the form strip). */
    recentForm?: ('crown' | 'final' | 'eliminated')[];
  };
  showcase?: CosmeticItem[];
  linkedProviders?: ('discord' | 'google' | 'email')[];
  /** Crown Shards toward the next Crown. */
  crownShards?: number;
  /** Shards that make one Crown. */
  shardsPerCrown?: number;
  /** Equipped profile banner art. */
  banner?: ProfileBanner;
  /** Equipped nameplate styling. */
  nameplate?: ProfileNameplate;
}

/** What this device knows about a Tumbler met in offline shows. */
export interface MetOfflineInfo {
  isBot: boolean;
  /** Shows played together. */
  showsTogether: number;
  /** Their best final place in those shows (1 = Crown). */
  bestPlace: number;
  /** Crowns they won in those shows. */
  crownsTogether: number;
  /** Shows where they finished ahead of you, when tracked. */
  aheadOfYou?: number;
  /** Epoch ms of the last show together. */
  lastSeen: number;
}

/** Profile banner art (from the equipped banner cosmetic). */
export interface ProfileBanner {
  name: string;
  motif: 'confetti' | 'clouds' | 'stripes' | 'stars' | 'candy' | 'waves';
  colors: [string, string, string];
}

/** Nameplate styling (from the equipped nameplate cosmetic). */
export interface ProfileNameplate {
  name: string;
  style: 'pill' | 'ribbon' | 'bubble' | 'ticket' | 'neon';
  bg: string;
  bg2: string;
  text: string;
  border: string;
}

/** One leaderboard row. */
export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  value: number;
  colors: TumblerColors;
  isSelf?: boolean;
  isBot?: boolean;
  /** Secondary line, e.g. "Faced 6 times · 2 Crowns". */
  detail?: string;
}

/** Leaderboard ids. `friends` is kept for callers that predate scopes (= crowns, friends scope). */
export type LeaderboardId = 'crowns' | 'crowns_all_time' | 'ranked' | 'weekly' | 'win_streak' | 'friends';

/** Who a leaderboard ranks. */
export type LeaderboardScope = 'global' | 'regional' | 'friends';

/** Where the rows of a leaderboard came from. */
export interface LeaderboardInfo {
  scope: LeaderboardScope;
  /** `api` = live server board; `local` = Hall of Fame built from this device's real show history. */
  source: 'api' | 'local';
  /** Epoch ms of the fetch. */
  updatedAt: number;
}

/** One past show for match history. */
export interface MatchHistoryEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  playlist: string;
  rounds: {
    name: string;
    type: RoundType;
    qualified: boolean;
    roundId?: string;
    /** Placement within the round (1 = first to qualify). */
    place?: number;
    /** Players who started the round. */
    of?: number;
    /** Race finishing time in seconds. */
    timeSec?: number;
  }[];
  result: 'crown' | 'final' | 'eliminated';
  xp: number;
  /** Final placement and field size. */
  place?: number;
  participants?: number;
  gumballs?: number;
}

/** A News tab card. */
export interface NewsItem {
  id: string;
  title: string;
  /** Short teaser (cards); the reader shows `blocks` when present. */
  body: string;
  tag: string;
  art: [string, string];
  icon: string;
  /** ISO date (yyyy-mm-dd). */
  date?: string;
  /** Hero image URL. */
  image?: string;
  /** Full post for the reader view. */
  blocks?: NewsBlock[];
  featured?: boolean;
  unread?: boolean;
}

/** One block of a news post. */
export type NewsBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'image'; src: string; caption?: string }
  | { type: 'tip'; text: string };

/** How the player starts a show from the Play tab. */
export type PlayMode = 'online' | 'offline';

/** Whether online play (account API + matchmaker) is reachable. */
export interface OnlineStatus {
  state: 'checking' | 'online' | 'offline' | 'disabled';
  /** Humans online in shows right now (matchmaker `GET /stats`), when reported. */
  playersOnline?: number;
  /** Players waiting in the matchmaking queue, when reported. */
  inQueue?: number;
  /** Short human explanation for the offline state. */
  message?: string;
}

// -----------------------------------------------------------------------------
// Social
// -----------------------------------------------------------------------------

/** Friend presence. */
export type Presence = 'online' | 'inShow' | 'inMenu' | 'inQueue' | 'offline';

/** Reasons offered by the report dialog (the API's report reasons). */
export type ReportReason = 'cheating' | 'harassment' | 'offensive_name' | 'griefing' | 'spam' | 'other';

/** How the local player relates to another player. */
export type Relation = 'friend' | 'incoming' | 'outgoing' | 'none';

/** A friend / recent player. */
export interface Friend {
  id: string;
  name: string;
  tag: string;
  presence: Presence;
  colors: TumblerColors;
  recent?: boolean;
  /** Recent players: whether they are already a friend or a request is pending. */
  relation?: Relation;
  /** Playlist name while queued or in a show. */
  playlist?: string;
  /** Their party has room and they are in the menu: "Join" works. */
  joinable?: boolean;
  /** Private show code they are sharing with friends. */
  lobbyCode?: string;
}

/** A party member slot. */
export interface PartyMember {
  id: string;
  name: string;
  /** Four-digit tag (Name#1234); friend requests need it. */
  tag?: string;
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

/** A lobby mini-game played on the menu platform. */
export type LobbyGameId = LobbyGameKind;

/** One scoreboard row: a team (Goal Rush) or a player. */
export interface LobbyGameRow {
  id: string;
  label: string;
  score: number;
  /** Team colour or the player's main colour. */
  color: string;
  /** The local player (or their team). */
  self: boolean;
  /** Knocked out or spectating. */
  out: boolean;
  /** Holding the hot potato. */
  it: boolean;
}

/** The live lobby game, as the score HUD shows it. */
export interface LobbyGameHud {
  kind: LobbyGameId;
  title: string;
  rule: string;
  phase: 'intro' | 'play' | 'results';
  /** Intro: whole seconds before GO (3, 2, 1), then 0. */
  countdown: number;
  /** Whole seconds on the game clock, or null when the game has none. */
  clock: number | null;
  rows: LobbyGameRow[];
  /** Hot Potato fuse left (0..1), or null. */
  fuse: number | null;
  /** Short call-out (GOAL!, POP!, +3); a new `seq` replays its animation. */
  banner: { text: string; tone: 'pink' | 'blue' | 'gold' | 'mint'; seq: number } | null;
  /** Results line, e.g. `Pink team wins!`, `Draw`, `Game cancelled`. */
  result: string | null;
  /** The local player won (results only). */
  won: boolean;
  /** The local player is watching (switched tab or knocked out). */
  spectating: boolean;
}

/** Lobby mini-games: the picker and the running game. */
export interface LobbyGamesState {
  pickerOpen: boolean;
  /** The local player may start or stop a game (solo, or the party leader). */
  canStart: boolean;
  /** Tumblers on the platform (1 when solo). */
  players: number;
  /** The running game, or null. */
  hud: LobbyGameHud | null;
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
  /** Spectator seats when `spectators` is on (default 2). */
  spectatorSlots?: number;
  /** Seconds the pre-show platform counts down before round 1. */
  countdownSec?: number;
  /** Players needed before the host can start (bots fill the rest). */
  minPlayers?: number;
}

/** A member of a custom lobby as the lobby view shows them. */
export interface CustomLobbyMember {
  id: string;
  name: string;
  colors: TumblerColors;
  /** Wears the crown. */
  isHost: boolean;
  isSelf: boolean;
  /** Ready check (always true for the host; spectators are not asked). */
  ready: boolean;
  /** Their connection dropped; the seat is held for a short grace period. */
  away: boolean;
}

/** Custom lobby state after create/join, pushed live from the matchmaker. */
export interface CustomLobbyState {
  code: string;
  isHost: boolean;
  players: CustomLobbyMember[];
  spectators: CustomLobbyMember[];
  options: CustomLobbyOptions;
  /** Code joins are refused while locked. */
  locked: boolean;
  /** Players the host removed; they cannot rejoin with the code until unbanned. */
  banned: { id: string; name: string }[];
  /** The show moved to the game server; only the host keeps this (for in-show kicks). */
  started?: boolean;
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

/** Live state of the round loading screen. */
export interface RoundLoadingState {
  /** This machine's build progress, 0..1 (real: scene steps and shader compilation). */
  progress: number;
  /** This machine finished building and is waiting for the round to start. */
  ready: boolean;
  /** Players who finished loading (online; 0 when nobody else loads). */
  loaded: number;
  /** Players loading this round (online; 0 when nobody else loads). */
  total: number;
  /** Who the round is still waiting for (at most 8; never the local player). */
  waiting: ShowPlayer[];
  /** Everyone is loaded: the round starts right after this beat. */
  everyoneIn: boolean;
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
  /** The show's mutator (Chaos Mode), announced on the card. */
  mutator?: { name: string; description: string; icon: string };
}

/** Local grab feedback for the HUD. */
export interface HudGrab {
  mode: 'none' | 'holding' | 'held' | 'carrying';
  /** Partner's display name (empty when carrying). */
  name: string;
  /** Holding/carrying: stamina left. Held: progress toward breaking free. */
  meter: number;
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
  /** Bot, local or party marker: Streamer Mode keeps the name. Omitted = another real player. */
  isBot?: boolean;
  isLocal?: boolean;
  isParty?: boolean;
}

/** Team score pill. */
export interface TeamScore {
  name: string;
  color: string;
  /** Shape cue drawn on the pill (matches the 3D nameplate dot), so colour is never the only cue. */
  shape?: TeamShape;
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
  /** Local grab: who you hold or who holds you, with the stamina or break-free meter (0..1). */
  grab: HudGrab;
  /** Local race progress 0..1. */
  progress: number;
  /** Leaders shown on the race bar (top 3 recommended). */
  leaders: ProgressMarker[];
  teams: TeamScore[];
  /** Round-trip time in ms; negative when there is no server (offline show). */
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
  /** Players still in the running this round (qualified or playing), when known. */
  remaining?: number;
}

/** The local player's seat in the running show. */
export interface ShowSeat {
  /** The show runs on a game server (rewards are granted by the account API). */
  online: boolean;
  /** Knocked out of the show: watching the remaining rounds as a spectator. */
  outOfShow: boolean;
  /** Joined as a spectator (a private show's spectator seat): watching, never knocked out. */
  spectator?: boolean;
}

/**
 * "Keep watching / Leave show" choice, offered once the local player is
 * knocked out (the in-round sheet, and the card over the results wall).
 */
export interface WatchChoice {
  /** Epoch ms when Keep watching is picked automatically (null = waits for the player). */
  autoAt: number | null;
  /** Players still in the show, when known. */
  remaining?: number;
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
  /** The 3D wall behind the overlay shows the players; the overlay keeps only its title and tallies. */
  render3D?: boolean;
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

/** Controller actions the player can remap (movement and camera stay on the sticks). */
export type PadBindAction =
  | 'jump'
  | 'dive'
  | 'grab'
  | 'emoteWheel'
  | 'emote1'
  | 'emote2'
  | 'emote3'
  | 'emote4'
  | 'pause'
  | 'spectatePrev'
  | 'spectateNext';

/**
 * Standard-mapping gamepad button index per action: [primary, secondary],
 * `-1` when a slot is empty.
 */
export type PadBinds = Record<PadBindAction, [number, number]>;

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
    /** Lock the mouse to the camera during rounds (Esc releases it). */
    mouseLock: boolean;
    toggleGrab: boolean;
    vibration: boolean;
    touchLayout: 'right' | 'left';
    touchButtonScale: number;
    keybinds: Keybinds;
    /** Controller button mapping (Settings → Controls → Controller). */
    padBinds: PadBinds;
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
    /** Pick "Keep watching" automatically after qualifying or being knocked out. */
    autoSpectate: boolean;
    /** Small "BOT" tag beside bot names (nameplates, results, wall, spectate). */
    botTags: boolean;
    /** Masks swearing in chat (slurs are always masked). */
    chatFilter: boolean;
    /** Off hides every chat line and quick ping from other players. */
    showChat: boolean;
    region: string;
  };
}

/** Photo mode look filters. */
export type PhotoFilter = 'none' | 'warm' | 'mono' | 'vivid';

/** Photo mode: the game hides the UI and frees the camera while `active`. */
export interface PhotoModeState {
  active: boolean;
  /** Vertical field of view (degrees); the slider and pad bumpers both change it. */
  fov: number;
  filter: PhotoFilter;
  /** Stamp the game logo on saved photos. */
  watermark: boolean;
}

/** Region probe results shown in Settings → Gameplay → Region. */
export interface RegionStatus {
  /** Measured round trip (ms) per region id; missing = not measurable. */
  pings: Record<string, number>;
  /** What Auto resolves to, null before the first probe. */
  auto: string | null;
  /** A probe is running. */
  probing: boolean;
}

/** Settings section ids. */
export type SettingsSection = keyof Settings | 'account';

// -----------------------------------------------------------------------------
// Replays
// -----------------------------------------------------------------------------

/** Replay viewer camera: follow a player, orbit freely, or the recorded live view. */
export type ReplayCameraMode = 'follow' | 'free' | 'pov';

/** Viewer controls the UI (buttons, scrub bar) sends to the game. */
export type ReplayCommand =
  | { type: 'toggle' }
  /** Absolute seek, seconds from the start of the recording. */
  | { type: 'seek'; t: number }
  | { type: 'seekBy'; seconds: number }
  | { type: 'speed'; speed: number }
  | { type: 'speedStep'; dir: 1 | -1 }
  | { type: 'camera'; mode: ReplayCameraMode | 'next' }
  /** Follow the previous/next player. */
  | { type: 'player'; dir: 1 | -1 }
  | { type: 'save' }
  | { type: 'exit' };

/** A recorded round of the current show the player can rewatch. */
export interface ReplayRoundEntry {
  key: string;
  /** 0-based round index within the show. */
  roundIndex: number;
  name: string;
  type: RoundType;
  isFinal: boolean;
  /** The local player's fate in that round. */
  outcome: 'qualified' | 'eliminated' | 'spectated';
  /** Seconds. */
  duration: number;
}

/** A point of interest on the replay scrub bar. */
export interface ReplayMarkerInfo {
  /** Seconds from the start of the recording. */
  t: number;
  kind: 'eliminated' | 'qualified' | 'localEliminated' | 'localQualified';
  label: string;
}

/** Live state of the open replay viewer. */
export interface ReplayViewerState {
  title: string;
  subtitle: string;
  /** Playhead, seconds. */
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
  camera: ReplayCameraMode;
  /** The recording carries the local player's camera ("Your view"). */
  povAvailable: boolean;
  /** Followed player (follow / your view cameras). */
  target: { name: string; color: string; index: number; count: number } | null;
  markers: ReplayMarkerInfo[];
  /** Offer "Save replay" (recordings made in this session). */
  canSave: boolean;
  /** Where the recording came from. */
  origin: 'show' | 'file';
}
