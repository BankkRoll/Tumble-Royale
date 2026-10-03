import type { RoundDefinitionInput } from '@tumble/shared';
import gooPeakFinal from './goo-peak-final/index.ts';
import jumpRopeRoyale from './jump-rope-royale/index.ts';
import lastTumblerStanding from './last-tumbler-standing/index.ts';
import risingGooTower from './rising-goo-tower/index.ts';
import tilePanic from './tile-panic/index.ts';

/** Rounds authored by level-builder group 3. */
export const ROUNDS_GROUP_3: RoundDefinitionInput[] = [
  tilePanic,
  risingGooTower,
  jumpRopeRoyale,
  lastTumblerStanding,
  gooPeakFinal,
];
