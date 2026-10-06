/**
 * Server-side live-ops reads for the matchmaker and the game servers. Node
 * only (signs with `node:crypto`).
 *
 * Responsibilities:
 * - Sign and verify service-to-service calls ({@link signInternal}).
 * - Fetch the API's live-ops snapshot (`POST /internal/liveops`, HMAC-signed
 *   with `INTERNAL_HMAC_SECRET`): raw flags, the maintenance window and the
 *   effective schedule of every playlist the API knows.
 * - Cache it for `cacheMs` (30 s by default) and share one in-flight request
 *   between concurrent callers.
 * - Fail open: when the API cannot be reached the last snapshot stays in use
 *   (so a maintenance window that was on stays on), and before the first
 *   success every flag is at its default and nothing is in maintenance.
 * - Report crashes to the API (`POST /internal/errors`) so they show up in
 *   `pnpm admin errors top` next to client errors.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  clockOffset,
  FLAG_DEFAULTS,
  maintenancePhase,
  mergeSchedule,
  NO_MAINTENANCE,
  parseMaintenance,
  playlistPhase,
  type FlagKey,
  type MaintenancePhase,
  type MaintenanceWindow,
  type PlaylistOverride,
  type PlaylistPhase,
  type PlaylistSchedule,
} from './liveops.ts';

// The package lint bans Date.now (it guards the deterministic sim); service code needs the real clock.
const wallClock = (): number => new Date().getTime();

/** Header carrying the signature scheme version; absent means the legacy v1 scheme. */
export const INTERNAL_SIG_VERSION_HEADER = 'x-tumble-signature-version';

/**
 * Accepted clock difference for signed internal calls. Receivers remember a
 * nonce for twice this long, so it cannot be replayed while its timestamp
 * would still pass.
 */
export const INTERNAL_SIG_WINDOW_MS = 5 * 60_000;

/** The request a v2 internal signature is bound to, besides its body. */
export interface InternalTarget {
  /** HTTP method, e.g. `POST`. */
  method: string;
  /**
   * Endpoint path as the receiving service routes it: no query string and no
   * reverse-proxy prefix (`/internal/match-results`, not `/api/internal/…`).
   */
  path: string;
}

/**
 * The string a v2 signature covers: `METHOD\npath\ntimestamp\nnonce\nbody`.
 *
 * @param target - Method and endpoint path.
 * @param timestamp - `x-tumble-timestamp` as sent.
 * @param nonce - `x-tumble-nonce` as sent.
 * @param body - Exact request body (`''` for a GET).
 */
export function internalSigningString(
  target: InternalTarget,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${target.method.toUpperCase()}\n${target.path}\n${timestamp}\n${nonce}\n${body}`;
}

/**
 * Headers for a signed service-to-service call (the API's
 * `requireInternalSignature`, the matchmaker's `/internal/*` routes):
 * `hex(HMAC-SHA256(secret, "METHOD\npath\ntimestamp\nnonce\nbody"))` and
 * `x-tumble-signature-version: 2`.
 *
 * SECURITY: binding the method and path means a captured signature for one
 * endpoint cannot be replayed against another that accepts the same body.
 *
 * @param secret - The caller's HMAC key (`INTERNAL_HMAC_SECRET`, or a game
 *   server's `GAME_SERVER_HMAC_SECRET`).
 * @param body - The exact request body (`''` for a GET).
 * @param nowMs - Wall clock (receivers check it against their own, ±5 min).
 * @param target - Method and endpoint path of the request.
 * @example
 * const body = '{}';
 * await fetch(`${apiUrl}/internal/liveops`, {
 *   method: 'POST',
 *   headers: signInternal(secret, body, Date.now(), { method: 'POST', path: '/internal/liveops' }),
 *   body,
 * });
 */
export function signInternal(
  secret: string,
  body: string,
  nowMs: number,
  target: InternalTarget,
): Record<string, string> {
  const timestamp = String(nowMs);
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret)
    .update(internalSigningString(target, timestamp, nonce, body))
    .digest('hex');
  return {
    'x-tumble-timestamp': timestamp,
    'x-tumble-nonce': nonce,
    'x-tumble-signature': signature,
    [INTERNAL_SIG_VERSION_HEADER]: '2',
  };
}

/** Options for {@link inspectInternal} and {@link verifyInternal}. */
export interface VerifyInternalOptions extends InternalTarget {
  /** Allowed clock difference (default {@link INTERNAL_SIG_WINDOW_MS}). */
  windowMs?: number;
  /**
   * Also accept the legacy v1 scheme (`"<timestamp>.<nonce>.<body>"`, no
   * method or path) while callers are being upgraded. Off by default.
   */
  allowV1?: boolean;
}

