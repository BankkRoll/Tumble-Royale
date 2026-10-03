/**
 * Obstacle visual registry. Merges both visual sets into one factory lookup.
 */
import type { ObstacleType } from '@tumble/sim';
import { obstacleVisualSetA } from './set-a.ts';
import { obstacleVisualSetB } from './set-b.ts';
import { obstacleVisualSetC } from './set-c.ts';
import type { ObstacleVisualFactory, ObstacleVisualSet } from './types.ts';

export * from './types.ts';
export { obstacleVisualSetA } from './set-a.ts';
export { obstacleVisualSetB } from './set-b.ts';
export { obstacleVisualSetC } from './set-c.ts';

/** Every obstacle visual factory, keyed by obstacle type. */
export const OBSTACLE_VISUALS: ObstacleVisualSet = {
  ...obstacleVisualSetA,
  ...obstacleVisualSetB,
  ...obstacleVisualSetC,
};

/**
 * Looks up the visual factory for an obstacle type.
 *
 * @returns The factory, or `undefined` for invisible or unknown types.
 */
export function getObstacleVisual(type: ObstacleType | string): ObstacleVisualFactory | undefined {
  return OBSTACLE_VISUALS[type as ObstacleType];
}
