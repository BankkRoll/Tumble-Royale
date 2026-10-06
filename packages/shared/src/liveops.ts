/**
 * Live-ops vocabulary shared by the API, the matchmaker, the game servers and
 * the browser client, so every service agrees on what a flag, a maintenance
 * window, a playlist schedule and an analytics event mean. Pure: no DOM, no
 * Node APIs.
 *
 * Responsibilities:
 * - Feature flags: the known keys, their offline defaults and how a missing
 *   or malformed flag resolves (always to the default, so a fresh install or
 *   an unreachable API behaves exactly like "nothing switched off").
 * - Maintenance: a window (`startsAt`..`endsAt`, both optional) and its phase
 *   at a given instant (`off`, `scheduled` ahead of time, or `active`).
 * - Scheduled playlists: `startsAt`/`endsAt`/`featured`/`hidden`, the phase
 *   of a playlist at an instant, and how an operator override merges over the
 *   bundled schedule.
 * - Analytics: the event allow-list and per-event payload limits enforced by
 *   both the client (before sending) and the API (on ingest).
 * - Clock skew: the offset between a device clock and the server clock.
 *
 * Time windows are half-open everywhere: a window is live from `startsAt`
 * inclusive to `endsAt` exclusive, so exactly at `endsAt` it is already over.
 */

// -----------------------------------------------------------------------------
// Feature flags
// -----------------------------------------------------------------------------

/** Flags the code reads. Unknown keys may exist in the database; they are passed through. */
export const FLAG_KEYS = [
  'store.enabled',
  'chat.global',
  'party.lobbyGames',
  'replays.enabled',
  'mutators.chaos',
  'analytics.sample',
  'events.enabled',
  /** Round voting between rounds (game servers read it per show, the offline client per show). */
  'shows.mapVoting',
] as const;

/** A flag the code reads. */
export type FlagKey = (typeof FLAG_KEYS)[number];

/** One evaluated flag. */
export interface FlagValue {
  enabled: boolean;
  /** Free-form settings (e.g. the analytics sample rate); null when unset. */
  payload: unknown;
}

/** Flags by key, as `GET /flags` answers them. */
export type FlagMap = Readonly<Record<string, FlagValue>>;

/**
 * What every flag is when the API has no row for it or cannot be reached.
 * Everything is on: flags are kill switches, so "unknown" must never turn a
 * feature off.
 */
export const FLAG_DEFAULTS: Readonly<Record<FlagKey, FlagValue>> = {
  'store.enabled': { enabled: true, payload: null },
  'chat.global': { enabled: true, payload: null },
  'party.lobbyGames': { enabled: true, payload: null },
  'replays.enabled': { enabled: true, payload: null },
  'mutators.chaos': { enabled: true, payload: null },
  'analytics.sample': { enabled: true, payload: null },
  'events.enabled': { enabled: true, payload: null },
  'shows.mapVoting': { enabled: true, payload: null },
};

/**
 * Whether a flag is on.
 *
 * @param flags - Evaluated flags, or null when none were ever fetched.
 * @param key - Flag key.
 * @returns The flag's state, or its default when missing or malformed.
 * @example
 * flagEnabled({ 'store.enabled': { enabled: false, payload: null } }, 'store.enabled'); // false
 * flagEnabled(null, 'store.enabled'); // true
 */
export function flagEnabled(flags: FlagMap | null | undefined, key: FlagKey): boolean {
  const v = flags?.[key];
  return typeof v?.enabled === 'boolean' ? v.enabled : FLAG_DEFAULTS[key].enabled;
}

/**
 * The share of clients that send analytics, from `analytics.sample`:
 * off → 0; on with a number payload (or `{ rate }`) in 0..1 → that number;
 * on without a usable payload → 1.
 *
 * @param flags - Evaluated flags.
 * @returns A rate in 0..1.
 */
export function analyticsSampleRate(flags: FlagMap | null | undefined): number {
  if (!flagEnabled(flags, 'analytics.sample')) return 0;
  const p = flags?.['analytics.sample']?.payload;
  const raw = typeof p === 'number' ? p : (p as { rate?: unknown } | null)?.rate;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
}

// -----------------------------------------------------------------------------
// Time windows
// -----------------------------------------------------------------------------

/**
 * Parses an ISO timestamp (or epoch ms) to epoch ms.
 *
 * @returns The instant, or null for null/undefined/unparseable input.
 */
