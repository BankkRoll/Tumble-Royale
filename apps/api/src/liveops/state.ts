/**
 * The API's own view of live-ops state: feature flags, the maintenance
 * window and playlist overrides, read from the database and cached per
 * instance.
 *
 * Responsibilities:
 * - One cached snapshot per app instance (30 s), shared by the kill switches
 *   on hot paths (purchases, global chat, the party lobby relay), queue ticket
 *   issuance and the public `/status` and `/playlists` routes.
 * - Cluster-wide invalidation: every admin write publishes on
 *   {@link LIVEOPS_INVALIDATION_CHANNEL}, so other API instances drop their
 *   cache at once instead of serving a stale kill switch for 30 s.
 * - The maintenance window lives in `feature_flags` under the reserved key
 *   {@link MAINTENANCE_FLAG_KEY} (enabled + `{ message, startsAt, endsAt }`
 *   payload), which keeps it next to the other operator switches without a
 *   table of its own.
 */
import { PLAYLISTS } from '@tumble/content/shows';
import {
  FLAG_DEFAULTS,
  maintenancePhase,
  mergeSchedule,
  NO_MAINTENANCE,
  parseMaintenance,
  playlistPhase,
  type FlagKey,
  type MaintenanceStatus,
  type MaintenanceWindow,
  type PlaylistOverride,
  type PlaylistPhase,
  type EffectiveSchedule,
} from '@tumble/shared/liveops';
import type { AppContext } from '../context.ts';
import { featureFlags, playlistOverrides } from '../db/schema.ts';
import { ApiError } from '../http/errors.ts';

/** Feature-flag key that stores the maintenance window. Not settable through the generic flag route. */
export const MAINTENANCE_FLAG_KEY = 'maintenance';

/** KV channel telling every API instance to drop its cached live-ops snapshot. */
export const LIVEOPS_INVALIDATION_CHANNEL = 'liveops:invalidate';

const CACHE_MS = 30_000;

/** One raw flag row. */
export interface FlagRow {
  enabled: boolean;
  rolloutPercent: number;
  payload: unknown;
}

/** Everything live-ops, as stored. */
export interface LiveOpsSnapshot {
  /** Raw flag rows by key, the maintenance row excluded. */
  flags: Record<string, FlagRow>;
  maintenance: MaintenanceWindow;
  playlists: PlaylistOverride[];
}

interface Cache {
  at: number;
  snapshot: Promise<LiveOpsSnapshot> | null;
  subscribed: Promise<void>;
}

const caches = new WeakMap<AppContext, Cache>();

async function load(ctx: AppContext): Promise<LiveOpsSnapshot> {
  const rows = await ctx.db.select().from(featureFlags);
  const flags: Record<string, FlagRow> = {};
  let maintenance = NO_MAINTENANCE;
  for (const r of rows) {
    if (r.key === MAINTENANCE_FLAG_KEY) {
      maintenance = parseMaintenance({ ...(r.payload as object | null), enabled: r.enabled });
      continue;
    }
    flags[r.key] = { enabled: r.enabled, rolloutPercent: r.rolloutPercent, payload: r.payload ?? null };
  }
  const overrides = await ctx.db.select().from(playlistOverrides);
  return {
    flags,
    maintenance,
    playlists: overrides.map((o) => ({
      id: o.id,
      startsAt: o.startsAt?.toISOString() ?? null,
      endsAt: o.endsAt?.toISOString() ?? null,
      featured: o.featured,
      hidden: o.hidden,
    })),
  };
}

function cacheFor(ctx: AppContext): Cache {
  let c = caches.get(ctx);
  if (!c) {
    const cache: Cache = { at: -Infinity, snapshot: null, subscribed: Promise.resolve() };
    cache.subscribed = ctx.kv
      .subscribe(LIVEOPS_INVALIDATION_CHANNEL, () => {
        cache.snapshot = null;
      })
      .then(() => undefined);
    caches.set(ctx, cache);
    c = cache;
  }
  return c;
}

/**
 * The cached live-ops snapshot (re-read after 30 s or an invalidation).
 *
 * @param ctx - Shared services.
 */
