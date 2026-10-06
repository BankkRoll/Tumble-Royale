/**
 * Public status page vocabulary shared by the API (which computes and stores
 * it) and the status page (which renders it). Pure: no DOM, no Node APIs, no
 * wall clock; every function that needs the time takes it.
 *
 * Responsibilities:
 * - Components: the fixed list shown on the page, plus one row per game
 *   server region (`gameservers:<region>`).
 * - States: component and overall states, their severity order, and how
 *   component states, incidents and maintenance combine into the headline.
 * - Incidents: impact levels, lifecycle statuses and input limits.
 * - Uptime: UTC day buckets, the per-day uptime ratio and the 90-day window.
 * - The exact JSON shapes of `GET /status/summary` and `GET /status/history`.
 */

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

/** Components every deployment shows, in display order. */
export const BASE_COMPONENTS = ['website', 'api', 'matchmaking', 'gameservers', 'store', 'chat'] as const;

/** A fixed component id. */
export type BaseComponentId = (typeof BASE_COMPONENTS)[number];

/** Display names of the fixed components. */
export const COMPONENT_NAMES: Readonly<Record<BaseComponentId, string>> = {
  website: 'Website',
  api: 'Accounts & API',
  matchmaking: 'Matchmaking',
  gameservers: 'Game servers',
  store: 'Store & payments',
  chat: 'Chat',
};

/**
 * Components whose total loss stops everyone from playing online; a major
 * outage of any other component (one region, the store, chat) is only a
 * partial outage of the service as a whole.
 */
export const CRITICAL_COMPONENTS: ReadonlySet<string> = new Set(['api', 'matchmaking', 'gameservers']);

/** Prefix of per-region game server components (`gameservers:eu`). */
export const REGION_COMPONENT_PREFIX = 'gameservers:';

/** Region ids as game servers report them; anything else is dropped before it reaches the page. */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

/** Most regions shown; a misconfigured fleet cannot grow the page without bound. */
export const MAX_REGIONS = 12;

const REGION_NAMES: Readonly<Record<string, string>> = {
  na: 'North America',
  sa: 'South America',
  eu: 'Europe',
  asia: 'Asia',
  oce: 'Oceania',
};

/**
 * Display name of a region.
 *
 * @param region - Region id (`eu`).
 * @returns The known name, else the id upper-cased.
 * @example
 * regionName('eu'); // 'Europe'
 * regionName('us-west'); // 'US-WEST'
 */
export function regionName(region: string): string {
  return REGION_NAMES[region] ?? region.toUpperCase();
}

/**
 * Whether an id names a component the page can show: a fixed one or a valid
 * region row.
 *
 * @param id - Untrusted component id.
 */
export function isComponentId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if ((BASE_COMPONENTS as readonly string[]).includes(id)) return true;
  return (
    id.startsWith(REGION_COMPONENT_PREFIX) && REGION_ID_RE.test(id.slice(REGION_COMPONENT_PREFIX.length))
  );
}

/**
 * Display name of any component id.
 *
 * @param id - A fixed id or `gameservers:<region>`.
 */
export function componentName(id: string): string {
  if (id.startsWith(REGION_COMPONENT_PREFIX))
    return `Game servers · ${regionName(id.slice(REGION_COMPONENT_PREFIX.length))}`;
  return COMPONENT_NAMES[id as BaseComponentId] ?? id;
}

// -----------------------------------------------------------------------------
// States
// -----------------------------------------------------------------------------

/** What one component is doing right now. `unknown` means it could not be checked. */
export type ComponentState =
  'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown';

/** The headline state of the whole service. */
export type OverallState = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';

/** Every component state, for validation. */
export const COMPONENT_STATES: readonly ComponentState[] = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
  'unknown',
];

/** Human labels for states. */
export const STATE_LABELS: Readonly<Record<ComponentState, string>> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Under maintenance',
  unknown: 'Unknown',
};

/** Headline copy for each overall state. */
export const OVERALL_LABELS: Readonly<Record<OverallState, string>> = {
  operational: 'All systems operational',
  degraded: 'Some systems are slow',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Down for maintenance',
};

/**
 * How bad a state is: 0 for fine, 3 for a major outage. Planned maintenance
 * and an unknown state rank 0 so neither raises the headline on its own.
 *
 * @param state - A component state.
 */
export function severity(state: ComponentState): number {
  switch (state) {
    case 'degraded':
      return 1;
    case 'partial_outage':
      return 2;
    case 'major_outage':
      return 3;
    default:
      return 0;
  }
}

