/**
 * "Play again" memory: the exact kind of show the player last started, so a
 * replay never silently switches mode (a Vs Bots show queueing online, an
 * offline private show turning into the default playlist).
 */
import type { CustomLobbyOptions } from '@tumble/ui';

/** How the last show was started. */
export type LastShow =
  /** Play with the default routing: matchmaking when reachable, else bots (also `?online=1`). */
  | { kind: 'auto'; playlistId: string | null }
  /** Vs Bots on a playlist. */
  | { kind: 'offline'; playlistId: string | null }
  /** Offline private show vs bots with picked rounds and options. */
  | { kind: 'custom'; options: CustomLobbyOptions }
  /** A matchmade online show (queue, party or custom lobby). */
  | { kind: 'matchmade'; playlistId: string };

/** What Play again does. */
export type PlayAgainAction =
  /** Start an offline show vs bots on this playlist, right away. */
  | { action: 'offline'; playlistId: string | null }
  /** Start an offline private show with these options. */
  | { action: 'custom'; options: CustomLobbyOptions }
  /** Go through the normal Play routing (queues online when it can). */
  | { action: 'play'; playlistId: string | null };

/**
 * Decides how to replay the last show.
 *
 * @param last - The last show (null before any, e.g. right after the tutorial).
 * @returns The action; with no last show, a normal Play on the default playlist.
 *
 * @example
 * playAgainAction({ kind: 'offline', playlistId: 'main-show' });
 * // → { action: 'offline', playlistId: 'main-show' }, even when online is reachable
 */
export function playAgainAction(last: LastShow | null): PlayAgainAction {
  if (!last) return { action: 'play', playlistId: null };
  switch (last.kind) {
    case 'offline':
      return { action: 'offline', playlistId: last.playlistId };
    case 'custom':
      // Copy so a later edit of the private show dialog can't change the replayed show.
      return { action: 'custom', options: { ...last.options, rounds: [...last.options.rounds] } };
    case 'matchmade':
      return { action: 'play', playlistId: last.playlistId };
    case 'auto':
      return { action: 'play', playlistId: last.playlistId };
  }
}
