/**
 * Small pure helpers for live-ops state in the UI: feature flags, the
 * browser's privacy signals and the maintenance banner text. Shared with the
 * game so both sides decide "is analytics on?" the same way.
 */
import type { MaintenanceNotice } from './types.ts';

/**
 * The public status page, served next to the game by every supported host
 * (`deploy/docker/client.Caddyfile`, `vercel.json`, `_redirects`). It is a
 * separate page so it still loads when the game's servers do not.
 */
export const STATUS_PAGE_URL = '/status';

/**
 * Whether a feature is on. Flags are kill switches: a key the game never
 * received is on.
 *
 * @param flags - `liveOps.flags`.
 * @param key - Flag key, e.g. `store.enabled`.
 */
export function featureOn(flags: Readonly<Record<string, boolean>>, key: string): boolean {
  return flags[key] !== false;
}

/** The parts of `navigator` that carry privacy signals. */
export interface PrivacyNavigator {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

/**
 * True when the browser asks not to be tracked (Do Not Track or Global
 * Privacy Control).
 *
 * @param nav - Usually `navigator`; undefined outside a browser.
 */
export function privacySignal(nav: PrivacyNavigator | undefined): boolean {
  if (!nav) return false;
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.doNotTrack === 'yes';
}

/**
 * Whether gameplay statistics may be sent.
 *
 * @param setting - `settings.gameplay.analytics` (null follows the browser).
 * @param nav - Usually `navigator`.
 * @example
 * analyticsAllowed(null, { doNotTrack: '1' }); // false
 * analyticsAllowed(true, { doNotTrack: '1' }); // true: the player opted in
 */
export function analyticsAllowed(
  setting: boolean | null | undefined,
  nav: PrivacyNavigator | undefined,
): boolean {
  return setting ?? !privacySignal(nav);
}

function minutesText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The banner headline for a maintenance notice.
 *
 * @param n - The notice.
 * @param now - Device clock (ms).
 * @example
 * maintenanceHeadline({ phase: 'scheduled', startsAt: now + 600_000, ... }, now); // 'Maintenance in 10 min'
 */
export function maintenanceHeadline(n: MaintenanceNotice, now: number): string {
  if (n.phase === 'scheduled' && n.startsAt !== null)
    return `Maintenance in ${minutesText(n.startsAt - now)}`;
  if (n.endsAt !== null && n.endsAt > now)
    return `Down for maintenance · back in about ${minutesText(n.endsAt - now)}`;
  return 'Down for maintenance';
}
