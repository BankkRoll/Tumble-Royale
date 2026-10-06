/**
 * UI → game intents.
 *
 * The UI never performs game/network side effects itself; it emits typed
 * intents that the client composition root subscribes to with `uiEvents.on`
 * or the `bindUI({ onPlay, ... })` convenience.
 */
import type {
  CosmeticSlot,
  CustomLobbyOptions,
  LeaderboardId,
  LeaderboardScope,
  LobbyGameId,
  MenuTab,
  NavDirection,
  OverlayId,
  PlayMode,
  PatternId,
  PlayerWallEvent,
  ReplayCommand,
  ReportReason,
  ScreenId,
  Settings,
  SettingsSection,
  TumblerColors,
} from './types.ts';
import type { ClubEmblem, ClubJoinMode, ClubReportReason } from '@tumble/shared';
import type { AuthProviderId } from './account.ts';
import type { ShareCardFormat } from './share.ts';

/** Every intent the UI can emit, keyed by name with its payload. */
export interface UIIntents {
  /** Splash "press any button" (also unlocks audio). */
  start: undefined;
  /** Welcome screen submitted. */
  welcomeDone: { name: string; colors: TumblerColors };
  /** Tutorial prompt answered. */
  tutorialChoice: { accept: boolean; dontAskAgain: boolean };
  /** Visit Practice Island (Play tab, Settings → Gameplay), any time. */
  startPractice: undefined;
  /** Main menu tab changed (3D lobby moves its camera). */
  menuTab: { tab: MenuTab };
  overlay: { overlay: OverlayId };
  selectPlaylist: { playlistId: string };
  /** Start a show. `mode` defaults to online when reachable, else offline vs bots. */
  play: { playlistId: string; mode?: PlayMode };
  /** Play tab mode switch (online matchmaking vs offline with bots). */
  playMode: { mode: PlayMode };
  /** Re-probe the game servers from the "server offline" state. */
  retryOnline: undefined;
  /** Host an offline custom show vs bots with the picked rounds. */
  playCustomOffline: { options: CustomLobbyOptions };
  /** Look up a shared custom round by its share code for the round picker. */
  customRoundLookup: { code: string };
  cancelQueue: undefined;
  ready: { ready: boolean };
  /** Preview an item on the 3D Tumbler (`itemId` null = clear). */
  tryOn: { slot: CosmeticSlot; itemId: string | null };
  equip: { slot: CosmeticSlot; itemId: string };
  selectLoadout: { index: number };
  customizeColors: { colors: TumblerColors };
  randomizeOutfit: undefined;
  purchase: { offerId: string };
  /** Store → Purchases opened or refreshed. */
  requestPurchaseHistory: undefined;
  /**
   * Refund a store purchase (already confirmed by the player), or request a
   * Gem pack refund (`reason` required) for staff review.
   */
  refundPurchase: { purchaseId: string; reason?: string };
  /** Profile → Gifts opened or refreshed. */
  requestGifts: undefined;
  /** Open or decline a received gift, or cancel a sent one (already confirmed where it costs anything). */
  giftAction: { giftId: string; action: 'open' | 'decline' | 'cancel' };
  /** Open the gift sheet for an offer, optionally with a friend picked. */
  openGiftPicker: { offerId: string; recipientId?: string };
  /** Send a gift the player confirmed (price shown in the confirm dialog). */
  sendGift: { offerId: string; recipientId: string; message?: string };
  /** Profile → Wish list opened or refreshed. */
  requestWishlist: undefined;
  /** Put an item (or `bundle:<id>`) on the wish list, or take it off. */
  wishlistToggle: { itemId: string; on: boolean };
  /** The whole wish list in its new order. */
  wishlistReorder: { itemIds: string[] };
  /** Wish list privacy and store alerts. */
  wishlistSettings: { visibility?: 'friends' | 'nobody'; alerts?: boolean };
  /** A friend's profile card wants their wish list. */
  requestFriendWishlist: { userId: string };
  /** Buy a Gem pack (`StoreData.gemPacks`). */
  buyGems: { packId: string };
  /** Try on several items at once (bundles); an empty list restores the equipped look. */
  tryOnBundle: { items: { slot: CosmeticSlot; itemId: string }[] };
  /** Store/Locker opened (true) or closed: the 3D lobby frames the Tumbler in the dressing-room stage area. */
  dressingRoom: { active: boolean };
  /** Turntable input on the dressing-room stage: yaw drag (radians) and zoom steps (+ = closer). */
  turntable: { rotate: number; zoom: number };
  /** Cards want rendered thumbnails for these item ids (batched, deduplicated). */
  needThumbnails: { ids: string[] };
  claimPassTier: { tier: number; track: 'free' | 'premium' };
  buyPremiumPass: undefined;
  rerollChallenge: { id: string };
  claimChallenge: { id: string };
  /** Claim a reached tier on an event's points track (online accounts). */
  claimEventTier: { eventId: string; tier: number };
  /** Claim a completed event challenge (online accounts). */
  claimEventChallenge: { eventId: string; challengeId: string };
  /** Claim today's daily login reward (online accounts). */
  claimLoginStreak: undefined;
  leaderboardQuery: { board: LeaderboardId; scope?: LeaderboardScope };
  /** Open another player's profile card (ranks, results, friends). */
  inspectPlayer: {
    playerId: string;
    name?: string;
    /** Open the full profile even for party members (whose click opens the player card). */
    direct?: boolean;
  };
  /** News posts the player has opened (clears unread badges). */
  newsRead: { ids: string[] };
  requestMatchHistory: undefined;
  settingsChange: { settings: Settings; section: SettingsSection };
  /**
   * Account management. `link-*` adds a sign-in method to this Tumbler,
   * `signIn-*` signs this device in to an existing Tumbler, `unlink-*` removes
   * one. `value` is the address for the email actions and the new name for `rename`.
   */
  accountAction: {
    action:
      | `link-${AuthProviderId}`
      | `signIn-${AuthProviderId}`
      | `unlink-${AuthProviderId}`
      | 'signOut'
      | 'deleteAccount'
      | 'rename';
    value?: string;
  };
  spectate: undefined;
  spectateNext: { dir: 1 | -1 };
  /** Vote (or change the vote) for the next round on the between-rounds card. */
  castVote: { roundIndex: number; option: number };
  playAgain: undefined;
  backToLobby: undefined;
  emote: { slot: number; id: string };
  quickPing: { kind: string };
  /** Enter photo mode (victory / winner cam / in-round menu while out of play). */
  photoMode: undefined;
  /** Photo mode: save the current frame as a PNG. */
  photoCapture: undefined;
  /** Photo mode: back to the game. */
  photoExit: undefined;
  /** Leave the current show (pause menu / reconnect curtain). */
  leaveShow: undefined;
  createCustom: { options: CustomLobbyOptions };
  joinCode: { code: string };
  /** Host starts the private show; `force` skips the ready check. */
  startCustom: { force?: boolean };
  leaveCustom: undefined;
  /** Host changes lobby settings live (debounced by the UI). */
  updateCustom: { options: Partial<CustomLobbyOptions> };
  /** Host removes a member; they cannot rejoin with the code until unbanned. */
  kickCustomMember: { userId: string };
  unbanCustomMember: { userId: string };
  /** Host hands the crown to another player. */
  transferCustomHost: { userId: string };
  /** Host locks or unlocks code joins. */
  lockCustom: { locked: boolean };
  /** Host retires the invite code for a new one. */
  newCustomCode: undefined;
  /** Member ready toggle in a private lobby. */
  readyCustom: { ready: boolean };
  /** Member switches between playing and spectating. */
  spectateCustom: { spectator: boolean };
  inviteFriend: { friendId: string };
  addFriend: { nameTag: string };
  copyInvite: { code: string };
  kickPartyMember: { memberId: string };
  /** Solo player or party leader starts a lobby mini-game on the menu platform. */
  lobbyGameStart: { game: LobbyGameId };
  /** Solo player or party leader ends the running lobby mini-game. */
  lobbyGameStop: undefined;
  /** Party leader hands leadership to a member. */
  promotePartyMember: { memberId: string };
  leaveParty: undefined;
  /** Friend request by account id (search results, recent players, profiles, chat). */
  requestFriend: { userId: string; name?: string };
  /** Answer or withdraw a pending friend request. */
  friendRequestAction: { userId: string; action: 'accept' | 'decline' | 'cancel' };
  /** Player search in the friends sheet (debounced by the UI). */
  searchPlayers: { query: string };
  removeFriend: { userId: string };
  blockPlayer: { userId: string; name: string };
  unblockPlayer: { userId: string };
  /** Local, persisted per-player mute. `key` is the account id, or `name:<name>` for bots. */
  mutePlayer: { key: string; name: string; muted: boolean };
  reportPlayer: { userId: string; reason: ReportReason; details?: string };
  /** Join a friend's party (or their shared private show) from their row. */
  joinFriend: { userId: string };
  /** Answer a party invite from the notifications panel. */
  partyInviteAction: { userId: string; code: string; action: 'join' | 'decline' };
  /** Reload the player's club, invites and requests (the club section opened, Retry). */
  clubRefresh: undefined;
  /** Found a club (fields already checked against the shared club rules). */
  clubCreate: {
    name: string;
    tag: string;
    description: string;
    emblem: ClubEmblem;
    joinMode: ClubJoinMode;
  };
  /** Club search by name or tag (debounced by the UI); also loads the recommended list. */
  clubSearch: { query: string };
  /** Join an open club, or ask to join a request-only one. */
  clubJoin: { clubId: string };
  /** Withdraw a join request. */
  clubCancelRequest: { clubId: string };
  /** Answer a club invite. */
  clubInviteAnswer: { clubId: string; accept: boolean };
  /** Officers: answer a join request. */
  clubRequestAnswer: { userId: string; accept: boolean };
  /** Officers: invite a friend. */
  clubInvite: { userId: string };
  /** Edit the club (only the fields given). */
  clubEdit: {
    name?: string;
    tag?: string;
    description?: string;
    emblem?: ClubEmblem;
    joinMode?: ClubJoinMode;
  };
  /** Kick (already confirmed), change a role, or hand over ownership (already confirmed). */
  clubMember: { userId: string; action: 'kick' | 'officer' | 'member' | 'transfer' };
  /** Leave the club, or disband it (owner); already confirmed. */
  clubLeave: { disband?: boolean };
  /** Load the weekly goals tab. */
  clubGoals: undefined;
  /** Claim a completed weekly goal. */
  clubClaim: { week: string; goalId: string };
  /** Invite an online club mate into the party. */
  clubPartyUp: { userId: string };
  /** Club chat from the club page's own input. */
  clubChat: { text: string };
  /** Report a club. */
  clubReport: { clubId: string; reason: ClubReportReason; details?: string };
  /**
   * Switch voice chat on (after the first-use explanation; the game then asks
   * for the microphone) or off.
   */
  voiceToggle: { on: boolean };
  /** Settings → Voice opened: re-check availability and list microphones. */
  voiceRefresh: undefined;
  /** In-show text chat (online shows only). */
  sendChat: { text: string };
  /** The in-show chat input opened or closed (the game frees the mouse and held keys). */
  chatInput: { open: boolean };
  /** Rewards / victory / winner-cam "Continue". */
  continue: { from: ScreenId };
  /** Timeline beat of the player wall; the 3D wall scene syncs to these. */
  playerWallEvent: PlayerWallEvent;
  /** The Tumble Wipe fully covers the screen: swap 3D scenes now. */
  transitionCovered: { to: ScreenId };
  /** A screen finished its entrance. */
  screenShown: { screen: ScreenId };
  dialogResult: { dialogId: string; buttonId: string };
  toastAction: { toastId: number; actionId: string };
  retryConnection: undefined;
  /** Install app (Settings or the menu): show the browser's install prompt. */
  installApp: undefined;
  /** Restart into the downloaded update. */
  applyUpdate: undefined;
  /** Settings → Region is on screen: re-measure region pings. */
  probeRegions: undefined;
  /**
   * Mobile touch controls, emitted synchronously on every change so a tap is
   * never coalesced away. `move` is a unit-disc vector, y = forward.
   */
  touchInput: { move: { x: number; y: number }; jump: boolean; dive: boolean; grab: boolean };
  /** Camera drag on the touch HUD, in CSS pixels since the last emit. */
  touchLook: { dx: number; dy: number };
  /** Touch Done button: leave idle play and bring the menu back. */
  leaveIdlePlay: undefined;
  /** A tap (not a drag) on the touch camera surface during idle play, in client pixels; picks the sign or a party member like a click on the stage. */
  stageTap: { x: number; y: number };
  /** A menu navigation the UI didn't consume (e.g. Back on the root menu). */
  navUnhandled: { dir: NavDirection };
  /** Colour preview while the welcome screen is open. */
  previewColors: { colors: TumblerColors; pattern: PatternId };
  /** Watch a recorded round of this show (`ReplayRoundEntry.key`). */
  replayOpen: { key: string };
  /** Watch the round in progress from the start (after being knocked out). */
  replayOpenLive: undefined;
  /** Load a saved replay file and play it. */
  replayOpenFile: { name: string; bytes: ArrayBuffer };
  /** Replay viewer control. */
  replayCommand: ReplayCommand;
  /** Skip the "How you went out" replay (its button; keys, clicks and pad buttons skip it too). */
  elimReplaySkip: undefined;
  /** Play highlights in the replay viewer, one after another (`HighlightEntry.id`s, in order). */
  highlightPlay: { ids: string[] };
  /** A highlight's Share button opened the share sheet on it (analytics). */
  highlightShare: { id: string };
  /** Share sheet: render the show's share card. */
  shareCard: { format: ShareCardFormat; includeName: boolean };
  /** Share sheet: render a clip of a recorded round (window in recording seconds). */
  shareClip: { key: string; start: number; length: number };
  /** Share sheet: stop the render in progress. */
  shareCancel: undefined;
  /** Share sheet: hand the rendered file over (Web Share, download or clipboard). */
  shareDeliver: { action: 'share' | 'download' | 'copy' };
  /** Share sheet closed: the rendered file can be dropped. */
  shareClose: undefined;
}

