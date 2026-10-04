import type { RoundDefinition } from '@tumble/shared';
import { CrownGrabRules, LastStandingRules } from './finals.ts';
import { FinishRules } from './finish.ts';
import { HoldItemRules } from './hold-item.ts';
import { computeQualifyTarget } from './quota.ts';
import { ScoreTargetRules } from './score-target.ts';
import { SurviveRules } from './survive.ts';
import { TeamScoreRules } from './team-score.ts';
import type { RoundRules, RoundRulesOptions } from './types.ts';

/**
 * Builds the rule set for a round's qualification mode.
 *
 * @param round - Validated round definition.
 * @param entrants - Players starting the round.
 * @param options - Show-level overrides (qualify target, variants).
 * @returns Fresh rules; call `init(host)` before use.
 * @example
 * const rules = createRoundRules(round, 40, { qualifyTarget: 26 });
 */
export function createRoundRules(
  round: RoundDefinition,
  entrants: number,
  options: RoundRulesOptions = {},
): RoundRules {
  const target = computeQualifyTarget(round, entrants, options.qualifyTarget);
  switch (round.qualification.mode) {
    case 'finish':
      return new FinishRules(target, options);
    case 'survive':
    case 'logicSurvive':
      return new SurviveRules(round.qualification.mode, target, options);
    case 'teamScore':
      return new TeamScoreRules(target, options);
    case 'holdItem':
      return new HoldItemRules(target, options);
    case 'lastStanding':
      return new LastStandingRules(target, options);
    case 'crownGrab':
      return new CrownGrabRules(target, options);
    case 'scoreTarget':
      return new ScoreTargetRules(target, options);
  }
}
