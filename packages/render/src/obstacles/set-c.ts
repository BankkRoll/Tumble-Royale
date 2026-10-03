/**
 * Visuals for obstacle set C (round-specific mechanics): the paint plaza grid,
 * the Pattern Panic board and screen, and team goals / egg nests.
 */
import { goalZoneVisual } from './goalZone.ts';
import { paintGridVisual } from './paintGrid.ts';
import { patternBoardVisual } from './patternBoard.ts';
import type { ObstacleVisualSet } from './types.ts';

/** Set C visual factories keyed by obstacle type. */
export const obstacleVisualSetC: ObstacleVisualSet = {
  paintGrid: paintGridVisual,
  patternBoard: patternBoardVisual,
  goalZone: goalZoneVisual,
};
