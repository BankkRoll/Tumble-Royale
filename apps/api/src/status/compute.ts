/**
 * Turns raw probe results into the public status summary. Pure, so every
 * combination of failures is unit-tested without timers or sockets.
 *
 * Rules, per component:
 * - Accounts & API: database down → major outage; KV down → partial outage
 *   (sign-in and the store still work, parties and presence do not); either
 *   slower than the threshold → degraded.
 * - Matchmaking: unreachable or timed out → major outage; slow → degraded.
 * - Game servers: one row per region once there are two or more. A region
 *   seen recently with no live server is a major outage; a region at 90 % of
 *   its seats is degraded. The total row is a major outage with no live
 *   server anywhere (or every region down), a partial outage when some
 *   regions are down. Unknown when the matchmaker cannot be asked.
 * - Store & payments: database down → major outage; `store.enabled` off →
 *   maintenance.
 * - Chat: KV down → major outage (chat fans out over KV pub/sub);
 *   `chat.global` off → maintenance.
 * - Website: only what incidents say (the API cannot see the static host,
 *   and the page that shows this was served by it).
 *
 * Active incidents then raise their components to their impact, and an
 * active maintenance window turns every component but the website into
 * `maintenance`.
 */
import type { MaintenanceStatus } from '@tumble/shared/liveops';
import {
  BASE_COMPONENTS,
  componentName,
  impactState,
  MAX_REGIONS,
  overallState,
  REGION_COMPONENT_PREFIX,
  REGION_ID_RE,
  worse,
  type ComponentState,
  type ComponentStatus,
  type PublicIncident,
  type StatusSummary,
} from '@tumble/shared/status';

/** Outcome of one timed check. */
export interface ProbeResult {
  ok: boolean;
  /** How long it took (the timeout when it timed out). */
  ms: number;
}

/** Live capacity of one region, as the matchmaker reports it. */
export interface RegionCapacity {
  region: string;
  servers: number;
  capacity: number;
  load: number;
}

/** Everything {@link computeSummary} needs. */
export interface ProbeReport {
  db: ProbeResult;
  kv: ProbeResult;
  /** Matchmaker `/health`; null when no matchmaker is configured. */
  matchmaker: (ProbeResult & { servers: number | null }) | null;
  /** Per-region capacity; null when the matchmaker did not answer it. */
  capacity: RegionCapacity[] | null;
  /** Regions sampled recently, so a region whose servers all vanished still shows as down. */
  knownRegions: readonly string[];
  /** Server-side kill switches. */
  flags: { store: boolean; chat: boolean };
  maintenance: MaintenanceStatus;
  /** Unresolved incidents, newest first. */
  incidents: readonly PublicIncident[];
}

/** Thresholds for {@link computeSummary}. */
export interface ComputeOptions {
  /** A probe slower than this is degraded (ms). */
  slowMs: number;
  /** Seat utilisation at which a region counts as degraded (0..1). */
  busyRatio: number;
}

/** Default thresholds. */
export const DEFAULT_COMPUTE: ComputeOptions = { slowMs: 1000, busyRatio: 0.9 };

const timed = (p: ProbeResult, slowMs: number): ComponentState =>
  !p.ok ? 'major_outage' : p.ms > slowMs ? 'degraded' : 'operational';

function apiState(r: ProbeReport, o: ComputeOptions): ComponentState {
  if (!r.db.ok) return 'major_outage';
  if (!r.kv.ok) return 'partial_outage';
  return r.db.ms > o.slowMs || r.kv.ms > o.slowMs ? 'degraded' : 'operational';
}