export function parseInstant(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Where an instant falls relative to a half-open window. */
export type WindowPhase = 'before' | 'inside' | 'after';

/**
 * @param startsAt - Window start (inclusive), or null for "always started".
 * @param endsAt - Window end (exclusive), or null for "never ends".
 * @param nowMs - The instant.
 */
export function windowPhase(startsAt: number | null, endsAt: number | null, nowMs: number): WindowPhase {
  if (startsAt !== null && nowMs < startsAt) return 'before';
  if (endsAt !== null && nowMs >= endsAt) return 'after';
  return 'inside';
}

// -----------------------------------------------------------------------------
// Maintenance
// -----------------------------------------------------------------------------

/** A maintenance window as an operator sets it. */
export interface MaintenanceWindow {
  /** Master switch; off means no maintenance whatever the times say. */
  enabled: boolean;
  /** Shown to players in the banner and in refusal messages. */
  message: string;
  /** ISO start; null starts it immediately. A future start shows "Maintenance in …". */
  startsAt: string | null;
  /** ISO end; null keeps it on until an operator clears it. */
  endsAt: string | null;
}

/** `off`, `scheduled` (announced, not started) or `active`. */
export type MaintenancePhase = 'off' | 'scheduled' | 'active';

/** A maintenance window with its phase at the time it was read. */
export interface MaintenanceStatus extends MaintenanceWindow {
  phase: MaintenancePhase;
}

/** Message used when the operator gives none. */
export const DEFAULT_MAINTENANCE_MESSAGE = 'Tumble Royale is down for maintenance. We will be back soon!';

/** No maintenance. */
export const NO_MAINTENANCE: MaintenanceWindow = {
  enabled: false,
  message: DEFAULT_MAINTENANCE_MESSAGE,
  startsAt: null,
  endsAt: null,
};

/**
 * The phase of a maintenance window at an instant.
 *
 * @example
 * maintenancePhase({ enabled: true, message: '', startsAt: '2026-01-01T10:00:00Z', endsAt: null },
 *   Date.parse('2026-01-01T09:50:00Z')); // 'scheduled'
 */
export function maintenancePhase(m: MaintenanceWindow | null | undefined, nowMs: number): MaintenancePhase {
  if (!m?.enabled) return 'off';
  const w = windowPhase(parseInstant(m.startsAt), parseInstant(m.endsAt), nowMs);
  return w === 'before' ? 'scheduled' : w === 'inside' ? 'active' : 'off';
}

/**
 * Validates a maintenance window from storage or the network; anything
 * malformed becomes {@link NO_MAINTENANCE} rather than blocking play.
 *
 * @param raw - Untrusted value.
 */
export function parseMaintenance(raw: unknown): MaintenanceWindow {
  if (!raw || typeof raw !== 'object') return NO_MAINTENANCE;
  const r = raw as Record<string, unknown>;
  const iso = (v: unknown): string | null => (typeof v === 'string' && parseInstant(v) !== null ? v : null);
  return {
    enabled: r.enabled === true,
    message:
      typeof r.message === 'string' && r.message.trim()
        ? r.message.slice(0, 500)
        : DEFAULT_MAINTENANCE_MESSAGE,
    startsAt: iso(r.startsAt),
    endsAt: iso(r.endsAt),
  };
}

// -----------------------------------------------------------------------------
// Scheduled playlists
// -----------------------------------------------------------------------------

/** When and how a playlist is offered. */
export interface PlaylistSchedule {
  /** ISO start (inclusive); null/absent means already open. */
  startsAt?: string | null;
  /** ISO end (exclusive); null/absent means permanent. */
  endsAt?: string | null;
  /** Spotlighted: announced as "Coming soon" before it starts. */
  featured?: boolean | null;
  /** Withdrawn by an operator regardless of the times. */
  hidden?: boolean | null;
}

/** A schedule with every field resolved. */
export interface EffectiveSchedule {
  startsAt: string | null;
  endsAt: string | null;
  featured: boolean;
  hidden: boolean;
}

/** An operator override for one bundled playlist (API `playlist_overrides`). */
export interface PlaylistOverride {
  id: string;
  startsAt: string | null;
  endsAt: string | null;
  featured: boolean;
  hidden: boolean;
}

/** `live` (queueable), `upcoming`, `ended` or `hidden`. */
export type PlaylistPhase = 'live' | 'upcoming' | 'ended' | 'hidden';

/**
 * The phase of a playlist at an instant.
 *
 * @example
 * playlistPhase({ startsAt: '2026-01-01T00:00:00Z' }, Date.parse('2026-01-01T00:00:00Z')); // 'live'
 * playlistPhase({ endsAt: '2026-01-02T00:00:00Z' }, Date.parse('2026-01-02T00:00:00Z')); // 'ended'
 */
export function playlistPhase(s: PlaylistSchedule | null | undefined, nowMs: number): PlaylistPhase {
  if (s?.hidden) return 'hidden';
  const w = windowPhase(parseInstant(s?.startsAt), parseInstant(s?.endsAt), nowMs);
  return w === 'before' ? 'upcoming' : w === 'inside' ? 'live' : 'ended';
}

/**
 * The effective schedule: an override replaces the bundled schedule
 * wholesale, so an operator can clear a bundled end date by setting null.
 *
 * @param bundled - Schedule shipped with content.
 * @param override - Operator override, if any.
 */
export function mergeSchedule(
  bundled: PlaylistSchedule | null | undefined,
  override: PlaylistOverride | null | undefined,
): EffectiveSchedule {
  if (override) {
    return {
      startsAt: override.startsAt,
      endsAt: override.endsAt,
      featured: override.featured,
      hidden: override.hidden,
    };
  }
  return {
    startsAt: bundled?.startsAt ?? null,
    endsAt: bundled?.endsAt ?? null,
    featured: bundled?.featured ?? false,
    hidden: bundled?.hidden ?? false,
  };
}

// -----------------------------------------------------------------------------
// Analytics
// -----------------------------------------------------------------------------

/**
 * Every analytics event the client may send. The API refuses anything else,
 * so a compromised or buggy client cannot fill the table with arbitrary
 * names (or forge internal ones such as `audit.*`).
 */
export const ANALYTICS_EVENTS = [
  'show_start',
  'show_end',
  'round_start',
  'round_end',
  'quit_point',
  'tutorial_step',
  'store_view',
  'store_purchase',
  'matchmaking_wait',
  'load_time',
  'fps_bucket',
  'error_count',
  /** A share card was made or delivered: `format` (social/story), `outcome`, `action`, `named`, `crowned`. */
  'share.card',
  /** A clip was made or delivered: `format` (mp4/webm), `encoder`, `outcome`, `action`, `seconds`, `height`. */
  'share.clip',
  /** A round-vote ballot was cast or changed: `round` (index), `option`, `changed`, `online`. */
  'vote.cast',
] as const;

/** An allow-listed analytics event name. */
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/** Crash reports from the browser (`crashReporter.ts`). */
export const CLIENT_ERROR_EVENT = 'client.error';
/** Crash reports from the Node services. */
export const SERVER_ERROR_EVENT = 'server.error';

/** Size limits on analytics payloads. */
export const ANALYTICS_LIMITS = {
  /** Properties per event. */
  maxProps: 12,
  /** Property name length. */
  maxKeyLength: 32,
  /** String property length. */
  maxStringLength: 80,
  /** Events per `POST /events`. */
  maxBatch: 50,
} as const;

/** A flat analytics property value. */
export type AnalyticsValue = string | number | boolean | null;

const KEY_RE = /^[a-z][a-zA-Z0-9_]*$/;

/**
 * Validates analytics properties: a flat object of short strings, finite
 * numbers, booleans and nulls. Rejects (returns null) rather than trimming
 * anything that breaks a limit, so client and server agree exactly on what
 * is acceptable.
 *
 * @param props - Untrusted properties (undefined is an empty object).
 * @returns The properties, or null when invalid.
 */
export function validAnalyticsProps(props: unknown): Record<string, AnalyticsValue> | null {
  if (props === undefined) return {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > ANALYTICS_LIMITS.maxProps) return null;
  const out: Record<string, AnalyticsValue> = {};
  for (const [k, v] of entries) {
    if (k.length > ANALYTICS_LIMITS.maxKeyLength || !KEY_RE.test(k)) return null;
    if (typeof v === 'string') {
      if (v.length > ANALYTICS_LIMITS.maxStringLength) return null;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
    } else if (typeof v !== 'boolean' && v !== null) return null;
    out[k] = v as AnalyticsValue;
  }
  return out;
}

/** True for an allow-listed analytics event name. */
export function isAnalyticsEvent(name: unknown): name is AnalyticsEventName {
  return typeof name === 'string' && (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

// -----------------------------------------------------------------------------
// Clock skew
// -----------------------------------------------------------------------------

/**
 * Offset to add to the device clock to get server time, from one request
 * that reported the server's clock. Assumes the server read its clock half
 * way through the round trip, which bounds the error by half the RTT.
 *
 * @param serverTimeMs - Server clock in the response.
 * @param sentAtMs - Device clock when the request left.
 * @param receivedAtMs - Device clock when the response arrived.
 * @example
 * const offset = clockOffset(res.serverTime, sent, Date.now());
 * const serverNow = Date.now() + offset;
 */
export function clockOffset(serverTimeMs: number, sentAtMs: number, receivedAtMs: number): number {
  return Math.round(serverTimeMs - (sentAtMs + receivedAtMs) / 2);
}
