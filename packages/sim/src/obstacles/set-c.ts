/**
 * Obstacle set C: round-specific mechanics added by the level builders.
 *
 * - `paintGrid` — Paint the Plaza's paintable floor, rinse arms and buckets.
 * - `patternBoard` — Pattern Panic's symbol tiles, big-screen schedule and sweeper.
 * - `goalZone` — team goals (ball goals) and egg nests (bonus values, deposit cues).
 */
import { goalZone } from './goalZone.ts';
import { paintGrid } from './paintGrid.ts';
import { patternBoard } from './patternBoard.ts';
import type { ObstacleModule } from './types.ts';

export * from './goalZone.ts';
export * from './paintGrid.ts';
export * from './patternBoard.ts';

/**
 * Set C modules. Params differ per module and each validates its own via zod,
 * so the shared array is typed loosely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous params, validated per module
export const obstacleSetC: ObstacleModule<any>[] = [paintGrid, patternBoard, goalZone];
