/**
 * Player counts for the Play Online tile, from the matchmaker. Only numbers
 * the servers actually report are shown: `GET /stats` gives queued players and
 * humans in rooms; an older matchmaker only reports its queue on `/health`.
 */
import type { OnlineStatus } from '@tumble/ui';

/** `GET /stats` body (mirrors `MatchmakerStats` in apps/matchmaker). */
export interface MatchmakerStatsBody {
  queued: number;
  inGame: number;
  servers?: number;
}

/**
 * Parses a `/stats` response body defensively.
 *
 * @param body - Decoded JSON.
 * @returns The counts, or null when the shape is wrong.
 */
export function parseMatchmakerStats(body: unknown): MatchmakerStatsBody | null {
  if (!body || typeof body !== 'object') return null;
  const { queued, inGame } = body as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return ok(queued) && ok(inGame) ? { queued: Math.floor(queued), inGame: Math.floor(inGame) } : null;
}

/** Show size when the playlist is unknown (the main show). */
export const DEFAULT_SHOW_SIZE = 40;

/**
 * Players a queued show fills to (the queue screen's "found / needed").
 *
 * @param playlists - Playlists the menu knows (with their sizes).
 * @param playlistId - The queued playlist, or null when unknown.
 * @returns The playlist's player count, else {@link DEFAULT_SHOW_SIZE}.
 */
export function queueTarget(
  playlists: readonly { id: string; players: number }[],
  playlistId: string | null,
): number {
  const p = playlistId ? playlists.find((x) => x.id === playlistId) : undefined;
  return p && p.players > 0 ? p.players : DEFAULT_SHOW_SIZE;
}

/**
 * Online-tile counts: "online" is everyone in a show or in the queue.
 *
 * @param stats - `/stats` counts, or null when unavailable.
 * @param queuedFromHealth - Queue size from `/health` (fallback), or null.
 * @returns The count fields of {@link OnlineStatus} (empty when nothing is known).
 *
 * @example
 * onlineCounts({ queued: 3, inGame: 37 }, null); // → { playersOnline: 40, inQueue: 3 }
 */
export function onlineCounts(
  stats: MatchmakerStatsBody | null,
  queuedFromHealth: number | null,
): Pick<OnlineStatus, 'playersOnline' | 'inQueue'> {
  if (stats) return { playersOnline: stats.inGame + stats.queued, inQueue: stats.queued };
  return queuedFromHealth !== null ? { inQueue: queuedFromHealth } : {};
}
