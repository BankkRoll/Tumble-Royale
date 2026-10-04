/**
 * The game ↔ UI store.
 *
 * Responsibilities:
 * - single source of truth for everything the overlay renders;
 * - plain, synchronous actions the non-React game loop calls
 *   (`ui.getState().setHud(...)`);
 * - screen/transition state machine (Tumble Wipe cover → swap → reveal);
 * - settings persistence hooks (emits `settingsChange`).
 *
 * React components read it with `useUI(selector)`; selectors keep HUD updates
 * from re-rendering anything but the widget that changed.
 */
import { DEFAULT_SHOW_PLAYERS } from '@tumble/shared';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { DEFAULT_HUD, DEFAULT_SETTINGS, DEFAULT_TRANSITIONS, MENU_INPUT_SCREENS } from './defaults.ts';
import { uiEvents } from './events.ts';
import type {
  BetweenRoundsInfo,
  BootState,
  ChallengesData,
  ConnectionState,
  CustomLobbyState,
  DialogSpec,
  FinalHypeInfo,
  Friend,
  HudState,
  InventoryData,
  CosmeticSlot,
  StoreSection,
  LeaderboardId,
  LeaderboardInfo,
  LeaderboardRow,
  LeaderboardScope,
  LobbyGamesState,
  MatchHistoryEntry,
  MenuTab,
  NavDirection,
  NewsItem,
  NotificationItem,
  OnlineStatus,
  OverlayId,
  PartyState,
  PlayMode,
  PlayerWallOptions,
  Playlist,
  PreShowInfo,
  ProfileData,
  QueueState,
  RegionStatus,
  PhotoModeState,
  ReplayRoundEntry,
  ReplayViewerState,
  RewardsSummary,
  RoundCatalogEntry,
  RoundIntroInfo,
  RoundLoadingState,
  RoundResults,
  ScreenId,
  SeasonPassData,
  SetScreenOptions,
  Settings,
  SettingsSection,
  ShowIntroInfo,
  ShowSeat,
  ShowSummary,
  SpectateInfo,
  StampEntry,
  StampKind,
  StoreData,
  Toast,
  ToastInput,
  TransitionKind,
  VictoryInfo,
  WatchChoice,
  WipePhase,
} from './types.ts';

/** Tumble Wipe machine state. */
export interface WipeState {
  phase: WipePhase;
  /** Screen shown once covered. */
  target: ScreenId | null;
  hold: boolean;
  /** Increments per wipe so the component restarts its animation. */
  seq: number;
}

/** Full store state (data + actions). */
export interface UIState {
  // --- screens -------------------------------------------------------------
  screen: ScreenId;
  /** Previous screen (for back navigation). */
  prevScreen: ScreenId | null;
  /** How the current screen entered. */
  screenTransition: TransitionKind;
  /** Bumps on every `setScreen`, even to the same screen. */
  screenSeq: number;
  wipe: WipeState;
  menuTab: MenuTab;
  overlay: OverlayId;
  /** True when the keyboard drives menus rather than the Tumbler. */
  inputMode: 'menu' | 'game';
  isTouch: boolean;
  /** Mouse camera lock in a round: 'off' when it does not apply (menus, touch, setting off). */
  cameraLock: 'off' | 'unlocked' | 'locked';
  /** The local Tumbler is running around the menu platform (idle play, party hangout, lobby games). */
  idlePlay: boolean;
  /** Settings is waiting for a controller button to bind; menu navigation ignores the pad meanwhile. */
  padCapture: boolean;

  // --- system --------------------------------------------------------------
  boot: BootState;
  connection: ConnectionState;
  dialog: DialogSpec | null;
  toasts: Toast[];
  notifications: NotificationItem[];
  settings: Settings;

