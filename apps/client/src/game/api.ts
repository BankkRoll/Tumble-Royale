/**
 * Account API client (apps/api). The game stays fully playable offline; when
 * the API answers, the guest signs in and the meta game (profile, locker,
 * store, pass, challenges, social, matchmaking tickets) runs against it.
 *
 * Responsibilities:
 * - guest sign-in, refresh-token rotation and device fallback (tokens persisted);
 * - authenticated JSON requests that refresh once on 401 and surface the
 *   API's `{ error, message }` as {@link ApiError};
 * - typed endpoint helpers mirroring `apps/api/README.md`.
 */
import type { PlayerRewardMsg } from '@tumble/netcode';
import type { ClubEmblemMotif, ClubJoinMode, ClubRole, VoiceConfigResponse } from '@tumble/shared';
import type { WalletLedger } from './online/checkout.ts';
import type {
  ApiGiftInbox,
  ApiGiftPicker,
  ApiGiftResult,
  ApiWishlist,
  ApiWishlistEntry,
} from './online/gifts.ts';
import type { ApiPurchaseHistory, ApiRefundResult } from './online/purchaseHistory.ts';
import { tokenSubject, type AuthOutcome, type LoginProvider } from './online/returnUrl.ts';
import { loadJson, removeJson, saveJson } from './storage.ts';

/** Tokens returned by `/auth/guest` and `/auth/refresh`. */
interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  deviceToken: string;
}

const PROBE_TIMEOUT_MS = 900;
const REQUEST_TIMEOUT_MS = 8000;
/** Refresh this long before the access token expires (15 min lifetime). */
const REFRESH_MARGIN_S = 60;

/** An API error response (`{ error, message, details? }`) or a network failure (`status` 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// -----------------------------------------------------------------------------
// Response shapes (the subset the client reads)
// -----------------------------------------------------------------------------

/** `GET /me`. */
export interface ApiMe {
  userId: string;
  displayName: string;
  tag: string;
  region: string;
  level: number;
  xp: { total: number; intoLevel: number; toNext: number };
  crowns: number;
  stats: {
    showsPlayed: number;
    wins: number;
    finals: number;
    roundsPlayed: number;
    roundsQualified: number;
    currentWinStreak: number;
    bestWinStreak: number;
  };
  ranked: { queue: string; tier: string; division: number; rp: number; placementsLeft: number }[];
  isGuest: boolean;
  wallet: { gumballs: number; gems: number; crownShards: number };
  activeLoadout: number;
  linkedProviders: string[];
  /** When the next rename is allowed (ISO); null = now. */
  nameChangeAvailableAt?: string | null;
}

/** `POST /auth/exchange` and `POST /auth/email/verify`: a session plus what the sign-in did. */
export interface ApiAuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; tag: string; isGuest: boolean };
  outcome: AuthOutcome;
  provider: LoginProvider;
}

/** `GET /auth/providers`. */
export interface ApiAuthProviders {
  discord: boolean;
  google: boolean;
  email: boolean;
}

/** API loadout body (content `CosmeticLoadout` + banner/footsteps). */
export interface ApiLoadoutItems {
  colors: [string, string, string];
  pattern: string;
  face: string;
  upper: string | null;
  lower: string | null;
  headwear: string | null;
  back: string | null;
  emotes: [string, string, string, string];
  celebration: string;
  victoryPose: string;
  nameplate: string;
  trail: string | null;
  banner: string | null;
  footsteps: string | null;
}

/** `GET /loadouts`. */
export interface ApiLoadouts {
  activeIndex: number;
  slots: ({ index: number; name: string; items: ApiLoadoutItems } | null)[];
}

/** A store offer. `offerId` is the cosmetic id. */
export interface ApiOffer {
  offerId: string;
  section: 'featured' | 'daily' | 'weekly';
  item: { id: string; name: string; slot: string; rarity: string };
  /** Today's price. */
  price: { currency: 'gumballs' | 'gems'; amount: number };
  /** Catalog price (higher than `price` on deals). */
  listPrice?: { currency: 'gumballs' | 'gems'; amount: number };
  owned: boolean;
}

/** A bundle priced for the caller (`offerId` is `bundle:<id>`). */
export interface ApiBundle {
  offerId: string;
  name: string;
  description: string;
  itemIds: string[];
  /** Items the caller does not own yet; buying grants these. */
  missing: string[];
  price: { currency: 'gumballs' | 'gems'; amount: number };
  listPrice: { currency: 'gumballs' | 'gems'; amount: number };
  owned: boolean;
}

/** `GET /store`. */
export interface ApiStore {
  day: string;
  featured: ApiOffer[];
  daily: ApiOffer[];
  weekly?: ApiOffer[];
  /** This week's hero bundle offer id. */
  heroBundle?: string | null;
  bundles?: ApiBundle[];
  /** Every item for sale at list price. */
  catalog?: { offerId: string; price: { currency: 'gumballs' | 'gems'; amount: number }; owned: boolean }[];
  refreshesAt: string;
  weeklyRefreshesAt?: string;
}

/** A Gem pack. */
export interface ApiGemPack {
  id: string;
  gems: number;
  priceCents: number;
  currency: string;
  name: string;
}

