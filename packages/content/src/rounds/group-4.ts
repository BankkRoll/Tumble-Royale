import type { RoundDefinitionInput } from '@tumble/shared';
import bounceBallBlitz from './bounce-ball-blitz/index.ts';
import eggHeist from './egg-heist/index.ts';
import paintThePlaza from './paint-the-plaza/index.ts';
import patternPanic from './pattern-panic/index.ts';
import tailChase from './tail-chase/index.ts';

/** Rounds authored by level-builder group 4: the team, hunt and logic rounds. */
export const ROUNDS_GROUP_4: RoundDefinitionInput[] = [
  eggHeist,
  bounceBallBlitz,
  paintThePlaza,
  tailChase,
  patternPanic,
];
