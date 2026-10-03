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
  section: 'featured' | 'daily';
  item: { id: string; name: string; slot: string; rarity: string };
  price: { currency: 'gumballs' | 'gems'; amount: number };
  owned: boolean;
}

/** `GET /store`. */
export interface ApiStore {
  day: string;
  featured: ApiOffer[];
  daily: ApiOffer[];
  refreshesAt: string;
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

/** `GET /pass`. */
export interface ApiPass {
  seasonId: string;
  name: string;
  endsAt: string;
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
  reward: { xp: number; gumballs: number };
  rerolled: boolean;
}

/** `GET /challenges`. */
export interface ApiChallenges {
  daily: ApiChallenge[];
  weekly: ApiChallenge[];
  rerollsLeft: number;
  dailyRefreshesAt: string;
  weeklyRefreshesAt: string;
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

/** `GET /friends`. */
export interface ApiFriends {
  friends: (ApiFriendCard & { presence: string })[];
  incoming: ApiFriendCard[];
  outgoing: ApiFriendCard[];
}

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

  // ---------------------------------------------------------------------------
  // Economy & progression
  // ---------------------------------------------------------------------------

  store = (): Promise<ApiStore> => this.request('GET', '/store');
  purchase = (offerId: string, key: string): Promise<{ wallet: ApiMe['wallet']; replayed: boolean }> =>
    this.request('POST', '/purchase', { offerId }, { idempotencyKey: key });
  gemPacks = (): Promise<{ provider: string; packs: ApiGemPack[] }> => this.request('GET', '/gems/packs');
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
  leaderboard = (type: string, scope: 'global' | 'regional' | 'friends'): Promise<ApiLeaderboard> =>
    this.request('GET', `/leaderboards/${type}?scope=${scope}&limit=50`);
  myMatches = (): Promise<{ matches: ApiMatch[] }> => this.request('GET', '/me/matches');

  // ---------------------------------------------------------------------------
  // Social
  // ---------------------------------------------------------------------------

  friends = (): Promise<ApiFriends> => this.request('GET', '/friends');
  recentPlayers = (): Promise<{ players: ApiFriendCard[] }> => this.request('GET', '/friends/recent');
  friendRequest = (
    nameTag: string,
  ): Promise<{ status: 'pending' | 'accepted'; user: { displayName: string; tag: string } }> =>
    this.request('POST', '/friends/request', { nameTag });
  acceptFriend = (userId: string): Promise<unknown> => this.request('POST', '/friends/accept', { userId });
  declineFriend = (userId: string): Promise<unknown> => this.request('POST', '/friends/decline', { userId });
  presence = (status: 'online' | 'in_menu' | 'in_queue' | 'in_match'): Promise<unknown> =>
    this.request('POST', '/presence', { status });
  party = (): Promise<{ party: ApiParty | null }> => this.request('GET', '/party');
  createParty = (): Promise<{ party: ApiParty }> => this.request('POST', '/party');
  joinParty = (code: string): Promise<{ party: ApiParty }> => this.request('POST', '/party/join', { code });
  leaveParty = (): Promise<void> => this.request('POST', '/party/leave');
  kickFromParty = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/kick', { userId });
  setReady = (ready: boolean): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/ready', { ready });
  setPartyPlaylist = (playlistId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/playlist', { playlistId });
  inviteToParty = (userId: string): Promise<{ party: ApiParty }> =>
    this.request('POST', '/party/invite', { userId });
  queueTicket = (playlistId: string): Promise<{ ticket: string; expiresIn: number }> =>
    this.request('POST', '/party/queue-ticket', { playlistId });
}
