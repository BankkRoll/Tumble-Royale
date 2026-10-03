/**
 * Visual factories for obstacle set B. The obstacle gallery auto-loads this
 * file; the integrator merges {@link obstacleVisualSetB} into the renderer's
 * type → factory registry.
 */
import { bumperCarVisual } from './bumperCar.ts';
import { cannonVisual } from './cannon.ts';
import { checkpointGateVisual } from './checkpointGate.ts';
import { climbWallVisual } from './climbWall.ts';
import { collapsingBridgeVisual } from './collapsingBridge.ts';
import { finishLineVisual } from './finishLine.ts';
import { iceFloorVisual } from './iceFloor.ts';
import { jumpRopeBeamVisual } from './jumpRopeBeam.ts';
import { laserSweepVisual } from './laserSweep.ts';
import { popupBlocksVisual } from './popupBlocks.ts';
import { propSpawnerVisual } from './propSpawner.ts';
import { rollingDrumVisual } from './rollingDrum.ts';
import { slideRampVisual } from './slideRamp.ts';
import { startGateVisual } from './startGate.ts';
import { stickyGooVisual } from './stickyGoo.ts';
import { teleporterPairVisual } from './teleporterPair.ts';
import type { ObstacleVisualSet } from './types.ts';
import { voidTriggerVisual } from './voidTrigger.ts';

export {
  bumperCarVisual,
  cannonVisual,
  checkpointGateVisual,
  climbWallVisual,
  collapsingBridgeVisual,
  finishLineVisual,
  iceFloorVisual,
  jumpRopeBeamVisual,
  laserSweepVisual,
  popupBlocksVisual,
  propSpawnerVisual,
  rollingDrumVisual,
  slideRampVisual,
  startGateVisual,
  stickyGooVisual,
  teleporterPairVisual,
  voidTriggerVisual,
};

/** Set-B visual factories keyed by obstacle type. */
export const obstacleVisualSetB: ObstacleVisualSet = {
  slideRamp: slideRampVisual,
  iceFloor: iceFloorVisual,
  stickyGoo: stickyGooVisual,
  popupBlocks: popupBlocksVisual,
  laserSweep: laserSweepVisual,
  cannon: cannonVisual,
  bumperCar: bumperCarVisual,
  rollingDrum: rollingDrumVisual,
  collapsingBridge: collapsingBridgeVisual,
  jumpRopeBeam: jumpRopeBeamVisual,
  teleporterPair: teleporterPairVisual,
  climbWall: climbWallVisual,
  checkpointGate: checkpointGateVisual,
  finishLine: finishLineVisual,
  startGate: startGateVisual,
  voidTrigger: voidTriggerVisual,
  propSpawner: propSpawnerVisual,
};