function gameServerStates(r: ProbeReport, o: ComputeOptions): ComponentStatus[] {
  const mm = r.matchmaker;
  if (!mm) return [];
  const total = (state: ComponentState): ComponentStatus => ({
    id: 'gameservers',
    name: componentName('gameservers'),
    state,
  });
  if (!r.capacity) {
    if (!mm.ok || mm.servers === null) return [total('unknown')];
    return [total(mm.servers > 0 ? 'operational' : 'major_outage')];
  }
  // SECURITY: region ids come from game-server registrations; only well-formed
  // ids reach the public page, and only a bounded number of them.
  const live = new Map(r.capacity.filter((c) => REGION_ID_RE.test(c.region)).map((c) => [c.region, c]));
  const regions = [...new Set([...live.keys(), ...r.knownRegions.filter((k) => REGION_ID_RE.test(k))])]
    .sort()
    .slice(0, MAX_REGIONS);
  const rows = regions.map((region): ComponentStatus => {
    const c = live.get(region);
    const state: ComponentState =
      !c || c.servers <= 0 || c.capacity <= 0
        ? 'major_outage'
        : c.load / c.capacity >= o.busyRatio
          ? 'degraded'
          : 'operational';
    const id = `${REGION_COMPONENT_PREFIX}${region}`;
    return { id, name: componentName(id), state };
  });
  const down = rows.filter((x) => x.state === 'major_outage').length;
  const agg: ComponentState =
    rows.length === 0 || down === rows.length
      ? 'major_outage'
      : down > 0
        ? 'partial_outage'
        : rows.some((x) => x.state === 'degraded')
          ? 'degraded'
          : 'operational';
  return [total(agg), ...(rows.length >= 2 ? rows : [])];
}

/**
 * Computes the public summary from probe results.
 *
 * @param r - Probe results, flags, maintenance and active incidents.
 * @param nowMs - Clock (epoch ms) for `generatedAt`.
 * @param o - Thresholds.
 * @returns The summary, components in display order.
 * @example
 * computeSummary(report, Date.now()).overall; // 'operational'
 */
export function computeSummary(
  r: ProbeReport,
  nowMs: number,
  o: ComputeOptions = DEFAULT_COMPUTE,
): StatusSummary {
  const states = new Map<string, ComponentState>();
  states.set('website', 'operational');
  states.set('api', apiState(r, o));
  if (r.matchmaker) states.set('matchmaking', timed(r.matchmaker, o.slowMs));
  const games = gameServerStates(r, o);
  for (const g of games) states.set(g.id, g.state);
  states.set('store', !r.db.ok ? 'major_outage' : r.flags.store ? 'operational' : 'maintenance');
  states.set('chat', !r.kv.ok ? 'major_outage' : r.flags.chat ? 'operational' : 'maintenance');

  const unscoped: ComponentState[] = [];
  for (const i of r.incidents) {
    if (i.status === 'resolved') continue;
    const imposed = impactState(i.impact);
    if (i.components.length === 0) unscoped.push(imposed);
    for (const id of i.components) {
      const current = states.get(id);
      if (current !== undefined) states.set(id, current === 'unknown' ? imposed : worse(current, imposed));
    }
  }

  const maintenanceActive = r.maintenance.phase === 'active';
  if (maintenanceActive) for (const id of states.keys()) if (id !== 'website') states.set(id, 'maintenance');

  const order = [...BASE_COMPONENTS, ...games.map((g) => g.id).filter((id) => id !== 'gameservers')];
  const sortKey = (id: string) => {
    // Region rows sit right after the total game-server row.
    if (id.startsWith(REGION_COMPONENT_PREFIX)) return BASE_COMPONENTS.indexOf('gameservers') + 0.5;
    return order.indexOf(id);
  };
  const components = [...states.entries()]
    .map(([id, state]) => ({ id, name: componentName(id), state }))
    .sort((a, b) => sortKey(a.id) - sortKey(b.id) || a.id.localeCompare(b.id));

  const window = (m: MaintenanceStatus) => ({ message: m.message, startsAt: m.startsAt, endsAt: m.endsAt });
  return {
    overall: overallState(components, maintenanceActive, unscoped),
    components,
    maintenance: {
      active: maintenanceActive ? window(r.maintenance) : null,
      upcoming: r.maintenance.phase === 'scheduled' ? window(r.maintenance) : null,
    },
    incidents: r.incidents.filter((i) => i.status !== 'resolved'),
    generatedAt: new Date(nowMs).toISOString(),
  };
}