/** A pass reward. */
export type ApiPassReward =
  { type: 'cosmetic'; id: string } | { type: 'gumballs' | 'gems' | 'crown_shards'; amount: number };

/** `GET /shop/shards`. */
export interface ApiShardShop {
  week: string;
  refreshesAt: string;
  shardsPerCrown: number;
  /** Signed-in balance, null when anonymous. */
  balance: number | null;
  offers: { offerId: string; price: { currency: 'crown_shards'; amount: number }; owned: boolean }[];
}

/** `GET /gems/packs`. */
export interface ApiGemPacks {
  provider: string;
  /** Older APIs omit it; `provider` then decides. */
  checkout?: 'live' | 'test' | 'unavailable';
  packs: ApiGemPack[];
}

/** `GET /pass`. */
export interface ApiPass {
  seasonId: string;
  /** Absent on APIs from before season rollover (always Season 1). */
  seasonNumber?: number;
  name: string;
  startsAt?: string;
  endsAt: string;
  next?: { id: string; number: number; name: string; startsAt: string };
  /** Ended seasons this request settled (unclaimed rewards auto-granted). */
  settled?: { seasonId: string; name: string; autoGranted: number }[];
  xp: number;
  tier: number;
  maxTier: number;
  xpIntoTier: number;
  nextTierXp: number;
  premium: boolean;
  premiumPriceGems: number;
  tiers: {
    tier: number;
    xp: number;
    free: ApiPassReward[];
    premium: ApiPassReward[];
    freeClaimed: boolean;
    premiumClaimed: boolean;
    unlocked: boolean;
  }[];
}

/** One challenge row. */
export interface ApiChallenge {
  id: string;
  challengeId: string;
  title: string;
  metric: string | null;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  reward: {
    xp: number;
    gumballs: number;
    gems?: number;
    cosmetic?: { id: string; name: string; slot: string; rarity: string } | null;
  };
  rerolled: boolean;
}

/** `GET /challenges`. */
export interface ApiChallenges {
  daily: ApiChallenge[];
  weekly: ApiChallenge[];
  /** Absent on APIs that predate seasonal and milestone challenges. */
  seasonal?: ApiChallenge[];
  milestone?: ApiChallenge[];
  rerollsLeft: number;
  dailyRefreshesAt: string;
  weeklyRefreshesAt: string;
  season?: { id: string; name: string; endsAt: string };
  /** Seasonal challenges of an ended season that this call paid out. */
  settled?: { id: string; title: string; gumballs: number; gems: number; cosmetic: string | null }[];
}

/** A reward as the API describes it (achievements, login ladder). */
export type ApiGrant =
  { type: 'xp' | 'gumballs' | 'gems' | 'crown_shards'; amount: number } | { type: 'cosmetic'; id: string };

/** `GET /achievements`. */
export interface ApiAchievements {
  achievements: {
    id: string;
    category: string;
    title: string;
    description: string;
    hidden: boolean;
    unlocked: boolean;
    unlockedAt: string | null;
    progress: number | null;
    target: number | null;
    series: { id: string; tier: number; tiers: number } | null;
    rewards: ApiGrant[];
  }[];
  categories: { id: string; unlocked: number; total: number }[];
  unlocked: number;
  total: number;
  newlyUnlocked: { id: string; title: string }[];
}

/** `GET /collection`. */
export interface ApiCollection {
  owned: number;
  total: number;
  percent: number;
  entries: {
    id: string;
    owned: boolean;
    acquiredAt: string | null;
    sources: { kind: string; label: string }[];
  }[];
}

/** `GET /streak`. */
export interface ApiStreak {
  streak: number;
  best: number;
  claims: number;
  today: string;
  claimedToday: boolean;
  canClaim: boolean;
  nextClaimAt: string;
  breaksAt: string | null;
  next: { streak: number; day: number; rewards: ApiGrant[] };
  ladder: { day: number; rewards: ApiGrant[]; state: 'claimed' | 'today' | 'upcoming' }[];
}

/** One event as `GET /live-events` lists it (also built from bundled content offline). */
export interface ApiLiveEvent {
  id: string;
  name: string;
  description: string;
  art: [string, string];
  icon: string;
  /** Effective window, ISO. */
  startsAt: string;
  endsAt: string;
  phase: 'upcoming' | 'live' | 'ended';
  playlistIds: string[];
  points: {
    perShow: number;
    perQualifiedRound: number;
    finalReached: number;
    crown: number;
    eventPlaylistMultiplier: number;
  };
  challenges: {
    id: string;
    title: string;
    metric: string;
    target: number;
    eventPlaylistsOnly: boolean;
    points: number;
    rewardXp: number;
  }[];
  tiers: { tier: number; points: number; rewards: ApiGrant[] }[];
}

/** `GET /live-events`. */
export interface ApiLiveEvents {
  enabled: boolean;
  events: ApiLiveEvent[];
  serverTime: number;
}

/** The player's standing in one event. */
export interface ApiEventProgress {
  eventId: string;
  points: number;
  shows: number;
  tierReached: number;
  claimedTiers: number[];
  challenges: { id: string; progress: number; target: number; completed: boolean; claimed: boolean }[];
}

