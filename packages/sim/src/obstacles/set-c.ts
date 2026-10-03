/**
 * Obstacle set C: round-specific mechanics (paint grids, pattern boards, team
 * goals) added by the level builders.
 */
import type { ObstacleModule } from './types.ts';

/**
 * Set C modules. Params differ per module and each validates its own via zod,
 * so the shared array is typed loosely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous params, validated per module
export const obstacleSetC: ObstacleModule<any>[] = [];
