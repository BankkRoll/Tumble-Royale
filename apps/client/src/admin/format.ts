/**
 * Pure formatting and query helpers for the admin console views.
 */
import type { BanRow, PersonRef, RefundStatus, ReportAction, StaffRole } from './types.ts';

/** A sanction length the console offers; `hours: null` means permanent. */
export interface DurationOption {
  label: string;
  hours: number | null;
}

/** Mute lengths. */
export const MUTE_DURATIONS: readonly DurationOption[] = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];

/** Suspension lengths, ending with a permanent ban. */
export const BAN_DURATIONS: readonly DurationOption[] = [
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Permanent', hours: null },
];

/** Human names for report reasons. */
export const REASON_LABELS: Record<string, string> = {
  cheating: 'Cheating',
  harassment: 'Harassment',
  offensive_name: 'Offensive name',
  griefing: 'Griefing',
  spam: 'Spam',
  other: 'Other',
};

/** Human names for ban scopes. */
export const SCOPE_LABELS: Record<string, string> = {
  all: 'Suspended',
  chat: 'Muted',
  ranked: 'Ranked ban',
};

/** Labels and tones for the queue's bulk actions. */
export const ACTION_META: Record<ReportAction, { label: string; danger: boolean; verb: string }> = {
  dismiss: { label: 'Dismiss', danger: false, verb: 'Dismiss' },
  resolve: { label: 'Resolve', danger: false, verb: 'Resolve' },
  warn: { label: 'Warn', danger: false, verb: 'Warn' },
  mute: { label: 'Mute chat…', danger: true, verb: 'Mute' },
  ban: { label: 'Ban…', danger: true, verb: 'Ban' },
};

/**
 * `name#tag`, falling back to a short id when the player has no profile.
 *
 * @param p - Name parts and id.
 */
export function personLabel(p: Pick<PersonRef, 'id' | 'displayName' | 'tag'>): string {
  return p.displayName ? `${p.displayName}#${p.tag ?? '????'}` : `${p.id.slice(0, 8)}…`;
}

/**
 * Relative time such as `5 min ago` or `in 3 h`.
 *
 * @param iso - Instant.
 * @param now - Clock reading (ms).
 */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'min'],
  ];
  let text = 'just now';
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      text = `${Math.floor(abs / ms)} ${unit}`;
      break;
    }
  }
  if (text === 'just now') return text;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

/**
 * Local date and time, compact (`2026-10-04 14:05`).
 *
 * @param iso - Instant.
 */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Converts an ISO instant to a `<input type="datetime-local">` value (local time).
 *
 * @param iso - Instant or null.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Converts a `datetime-local` value (local time) to an ISO instant; empty → null.
 *
 * @param value - Input value.
 * @returns ISO string, null for empty, undefined when unparseable.
 */
export function fromLocalInput(value: string): string | null | undefined {
  if (!value.trim()) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Where a ban stands now.
 *
 * @param ban - Ban row.
 * @param now - Clock reading (ms).
 */
export function banState(
  ban: Pick<BanRow, 'expiresAt' | 'revokedAt'>,
  now: number,
): 'active' | 'lifted' | 'expired' {
  if (ban.revokedAt) return 'lifted';
  if (ban.expiresAt && Date.parse(ban.expiresAt) <= now) return 'expired';
  return 'active';
}

/**
 * Builds a query string from defined, non-empty values.
 *
 * @param params - Values.
 * @returns `?a=1&b=2`, or `''` when nothing is set.
 */
export function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Body of `POST /internal/reports/action`.
 *
 * @param reportIds - Selected reports.
 * @param action - Decision.
 * @param reason - Required reason.
 * @param hours - Mute/ban length; null = permanent ban.
 */
export function reportActionBody(
  reportIds: readonly string[],
  action: ReportAction,
  reason: string,
  hours: number | null | undefined,
): { reportIds: string[]; action: ReportAction; reason: string; durationHours?: number } {
  return {
    reportIds: [...reportIds],
    action,
    reason: reason.trim(),
    ...((action === 'mute' || action === 'ban') && hours ? { durationHours: hours } : {}),
  };
}

/** True when a role may use admin-only features. */
export function isAdmin(role: StaffRole | undefined): boolean {
  return role === 'admin';
}

/** Hash routes of the console. */
export type Route =
  | { view: 'reports' }
  | { view: 'players'; id?: string; q?: string }
  | { view: 'sanctions' }
  | { view: 'liveops' }
  | { view: 'refunds'; id?: string }
  | { view: 'clubs'; id?: string; q?: string }
  | { view: 'audit'; target?: string };

/**
 * Parses `location.hash` (`#/players/<id>`, `#/players?q=name`, `#/audit?target=…`).
 *
 * @param hash - Raw hash.
 */
export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(search);
  const [view, id] = path.split('/');
  switch (view) {
    case 'players':
      return {
        view: 'players',
        ...(id ? { id: decodeURIComponent(id) } : {}),
        ...(params.get('q') ? { q: params.get('q')! } : {}),
      };
    case 'sanctions':
      return { view: 'sanctions' };
    case 'liveops':
      return { view: 'liveops' };
    case 'refunds':
      return { view: 'refunds', ...(id ? { id: decodeURIComponent(id) } : {}) };
    case 'clubs':
      return {
        view: 'clubs',
        ...(id ? { id: decodeURIComponent(id) } : {}),
        ...(params.get('q') ? { q: params.get('q')! } : {}),
      };
    case 'audit':
      return { view: 'audit', ...(params.get('target') ? { target: params.get('target')! } : {}) };
    default:
      return { view: 'reports' };
  }
}

/**
 * The hash for a route.
 *
 * @param r - Route.
 */
export function routeHash(r: Route): string {
  switch (r.view) {
    case 'players':
      return r.id ? `#/players/${encodeURIComponent(r.id)}` : `#/players${query({ q: r.q })}`;
    case 'refunds':
      return r.id ? `#/refunds/${encodeURIComponent(r.id)}` : '#/refunds';
    case 'clubs':
      return r.id ? `#/clubs/${encodeURIComponent(r.id)}` : `#/clubs${query({ q: r.q })}`;
    case 'audit':
      return `#/audit${query({ target: r.target })}`;
    default:
      return `#/${r.view}`;
  }
}

/** Human names and badge tones for refund statuses. */
export const REFUND_STATUS: Record<
  RefundStatus,
  { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }
> = {
  completed: { label: 'refunded (self-service)', tone: 'neutral' },
  pending: { label: 'awaiting decision', tone: 'warn' },
  processing: { label: 'sent to Stripe', tone: 'info' },
  manual: { label: 'refund by hand', tone: 'info' },
  refunded: { label: 'refunded', tone: 'good' },
  partially_refunded: { label: 'partly refunded', tone: 'good' },
  denied: { label: 'denied', tone: 'neutral' },
  failed: { label: 'failed', tone: 'bad' },
};

/**
 * A refund amount for people: money in dollars, currencies with their name.
 *
 * @param currency - `usd`, `gumballs` or `gems`.
 * @param amount - Minor units for money, otherwise whole units.
 * @returns The formatted amount.
 * @example
 * refundAmount('usd', 999); // "$9.99"
 */
export function refundAmount(currency: string, amount: number): string {
  if (currency === 'usd') return `$${(amount / 100).toFixed(2)}`;
  const names: Record<string, string> = { gumballs: 'Gumballs', gems: 'Gems', crown_shards: 'Crown Shards' };
  return `${amount.toLocaleString('en-US')} ${names[currency] ?? currency}`;
}