/** `GET /live-events/progress`. */
export interface ApiEventProgressList {
  enabled: boolean;
  progress: ApiEventProgress[];
  /** Ended events this read paid out automatically. */
  settled: { eventId: string; name: string; points: number; tiers: number[]; challenges: string[] }[];
  serverTime: number;
}

/** `POST /streak/claim`. */
export interface ApiStreakClaim {
  day: string;
  streak: number;
  best: number;
  ladderDay: number;
  rewards: (ApiGrant & { granted: boolean })[];
  achievements: { id: string; title: string }[];
  wallet: ApiMe['wallet'];
  view: ApiStreak;
}

/** `POST /me/tutorial-complete`. */
export interface ApiTutorialComplete {
  /** True when this call granted the reward; false on repeats. */
  granted: boolean;
  xp: number;
  /** Cosmetic id unlocked by this call, or null. */
  unlock: string | null;
  level: number;
  totalXp: number;
}

/** `GET /leaderboards/:type`. */
export interface ApiLeaderboard {
  entries: { rank: number; userId: string; score: number; displayName: string; tag: string }[];
  me: { rank: number; userId: string; score: number; displayName: string; tag: string } | null;
}

/** `GET /me/matches` row. */
export interface ApiMatch {
  id: string;
  queue: string;
  playlistId: string;
  endedAt: string;
  playerCount: number;
  placement: number;
  crowned: boolean;
  xp: number;
  gumballs: number;
  rounds: { index: number; roundId: string; roundType: string; played: boolean; qualified: boolean }[];
}

/** A friend card. */
export interface ApiFriendCard {
  userId: string;
  displayName: string;
  tag: string;
  level: number;
}

/** Presence states the API reports. */
export type ApiPresenceStatus = 'online' | 'in_menu' | 'in_queue' | 'in_match' | 'offline';

/** What friends see about a player's presence (`GET /friends`, realtime `presence`). */
export interface ApiPresenceView {
  playlistId?: string;
  lobbyCode?: string;
  joinable?: boolean;
}

/** A friend row in `GET /friends`. */
export type ApiFriend = ApiFriendCard & ApiPresenceView & { presence: ApiPresenceStatus; since?: string };

/** A pending request or blocked row (`at` = ISO time it was made). */
export type ApiFriendRequest = ApiFriendCard & { at?: string };

/** `GET /friends`. */
export interface ApiFriends {
  friends: ApiFriend[];
  incoming: ApiFriendRequest[];
  outgoing: ApiFriendRequest[];
  blocked?: ApiFriendRequest[];
  total?: number;
}

/** How the caller relates to another player. */
export type ApiRelation = 'self' | 'friend' | 'incoming' | 'outgoing' | 'none';

/** `GET /friends/recent` row. */
export type ApiRecentPlayer = ApiFriendCard & { relation?: ApiRelation; presence?: ApiPresenceStatus };

/** `GET /friends/search` row. */
export type ApiSearchResult = ApiFriendCard & { relation: ApiRelation };

/** Report reasons accepted by `POST /report`. */
export type ApiReportReason =
  'cheating' | 'harassment' | 'offensive_name' | 'griefing' | 'spam' | 'voice' | 'other';

/** A party (API view). */
export interface ApiParty {
  id: string;
  code: string;
  leaderId: string;
  members: { userId: string; displayName: string; tag: string; ready: boolean; joinedAt: number }[];
  playlistId: string;
  inviteUrl: string;
  maxSize: number;
}

/** A club as other players see it. */
export interface ApiClubCard {
  id: string;
  name: string;
  tag: string;
  description: string;
  emblem: { motif: ClubEmblemMotif; primary: string; secondary: string };
  joinMode: ClubJoinMode;
  memberCount: number;
  maxMembers: number;
}

/** `GET /clubs/me`. */
export interface ApiMyClub {
  club:
    | (ApiClubCard & {
        members: {
          userId: string;
          displayName: string;
          tag: string;
          level: number;
          role: ClubRole;
          presence: string;
        }[];
      })
    | null;
  role: ClubRole | null;
  joinRequests?: { userId: string; displayName: string; tag: string; level: number; at: string }[];
  invites: { club: ApiClubCard; from: { userId: string; name: string; tag: string } | null }[];
  requests: { club: ApiClubCard }[];
}

/** A club chat line. */
export interface ApiClubChatLine {
  id: string;
  clubId: string;
  from: { userId: string; name: string; tag: string; club?: string };
  text: string;
  masked?: string;
  at: number;
}

/** `GET /clubs/me/goals`. */
export interface ApiClubGoals {
  week: string;
  refreshesAt: string;
  eligible: boolean;
  goals: {
    goalId: string;
    title: string;
    progress: number;
    target: number;
    completed: boolean;
    claimed: boolean;
    reward: { xp: number; gumballs: number };
  }[];
  contributions: {
    userId: string;
    displayName: string;
    tag: string;
    shows: number;
    rounds: number;
    crowns: number;
  }[];
  settled: { goalId: string; title: string; xp: number; gumballs: number }[];
}

/** `GET /party/code/:code`: who is behind an invite code. */
export interface ApiPartyPreview {
  code: string;
  /** `name#tag` of the leader. */
  leader: string | null;
  size: number;
  maxSize: number;
  playlistId: string;
}

