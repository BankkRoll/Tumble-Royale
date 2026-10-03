import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { FallVerdict, RulesPlayer } from './types.ts';

/**
 * Survival rules (also used for logic rounds, where the obstacle drops the
 * wrong tiles and the fall does the rest): anyone who falls is eliminated;
 * whoever is still standing when the timer ends qualifies.
 *
 * With `endEarlyAtQuota` (default), the round ends as soon as survivors drop to
 * the qualification target, so a brutal round never eliminates more than the
 * show's shrink curve wants.
 */
export class SurviveRules extends BaseRules {
  constructor(
    readonly mode: 'survive' | 'logicSurvive',
    qualifyTarget: number,
    options: ConstructorParameters<typeof BaseRules>[1],
  ) {
    super(qualifyTarget, options);
  }

  override onFellOut(_p: RulesPlayer): FallVerdict {
    return 'eliminate';
  }

  protected override tickRules(): void {
    const alive = this.countStatus(PlayerRoundStatus.Playing);
    if (alive === 0) {
      this.finishRound();
      return;
    }
    if ((this.options.endEarlyAtQuota ?? true) && alive <= this.qualifyTarget) {
      this.qualifyRemaining();
      this.finishRound();
    }
  }

  protected onTimeUp(): void {
    this.qualifyRemaining();
  }
}
