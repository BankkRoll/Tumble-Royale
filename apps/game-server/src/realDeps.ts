/**
 * Production room dependencies: the real match simulation (Tumbler controller
 * + full obstacle library), the content round catalogue and the show director.
 * Matchmade rooms play the ticket's playlist; custom lobbies restrict the
 * round pool to the host's picks.
 */
import { randomInt } from 'node:crypto';
import { getPlaylist, MAIN_SHOW } from '@tumble/content/shows';
import { getRound, showRoundCatalog } from '@tumble/content/rounds';
import type { Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { PRE_SHOW_LOBBY_ROUND, ShowPlaylistSchema, type ShowPlaylist } from '@tumble/sim/show';
import type { MatchSettings, RoomDeps } from './room/types.ts';
import type { ResultsSink } from './results.ts';
import type { VoiceTeamsSink } from './voiceTeams.ts';
import { ShowDirectorController, type ShowDirectorControllerOptions } from './show/ShowDirectorController.ts';

/** Options for {@link createRealRoomDeps}. */
export interface RealDepsOptions {
  /** Playlist id from `@tumble/content/shows` for unticketed rooms; defaults to the Main Show. */
  playlistId?: string;
  log?: (msg: string) => void;
  /** Results reporting for matchmade shows. */
  results?: ResultsSink | null;
  /** Team assignments for team voice (see `voiceTeams.ts`). */
  voiceTeams?: VoiceTeamsSink | null;
  /**
   * The `mutators.chaos` kill switch, read when each show starts: false plays
   * mutator playlists (Chaos Mode) without their twist. Default: on.
   */
  mutatorsEnabled?: () => boolean;
}

/**
 * Estimated rounds in a show: replays the director's final-round rule with
 * the playlist's shrink curve (the real count depends on live results).
 */
function estimateRoundCount(p: ShowPlaylist, players: number): number {
  let n = players;
  for (let i = 0; i < p.maxRounds; i++) {
    if (n <= 2 || i >= p.maxRounds - 1 || (n <= p.finalAtOrBelow && i >= p.minRounds - 1)) return i + 1;
    n = Math.max(2, Math.round(n * (p.qualifyCurve[i] ?? 0.65)));
  }
  return p.maxRounds;
}

/**
 * The playlist a match plays. A custom lobby's host-picked rounds become the
 * pool (finals from the base playlist are kept when none was picked, so the
 * show can still end on a final).
 */
export function playlistForMatch(
  defaultId: string | undefined,
  match: MatchSettings | null | undefined,
): ShowPlaylist {
  const id = match?.custom?.playlistId ?? match?.playlistId ?? defaultId;
  const base = ShowPlaylistSchema.parse((id && getPlaylist(id)) || MAIN_SHOW);
  const picks = (match?.custom?.rounds ?? []).filter((r) => getRound(r));
  if (picks.length === 0) return base;
  const pickedFinal = picks.some((r) => getRound(r)?.type === 'final');
  const finals = pickedFinal ? [] : base.pool.filter((e) => getRound(e.roundId)?.type === 'final');
  const firstType = getRound(picks[0]!)?.type;
  const count = Math.max(1, picks.length + (pickedFinal ? 0 : 1));
  return {
    ...base,
    id: `${base.id}-custom`,
    pool: [...picks.map((roundId) => ({ roundId, weight: 1 })), ...finals],
    minRounds: Math.min(base.minRounds, count),
    maxRounds: count,
    ...(firstType && firstType !== 'final' ? { firstRoundType: firstType } : {}),
  };
}

/**
 * Director options from a custom lobby's settings: the round timer multiplier
 * and the pre-show countdown. Values are clamped to the matchmaker's own
 * validation ranges (0.5–2, 0–120 s) in case a ticket was minted by an older
 * matchmaker.
 *
 * @param match - The room's match settings.
 * @returns Partial controller options (empty for public queues).
 * @example
 * new ShowDirectorController({ playlist, rounds, ...customShowOptions(match) });
 */
export function customShowOptions(
  match: MatchSettings | null | undefined,
): Pick<ShowDirectorControllerOptions, 'roundTimeScale' | 'timings'> {
  const c = match?.custom;
  if (!c) return {};
  const out: Pick<ShowDirectorControllerOptions, 'roundTimeScale' | 'timings'> = {};
  if (typeof c.roundTimeScale === 'number' && Number.isFinite(c.roundTimeScale))
    out.roundTimeScale = Math.min(2, Math.max(0.5, c.roundTimeScale));
  if (typeof c.lobbyCountdownSec === 'number' && Number.isFinite(c.lobbyCountdownSec))
    out.timings = { preShow: Math.min(120, Math.max(0, Math.round(c.lobbyCountdownSec))) };
  return out;
}

/**
 * Builds {@link RoomDeps} backed by the real game.
 *
 * @example
 * const deps = createRealRoomDeps(await loadRapier(), { playlistId: 'main-show' });
 */
export function createRealRoomDeps(R: Rapier, opts: RealDepsOptions = {}): RoomDeps {
  const matchDeps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
  const rounds = showRoundCatalog();
  return {
    R,
    createMatchSim: (o) => createMatchSim(o, matchDeps),
    loadRound: (id) => {
      const round = getRound(id);
      if (!round) throw new Error(`Unknown round "${id}"`);
      return round;
    },
    createShowController: ({ match }) =>
      new ShowDirectorController({
        playlist: playlistForMatch(opts.playlistId, match),
        rounds,
        ...customShowOptions(match),
        ...(opts.mutatorsEnabled?.() === false ? { mutatorId: null } : {}),
      }),
    lobbyRound: PRE_SHOW_LOBBY_ROUND,
    describePlaylist: (playlistId, players) => {
      const p = ShowPlaylistSchema.parse(
        (playlistId && getPlaylist(playlistId)) ||
          (opts.playlistId && getPlaylist(opts.playlistId)) ||
          MAIN_SHOW,
      );
      return { id: p.id, name: p.name, roundCount: estimateRoundCount(p, players) };
    },
    // The real match sim runs its own bot brains.
    createBot: null,
    now: () => performance.now(),
    randomSeed: () => randomInt(0, 2 ** 31),
    results: opts.results ?? null,
    voiceTeams: opts.voiceTeams ?? null,
    ...(opts.log ? { log: opts.log } : {}),
  };
}
