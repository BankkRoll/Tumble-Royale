/**
 * Playlist schedules on the client: which playlists the menu offers right
 * now, which are announced as "Coming soon", and the countdowns on both.
 *
 * Responsibilities:
 * - Merge the API's effective schedules (`GET /playlists`) over the bundled
 *   ones; without an API answer (offline, never fetched) the bundled
 *   schedules are used as shipped.
 * - Evaluate windows on the server's clock (a measured offset), so a device
 *   whose clock is off still opens and closes a limited-time show when the
 *   matchmaker does, and convert times back to the device clock for the UI's
 *   timers.
 * - Cache the last answer (with its offset) so an offline boot keeps it.
 */
import {
  clockOffset,
  mergeSchedule,
  parseInstant,
  playlistPhase,
  type PlaylistOverride,
  type PlaylistPhase,
  type PlaylistSchedule,
} from '@tumble/shared/liveops';
import { loadJson, saveJson } from '../storage.ts';

/** The last schedule answer and the clock offset measured with it. */
export interface ScheduleCache {
  playlists: PlaylistOverride[];
  /** Server clock minus device clock (ms). */
  offsetMs: number;
  /** Device clock (ms) of the fetch. */
  fetchedAt: number;
}

/** How a playlist shows in the menu right now. */
export interface ScheduledCard {
  phase: PlaylistPhase;
  featured: boolean;
  /** Device-clock epoch ms, for countdowns. */
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * Validates a `GET /playlists` answer.
 *
 * @param raw - Untrusted `playlists` array.
 * @returns The valid entries.
 */
export function parseSchedule(raw: unknown): PlaylistOverride[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): PlaylistOverride[] => {
    const p = x as Record<string, unknown> | null;
    if (!p || typeof p.id !== 'string' || p.id.length > 64) return [];
    const iso = (v: unknown) => (typeof v === 'string' && parseInstant(v) !== null ? v : null);
    return [
      {
        id: p.id,
        startsAt: iso(p.startsAt),
        endsAt: iso(p.endsAt),
        featured: p.featured === true,
        // The public route reports hidden playlists by phase, not by flag.
        hidden: p.hidden === true || p.phase === 'hidden',
      },
    ];
  });
}

/**
 * Where a playlist stands now.
 *
 * @param bundled - The playlist as shipped (its own schedule fields).
 * @param id - Playlist id.
 * @param cache - The API's schedules, or null to use the bundled one.
 * @param deviceNow - Device clock (ms).
 */
export function scheduledCard(
  bundled: PlaylistSchedule | undefined,
  id: string,
  cache: ScheduleCache | null,
  deviceNow: number,
): ScheduledCard {
  const offset = cache?.offsetMs ?? 0;
  const s = mergeSchedule(
    bundled,
    cache?.playlists.find((p) => p.id === id),
  );
  const toDevice = (iso: string | null) => {
    const t = parseInstant(iso);
    return t === null ? null : t - offset;
  };
  return {
    phase: playlistPhase(s, deviceNow + offset),
    featured: s.featured,
    startsAt: toDevice(s.startsAt),
    endsAt: toDevice(s.endsAt),
  };
}

/** The cached schedule, if any. */
export function cachedSchedule(): ScheduleCache | null {
  const c = loadJson<ScheduleCache>('playlistSchedule');
  return c && Array.isArray(c.playlists) && typeof c.offsetMs === 'number'
    ? { ...c, playlists: parseSchedule(c.playlists) }
    : null;
}

let active: ScheduleCache | null | undefined;

/** The schedule the menu uses now: the last answer, else the cached one, else null (bundled). */
export function activeSchedule(): ScheduleCache | null {
  active ??= cachedSchedule();
  return active;
}

/**
 * Makes a fresh answer the one the menu uses.
 *
 * @param cache - New schedule (null forgets it and falls back to the bundled schedules).
 */
export function setActiveSchedule(cache: ScheduleCache | null): void {
  active = cache;
}

/**
 * Whether a playlist can be played now under the active schedule.
 *
 * @param bundled - The playlist as shipped, or undefined for unknown ids (always playable).
 * @param id - Playlist id.
 * @param deviceNow - Device clock.
 */
export function isPlaylistLive(
  bundled: PlaylistSchedule | undefined,
  id: string,
  deviceNow: number = Date.now(),
): boolean {
  if (!bundled) return true;
  return scheduledCard(bundled, id, activeSchedule(), deviceNow).phase === 'live';
}

/**
 * Fetches and caches the schedule. Never throws; failures keep the cache.
 *
 * @param fetchSchedule - `ApiClient.playlistSchedule`.
 * @param now - Device clock.
 * @returns The fresh cache, or null when the fetch failed.
 */
export async function refreshSchedule(
  fetchSchedule: () => Promise<{ playlists: unknown; serverTime: unknown }>,
  now: () => number = Date.now,
): Promise<ScheduleCache | null> {
  const sent = now();
  try {
    const r = await fetchSchedule();
    const received = now();
    const cache: ScheduleCache = {
      playlists: parseSchedule(r.playlists),
      offsetMs: typeof r.serverTime === 'number' ? clockOffset(r.serverTime, sent, received) : 0,
      fetchedAt: received,
    };
    saveJson('playlistSchedule', cache);
    return cache;
  } catch {
    return null;
  }
}