/** A request that passed {@link verifyInternal}. */
export interface VerifiedInternal {
  /** The request's nonce; the receiver records it so the request cannot be replayed. */
  nonce: string;
  /** Signed timestamp (epoch ms). */
  timestamp: number;
  /** Scheme the caller used. */
  version: 1 | 2;
}

/** Why {@link inspectInternal} refused a request. */
export type InternalSignatureProblem = 'missing' | 'malformed' | 'stale' | 'mismatch';

const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const v = headers[name];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Checks headers made by {@link signInternal} against any of `secrets` and
 * says why a request failed; {@link verifyInternal} is the single-key form.
 *
 * Nonces are not remembered here: the receiver must record
 * {@link VerifiedInternal.nonce} for twice {@link INTERNAL_SIG_WINDOW_MS}
 * and refuse it a second time.
 *
 * @param secrets - Keys to try in order; empty entries are skipped.
 * @param headers - Request headers (lower-case names).
 * @param body - The exact request body (`''` for a GET).
 * @param nowMs - Wall clock.
 * @param opts - Method and path the request arrived on, and the scheme policy.
 * @returns The verified request with the index of the key that matched, or the problem.
 */
export function inspectInternal(
  secrets: readonly (string | undefined)[],
  headers: Record<string, string | string[] | undefined>,
  body: string,
  nowMs: number,
  opts: VerifyInternalOptions,
): { ok: VerifiedInternal & { key: number } } | { problem: InternalSignatureProblem } {
  const ts = headerValue(headers, 'x-tumble-timestamp');
  const nonce = headerValue(headers, 'x-tumble-nonce');
  const sig = headerValue(headers, 'x-tumble-signature');
  const versionRaw = headerValue(headers, INTERNAL_SIG_VERSION_HEADER);
  if (ts === undefined || nonce === undefined || sig === undefined) return { problem: 'missing' };
  if (!/^\d{10,16}$/.test(ts) || nonce.length < 16 || nonce.length > 128 || !/^[0-9a-f]{64}$/i.test(sig))
    return { problem: 'malformed' };
  if (versionRaw !== undefined && versionRaw !== '2') return { problem: 'malformed' };
  const version = versionRaw === '2' ? 2 : 1;
  if (version === 1 && !opts.allowV1) return { problem: 'mismatch' };
  if (Math.abs(nowMs - Number(ts)) > (opts.windowMs ?? INTERNAL_SIG_WINDOW_MS)) return { problem: 'stale' };
  const signed = version === 2 ? internalSigningString(opts, ts, nonce, body) : `${ts}.${nonce}.${body}`;
  const got = Buffer.from(sig.toLowerCase(), 'hex');
  for (let key = 0; key < secrets.length; key++) {
    const secret = secrets[key];
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(signed).digest();
    if (timingSafeEqual(expected, got)) return { ok: { nonce, timestamp: Number(ts), version, key } };
  }
  return { problem: 'mismatch' };
}

/**
 * Checks headers made by {@link signInternal}: well formed, signed with
 * `secret` over this method, path and body, and stamped within the window.
 *
 * @param secret - The shared key.
 * @param headers - Request headers (lower-case names).
 * @param body - The exact request body (`''` for a GET).
 * @param nowMs - Wall clock.
 * @param opts - Method and path the request arrived on, and the scheme policy.
 * @returns The verified nonce and timestamp, or null when the request is not authentic.
 * @example
 * const ok = verifyInternal(secret, req.headers, '', Date.now(), { method: 'GET', path: '/internal/capacity' });
 * if (!ok || !(await nonces.use(ok.nonce))) return reply.code(401).send();
 */
export function verifyInternal(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  nowMs: number,
  opts: VerifyInternalOptions,
): VerifiedInternal | null {
  const r = inspectInternal([secret], headers, body, nowMs, opts);
  if (!('ok' in r)) return null;
  return { nonce: r.ok.nonce, timestamp: r.ok.timestamp, version: r.ok.version };
}

/** One raw flag row as the API stores it. */
export interface RawFlag {
  enabled: boolean;
  rolloutPercent: number;
  payload: unknown;
}

/** The API's answer to `POST /internal/liveops`. */
export interface LiveOpsSnapshot {
  flags: Record<string, RawFlag>;
  maintenance: MaintenanceWindow;
  /** The API's effective schedule per playlist; ids it does not know fall back to the caller's copy. */
  playlists: PlaylistOverride[];
  /** API clock (epoch ms) when the snapshot was taken. */
  serverTime: number;
}

