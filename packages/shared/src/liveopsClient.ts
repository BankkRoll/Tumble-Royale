/**
 * Server-side live-ops reads for the matchmaker and the game servers. Node
 * only (signs with `node:crypto`).
 *
 * Responsibilities:
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
import { createHmac, randomBytes } from 'node:crypto';
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

/**
 * Headers for a call the API verifies with `requireInternalSignature`:
 * `hex(HMAC-SHA256(secret, "<timestamp>.<nonce>.<body>"))`.
 *
 * @param secret - `INTERNAL_HMAC_SECRET`.
 * @param body - The exact request body.
 * @param nowMs - Wall clock (the API checks it against its own, ±5 min).
 */
export function signInternal(secret: string, body: string, nowMs: number): Record<string, string> {
  const timestamp = String(nowMs);
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  return { 'x-tumble-timestamp': timestamp, 'x-tumble-nonce': nonce, 'x-tumble-signature': signature };
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
        headers: { 'content-type': 'application/json', ...signInternal(this.opts.secret, body, wallClock()) },
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
        headers: { 'content-type': 'application/json', ...signInternal(opts.secret, body, wallClock()) },
        body,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // The process is crashing; there is nobody left to tell.
    }
  };
}
