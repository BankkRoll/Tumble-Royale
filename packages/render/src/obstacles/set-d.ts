/**
 * Visuals for obstacle set D (post-launch round mechanics): Comet Catch's
 * comets, Sunbeam Squabble's sunbeams, the Colour Cauldron / Trail Tracer
 * puzzle floor and screen, and Throne Rush's thrones and opening floor.
 */
import { cometFieldVisual } from './cometField.ts';
import { sunbeamZonesVisual } from './sunbeamZones.ts';
import type { ObstacleVisualSet } from './types.ts';

/** Set D visual factories keyed by obstacle type. */
export const obstacleVisualSetD: ObstacleVisualSet = {
  cometField: cometFieldVisual,
  sunbeamZones: sunbeamZonesVisual,
};