/** An empty snapshot: defaults everywhere. */
export const EMPTY_SNAPSHOT: LiveOpsSnapshot = {
  flags: {},
  maintenance: NO_MAINTENANCE,
  playlists: [],
  serverTime: 0,
};

/**
 * Read-side view of a snapshot.
 *
 * Server-side kill switches read a flag's master `enabled` only: percentage
 * rollouts are per player (sticky buckets) and only mean something where a
 * player is known, which is the client's `GET /flags`.
 *
 * Times passed in are the caller's clock; `offsetMs` (measured when the
 * snapshot was fetched) shifts them onto the API's clock, so a service whose
 * clock drifted still opens and closes windows when the API says it should.
 */
export class LiveOpsState {
  private readonly overrides: Map<string, PlaylistOverride>;

  /**
   * @param snapshot - What the API answered.
   * @param offsetMs - API clock minus the caller's clock.
   */
  constructor(
    readonly snapshot: LiveOpsSnapshot,
    readonly offsetMs = 0,
  ) {
    this.overrides = new Map(snapshot.playlists.map((p) => [p.id, p]));
  }

  /** Whether a flag is on (its default when the API has no row). */
  flag(key: FlagKey): boolean {
    const f = this.snapshot.flags[key];
    return typeof f?.enabled === 'boolean' ? f.enabled : FLAG_DEFAULTS[key].enabled;
  }

  /** The maintenance window and its phase at `nowMs`. */
  maintenance(nowMs: number): MaintenanceWindow & { phase: MaintenancePhase } {
    const phase = maintenancePhase(this.snapshot.maintenance, nowMs + this.offsetMs);
    return { ...this.snapshot.maintenance, phase };
  }

  /**
   * A playlist's phase: the API's schedule when it sent one, else `bundled`.
   *
   * @param id - Playlist id.
   * @param bundled - The schedule shipped with content.
   * @param nowMs - The instant.
   */
  playlist(id: string, bundled: PlaylistSchedule | null | undefined, nowMs: number): PlaylistPhase {
    return playlistPhase(mergeSchedule(bundled, this.overrides.get(id)), nowMs + this.offsetMs);
  }
}

/** Anything that can answer "what is the live-ops state right now?". */
export interface LiveOpsSource {
  /** The freshest state, refreshing it first when the cache is stale. */
  get(): Promise<LiveOpsState>;
  /** The cached state without waiting (refreshes in the background when stale). */
  peek(): LiveOpsState;
}

/** A source that always answers the defaults (tests, deployments without `API_URL`). */
export const STATIC_LIVEOPS: LiveOpsSource = (() => {
  const state = new LiveOpsState(EMPTY_SNAPSHOT);
  return { get: async () => state, peek: () => state };
})();

/**
 * A fixed source, for tests.
 *
 * @param snapshot - Partial snapshot; the rest is empty.
 */
export function fixedLiveOps(snapshot: Partial<LiveOpsSnapshot>): LiveOpsSource & {
  set(next: Partial<LiveOpsSnapshot>): void;
} {
  let state = new LiveOpsState({ ...EMPTY_SNAPSHOT, ...snapshot });
  return {
    get: async () => state,
    peek: () => state,
    set: (next) => {
      state = new LiveOpsState({ ...EMPTY_SNAPSHOT, ...next });
    },
  };
}

/** Options for {@link ApiLiveOps}. */
export interface ApiLiveOpsOptions {
  /** API base URL, e.g. `http://localhost:7360`. */
  apiUrl: string;
  /** `INTERNAL_HMAC_SECRET`. */
  secret: string;
  /** Cache lifetime (default 30 s). */
  cacheMs?: number;
  /** Per-request timeout (default 3 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Clock for the cache (ms). Signatures always use the wall clock. */
  now?: () => number;
  log?: (msg: string) => void;
}