export async function liveOpsSnapshot(ctx: AppContext): Promise<LiveOpsSnapshot> {
  const c = cacheFor(ctx);
  // Nothing is cached before the subscription is live, so no invalidation can be missed.
  await c.subscribed;
  const now = ctx.now().getTime();
  if (!c.snapshot || now - c.at >= CACHE_MS) {
    c.at = now;
    const p = load(ctx);
    c.snapshot = p;
    // A failed read must not be cached; the next caller tries again.
    p.catch(() => {
      if (c.snapshot === p) c.snapshot = null;
    });
  }
  return c.snapshot;
}

/**
 * Drops the cached snapshot on every API instance. Call after the write committed.
 *
 * @param ctx - Shared services.
 */
export async function invalidateLiveOps(ctx: AppContext): Promise<void> {
  const c = caches.get(ctx);
  if (c) c.snapshot = null;
  await ctx.kv.publish(LIVEOPS_INVALIDATION_CHANNEL, '1');
}

/**
 * A server-side kill switch: the flag's master `enabled` (rollout percentages
 * are per player and apply to `GET /flags` only), or its default.
 *
 * @param ctx - Shared services.
 * @param key - Flag key.
 */
export async function serverFlag(ctx: AppContext, key: FlagKey): Promise<boolean> {
  const f = (await liveOpsSnapshot(ctx)).flags[key];
  return f ? f.enabled : FLAG_DEFAULTS[key].enabled;
}

/**
 * Throws 503 `feature_disabled` when an operator switched a feature off.
 *
 * @param ctx - Shared services.
 * @param key - Flag key.
 * @param message - Player-facing explanation.
 * @throws {ApiError} 503 `feature_disabled`.
 */
export async function requireFlag(ctx: AppContext, key: FlagKey, message: string): Promise<void> {
  if (!(await serverFlag(ctx, key))) throw new ApiError(503, 'feature_disabled', message, { flag: key });
}

/**
 * The maintenance window with its phase now.
 *
 * @param ctx - Shared services.
 */
export async function maintenanceStatus(ctx: AppContext): Promise<MaintenanceStatus> {
  const m = (await liveOpsSnapshot(ctx)).maintenance;
  return { ...m, phase: maintenancePhase(m, ctx.now().getTime()) };
}

/**
 * Throws 503 `maintenance` while a maintenance window is active.
 *
 * @param ctx - Shared services.
 * @throws {ApiError} 503 `maintenance` with the window in `details`.
 */
export async function refuseDuringMaintenance(ctx: AppContext): Promise<void> {
  const m = await maintenanceStatus(ctx);
  if (m.phase === 'active')
    throw new ApiError(503, 'maintenance', m.message, { startsAt: m.startsAt, endsAt: m.endsAt });
}

/** A bundled playlist with its effective schedule. */
export interface ScheduledPlaylist extends EffectiveSchedule {
  id: string;
  name: string;
  phase: PlaylistPhase;
  /** True when an operator override is in effect. */
  overridden: boolean;
}

/**
 * Every bundled playlist with operator overrides merged in, and its phase now.
 *
 * @param ctx - Shared services.
 */
export async function scheduledPlaylists(ctx: AppContext): Promise<ScheduledPlaylist[]> {
  const overrides = new Map((await liveOpsSnapshot(ctx)).playlists.map((o) => [o.id, o]));
  const now = ctx.now().getTime();
  return PLAYLISTS.map((p) => {
    const o = overrides.get(p.id);
    const schedule = mergeSchedule(p, o);
    return { id: p.id, name: p.name, ...schedule, phase: playlistPhase(schedule, now), overridden: !!o };
  });
}

/**
 * Throws 409 `playlist_unavailable` unless the playlist is live right now.
 *
 * @param ctx - Shared services.
 * @param playlistId - Bundled playlist id.
 * @throws {ApiError} 409 `playlist_unavailable` (details: phase, startsAt, endsAt).
 */
export async function requireLivePlaylist(ctx: AppContext, playlistId: string): Promise<void> {
  const p = (await scheduledPlaylists(ctx)).find((x) => x.id === playlistId);
  // Catalog-only ids (not in content) have no schedule to enforce.
  if (!p || p.phase === 'live') return;
  const message =
    p.phase === 'upcoming'
      ? `${p.name} has not started yet`
      : p.phase === 'ended'
        ? `${p.name} has ended`
        : `${p.name} is not available right now`;
  throw new ApiError(409, 'playlist_unavailable', message, {
    phase: p.phase,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  });
}
