import { GRAVITY_Y, SIM_DT } from '@tumble/shared';
import type { Rapier } from './rapier.ts';
import type { World } from '@dimforge/rapier3d-compat';

/** Options for {@link createWorld}. */
export interface WorldOptions {
  /** Gravity on Y in m/s². Defaults to {@link GRAVITY_Y}. */
  gravityY?: number;
  /** Fixed timestep in seconds. Defaults to {@link SIM_DT}. */
  dt?: number;
}

/**
 * Creates a Rapier world configured identically on client and server.
 *
 * @param R - The initialised Rapier namespace from `loadRapier()`.
 * @param opts - Optional overrides.
 * @returns A new physics world.
 */
export function createWorld(R: Rapier, opts: WorldOptions = {}): World {
  const world = new R.World({ x: 0, y: opts.gravityY ?? GRAVITY_Y, z: 0 });
  world.timestep = opts.dt ?? SIM_DT;
  return world;
}