/**
 * The worse of two states (by {@link severity}; ties keep the first).
 *
 * @param a - A state.
 * @param b - Another state.
 */
export function worse(a: ComponentState, b: ComponentState): ComponentState {
  return severity(b) > severity(a) ? b : a;
}

// -----------------------------------------------------------------------------
// Incidents
// -----------------------------------------------------------------------------

/** How much an incident hurts the components it names. */
export type IncidentImpact = 'minor' | 'major' | 'critical';

/** Impact levels, least severe first. */
export const INCIDENT_IMPACTS: readonly IncidentImpact[] = ['minor', 'major', 'critical'];

/** Where an incident is in its lifecycle. */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/** Lifecycle statuses, in order. */
export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
];

/** Human labels for incident statuses. */
export const INCIDENT_STATUS_LABELS: Readonly<Record<IncidentStatus, string>> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

/** Input limits for incidents; the API refuses anything longer. */
export const INCIDENT_LIMITS = {
  /** Characters in a title. */
  titleMax: 120,
  /** Characters in one public update. */
  messageMax: 2000,
  /** Components one incident may name. */
  componentsMax: 16,
  /** Updates kept per incident. */
  updatesMax: 100,
} as const;

/**
 * The component state an active incident imposes.
 *
 * @param impact - Incident impact.
 * @example
 * impactState('major'); // 'partial_outage'
 */
export function impactState(impact: IncidentImpact): ComponentState {
  return impact === 'critical' ? 'major_outage' : impact === 'major' ? 'partial_outage' : 'degraded';
}

/**
 * Normalises operator text for public display: drops control characters
 * (except newlines and tabs), normalises line endings and trims. The text
 * stays plain text; every renderer escapes it.
 *
 * @param text - Untrusted input.
 * @returns The cleaned text.
 */
export function cleanPublicText(text: string): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0)!;
    if (ch !== '\n' && ch !== '\t' && STRIPPED.some(([lo, hi]) => c >= lo && c <= hi)) continue;
    out += ch;
  }
  return out.trim();
}

// C0/C1 controls, zero-width characters and bidi overrides (which can make a
// message read differently from what was typed).
const STRIPPED: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

// -----------------------------------------------------------------------------
// Headline
// -----------------------------------------------------------------------------

/** One component's state as the summary reports it. */
export interface ComponentStatus {
  id: string;
  name: string;
  state: ComponentState;
}

/**
 * The headline state.
 *
 * Active maintenance wins outright. Otherwise the worst component state
 * decides, except that a major outage of a non-critical component (one
 * region, the store, chat, the website) reads as a partial outage: most
 * players can still play.
 *
 * @param components - Component states (incidents already applied).
 * @param maintenanceActive - A live-ops maintenance window is active.
 * @param unscoped - States imposed by active incidents that name no component.
 * @returns The overall state.
 */
export function overallState(
  components: readonly Pick<ComponentStatus, 'id' | 'state'>[],
  maintenanceActive: boolean,
  unscoped: readonly ComponentState[] = [],
): OverallState {
  if (maintenanceActive) return 'maintenance';
  let worst = 0;
  for (const c of components) {
    let s = severity(c.state);
    if (s === 3 && !CRITICAL_COMPONENTS.has(c.id)) s = 2;
    worst = Math.max(worst, s);
  }
  for (const state of unscoped) worst = Math.max(worst, severity(state));
  return (['operational', 'degraded', 'partial_outage', 'major_outage'] as const)[worst]!;
}

// -----------------------------------------------------------------------------
// Uptime
// -----------------------------------------------------------------------------

/** Days of history the page shows and the API keeps. */
export const UPTIME_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * The UTC day an instant falls in.
 *
 * @param ms - Epoch ms.
 * @returns `YYYY-MM-DD`.
 * @example
 * dayKey(Date.parse('2026-10-05T23:59:59Z')); // '2026-10-05'
 */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The last `n` UTC days ending with today, oldest first.
 *
 * @param nowMs - Epoch ms.
 * @param n - Number of days (default {@link UPTIME_DAYS}).
 */
