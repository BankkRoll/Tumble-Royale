/**
 * Visual factories for obstacle set A. Each visual mirrors its sim module's
 * pure `pose()` (imported directly) and reads non-pure state (tiles, doors,
 * hinges, bounce timing) from the optional runtime.
 *
 * NOTE: visuals import sim modules by relative path because
 * `@tumble/sim/obstacles` (the registry index) is written by the integrator;
 * once it exists these imports can switch to the package sub-path.
 */
import type { ObstacleVisualSet } from './types.ts';
import { bouncePadVisual } from './bouncePad.ts';
import { boulderLaneVisual } from './boulderLane.ts';
import { bumperPillarVisual } from './bumperPillar.ts';
import { conveyorBeltVisual } from './conveyorBelt.ts';
import { doorGauntletVisual } from './doorGauntlet.ts';
import { fallingTilesVisual } from './fallingTiles.ts';
import { fanZoneVisual } from './fanZone.ts';
import { movingPlatformVisual } from './movingPlatform.ts';
import { pendulumHammerVisual } from './pendulumHammer.ts';
import { punchWallVisual } from './punchWall.ts';
import { risingSlimeVisual } from './risingSlime.ts';
import { seesawVisual } from './seesaw.ts';
import { spinningDiscVisual } from './spinningDisc.ts';
import { spinwheelVisual } from './spinwheel.ts';
import { sweeperArmVisual } from './sweeperArm.ts';
import { tiltPlatformVisual } from './tiltPlatform.ts';

export * from './visual-helpers-a.ts';
export {
  bouncePadVisual,
  boulderLaneVisual,
  bumperPillarVisual,
  conveyorBeltVisual,
  doorGauntletVisual,
  fallingTilesVisual,
  fanZoneVisual,
  movingPlatformVisual,
  pendulumHammerVisual,
  punchWallVisual,
  risingSlimeVisual,
  seesawVisual,
  spinningDiscVisual,
  spinwheelVisual,
  sweeperArmVisual,
  tiltPlatformVisual,
};

/** Set-A visual factories keyed by obstacle type. */
export const obstacleVisualSetA: ObstacleVisualSet = {
  spinwheel: spinwheelVisual,
  pendulumHammer: pendulumHammerVisual,
  sweeperArm: sweeperArmVisual,
  bumperPillar: bumperPillarVisual,
  punchWall: punchWallVisual,
  doorGauntlet: doorGauntletVisual,
  conveyorBelt: conveyorBeltVisual,
  tiltPlatform: tiltPlatformVisual,
  seesaw: seesawVisual,
  fanZone: fanZoneVisual,
  bouncePad: bouncePadVisual,
  fallingTiles: fallingTilesVisual,
  risingSlime: risingSlimeVisual,
  boulderLane: boulderLaneVisual,
  spinningDisc: spinningDiscVisual,
  movingPlatform: movingPlatformVisual,
};
