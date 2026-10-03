/**
 * Obstacle set A: the sixteen "core" obstacles (spinners, hammers, punches,
 * doors, belts, hinged platforms, fans, pads, tiles, slime, boulders, discs
 * and moving platforms). The integrator merges this with set B into the
 * registry in `obstacles/index.ts`.
 */
import { bouncePad } from './bouncePad.ts';
import { boulderLane } from './boulderLane.ts';
import { bumperPillar } from './bumperPillar.ts';
import { conveyorBelt } from './conveyorBelt.ts';
import { doorGauntlet } from './doorGauntlet.ts';
import { fallingTiles } from './fallingTiles.ts';
import { fanZone } from './fanZone.ts';
import { movingPlatform } from './movingPlatform.ts';
import { pendulumHammer } from './pendulumHammer.ts';
import { punchWall } from './punchWall.ts';
import { risingSlime } from './risingSlime.ts';
import { seesaw } from './seesaw.ts';
import { spinningDisc } from './spinningDisc.ts';
import { spinwheel } from './spinwheel.ts';
import { sweeperArm } from './sweeperArm.ts';
import { tiltPlatform } from './tiltPlatform.ts';
import type { ObstacleModule } from './types.ts';

export * from './helpers-a.ts';
export * from './bouncePad.ts';
export * from './boulderLane.ts';
export * from './bumperPillar.ts';
export * from './conveyorBelt.ts';
export * from './doorGauntlet.ts';
export * from './fallingTiles.ts';
export * from './fanZone.ts';
export * from './movingPlatform.ts';
export * from './pendulumHammer.ts';
export * from './punchWall.ts';
export * from './risingSlime.ts';
export * from './seesaw.ts';
export * from './spinningDisc.ts';
export * from './spinwheel.ts';
export * from './sweeperArm.ts';
export * from './tiltPlatform.ts';

/**
 * Every set-A module.
 *
 * `ObstacleModule<P>` is invariant in `P` (P appears in both `schema` output
 * and `create`/`pose` inputs), so no single concrete P fits all sixteen param
 * types. Consumers always look modules up by `type` and pass params through
 * the module's own `schema.parse`, which restores type safety at the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry, see above.
export const obstacleSetA: ObstacleModule<any>[] = [
  spinwheel,
  pendulumHammer,
  sweeperArm,
  bumperPillar,
  punchWall,
  doorGauntlet,
  conveyorBelt,
  tiltPlatform,
  seesaw,
  fanZone,
  bouncePad,
  fallingTiles,
  risingSlime,
  boulderLane,
  spinningDisc,
  movingPlatform,
];