/** Intent name. */
export type UIIntentName = keyof UIIntents;

/** Listener for one intent. */
export type UIIntentListener<K extends UIIntentName> = (payload: UIIntents[K]) => void;

type AnyListener = (payload: never) => void;

/**
 * Minimal typed emitter. Synchronous, allocation-free on emit; listener errors
 * are isolated so one bad subscriber can't break the UI.
 */
export class UIEventEmitter {
  private readonly listeners = new Map<UIIntentName, Set<AnyListener>>();
  private readonly anyListeners = new Set<(name: UIIntentName, payload: unknown) => void>();

  /**
   * Subscribes to an intent.
   * @returns Unsubscribe function.
   * @example uiEvents.on('play', ({ playlistId }) => net.queue(playlistId));
   */
  on<K extends UIIntentName>(name: K, fn: UIIntentListener<K>): () => void {
    const set = this.listeners.get(name) ?? new Set<AnyListener>();
    this.listeners.set(name, set);
    set.add(fn as AnyListener);
    return () => set.delete(fn as AnyListener);
  }

  /** Subscribes to every intent (logging, analytics, the preview harness). */
  onAny(fn: (name: UIIntentName, payload: unknown) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  /** Emits an intent. Used by UI components; the game normally only listens. */
  emit<K extends UIIntentName>(
    name: K,
    ...payload: UIIntents[K] extends undefined ? [] : [UIIntents[K]]
  ): void {
    const value = payload[0] as UIIntents[K];
    const set = this.listeners.get(name);
    if (set) {
      for (const fn of set) {
        try {
          (fn as UIIntentListener<K>)(value);
        } catch (err) {
          console.error(`[ui] listener for "${name}" threw`, err);
        }
      }
    }
    for (const fn of this.anyListeners) {
      try {
        fn(name, value);
      } catch (err) {
        console.error('[ui] onAny listener threw', err);
      }
    }
  }

  /** Removes every listener. */
  clear(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}

/** The shared UI intent bus. */
export const uiEvents = new UIEventEmitter();

type HandlerName<K extends string> = `on${Capitalize<K>}`;

/** `on<Intent>` callback map accepted by `bindUI`. */
export type UIHandlers = {
  [K in UIIntentName as HandlerName<K>]?: UIIntentListener<K>;
};

/**
 * Subscribes a handler object to the intent bus.
 * @param handlers `onPlay`, `onCancelQueue`, `onEquip`, … (any subset).
 * @returns Unsubscribe-all function.
 * @example
 * const off = bindUI({
 *   onPlay: ({ playlistId }) => matchmaker.queue(playlistId),
 *   onCancelQueue: () => matchmaker.cancel(),
 * });
 */
export function bindUI(handlers: UIHandlers): () => void {
  const offs: (() => void)[] = [];
  for (const [key, fn] of Object.entries(handlers)) {
    if (!key.startsWith('on') || typeof fn !== 'function') continue;
    const name = (key.charAt(2).toLowerCase() + key.slice(3)) as UIIntentName;
    offs.push(uiEvents.on(name, fn as UIIntentListener<typeof name>));
  }
  return () => {
    for (const off of offs) off();
  };
}
