import type { RoundDefinitionInput } from '@tumble/shared';
import conveyorChaos from './conveyor-chaos/index.ts';
import crownClimb from './crown-climb/index.ts';
import gumdropGauntlet from './gumdrop-gauntlet/index.ts';
import slipNSpiral from './slip-n-spiral/index.ts';
import tiltTown from './tilt-town/index.ts';

/** Rounds authored by level-builder group 1: R1–R4 and the F1 final. */
export const ROUNDS_GROUP_1: RoundDefinitionInput[] = [
  gumdropGauntlet,
  conveyorChaos,
  tiltTown,
  slipNSpiral,
  crownClimb,
];