export function dayRange(nowMs: number, n = UPTIME_DAYS): string[] {
  const today = Date.parse(`${dayKey(nowMs)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => dayKey(today - (n - 1 - i) * DAY_MS));
}

/** Samples of one component on one UTC day, by state. */
export interface UptimeCounts {
  samples: number;
  operational: number;
  degraded: number;
  partial: number;
  major: number;
  maintenance: number;
}

/** An empty day. */
export const NO_SAMPLES: UptimeCounts = {
  samples: 0,
  operational: 0,
  degraded: 0,
  partial: 0,
  major: 0,
  maintenance: 0,
};

/**
 * The counter column a sampled state increments. `unknown` counts only
 * towards `samples`, so a probe that could not run neither helps nor hurts.
 *
 * @param state - Sampled state.
 */
export function countKey(state: ComponentState): keyof Omit<UptimeCounts, 'samples'> | null {
  switch (state) {
    case 'operational':
      return 'operational';
    case 'degraded':
      return 'degraded';
    case 'partial_outage':
      return 'partial';
    case 'major_outage':
      return 'major';
    case 'maintenance':
      return 'maintenance';
    default:
      return null;
  }
}

/**
 * Uptime over some samples: a major outage counts fully as down, a partial
 * outage half; degraded counts as up; maintenance and unknown samples are
 * left out of the denominator.
 *
 * @param c - Counts (one day or summed).
 * @returns A ratio in 0..1, or null when nothing measurable was sampled.
 * @example
 * uptimeRatio({ ...NO_SAMPLES, samples: 4, operational: 2, partial: 2 }); // 0.75
 */
export function uptimeRatio(c: UptimeCounts): number | null {
  const counted = c.operational + c.degraded + c.partial + c.major;
  if (counted <= 0) return null;
  return Math.max(0, Math.min(1, (counted - c.major - c.partial / 2) / counted));
}

/**
 * The colour of one day's bar: the worst state sampled that day, or
 * `maintenance` when the day was only maintenance, or null for no data.
 *
 * @param c - One day's counts.
 */
export function dayState(c: UptimeCounts): ComponentState | null {
  if (c.major > 0) return 'major_outage';
  if (c.partial > 0) return 'partial_outage';
  if (c.degraded > 0) return 'degraded';
  if (c.operational > 0) return 'operational';
  if (c.maintenance > 0) return 'maintenance';
  return null;
}

/**
 * Adds counts together.
 *
 * @param days - Counts to sum.
 */
export function sumCounts(days: Iterable<UptimeCounts>): UptimeCounts {
  const out = { ...NO_SAMPLES };
  for (const d of days) {
    out.samples += d.samples;
    out.operational += d.operational;
    out.degraded += d.degraded;
    out.partial += d.partial;
    out.major += d.major;
    out.maintenance += d.maintenance;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Wire shapes
// -----------------------------------------------------------------------------

/** One public update on an incident. */
export interface PublicIncidentUpdate {
  status: IncidentStatus;
  /** Plain text; renderers must escape it. */
  message: string;
  /** ISO time. */
  at: string;
}

/** An incident as the public sees it: no operator identity, no internal notes. */
export interface PublicIncident {
  id: string;
  /** Plain text; renderers must escape it. */
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  components: string[];
  /** ISO time the incident began. */
  startedAt: string;
  /** ISO time of the latest update. */
  updatedAt: string;
  resolvedAt: string | null;
  /** Newest first. */
  updates: PublicIncidentUpdate[];
}

/** A maintenance window as the page shows it. */
export interface PublicMaintenance {
  message: string;
  startsAt: string | null;
  endsAt: string | null;
}

/** `GET /status/summary`. */
export interface StatusSummary {
  overall: OverallState;
  components: ComponentStatus[];
  maintenance: {
    /** The window in force now, or null. */
    active: PublicMaintenance | null;
    /** An announced window that has not started, or null. */
    upcoming: PublicMaintenance | null;
  };
  /** Unresolved incidents, newest first. */
  incidents: PublicIncident[];
  /** ISO time the summary was computed (it is cached for a few seconds). */
  generatedAt: string;
}

/** One component's 90-day uptime row. */
export interface ComponentHistory {
  id: string;
  name: string;
  /** Uptime over the whole window, or null with no data. */
  uptime: number | null;
  /** One entry per day of {@link StatusHistory.days}. */
  days: { state: ComponentState | null; uptime: number | null }[];
}

/** `GET /status/history`. */
export interface StatusHistory {
  /** UTC days, oldest first. */
  days: string[];
  components: ComponentHistory[];
  /** Incidents that started inside the window, newest first. */
  incidents: PublicIncident[];
  generatedAt: string;
}
