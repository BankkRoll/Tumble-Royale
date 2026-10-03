/**
 * Standalone room dependencies: the Rapier capsule stand-in sim, the dev arena
 * round, the single-round show loop and random-walk bots. Used until the
 * integrator wires the real `createMatchSim`, content rounds and ShowDirector
 * (see `main.ts`), and by load tests.
 */
import { randomInt } from 'node:crypto';
import { createCapsuleMatchSim, createDevRound } from '@tumble/netcode/dev';
import type { Rapier } from '@tumble/sim';
import { randomWalkBots } from './bots/randomWalkBot.ts';
import type { RoomDeps } from './room/types.ts';
import { SimpleShowController } from './show/SimpleShowController.ts';

/** Options for {@link createDevRoomDeps}. */
export interface DevDepsOptions {
  /** PLAYING length of each loop of the dev round (s). */
  playSeconds?: number;
  log?: (msg: string) => void;
}

/**
 * Builds {@link RoomDeps} that need nothing beyond Rapier.
 *
 * @example
 * const deps = createDevRoomDeps(await loadRapier(), { playSeconds: 90 });
 */
export function createDevRoomDeps(R: Rapier, opts: DevDepsOptions = {}): RoomDeps {
  const round = createDevRound();
  return {
    R,
    createMatchSim: createCapsuleMatchSim,
    loadRound: () => round,
    createShowController: () =>
      new SimpleShowController({ roundId: round.id, playSeconds: opts.playSeconds ?? 120 }),
    createBot: randomWalkBots,
    now: () => performance.now(),
    randomSeed: () => randomInt(0, 2 ** 31),
    ...(opts.log ? { log: opts.log } : {}),
  };
}
