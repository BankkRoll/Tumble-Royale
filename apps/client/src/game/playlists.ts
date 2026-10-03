/**
 * Which playlist a Play press actually starts, and how private-show options
 * map onto a playlist. Pure (content + sim schema only) so it is unit tested
 * without the UI.
 *
 * Responsibilities:
 * - First Show: a newcomer's first {@link FIRST_SHOW_COUNT} shows swap the
 *   default Main Show for the gentle, bot-heavy `first-show` playlist, and the
 *   menu card says so.
 * - Offline fallbacks: ranked needs real opponents, so offline it plays as the
 *   Main Show.
 * - Private shows: picked rounds, seat count, bots on/off and the timer scale.
 */
import { getPlaylist } from '@tumble/content/shows';
import { clampRoundTimeScale } from '@tumble/sim/match';
import type { ShowPlaylist } from '@tumble/sim/show';
import { ShowPlaylistSchema } from '@tumble/sim/show/schema';

/** Shows that use the First Show playlist before the Main Show takes over (SHOWS.md §4.6). */
export const FIRST_SHOW_COUNT = 3;

/** The playlist the menu selects by default and that a newcomer's Play is swapped from. */
export const DEFAULT_PLAYLIST_ID = 'main-show';

/**
 * @param showsPlayed - Finished shows on this account/device, or null when unknown (online profile not loaded).
 * @returns True while the player should get the First Show.
 */
export function isNewcomer(showsPlayed: number | null): boolean {
  return showsPlayed !== null && showsPlayed < FIRST_SHOW_COUNT;
}

/**
 * The playlist id to queue or play for a Play press. A newcomer pressing Play
 * on the default Main Show (or with nothing selected) gets `first-show`; an
 * explicit pick of any other playlist is respected.
 *
 * @param requested - Menu selection, or null.
 * @param showsPlayed - Finished shows, or null when unknown.
 * @param forced - A `?playlist=` override: always wins, never swapped.
 * @returns A playlist id.
 * @example
 * playlistIdForPlay('main-show', 0); // 'first-show'
 * playlistIdForPlay('duos', 0); // 'duos'
 */
export function playlistIdForPlay(
  requested: string | null,
  showsPlayed: number | null,
  forced: string | null = null,
): string {
  if (forced) return forced;
  const id = requested || DEFAULT_PLAYLIST_ID;
  if (id === DEFAULT_PLAYLIST_ID && isNewcomer(showsPlayed) && getPlaylist('first-show')) return 'first-show';
  return id;
}

/**
 * Resolves the playlist for an offline show.
 *
 * @param requested - Menu selection, or null.
 * @param showsPlayed - Finished shows on this device (or account), or null when unknown.
 * @param forced - A `?playlist=` override.
 * @returns A validated playlist; ranked and unknown ids fall back to the Main Show.
 */
export function resolvePlaylist(
  requested: string | null,
  showsPlayed: number | null,
  forced: string | null = null,
): ShowPlaylist {
  const p = getPlaylist(playlistIdForPlay(requested, showsPlayed, forced));
  // Ranked needs real opponents; offline it plays as the Main Show.
  if (!p || p.ranked) return getPlaylist(DEFAULT_PLAYLIST_ID) as ShowPlaylist;
  return p;
}

/** Private-show options that shape the show (a subset of the UI's `CustomLobbyOptions`). */
export interface PrivateShowOptions {
  rounds: readonly string[];
  /** "Fill empty spots with bots". */
  bots: boolean;
  maxPlayers: number;
  /** Round timer multiplier from the dialog. */
  timerScale: number;
}

/** An offline private show: its playlist and the round timer multiplier. */
export interface PrivateShow {
  playlist: ShowPlaylist;
  /** Clamped to 0.5–2; pass to `createOfflineShow`/`ShowDirector` as `roundTimeScale`. */
  roundTimeScale: number;
}

/**
 * An offline private show: the host's picked rounds (played in that pool, the
 * last one a final when one was picked) and the dialog's seat count. With bots
 * off, `createOfflineShow` fills only the seats the picked rounds need (see
 * `minimumShowSeats`).
 *
 * @param options - Custom lobby options from the UI.
 * @returns The playlist and timer scale.
 */
export function privateShow(options: PrivateShowOptions): PrivateShow {
  const base = getPlaylist(DEFAULT_PLAYLIST_ID) as ShowPlaylist;
  const n = Math.max(1, options.rounds.length);
  const playlist = ShowPlaylistSchema.parse({
    ...base,
    id: 'custom-offline',
    name: 'Private Show',
    description: 'Your rounds, your rules.',
    maxPlayers: Math.max(2, Math.min(60, Math.round(options.maxPlayers))),
    minRounds: Math.min(base.minRounds, n),
    maxRounds: Math.max(2, Math.min(n, 8)),
    pool: options.rounds.map((roundId) => ({ roundId, weight: 1 })),
    botsAllowed: options.bots,
  });
  return { playlist, roundTimeScale: clampRoundTimeScale(options.timerScale) };
}