  // --- meta ----------------------------------------------------------------
  profile: ProfileData | null;
  inventory: InventoryData | null;
  store: StoreData | null;
  pass: SeasonPassData | null;
  challenges: ChallengesData | null;
  leaderboards: Partial<Record<LeaderboardId, LeaderboardRow[]>>;
  matchHistory: MatchHistoryEntry[];
  news: NewsItem[];
  friends: Friend[];
  party: PartyState | null;
  playlists: Playlist[];
  selectedPlaylist: string;
  localReady: boolean;
  /** Lobby mini-games on the menu platform (picker + running game). */
  lobbyGames: LobbyGamesState;
  customLobby: CustomLobbyState | null;
  roundCatalog: RoundCatalogEntry[];
  /** Rendered cosmetic thumbnails (data/blob URLs) by item id; cards fall back to the emoji icon. */
  thumbnails: Record<string, string>;
  /** Top-bar currency popover. */
  currencyPanel: 'none' | 'gumballs' | 'gems';
  /** Play tab start mode. */
  playMode: PlayMode;
  /** Online play reachability (drives the Play Online card). */
  onlineStatus: OnlineStatus;
  /** Where each leaderboard's rows came from. */
  leaderboardInfo: Partial<Record<LeaderboardId, LeaderboardInfo>>;
  /** Another player's profile card being viewed (null = closed). */
  inspectedProfile: ProfileData | null;
  /** Slot the Locker should open on (set by deep links such as Profile → banner). */
  lockerSlot: CosmeticSlot | null;
  /** Section the Store should open on (set by deep links such as the Locker's empty state). */
  storeSection: StoreSection | null;

  // --- show ----------------------------------------------------------------
  queue: QueueState;
  /** Region pings and the Auto pick (Settings → Region). */
  regionStatus: RegionStatus;
  /** Photo mode controls (the game owns the camera). */
  photo: PhotoModeState;
  preShow: PreShowInfo | null;
  showIntro: ShowIntroInfo | null;
  roundIntro: RoundIntroInfo | null;
  /** Loading screen progress and who is still loading (null outside a round load). */
  roundLoading: RoundLoadingState | null;
  hud: HudState;
  /** 3, 2, 1, 0 (= GO), or null when hidden. */
  countdown: number | null;
  stamps: StampEntry[];
  eliminatedSheet: boolean;
  /** "Keep watching / Leave show" offer while knocked out (null = nothing pending). */
  watchChoice: WatchChoice | null;
  /** The local seat in the running show (null outside shows). */
  showSeat: ShowSeat | null;
  spectate: SpectateInfo | null;
  emoteWheelOpen: boolean;
  results: RoundResults | null;
  betweenRounds: BetweenRoundsInfo | null;
  finalHype: FinalHypeInfo | null;
  victory: VictoryInfo | null;
  playerWall: ShowSummary | null;
  playerWallOptions: PlayerWallOptions;
  /** Bumps when a new wall starts so the timeline restarts. */
  playerWallSeq: number;
  rewards: RewardsSummary | null;
  /**
   * A signed-in player's reward is not here yet: `arriving` while the game
   * asks the account servers, `deferred` once it gave up waiting (the reward
   * still lands on the profile). Null once `rewards` is set.
   */
  rewardsPending: 'arriving' | 'deferred' | null;
  /** Announcer caption (shown when captions are enabled). */
  caption: string | null;

  // --- replays ------------------------------------------------------------
  /** Recorded rounds of the current (or just finished) show. */
  replays: ReplayRoundEntry[];
  /** The round in progress is being recorded and can be watched now (after elimination). */
  replayLive: boolean;
  /** The open replay viewer (null = closed). While open it covers the screen and HUD. */
  replay: ReplayViewerState | null;

  // --- actions: screens ----------------------------------------------------
  /** Changes screen, with the screen's default transition unless overridden. */
  setScreen: (screen: ScreenId, opts?: SetScreenOptions) => void;
  /** Lets a held Tumble Wipe reveal. */
  releaseWipe: () => void;
  setMenuTab: (tab: MenuTab) => void;
  setOverlay: (overlay: OverlayId) => void;
  setTouch: (isTouch: boolean) => void;
  /** Gamepad/keyboard menu navigation; wired to the DOM navigator by `mountUI`. */
  navigate: (dir: NavDirection) => void;

  // --- actions: system -----------------------------------------------------
  setBoot: (boot: Partial<BootState>) => void;
  setConnection: (connection: ConnectionState) => void;
  showDialog: (dialog: DialogSpec) => void;
  closeDialog: () => void;
  /** @returns toast id. */
  pushToast: (toast: ToastInput) => number;
  dismissToast: (id: number) => void;
  setNotifications: (items: NotificationItem[]) => void;
  /** Replaces settings without emitting (e.g. loaded from storage). */
  setSettings: (settings: Settings) => void;
  /** Merges a section patch and emits `settingsChange`. */
  updateSettings: <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => void;
  setCaption: (caption: string | null) => void;

