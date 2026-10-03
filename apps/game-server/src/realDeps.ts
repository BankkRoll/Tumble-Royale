/**
 * Production room dependencies: the real match simulation (Tumbler controller
 * + full obstacle library), the content round catalogue and the show director.
 */
import { randomInt } from 'node:crypto';
import { getPlaylist, MAIN_SHOW } from '@tumble/content/shows';
import { getRound, showRoundCatalog } from '@tumble/content/rounds';
import type { Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import type { RoomDeps } from './room/types.ts';
import { ShowDirectorController } from './show/ShowDirectorController.ts';

/** Options for {@link createRealRoomDeps}. */
export interface RealDepsOptions {
  /** Playlist id from `@tumble/content/shows`; defaults to the Main Show. */
  playlistId?: string;
  log?: (msg: string) => void;
}

/**
 * Builds {@link RoomDeps} backed by the real game.
 *
 * @example
 * const deps = createRealRoomDeps(await loadRapier(), { playlistId: 'main-show' });
 */
export function createRealRoomDeps(R: Rapier, opts: RealDepsOptions = {}): RoomDeps {
  const playlist = (opts.playlistId && getPlaylist(opts.playlistId)) || MAIN_SHOW;
  const matchDeps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
  return {
    R,
    createMatchSim: (o) => createMatchSim(o, matchDeps),
    loadRound: (id) => {
      const round = getRound(id);
      if (!round) throw new Error(`Unknown round "${id}"`);
      return round;
    },
    createShowController: () => new ShowDirectorController({ playlist, rounds: showRoundCatalog() }),
    // The real match sim runs its own bot brains.
    createBot: null,
    now: () => performance.now(),
    randomSeed: () => randomInt(0, 2 ** 31),
    ...(opts.log ? { log: opts.log } : {}),
  };
}