/** `GET /profile/:id`. */
export interface ApiProfileCard {
  userId: string;
  displayName: string;
  tag: string;
  level: number;
  xp?: { total: number; intoLevel: number; toNext: number };
  crowns?: number;
  stats?: {
    showsPlayed: number;
    wins: number;
    finals: number;
    roundsPlayed: number;
    roundsQualified: number;
    currentWinStreak: number;
    bestWinStreak: number;
  };
  ranked?: { queue: string; tier: string; division: number; rp: number; placementsLeft: number }[];
  loadout: ApiLoadoutItems | null;
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Seconds until a JWT's `exp` (negative when expired, -Infinity when unreadable). */
function secondsLeft(jwt: string): number {
  try {
    const part = jwt.split('.')[1] ?? '';
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp - Date.now() / 1000 : -Infinity;
  } catch {
    return -Infinity;
  }
}

/**
 * A fresh idempotency key for one purchase attempt (8–128 URL-safe chars).
 *
 * @param prefix - Readable prefix for logs.
 */
export function idempotencyKey(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`.replace(/[^A-Za-z0-9_\-:.]/g, '').slice(0, 128);
}

/**
 * Account API client.
 *
 * @example
 * const api = new ApiClient('http://localhost:7360');
 * if (await api.probe()) await api.signInGuest('Sprinkles');
 * const me = await api.me();
 */
export class ApiClient {
  /** True after a successful health probe. */
  online = false;
  private tokens: AuthTokens | null = loadJson<AuthTokens>('auth');
  private refreshing: Promise<boolean> | null = null;

  constructor(readonly baseUrl: string) {}

  /** Whether a guest session exists (tokens stored). */
  get signedIn(): boolean {
    return this.tokens !== null;
  }

  /** Realtime gateway URL for the current access token. */
  wsUrl(token: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  }

  /**
   * Checks that the API answers.
   *
   * @returns True when reachable.
   */
  async probe(): Promise<boolean> {
    const r = await fetchJson<{ ok?: boolean }>(
      `${this.baseUrl}/health`,
      { method: 'GET' },
      PROBE_TIMEOUT_MS,
    );
    this.online = r !== null;
    return this.online;
  }

  /**
   * Signs in (or back in) as a guest, keeping the device token so the same
   * account comes back on later launches.
   *
   * @param displayName - Name chosen on the welcome screen.
   * @returns True when tokens were obtained.
   */
  async signInGuest(displayName: string): Promise<boolean> {
    if (!this.online) return false;
    const body = {
      displayName,
      ...(this.tokens?.deviceToken ? { deviceToken: this.tokens.deviceToken } : {}),
    };
    const r = await fetchJson<AuthTokens>(
      `${this.baseUrl}/auth/guest`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      REQUEST_TIMEOUT_MS,
    );
    if (!r?.accessToken) return false;
    this.tokens = { accessToken: r.accessToken, refreshToken: r.refreshToken, deviceToken: r.deviceToken };
    saveJson('auth', this.tokens);
    return true;
  }

  /**
   * Rotates the refresh token at launch (falls back to device sign-in).
   *
   * @param displayName - Current display name for the fallback.
   */
  async resume(displayName: string): Promise<boolean> {
    if (!this.online || !this.tokens) return false;
    if (await this.refresh()) return true;
    return this.signInGuest(displayName);
  }

  /**
   * Revokes the session on the server (best effort) and forgets every token,
   * including the device token, so the next launch starts a new guest.
   */
  async signOut(): Promise<void> {
    const tokens = this.tokens;
    this.tokens = null;
    removeJson('auth');
    if (!tokens || !this.online) return;
    await fetchJson(
      `${this.baseUrl}/auth/logout`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      },
      REQUEST_TIMEOUT_MS,
    );
  }

  /** The signed-in account's id (from the stored access token), or null. */
  currentUserId(): string | null {
    return tokenSubject(this.tokens?.accessToken);
  }

  /**
   * Switches this device to a session from an OAuth/email sign-in.
   *
   * @param session - Tokens from `/auth/exchange` or `/auth/email/verify`.
   * @param keepDevice - Keep the guest device token. Only for the same
   *   account: a stale device token would otherwise sign the device back in
   *   to the old guest the next time a refresh fails.
   */
  adoptSession(session: { accessToken: string; refreshToken: string }, keepDevice: boolean): void {
    this.tokens = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      deviceToken: keepDevice ? (this.tokens?.deviceToken ?? '') : '',
    };
    saveJson('auth', this.tokens);
  }

  /** Drops the stored session without telling the server (the account is gone). */
  forget(): void {
    this.tokens = null;
    removeJson('auth');
  }

  /**
   * Revokes a session this device decided not to keep (best effort).
   *
   * @param refreshToken - That session's refresh token.
   */
  async revoke(refreshToken: string): Promise<void> {
    await fetchJson(
      `${this.baseUrl}/auth/logout`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      REQUEST_TIMEOUT_MS,
    );
  }

  /** Rotates the refresh token; concurrent callers share one rotation. */
  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const tokens = this.tokens;
    if (!tokens) return Promise.resolve(false);
    this.refreshing = (async () => {
      const r = await fetchJson<{ accessToken: string; refreshToken: string }>(
        `${this.baseUrl}/auth/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        },
        REQUEST_TIMEOUT_MS,
      );
      if (!r?.accessToken) return false;
      this.tokens = { ...tokens, accessToken: r.accessToken, refreshToken: r.refreshToken };
      saveJson('auth', this.tokens);
      return true;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * An access token valid for at least a minute (refreshing first if needed),
   * for the matchmaker and the realtime gateways.
   */
  async accessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (secondsLeft(this.tokens.accessToken) < REFRESH_MARGIN_S) await this.refresh();
    return this.tokens?.accessToken ?? null;
  }

  /**
   * Authenticated JSON request. Refreshes once on 401.
   *
   * @throws {ApiError} On any non-2xx answer or network failure.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<T> {
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
      if (opts.auth !== false) {
        const token = await this.accessToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: ctrl.signal,
        });
      } finally {
        window.clearTimeout(timer);
      }
    };
    let res: Response;
    try {
      res = await send();
      if (res.status === 401 && opts.auth !== false && (await this.refresh())) res = await send();
    } catch (err) {
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
      details?: unknown;
    } | null;
    if (!res.ok)
      throw new ApiError(
        res.status,
        data?.error ?? 'http_error',
        data?.message ?? `HTTP ${res.status}`,
        data?.details,
      );
    return data as T;
  }

  // ---------------------------------------------------------------------------
  // Account & locker
  // ---------------------------------------------------------------------------

  me = (): Promise<ApiMe> => this.request('GET', '/me');
  patchMe = (patch: {
    displayName?: string;
    region?: string;
  }): Promise<{ displayName?: string; tag?: string }> => this.request('PATCH', '/me', patch);
  profileCard = (userId: string): Promise<ApiProfileCard> =>
    this.request('GET', `/profile/${encodeURIComponent(userId)}`);
  inventory = (): Promise<{ items: { id: string; source: string }[] }> => this.request('GET', '/inventory');
  loadouts = (): Promise<ApiLoadouts> => this.request('GET', '/loadouts');
  putLoadout = (index: number, name: string, items: ApiLoadoutItems): Promise<{ index: number }> =>
    this.request('PUT', `/loadouts/${index}`, { name, items });
  activateLoadout = (index: number): Promise<{ activeIndex: number; items: ApiLoadoutItems }> =>
    this.request('POST', `/loadouts/${index}/activate`);
  /** Deletes the account on the server (204; the literal confirm guards against stray calls). */
  deleteMe = (): Promise<void> => this.request('DELETE', '/me', { confirm: 'DELETE' });

  // ---------------------------------------------------------------------------
  // Sign-in methods
  // ---------------------------------------------------------------------------

  authProviders = (): Promise<ApiAuthProviders> =>
    this.request('GET', '/auth/providers', undefined, { auth: false });
  /** Trades the one-time code from `/auth/complete` for a session. */
  exchangeCode = (code: string): Promise<ApiAuthResult> =>
    this.request('POST', '/auth/exchange', { code }, { auth: false });
  /** Redeems an email magic-link token for a session. */
  verifyEmail = (token: string): Promise<ApiAuthResult> =>
    this.request('POST', '/auth/email/verify', { token }, { auth: false });
  /**
   * Starts Discord/Google sign-in. With `link` the signed-in account is sent
   * along, so a new identity is linked to it (or the device switches to the
   * account that already owns it).
   */
  startOAuth = (provider: 'discord' | 'google', link: boolean): Promise<{ url: string }> =>
    this.request('POST', `/auth/${provider}/start`, undefined, { auth: link });
  /** Emails a magic link; `link` works as for {@link ApiClient.startOAuth}. */
  startEmail = (email: string, link: boolean): Promise<{ sent: boolean }> =>
    this.request('POST', '/auth/email/start', { email }, { auth: link });
  unlinkIdentity = (provider: LoginProvider): Promise<{ linkedProviders: string[] }> =>
    this.request('DELETE', `/me/identities/${provider}`);

  // ---------------------------------------------------------------------------
  // Economy & progression
  // ---------------------------------------------------------------------------

  store = (): Promise<ApiStore> => this.request('GET', '/store');
  wallet = (): Promise<{ wallet: ApiMe['wallet'] } & WalletLedger> => this.request('GET', '/wallet');
  purchase = (offerId: string, key: string): Promise<{ wallet: ApiMe['wallet']; replayed: boolean }> =>
    this.request('POST', '/purchase', { offerId }, { idempotencyKey: key });
  gemPacks = (): Promise<ApiGemPacks> => this.request('GET', '/gems/packs');
  /** Purchase history with each purchase's refund and refund eligibility. */
  purchaseHistory = (): Promise<ApiPurchaseHistory> => this.request('GET', '/purchases');
  /** Refunds a store purchase, or files a Gem pack refund request (`reason` required there). */
  refundPurchase = (purchaseId: string, reason?: string): Promise<ApiRefundResult> =>
    this.request('POST', `/purchases/${encodeURIComponent(purchaseId)}/refund`, reason ? { reason } : {});
  /** Gifts sent and received, with today's count and the policy. */
  gifts = (): Promise<ApiGiftInbox> => this.request('GET', '/gifts');
  /** Every friend with whether they can be gifted this offer now. */
  giftPicker = (offerId: string): Promise<ApiGiftPicker> =>
    this.request('GET', `/gifts/eligibility?offerId=${encodeURIComponent(offerId)}`);
  /** Buys an offer for a friend; the key makes a retried send replay the first. */
  sendGift = (
    body: { recipientId: string; offerId: string; message?: string },
    key: string,
  ): Promise<ApiGiftResult & { wallet: ApiMe['wallet'] }> =>
    this.request('POST', '/gifts', body, { idempotencyKey: key });
  /** Opens or declines a received gift, or cancels a sent one. */
  giftAction = (giftId: string, action: 'open' | 'decline' | 'cancel'): Promise<ApiGiftResult> =>
    this.request('POST', `/gifts/${encodeURIComponent(giftId)}/${action}`);
  wishlist = (): Promise<ApiWishlist> => this.request('GET', '/wishlist');
  wishlistAdd = (itemId: string): Promise<ApiWishlist> => this.request('POST', '/wishlist', { itemId });
  wishlistRemove = (itemId: string): Promise<ApiWishlist> =>
    this.request('DELETE', `/wishlist/${encodeURIComponent(itemId)}`);
  wishlistOrder = (itemIds: string[]): Promise<ApiWishlist> =>
    this.request('PUT', '/wishlist/order', { itemIds });
  wishlistSettings = (patch: { visibility?: 'friends' | 'nobody'; alerts?: boolean }): Promise<ApiWishlist> =>
    this.request('PATCH', '/wishlist/settings', patch);
  /** A friend's wish list (403 `wishlist_hidden` when they don't share it with you). */
  friendWishlist = (userId: string): Promise<{ userId: string; entries: ApiWishlistEntry[] }> =>
    this.request('GET', `/players/${encodeURIComponent(userId)}/wishlist`);
  shardShop = (): Promise<ApiShardShop> => this.request('GET', '/shop/shards');
  buyShardOffer = (offerId: string, key: string): Promise<{ wallet: ApiMe['wallet']; replayed: boolean }> =>
    this.request('POST', '/shop/shards/buy', { offerId }, { idempotencyKey: key });
  /** Feature flags; signed in, percentage rollouts are evaluated for this account. */
  flags = (): Promise<{ flags: Record<string, unknown> }> => this.request('GET', '/flags');
  /** Maintenance window and the server clock (public). */
  status = (): Promise<{ maintenance: unknown; serverTime: number }> =>
    this.request('GET', '/status', undefined, { auth: false });
  /** Every playlist's effective schedule and the server clock (public). */
  playlistSchedule = (): Promise<{ playlists: unknown[]; serverTime: number }> =>
    this.request('GET', '/playlists', undefined, { auth: false });
  /**
   * The stored access token without refreshing it, for `pagehide` beacons
   * that cannot wait for a refresh. The API treats an expired one as anonymous.
   */
  currentAccessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }
  /** Live news feed (public; no sign-in needed). */
  news = (): Promise<{ posts: unknown[]; withdrawn?: string[] }> =>
    this.request('GET', '/news', undefined, { auth: false });
  gemCheckout = (
    packId: string,
    key: string,
  ): Promise<{ status: string; checkoutUrl: string; gems: number; provider: string }> =>
    this.request('POST', '/gems/checkout', { packId }, { idempotencyKey: key });
  pass = (): Promise<ApiPass> => this.request('GET', '/pass');
  claimPassTier = (tier: number, track: 'free' | 'premium'): Promise<unknown> =>
    this.request('POST', '/pass/claim', { tier, track });
  unlockPremium = (key: string): Promise<unknown> =>
    this.request('POST', '/pass/premium', undefined, { idempotencyKey: key });
  challenges = (): Promise<ApiChallenges> => this.request('GET', '/challenges');
  rerollChallenge = (id: string): Promise<unknown> => this.request('POST', '/challenges/reroll', { id });
  claimChallenge = (id: string): Promise<unknown> => this.request('POST', '/challenges/claim', { id });
  /** Achievements; also unlocks anything already earned (the API announces those over realtime). */
  achievements = (): Promise<ApiAchievements> => this.request('GET', '/achievements');
  collection = (): Promise<ApiCollection> => this.request('GET', '/collection');
  streak = (): Promise<ApiStreak> => this.request('GET', '/streak');
  claimStreak = (): Promise<ApiStreakClaim> => this.request('POST', '/streak/claim');
  /** Upcoming, live and recently ended events (public). */
  liveEvents = (): Promise<ApiLiveEvents> => this.request('GET', '/live-events', undefined, { auth: false });
  /** The player's event progress; also pays out events that ended. */
  eventProgress = (): Promise<ApiEventProgressList> => this.request('GET', '/live-events/progress');
  claimEventTier = (eventId: string, tier: number): Promise<{ progress: ApiEventProgress }> =>
    this.request('POST', `/live-events/${encodeURIComponent(eventId)}/claim`, { tier });
  claimEventChallenge = (
    eventId: string,
    challengeId: string,
  ): Promise<{ points: number; xp: number; progress: ApiEventProgress }> =>
    this.request('POST', `/live-events/${encodeURIComponent(eventId)}/challenges/claim`, { challengeId });
  tutorialComplete = (): Promise<ApiTutorialComplete> => this.request('POST', '/me/tutorial-complete');
  leaderboard = (type: string, scope: 'global' | 'regional' | 'friends'): Promise<ApiLeaderboard> =>
    this.request('GET', `/leaderboards/${type}?scope=${scope}&limit=50`);
  myMatches = (): Promise<{ matches: ApiMatch[] }> => this.request('GET', '/me/matches');
  /**
   * The caller's reward for one show; 404 (`not_found`) until the game
   * server's results reach the API, `reward: null` when there was none.
   */
  matchReward = (matchId: string): Promise<{ matchId: string; reward: PlayerRewardMsg | null }> =>
    this.request('GET', `/me/matches/${encodeURIComponent(matchId)}/reward`);

  // ---------------------------------------------------------------------------
  // Social
  // ---------------------------------------------------------------------------

  friends = (): Promise<ApiFriends> => this.request('GET', '/friends');
  recentPlayers = (): Promise<{ players: ApiRecentPlayer[] }> => this.request('GET', '/friends/recent');
  searchPlayers = (q: string): Promise<{ players: ApiSearchResult[] }> =>
    this.request('GET', `/friends/search?q=${encodeURIComponent(q)}`);
  /** Sends a request by `name#tag` or account id. */
  friendRequest = (
    target: string | { userId: string },
  ): Promise<{
    status: 'pending' | 'accepted';
    user: { userId: string; displayName: string; tag: string };
  }> => this.request('POST', '/friends/request', typeof target === 'string' ? { nameTag: target } : target);
  acceptFriend = (userId: string): Promise<unknown> => this.request('POST', '/friends/accept', { userId });
  declineFriend = (userId: string): Promise<unknown> => this.request('POST', '/friends/decline', { userId });
  cancelFriendRequest = (userId: string): Promise<void> =>
    this.request('DELETE', `/friends/request/${encodeURIComponent(userId)}`);
  removeFriend = (userId: string): Promise<void> =>
    this.request('DELETE', `/friends/${encodeURIComponent(userId)}`);
  block = (userId: string): Promise<unknown> => this.request('POST', '/friends/block', { userId });
  unblock = (userId: string): Promise<void> =>
    this.request('DELETE', `/friends/block/${encodeURIComponent(userId)}`);
  report = (body: {
    targetUserId: string;
    reason: ApiReportReason;
    details?: string;
    matchId?: string;
  }): Promise<{ id: string }> => this.request('POST', '/report', body);
  presence = (
    status: 'online' | 'in_menu' | 'in_queue' | 'in_match',
    details: { playlistId?: string; lobbyCode?: string } = {},
  ): Promise<unknown> => this.request('POST', '/presence', { status, ...details });
  joinFriendParty = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/join-friend', { userId });
  declinePartyInvite = (userId: string): Promise<void> =>
    this.request('POST', '/party/invite/decline', { userId });
  partyChat = (text: string): Promise<unknown> => this.request('POST', '/party/chat', { text });
  whisper = (userId: string, text: string): Promise<unknown> =>
    this.request('POST', '/whisper', { userId, text });
  party = (): Promise<{ party: ApiParty | null }> => this.request('GET', '/party');
  createParty = (): Promise<{ party: ApiParty }> => this.request('POST', '/party');
  joinParty = (code: string): Promise<{ party: ApiParty }> => this.request('POST', '/party/join', { code });
  /** Public summary of the party behind an invite code (404 when none). */
  partyByCode = (code: string): Promise<ApiPartyPreview> =>
    this.request('GET', `/party/code/${encodeURIComponent(code)}`);
  /** Leader: the matchmaker accepted the party's ticket, so the ready votes are spent. */
  partyQueued = (): Promise<{ party: ApiParty | null }> => this.request('POST', '/party/queued');
  /** Tells the party this player started (or finished) a show on their own. */
  partySolo = (playing: boolean): Promise<{ party: ApiParty | null }> =>
    this.request('POST', '/party/solo', { playing });
  leaveParty = (): Promise<void> => this.request('POST', '/party/leave');
  kickFromParty = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/kick', { userId });
  promotePartyMember = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/promote', { userId });
  setReady = (ready: boolean): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/ready', { ready });
  setPartyPlaylist = (playlistId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/playlist', { playlistId });
  inviteToParty = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/invite', { userId });
  /** Whether voice chat can be switched on for this account (`GET /voice/config`). */
  voiceConfig = (): Promise<VoiceConfigResponse> => this.request('GET', '/voice/config');

  // ---------------------------------------------------------------------------
  // Clubs
  // ---------------------------------------------------------------------------

  myClub = (): Promise<ApiMyClub> => this.request('GET', '/clubs/me');
  createClub = (body: {
    name: string;
    tag: string;
    description: string;
    emblem: ApiClubCard['emblem'];
    joinMode: ApiClubCard['joinMode'];
  }): Promise<{ club: ApiClubCard }> => this.request('POST', '/clubs', body);
  editClub = (patch: Record<string, unknown>): Promise<{ club: ApiClubCard }> =>
    this.request('PATCH', '/clubs/me', patch);
  searchClubs = (q: string): Promise<{ clubs: ApiClubCard[] }> =>
    this.request('GET', `/clubs/search?q=${encodeURIComponent(q)}`);
  recommendedClubs = (): Promise<{ clubs: ApiClubCard[] }> => this.request('GET', '/clubs/recommended');
  joinClub = (clubId: string): Promise<{ status: 'joined' | 'requested'; club: ApiClubCard }> =>
    this.request('POST', `/clubs/${encodeURIComponent(clubId)}/join`);
  cancelClubRequest = (clubId: string): Promise<void> =>
    this.request('DELETE', `/clubs/${encodeURIComponent(clubId)}/request`);
  answerClubInvite = (clubId: string, accept: boolean): Promise<unknown> =>
    this.request('POST', `/clubs/invites/${encodeURIComponent(clubId)}/${accept ? 'accept' : 'decline'}`);
  answerClubRequest = (userId: string, accept: boolean): Promise<unknown> =>
    this.request('POST', `/clubs/me/requests/${encodeURIComponent(userId)}/${accept ? 'accept' : 'decline'}`);
  inviteToClub = (userId: string): Promise<unknown> => this.request('POST', '/clubs/me/invites', { userId });
  kickFromClub = (userId: string): Promise<void> =>
    this.request('POST', `/clubs/me/members/${encodeURIComponent(userId)}/kick`);
  setClubRole = (userId: string, role: 'officer' | 'member'): Promise<unknown> =>
    this.request('POST', `/clubs/me/members/${encodeURIComponent(userId)}/role`, { role });
  transferClub = (userId: string): Promise<unknown> => this.request('POST', '/clubs/me/transfer', { userId });
  leaveClub = (): Promise<void> => this.request('POST', '/clubs/me/leave');
  disbandClub = (): Promise<void> => this.request('POST', '/clubs/me/disband');
  clubChatHistory = (): Promise<{ clubId: string; lines: ApiClubChatLine[] }> =>
    this.request('GET', '/clubs/me/chat');
  clubChat = (text: string): Promise<{ message: ApiClubChatLine }> =>
    this.request('POST', '/clubs/me/chat', { text });
  clubGoals = (): Promise<ApiClubGoals> => this.request('GET', '/clubs/me/goals');
  claimClubGoal = (week: string, goalId: string): Promise<unknown> =>
    this.request('POST', '/clubs/me/goals/claim', { week, goalId });
  clubPartyUp = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/clubs/me/party-up', { userId });
  reportClub = (clubId: string, reason: string, details?: string): Promise<{ id: string }> =>
    this.request(
      'POST',
      `/clubs/${encodeURIComponent(clubId)}/report`,
      details ? { reason, details } : { reason },
    );

  /**
   * Party queue ticket. `region` is the client's measured pick (Settings →
   * Region); the API also reads it from the account after `PATCH /me`.
   */
  queueTicket = (playlistId: string, region?: string): Promise<{ ticket: string; expiresIn: number }> =>
    this.request('POST', '/party/queue-ticket', region ? { playlistId, region } : { playlistId });

  // ---------------------------------------------------------------------------
  // Shared custom rounds
  // ---------------------------------------------------------------------------

  /** A shared round by code (anyone; the owner also sees their unpublished rounds). */
  customRound = (code: string): Promise<ApiCustomRound> =>
    this.request('GET', `/custom-rounds/${encodeURIComponent(code)}`, undefined, { auth: this.signedIn });
  myCustomRounds = (): Promise<{ rounds: ApiCustomRoundSummary[]; limit: number }> =>
    this.request('GET', '/custom-rounds/mine');
  publishCustomRound = (round: unknown, description: string): Promise<{ round: ApiCustomRoundSummary }> =>
    this.request('POST', '/custom-rounds', { round, description });
  updateCustomRound = (
    code: string,
    round: unknown,
    description: string,
  ): Promise<{ round: ApiCustomRoundSummary }> =>
    this.request('PUT', `/custom-rounds/${encodeURIComponent(code)}`, { round, description });
  setCustomRoundPublished = (code: string, published: boolean): Promise<{ round: ApiCustomRoundSummary }> =>
    this.request('POST', `/custom-rounds/${encodeURIComponent(code)}/${published ? 'publish' : 'unpublish'}`);
  deleteCustomRound = (code: string): Promise<void> =>
    this.request('DELETE', `/custom-rounds/${encodeURIComponent(code)}`);
  reportCustomRound = (
    code: string,
    reason: ApiRoundReportReason,
    details?: string,
  ): Promise<{ id: string }> =>
    this.request('POST', `/custom-rounds/${encodeURIComponent(code)}/report`, {
      reason,
      ...(details ? { details } : {}),
    });
}

/** Why a shared round is reported. */
export type ApiRoundReportReason = 'offensive' | 'broken' | 'spam' | 'copied' | 'other';

/** A shared round in lists. */
export interface ApiCustomRoundSummary {
  code: string;
  name: string;
  description: string;
  type: string;
  status: 'published' | 'unpublished' | 'taken_down';
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  takedownReason?: string | null;
}

/** `GET /custom-rounds/:code`. */
export interface ApiCustomRound extends ApiCustomRoundSummary {
  author: string | null;
  definition: unknown;
}
