/**
 * Obstacle library registry. Merges both obstacle sets into one lookup used by
 * the match sim, bots and the level tools.
 */
import { obstacleSetA } from './set-a.ts';
import { obstacleSetB } from './set-b.ts';
import { obstacleSetC } from './set-c.ts';
import type { ObstacleModule, ObstacleType } from './types.ts';

export * from './types.ts';
export * from './set-a.ts';
export * from './set-b.ts';
export * from './set-c.ts';

/**
 * Every obstacle module in the library.
 *
 * Params are heterogeneous per module, so the list is typed loosely; each
 * module validates its own params with its zod schema at build time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment: per-module params differ
export const ALL_OBSTACLES: readonly ObstacleModule<any>[] = [
  ...obstacleSetA,
  ...obstacleSetB,
  ...obstacleSetC,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same heterogeneous param types as above
const byType = new Map<string, ObstacleModule<any>>(ALL_OBSTACLES.map((m) => [m.type, m]));

/**
 * Looks up an obstacle module by type id.
 *
 * @returns The module, or `undefined` for unknown types (round data may be newer than the client).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers parse params via the module schema
export function getObstacleModule(type: ObstacleType | string): ObstacleModule<any> | undefined {
  return byType.get(type);
}

/** The obstacle lookup map, in the shape `MatchDeps.obstacles` expects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous params, validated per module
export const OBSTACLE_REGISTRY: ReadonlyMap<string, ObstacleModule<any>> = byType;
