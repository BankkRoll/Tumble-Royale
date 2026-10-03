/**
 * Obstacle set B: surfaces (slide, ice, goo), timed hazards (pop-up blocks,
 * lasers, cannons, bumper carts, drums, crumble bridges, skip sweepers),
 * traversal (warp pads, climb walls), course flow (checkpoint, finish, start,
 * void) and replicated props.
 *
 * The integrator's obstacle registry spreads {@link obstacleSetB} into the
 * type → module map; the named re-exports give visuals, bots and tests access
 * to each module's pure helpers (pose, schedules, part lists).
 */
import { bumperCar } from './bumperCar.ts';
import { cannon } from './cannon.ts';
import { checkpointGate } from './checkpointGate.ts';
import { climbWall } from './climbWall.ts';
import { collapsingBridge } from './collapsingBridge.ts';
import { finishLine } from './finishLine.ts';
import { iceFloor } from './iceFloor.ts';
import { jumpRopeBeam } from './jumpRopeBeam.ts';
import { laserSweep } from './laserSweep.ts';
import { popupBlocks } from './popupBlocks.ts';
import { propSpawner } from './propSpawner.ts';
import { rollingDrum } from './rollingDrum.ts';
import { slideRamp } from './slideRamp.ts';
import { startGate } from './startGate.ts';
import { stickyGoo } from './stickyGoo.ts';
import { teleporterPair } from './teleporterPair.ts';
import { voidTrigger } from './voidTrigger.ts';
import type { ObstacleModule } from './types.ts';

export * from './slideRamp.ts';
export * from './iceFloor.ts';
export * from './stickyGoo.ts';
export * from './popupBlocks.ts';
export * from './laserSweep.ts';
export * from './cannon.ts';
export * from './bumperCar.ts';
export * from './rollingDrum.ts';
export * from './collapsingBridge.ts';
export * from './jumpRopeBeam.ts';
export * from './teleporterPair.ts';
export * from './climbWall.ts';
export * from './checkpointGate.ts';
export * from './finishLine.ts';
export * from './startGate.ts';
export * from './voidTrigger.ts';
export * from './propSpawner.ts';
export { archParts, type BoxPart } from './helpers-b.ts';

/**
 * Every set-B module.
 *
 * Typed `ObstacleModule<any>` because a heterogeneous list of modules cannot be
 * expressed with a single param type: `ObstacleModule<P>` is invariant in `P`
 * (P appears in both `schema` output and `create`/`pose` inputs), so neither
 * `unknown` nor a union would accept the concrete modules. Params are validated
 * by each module's own zod schema at create time, so the loose type never
 * reaches untyped data.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const obstacleSetB: ObstacleModule<any>[] = [
  slideRamp,
  iceFloor,
  stickyGoo,
  popupBlocks,
  laserSweep,
  cannon,
  bumperCar,
  rollingDrum,
  collapsingBridge,
  jumpRopeBeam,
  teleporterPair,
  climbWall,
  checkpointGate,
  finishLine,
  startGate,
  voidTrigger,
  propSpawner,
];