  // --- actions: meta -------------------------------------------------------
  setProfile: (profile: ProfileData | null) => void;
  /** Updates currencies only (purchase, rewards). */
  setWallet: (wallet: { gumballs?: number; gems?: number }) => void;
  setInventory: (inventory: InventoryData | null) => void;
  setStoreData: (store: StoreData | null) => void;
  setPass: (pass: SeasonPassData | null) => void;
  setChallenges: (challenges: ChallengesData | null) => void;
  setLeaderboard: (board: LeaderboardId, rows: LeaderboardRow[], info?: LeaderboardInfo) => void;
  /** Marks a board's last load as failed (`null` clears it before a retry). Rows are kept. */
  setLeaderboardError: (board: LeaderboardId, scope: LeaderboardScope, error: string | null) => void;
  setMatchHistory: (entries: MatchHistoryEntry[]) => void;
  setNews: (news: NewsItem[]) => void;
  setFriends: (friends: Friend[]) => void;
  setParty: (party: PartyState | null) => void;
  setPlaylists: (playlists: Playlist[], selected?: string) => void;
  selectPlaylist: (id: string) => void;
  setLocalReady: (ready: boolean) => void;
  /** Merges lobby mini-game state (the game publishes the HUD; the UI opens/closes the picker). */
  setLobbyGames: (patch: Partial<LobbyGamesState>) => void;
  setCustomLobby: (lobby: CustomLobbyState | null) => void;
  setRoundCatalog: (rounds: RoundCatalogEntry[]) => void;
  /** Adds rendered thumbnails (merged into `thumbnails`). */
  setThumbnails: (thumbs: Record<string, string>) => void;
  setCurrencyPanel: (panel: 'none' | 'gumballs' | 'gems') => void;
  /** Switches the Play tab mode and emits `playMode`. */
  setPlayMode: (mode: PlayMode) => void;
  setOnlineStatus: (status: OnlineStatus) => void;
  setInspectedProfile: (profile: ProfileData | null) => void;
  /** Opens the Locker tab on a slot. */
  openLocker: (slot: CosmeticSlot | null) => void;
  /** Opens the Store tab on a section. */
  openStore: (section: StoreSection | null) => void;

  // --- actions: show -------------------------------------------------------
  setQueue: (queue: Partial<QueueState>) => void;
  setRegionStatus: (patch: Partial<RegionStatus>) => void;
  setPhoto: (patch: Partial<PhotoModeState>) => void;
  setPreShow: (info: PreShowInfo | null) => void;
  setShowIntro: (info: ShowIntroInfo | null) => void;
  setRoundIntro: (info: RoundIntroInfo | null) => void;
  /**
   * Merges loading screen state (null clears it). Progress changes re-render
   * the loading screen: call at ≤ 4 Hz while a round builds.
   */
  setRoundLoading: (patch: Partial<RoundLoadingState> | null) => void;
  /** Merges HUD fields. Safe to call at 10–15 Hz. */
  setHud: (patch: Partial<HudState>) => void;
  resetHud: (patch?: Partial<HudState>) => void;
  setCountdown: (value: number | null) => void;
  /** Queues a stamp; returns its id. */
  showStamp: (kind: StampKind, opts?: { text?: string; sub?: string }) => number;
  dismissStamp: (id: number) => void;
  clearStamps: () => void;
  setEliminatedSheet: (open: boolean) => void;
  setWatchChoice: (choice: WatchChoice | null) => void;
  setShowSeat: (seat: ShowSeat | null) => void;
  setSpectate: (info: SpectateInfo | null) => void;
  setEmoteWheel: (open: boolean) => void;
  setResults: (results: RoundResults | null) => void;
  setBetweenRounds: (info: BetweenRoundsInfo | null) => void;
  setFinalHype: (info: FinalHypeInfo | null) => void;
  setVictory: (info: VictoryInfo | null) => void;
  /** Loads the end-of-show wall; call before `setScreen('playerWall')`. */
  setPlayerWall: (summary: ShowSummary | null, opts?: Partial<PlayerWallOptions>) => void;
  /** Shows the rewards (clears any pending state). */
  setRewards: (rewards: RewardsSummary | null) => void;
  setRewardsPending: (pending: 'arriving' | 'deferred' | null) => void;

