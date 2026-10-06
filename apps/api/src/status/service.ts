/**
 * The status page's server side: probes, the cached summary, the uptime
 * sampler and the 90-day history.
 *
 * Responsibilities:
 * - Probe what the API can check safely: its own database and KV, the
 *   matchmaker's `/health`, and per-region game-server capacity from the
 *   matchmaker's signed `/internal/capacity`. Every probe has a timeout and
 *   never throws.
 * - Cache the computed summary for a few seconds per instance (one probe
 *   round in flight at a time), dropped on every API instance when an
 *   incident changes.
 * - Sample every component once per interval into `status_uptime`. All
 *   instances run the timer; a KV `setNX` on the interval's slot elects one
 *   writer per slot, so N instances still add one sample. Rows older than
 *   the 90-day window are pruned on the way.
 */
import { signInternal } from '@tumble/shared/liveops-client';
import { maintenancePhase, NO_MAINTENANCE, type MaintenanceStatus } from '@tumble/shared/liveops';
import {
  countKey,
  dayKey,
  dayRange,
  dayState,
  NO_SAMPLES,
  REGION_COMPONENT_PREFIX,
  REGION_ID_RE,
  sumCounts,
  UPTIME_DAYS,
  uptimeRatio,
  type PublicIncident,
  type StatusHistory,
  type StatusSummary,
  type UptimeCounts,
} from '@tumble/shared/status';
import { and, gte, like, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { statusUptime } from '../db/schema.ts';
import { liveOpsSnapshot } from '../liveops/state.ts';
import {
  computeSummary,
  DEFAULT_COMPUTE,
  type ComputeOptions,
  type ProbeReport,
  type ProbeResult,
  type RegionCapacity,
} from './compute.ts';
import { listIncidents } from './incidents.ts';

/** KV channel telling every API instance to drop its cached summary. */
export const STATUS_INVALIDATION_CHANNEL = 'status:invalidate';

const DAY_MS = 86_400_000;
/** A region that reported in this window still shows (as down) after its servers vanish. */
const KNOWN_REGION_DAYS = 7;

/** Tunables (tests shorten them). */
export interface StatusServiceOptions extends ComputeOptions {
  /** Per-probe timeout (ms). */
  timeoutMs: number;
  /** How long a computed summary is reused (ms). */
  cacheMs: number;
  /** How long the history is reused (ms). */
  historyCacheMs: number;
  /** Uptime sampling interval (ms); 0 disables the timer (`sample()` still works). */
  sampleIntervalMs: number;
}

/** The status page's server side. */
export interface StatusService {
  /** The public summary (cached). */
  summary(): Promise<StatusSummary>;
  /** The 90-day history (cached). */
  history(): Promise<StatusHistory>;
  /**
   * Records one uptime sample for the current slot unless another instance
   * already did.
   *
   * @returns True when this call wrote the sample.
   */
  sample(): Promise<boolean>;
  /** Drops the cached summary and history here and on every other instance. */
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

const elapsed = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

/**
 * Runs `fn` with a timeout and reports whether it succeeded and how long it took.
 *
 * @param fn - The check.
 * @param timeoutMs - Give up after this long.
 * @returns Never rejects.
 */
export async function timedProbe<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<ProbeResult & { value: T | null }> {
  const start = process.hrtime.bigint();
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new Error('timeout'));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    return { ok: true, ms: elapsed(start), value };
  } catch {
    return { ok: false, ms: Math.max(elapsed(start), 0), value: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseCapacity(raw: unknown): RegionCapacity[] | null {
  const list = (raw as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(list)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const out: RegionCapacity[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const servers = num(r?.servers);
    const capacity = num(r?.capacity);
    const load = num(r?.load);
    if (typeof r?.region !== 'string' || servers === null || capacity === null || load === null) continue;
    out.push({ region: r.region, servers, capacity, load });
  }
  return out;
}

/**
 * Creates the status service and, when sampling is on, starts its timer.
 *
 * @param ctx - Shared services.
 * @param overrides - Tunables (defaults from `ctx.config.ops.status`).
 * @returns The service.
 */
export function createStatusService(
  ctx: AppContext,
  overrides: Partial<StatusServiceOptions> = {},
): StatusService {
  const opts: StatusServiceOptions = {
    ...DEFAULT_COMPUTE,
    timeoutMs: 2000,
    cacheMs: 5000,
    historyCacheMs: 60_000,
    sampleIntervalMs: ctx.config.ops.status.sampleIntervalMs,
    ...overrides,
  };
  const mmUrl = ctx.config.ops.status.matchmakerUrl;
  let summaryCache: { at: number; value: Promise<StatusSummary> } | null = null;
  let historyCache: { at: number; value: Promise<StatusHistory> } | null = null;
  // Last answers that needed the database, so a database outage still shows open incidents.
  let lastIncidents: PublicIncident[] = [];
  let lastMaintenance: MaintenanceStatus = { ...NO_MAINTENANCE, phase: 'off' };
  const nowMs = () => ctx.now().getTime();

  const unsubscribe = ctx.kv.subscribe(STATUS_INVALIDATION_CHANNEL, () => {
    summaryCache = null;
    historyCache = null;
  });

  const matchmakerProbes = async (): Promise<Pick<ProbeReport, 'matchmaker' | 'capacity'>> => {
    if (!mmUrl) return { matchmaker: null, capacity: null };
    const getJson = async (path: string, signal: AbortSignal, headers: Record<string, string> = {}) => {
      const res = await ctx.fetch(`${mmUrl}${path}`, { headers, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as unknown;
    };
    const [health, capacity] = await Promise.all([
      timedProbe((s) => getJson('/health', s), opts.timeoutMs),
      timedProbe(
        (s) =>
          getJson(
            '/internal/capacity',
            s,
            signInternal(ctx.config.internalHmacSecret, '', nowMs(), {
              method: 'GET',
              path: '/internal/capacity',
            }),
          ),
        opts.timeoutMs,
      ),
    ]);
    const servers = (health.value as { servers?: unknown } | null)?.servers;
    return {
      matchmaker: {
        ok: health.ok,
        ms: health.ms,
        servers: typeof servers === 'number' && Number.isFinite(servers) ? servers : null,
      },
      capacity: capacity.ok ? parseCapacity(capacity.value) : null,
    };
  };

  const knownRegions = async (): Promise<string[]> => {
    const since = dayKey(nowMs() - KNOWN_REGION_DAYS * DAY_MS);
    const rows = await ctx.db
      .selectDistinct({ component: statusUptime.component })
      .from(statusUptime)
      .where(and(like(statusUptime.component, `${REGION_COMPONENT_PREFIX}%`), gte(statusUptime.day, since)));
    return rows
      .map((r) => r.component.slice(REGION_COMPONENT_PREFIX.length))
      .filter((r) => REGION_ID_RE.test(r));
  };

  const probeAll = async (): Promise<ProbeReport> => {
    const [db, kv, mm] = await Promise.all([
      timedProbe(() => ctx.db.execute(sql`select 1`), opts.timeoutMs),
      timedProbe(() => ctx.kv.ping(), opts.timeoutMs),
      matchmakerProbes(),
    ]);
    let flags = { store: true, chat: true };
    if (db.ok) {
      const [snap, incidents, regions] = await Promise.all([
        timedProbe(() => liveOpsSnapshot(ctx), opts.timeoutMs),
        timedProbe(() => listIncidents(ctx.db, { activeOnly: true, limit: 20 }), opts.timeoutMs),
        timedProbe(() => knownRegions(), opts.timeoutMs),
      ]);
      if (snap.value) {
        const f = snap.value.flags;
        flags = { store: f['store.enabled']?.enabled ?? true, chat: f['chat.global']?.enabled ?? true };
        lastMaintenance = {
          ...snap.value.maintenance,
          phase: maintenancePhase(snap.value.maintenance, nowMs()),
        };
      }
      if (incidents.value) lastIncidents = incidents.value;
      return {
        db,
        kv,
        ...mm,
        knownRegions: regions.value ?? [],
        flags,
        maintenance: lastMaintenance,
        incidents: lastIncidents,
      };
    }
    // The cached window can have opened or closed since it was read.
    const maintenance = { ...lastMaintenance, phase: maintenancePhase(lastMaintenance, nowMs()) };
    return { db, kv, ...mm, knownRegions: [], flags, maintenance, incidents: lastIncidents };
  };

  const fresh = async (): Promise<StatusSummary> => computeSummary(await probeAll(), nowMs(), opts);

  const summary = (): Promise<StatusSummary> => {
    const now = nowMs();
    if (!summaryCache || now - summaryCache.at >= opts.cacheMs) {
      const value = fresh();
      summaryCache = { at: now, value };
      value.catch(() => {
        if (summaryCache?.value === value) summaryCache = null;
      });
    }
    return summaryCache.value;
  };

  const history = (): Promise<StatusHistory> => {
    const now = nowMs();
    if (!historyCache || now - historyCache.at >= opts.historyCacheMs) {
      const value = loadHistory(ctx, summary, now);
      historyCache = { at: now, value };
      value.catch(() => {
        if (historyCache?.value === value) historyCache = null;
      });
    }
    return historyCache.value;
  };

  const sample = async (): Promise<boolean> => {
    // With the timer off (tests, STATUS_SAMPLE_SECONDS=0) a manual call still uses one-minute slots.
    const interval = opts.sampleIntervalMs > 0 ? opts.sampleIntervalMs : 60_000;
    const now = nowMs();
    const slot = Math.floor(now / interval);
    if (!(await ctx.kv.setNX(`status:sample:${slot}`, '1', interval * 2))) return false;
    const s = await fresh();
    await recordSample(ctx, s, now);
    return true;
  };

  let timer: NodeJS.Timeout | undefined;
  if (opts.sampleIntervalMs > 0) {
    timer = setInterval(() => void sample().catch(() => undefined), opts.sampleIntervalMs);
    timer.unref();
  }

  return {
    summary,
    history,
    sample,
    invalidate: async () => {
      summaryCache = null;
      historyCache = null;
      await ctx.kv.publish(STATUS_INVALIDATION_CHANNEL, '1');
    },
    close: async () => {
      clearInterval(timer);
      await (
        await unsubscribe
      )();
    },
  };
}

/**
 * Adds one sample per component for the UTC day of `nowMs`, and prunes days
 * that fell out of the window.
 *
 * @param ctx - Shared services.
 * @param s - The summary sampled.
 * @param nowMs - Sample time.
 */
export async function recordSample(ctx: AppContext, s: StatusSummary, nowMs: number): Promise<void> {
  const day = dayKey(nowMs);
  const rows = s.components.map((c) => {
    const row: { component: string; day: string } & UptimeCounts = {
      component: c.id,
      day,
      ...NO_SAMPLES,
      samples: 1,
    };
    const key = countKey(c.state);
    if (key) row[key] = 1;
    return row;
  });
  if (rows.length === 0) return;
  const add = (col: keyof UptimeCounts) => sql.raw(`"status_uptime"."${col}" + excluded."${col}"`);
  await ctx.db
    .insert(statusUptime)
    .values(rows)
    .onConflictDoUpdate({
      target: [statusUptime.component, statusUptime.day],
      set: {
        samples: add('samples'),
        operational: add('operational'),
        degraded: add('degraded'),
        partial: add('partial'),
        major: add('major'),
        maintenance: add('maintenance'),
      },
    });
  await ctx.db.delete(statusUptime).where(lt(statusUptime.day, dayRange(nowMs)[0]!));
}

/**
 * The 90-day history for the components the summary shows now.
 *
 * @param ctx - Shared services.
 * @param summary - Current summary (component list and names).
 * @param nowMs - Clock.
 */
async function loadHistory(
  ctx: AppContext,
  summary: () => Promise<StatusSummary>,
  nowMs: number,
): Promise<StatusHistory> {
  const days = dayRange(nowMs, UPTIME_DAYS);
  const [current, rows, incidents] = await Promise.all([
    summary(),
    ctx.db.select().from(statusUptime).where(gte(statusUptime.day, days[0]!)),
    listIncidents(ctx.db, { since: new Date(Date.parse(`${days[0]}T00:00:00Z`)), limit: 100 }),
  ]);
  const by = new Map<string, UptimeCounts>();
  for (const r of rows) by.set(`${r.component}|${r.day}`, r);
  return {
    days,
    components: current.components.map((c) => {
      const perDay = days.map((d) => by.get(`${c.id}|${d}`) ?? NO_SAMPLES);
      return {
        id: c.id,
        name: c.name,
        uptime: uptimeRatio(sumCounts(perDay)),
        days: perDay.map((d) => ({ state: dayState(d), uptime: uptimeRatio(d) })),
      };
    }),
    incidents,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
