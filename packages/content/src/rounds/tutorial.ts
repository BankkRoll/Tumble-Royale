/**
 * Tutorial round registry. Practice Island is registered here instead of in
 * `ROUNDS`, so it never enters the show catalog, round pickers or bot
 * measurement sweeps; its id is also in `DEV_ROUND_IDS` as a second guard.
 */
import { RoundDefinitionSchema, type RoundDefinition, type RoundDefinitionInput } from '@tumble/shared';
import practiceIsland from './practice-island/round.ts';

export {
  COACH_PODIUM,
  FALL_BOARD,
  ISLAND,
  PRACTICE_SPAWN,
  PRACTICE_STATIONS,
  RACE_SECONDS,
  RACE_SPAWN,
  type PracticeStation,
  type PracticeStationId,
  type ZoneBox,
} from './practice-island/layout.ts';

/** Practice Island as authored. */
export const TUTORIAL_ROUND_INPUT: RoundDefinitionInput = practiceIsland;

/**
 * Practice Island, validated (schema defaults applied).
 *
 * @example
 * import { TUTORIAL_ROUND } from '@tumble/content/rounds/practice-island';
 * createMatchSim({ R, round: TUTORIAL_ROUND, ... }, deps);
 */
export const TUTORIAL_ROUND: RoundDefinition = RoundDefinitionSchema.parse(practiceIsland);