  // --- actions: replays ----------------------------------------------------
  setReplays: (replays: ReplayRoundEntry[]) => void;
  setReplayLive: (live: boolean) => void;
  /** Opens (state) or closes (null) the replay viewer. */
  setReplay: (replay: ReplayViewerState | null) => void;
  /** Merges viewer fields (playhead updates at ~15 Hz). */
  patchReplay: (patch: Partial<ReplayViewerState>) => void;

  // --- internal (TumbleWipe component) -------------------------------------
  /** @internal Cover animation finished. */
  _wipeCovered: () => void;
  /** @internal Reveal animation finished. */
  _wipeDone: () => void;
}

let navigator: ((dir: NavDirection) => void) | null = null;

/**
 * Installs the DOM navigator used by `navigate` (done by `mountUI`).
 * @internal
 */
export function setNavigator(fn: ((dir: NavDirection) => void) | null): void {
  navigator = fn;
}

let toastSeq = 1;
let stampSeq = 1;

/**
 * The UI store. Non-React code uses `ui.getState().action(...)` and
 * `ui.subscribe(...)`.
 */
export const ui = createStore<UIState>()((set, get) => ({
  screen: 'boot',
  prevScreen: null,
  screenTransition: 'none',
  screenSeq: 0,
  wipe: { phase: 'idle', target: null, hold: false, seq: 0 },
  menuTab: 'play',
  overlay: 'none',
  inputMode: 'game',
  isTouch: false,
  cameraLock: 'off',
  idlePlay: false,
  padCapture: false,

  boot: { progress: 0, label: 'Inflating Tumblers…' },
  connection: { status: 'online' },
  dialog: null,
  toasts: [],
  notifications: [],
  settings: DEFAULT_SETTINGS,

  profile: null,
  inventory: null,
  store: null,
  pass: null,
  challenges: null,
  leaderboards: {},
  matchHistory: [],
  news: [],
  friends: [],
  party: null,
  playlists: [],
  selectedPlaylist: '',
  localReady: false,
  lobbyGames: { pickerOpen: false, canStart: true, players: 1, hud: null },
  customLobby: null,
  roundCatalog: [],
  thumbnails: {},
  currencyPanel: 'none',
  playMode: 'offline',
  onlineStatus: { state: 'checking' },
  leaderboardInfo: {},
  inspectedProfile: null,
  lockerSlot: null,
  storeSection: null,

  queue: {
    status: 'idle',
    startedAt: 0,
    playersFound: 0,
    playersNeeded: DEFAULT_SHOW_PLAYERS,
    etaSec: -1,
    region: 'auto',
  },
  regionStatus: { pings: {}, auto: null, probing: false },
  photo: { active: false, fov: 50, filter: 'none', watermark: true },
  preShow: null,
  showIntro: null,
  roundIntro: null,
  roundLoading: null,
  hud: DEFAULT_HUD,
  countdown: null,
  stamps: [],
  eliminatedSheet: false,
  watchChoice: null,
  showSeat: null,
  spectate: null,
  emoteWheelOpen: false,
  results: null,
  betweenRounds: null,
  finalHype: null,
  victory: null,
  playerWall: null,
  playerWallOptions: { render3D: false, autoContinueMs: 6000 },
  playerWallSeq: 0,
  rewards: null,
  rewardsPending: null,
  caption: null,
  replays: [],
  replayLive: false,
  replay: null,

  setScreen: (screen, opts = {}) => {
    const s = get();
    let kind = opts.transition ?? DEFAULT_TRANSITIONS[screen];
    if (kind === 'wipe' && s.settings.accessibility.reduceMotion) kind = 'fade';
    const hold = opts.hold ?? false;

    if (s.wipe.phase === 'covering') {
      set({ wipe: { ...s.wipe, target: screen, hold: hold || s.wipe.hold } });
      return;
    }
    if (s.wipe.phase === 'covered') {
      applyScreen(screen, 'none');
      set({ wipe: { ...get().wipe, phase: hold ? 'covered' : 'revealing', hold } });
      return;
    }
    if (kind === 'wipe') {
      set({ wipe: { phase: 'covering', target: screen, hold, seq: s.wipe.seq + 1 } });
      return;
    }
    applyScreen(screen, kind);
  },

  releaseWipe: () => {
    const w = get().wipe;
    if (w.phase === 'covered') set({ wipe: { ...w, phase: 'revealing', hold: false } });
    else if (w.phase === 'covering') set({ wipe: { ...w, hold: false } });
  },

  _wipeCovered: () => {
    const w = get().wipe;
    if (w.phase !== 'covering') return;
    if (w.target) {
      applyScreen(w.target, 'wipe');
      uiEvents.emit('transitionCovered', { to: w.target });
    }
    set({ wipe: { ...get().wipe, phase: w.hold ? 'covered' : 'revealing', target: null } });
  },

  _wipeDone: () => {
    const w = get().wipe;
    if (w.phase === 'revealing') set({ wipe: { ...w, phase: 'idle' } });
  },

  setMenuTab: (tab) => {
    if (get().menuTab === tab) return;
    set({ menuTab: tab });
    uiEvents.emit('menuTab', { tab });
  },
  setOverlay: (overlay) => {
    set({ overlay });
    uiEvents.emit('overlay', { overlay });
  },
  setTouch: (isTouch) => set({ isTouch }),
  navigate: (dir) => navigator?.(dir),

  setBoot: (boot) => set({ boot: { ...get().boot, ...boot } }),
  setConnection: (connection) => set({ connection }),
  showDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  pushToast: (input) => {
    const id = toastSeq++;
    const variant = input.variant ?? (get().screen === 'round' ? 'feed' : 'card');
    const toast: Toast = { ...input, id, kind: input.kind ?? 'info', variant, createdAt: performance.now() };
    const toasts = [...get().toasts, toast];
    // Old feed lines are dropped first; sticky cards survive.
    while (toasts.filter((t) => t.variant === variant).length > (variant === 'feed' ? 5 : 4)) {
      const idx = toasts.findIndex((t) => t.variant === variant);
      toasts.splice(idx, 1);
    }
    set({ toasts });
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setNotifications: (notifications) => set({ notifications }),
  setSettings: (settings) => set({ settings }),
  updateSettings: (section, patch) => {
    const settings: Settings = { ...get().settings, [section]: { ...get().settings[section], ...patch } };
    set({ settings });
    uiEvents.emit('settingsChange', { settings, section: section as SettingsSection });
  },
  setCaption: (caption) => set({ caption }),

  setProfile: (profile) => set({ profile }),
  setWallet: (wallet) => {
    const p = get().profile;
    if (p) set({ profile: { ...p, ...wallet } });
  },
  setInventory: (inventory) => set({ inventory }),
  setStoreData: (store) => set({ store }),
  setPass: (pass) => set({ pass }),
  setChallenges: (challenges) => set({ challenges }),
  setLeaderboard: (board, rows, info) =>
    set({
      leaderboards: { ...get().leaderboards, [board]: rows },
      ...(info ? { leaderboardInfo: { ...get().leaderboardInfo, [board]: info } } : {}),
    }),
  setLeaderboardError: (board, scope, error) => {
    const prev = get().leaderboardInfo[board];
    if (!error && !prev?.error) return;
    const next: LeaderboardInfo = { ...(prev ?? { source: 'api', updatedAt: Date.now() }), scope };
    if (error) next.error = error;
    else delete next.error;
    set({ leaderboardInfo: { ...get().leaderboardInfo, [board]: next } });
  },
  setMatchHistory: (matchHistory) => set({ matchHistory }),
  setNews: (news) => set({ news }),
  setFriends: (friends) => set({ friends }),
  setParty: (party) => set({ party }),
  setPlaylists: (playlists, selected) =>
    set({ playlists, selectedPlaylist: selected ?? (get().selectedPlaylist || playlists[0]?.id || '') }),
  selectPlaylist: (id) => {
    set({ selectedPlaylist: id });
    uiEvents.emit('selectPlaylist', { playlistId: id });
  },
  setLocalReady: (localReady) => set({ localReady }),
  setLobbyGames: (patch) => set({ lobbyGames: { ...get().lobbyGames, ...patch } }),
  setCustomLobby: (customLobby) => set({ customLobby }),
  setRoundCatalog: (roundCatalog) => set({ roundCatalog }),
  setThumbnails: (thumbs) => set({ thumbnails: { ...get().thumbnails, ...thumbs } }),
  setCurrencyPanel: (currencyPanel) => set({ currencyPanel }),
  setPlayMode: (playMode) => {
    if (get().playMode === playMode) return;
    set({ playMode });
    uiEvents.emit('playMode', { mode: playMode });
  },
  setOnlineStatus: (onlineStatus) => set({ onlineStatus }),
  setInspectedProfile: (inspectedProfile) => set({ inspectedProfile }),
  openLocker: (lockerSlot) => {
    set({ lockerSlot });
    get().setMenuTab('locker');
  },
  openStore: (storeSection) => {
    set({ storeSection });
    get().setMenuTab('store');
  },

  setQueue: (queue) => set({ queue: { ...get().queue, ...queue } }),
  setRegionStatus: (patch) => set({ regionStatus: { ...get().regionStatus, ...patch } }),
  setPhoto: (patch) => set({ photo: { ...get().photo, ...patch } }),
  setPreShow: (preShow) => set({ preShow }),
  setShowIntro: (showIntro) => set({ showIntro }),
  setRoundIntro: (roundIntro) => set({ roundIntro }),
  setRoundLoading: (patch) =>
    set({
      roundLoading:
        patch === null
          ? null
          : {
              ...(get().roundLoading ?? {
                progress: 0,
                ready: false,
                loaded: 0,
                total: 0,
                waiting: [],
                everyoneIn: false,
              }),
              ...patch,
            },
    }),
  setHud: (patch) => {
    const hud = get().hud;
    for (const k in patch) {
      if (hud[k as keyof HudState] !== patch[k as keyof HudState]) {
        set({ hud: { ...hud, ...patch } });
        return;
      }
    }
  },
  resetHud: (patch) =>
    set({
      hud: { ...DEFAULT_HUD, ...patch },
      countdown: null,
      eliminatedSheet: false,
      spectate: null,
      emoteWheelOpen: false,
    }),
  setCountdown: (countdown) => set({ countdown }),
  showStamp: (kind, opts = {}) => {
    const id = stampSeq++;
    set({ stamps: [...get().stamps, { id, kind, ...opts }] });
    return id;
  },
  dismissStamp: (id) => set({ stamps: get().stamps.filter((s) => s.id !== id) }),
  clearStamps: () => set({ stamps: [] }),
  setEliminatedSheet: (eliminatedSheet) => set({ eliminatedSheet }),
  setWatchChoice: (watchChoice) => set({ watchChoice }),
  setShowSeat: (showSeat) => set({ showSeat }),
  setSpectate: (spectate) => set({ spectate }),
  setEmoteWheel: (emoteWheelOpen) => set({ emoteWheelOpen }),
  setResults: (results) => set({ results }),
  setBetweenRounds: (betweenRounds) => set({ betweenRounds }),
  setFinalHype: (finalHype) => set({ finalHype }),
  setVictory: (victory) => set({ victory }),
  setPlayerWall: (playerWall, opts) =>
    set({
      playerWall,
      playerWallOptions: { ...get().playerWallOptions, ...opts },
      playerWallSeq: get().playerWallSeq + 1,
    }),
  setRewards: (rewards) => set({ rewards, ...(rewards ? { rewardsPending: null } : {}) }),
  setRewardsPending: (rewardsPending) => set({ rewardsPending }),
  setReplays: (replays) => set({ replays }),
  setReplayLive: (replayLive) => {
    if (get().replayLive !== replayLive) set({ replayLive });
  },
  setReplay: (replay) => set({ replay }),
  patchReplay: (patch) => {
    const r = get().replay;
    if (!r) return;
    for (const k in patch) {
      if (r[k as keyof ReplayViewerState] !== patch[k as keyof ReplayViewerState]) {
        set({ replay: { ...r, ...patch } });
        return;
      }
    }
  },
}));

function applyScreen(screen: ScreenId, transition: TransitionKind): void {
  const s = ui.getState();
  ui.setState({
    screen,
    prevScreen: s.screen === screen ? s.prevScreen : s.screen,
    screenTransition: transition,
    screenSeq: s.screenSeq + 1,
    inputMode: MENU_INPUT_SCREENS.has(screen) ? 'menu' : 'game',
    // Leaving the round clears in-round transient UI so it never leaks into menus.
    ...(screen !== 'round' ? { eliminatedSheet: false, emoteWheelOpen: false, countdown: null } : {}),
    overlay: screen === 'menu' ? s.overlay : 'none',
  });
}

/**
 * React hook over the UI store.
 * @param selector Pick the smallest slice you need; HUD widgets should select single fields.
 * @example const qualified = useUI((s) => s.hud.qualified);
 */
export function useUI<T>(selector: (s: UIState) => T): T {
  return useStore(ui, selector);
}
