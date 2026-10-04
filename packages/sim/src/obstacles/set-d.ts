/**
 * Obstacle set D: the mechanics behind the hunt, logic and final rounds added
 * after launch.
 *
 * - `cometField` — Comet Catch's hopping comets (individual pickups).
 * - `sunbeamZones` — Sunbeam Squabble's drifting scoring zones.
 * - `puzzleFloor` — the Colour Cauldron and Trail Tracer puzzle boards.
 * - `throneFloor` — Throne Rush's rising thrones and opening floor.
 */
import { cometField } from './cometField.ts';
import { puzzleFloor } from './puzzleFloor.ts';
import { sunbeamZones } from './sunbeamZones.ts';
import { throneFloor } from './throneFloor.ts';
import type { ObstacleModule } from './types.ts';

export * from './cometField.ts';
export * from './puzzleFloor.ts';
export * from './sunbeamZones.ts';
export * from './throneFloor.ts';

/**
 * Set D modules. Params differ per module and each validates its own via zod,
 * so the shared array is typed loosely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous params, validated per module
export const obstacleSetD: ObstacleModule<any>[] = [cometField, sunbeamZones, puzzleFloor, throneFloor];