function parseSnapshot(raw: unknown): LiveOpsSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const flags: Record<string, RawFlag> = {};
  if (r.flags && typeof r.flags === 'object') {
    for (const [k, v] of Object.entries(r.flags as Record<string, unknown>)) {
      const f = v as Partial<RawFlag> | null;
      if (f && typeof f.enabled === 'boolean')
        flags[k] = {
          enabled: f.enabled,
          rolloutPercent: typeof f.rolloutPercent === 'number' ? f.rolloutPercent : 100,
          payload: f.payload ?? null,
        };
    }
  }
  const playlists = (Array.isArray(r.playlists) ? r.playlists : []).flatMap((p): PlaylistOverride[] => {
    const o = p as Partial<PlaylistOverride> | null;
    if (!o || typeof o.id !== 'string') return [];
    return [
      {
        id: o.id,
        startsAt: typeof o.startsAt === 'string' ? o.startsAt : null,
        endsAt: typeof o.endsAt === 'string' ? o.endsAt : null,
        featured: o.featured === true,
        hidden: o.hidden === true,
      },
    ];
  });
  return {
    flags,
    maintenance: parseMaintenance(r.maintenance),
    playlists,
    serverTime: typeof r.serverTime === 'number' ? r.serverTime : 0,
  };
}

/**
 * Cached live-ops reads from the API.
 *
 * @example
 * const liveOps = new ApiLiveOps({ apiUrl: 'http://localhost:7360', secret });
 * if ((await liveOps.get()).maintenance(Date.now()).phase === 'active') refuse();
 */
export class ApiLiveOps implements LiveOpsSource {
  private state = new LiveOpsState(EMPTY_SNAPSHOT);
  private fetchedAt = -Infinity;
  private inflight: Promise<LiveOpsState> | null = null;
  private readonly cacheMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  /** Failed refreshes in a row (diagnostics). */
  failures = 0;

  constructor(private readonly opts: ApiLiveOpsOptions) {
    this.cacheMs = opts.cacheMs ?? 30_000;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? wallClock;
  }

  async get(): Promise<LiveOpsState> {
    if (this.now() - this.fetchedAt < this.cacheMs) return this.state;
    return this.refresh();
  }

  peek(): LiveOpsState {
    if (this.now() - this.fetchedAt >= this.cacheMs) void this.refresh();
    return this.state;
  }

  /** Fetches now (sharing a request already in flight). Never throws. */
  refresh(): Promise<LiveOpsState> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<LiveOpsState> {
    try {
      const body = '{}';
      const sentAt = this.now();
      const res = await this.fetchFn(`${this.opts.apiUrl}/internal/liveops`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signInternal(this.opts.secret, body, wallClock(), { method: 'POST', path: '/internal/liveops' }),
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
      if (!res.ok) throw new Error(`API answered ${res.status}`);
      const snap = parseSnapshot(await res.json());
      if (!snap) throw new Error('malformed live-ops snapshot');
      // Measured against the injected clock: the same one callers pass in.
      const offset = snap.serverTime > 0 ? clockOffset(snap.serverTime, sentAt, this.now()) : 0;
      this.state = new LiveOpsState(snap, offset);
      this.failures = 0;
    } catch (err) {
      this.failures++;
      // Only the first failure in a row is logged; an outage would otherwise log every 30 s per caller.
      if (this.failures === 1)
        this.opts.log?.(
          `[liveops] refresh failed, keeping the last known state: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    // A failure also restarts the cache window, so an outage costs one request per window, not one per call.
    this.fetchedAt = this.now();
    return this.state;
  }
}

/** Options for {@link apiErrorReporter}. */
export interface ApiErrorReporterOptions {
  apiUrl: string;
  secret: string;
  /** `api`, `matchmaker`, `game-server`. */
  service: string;
  release?: string | undefined;
  fetch?: typeof fetch;
}

/**
 * A crash reporter for `installLifecycle({ reporters })` that records the
 * error on the API (`server.error` events). Best effort: failures are
 * swallowed because the process is already going down.
 *
 * @example
 * installLifecycle({ ..., reporters: [apiErrorReporter({ apiUrl, secret, service: 'matchmaker' })] });
 */
export function apiErrorReporter(
  opts: ApiErrorReporterOptions,
): (err: unknown, context: Record<string, unknown>) => Promise<void> {
  const fetchFn = opts.fetch ?? fetch;
  return async (err, context) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const body = JSON.stringify({
      service: opts.service,
      kind: typeof context.kind === 'string' ? context.kind : 'error',
      type: (e.name || 'Error').slice(0, 100),
      message: e.message.slice(0, 500),
      ...(e.stack ? { stack: e.stack.slice(0, 4000) } : {}),
      ...(opts.release ? { release: opts.release.slice(0, 100) } : {}),
    });
    try {
      await fetchFn(`${opts.apiUrl}/internal/errors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signInternal(opts.secret, body, wallClock(), { method: 'POST', path: '/internal/errors' }),
        },
        body,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // The process is crashing; there is nobody left to tell.
    }
  };
}
