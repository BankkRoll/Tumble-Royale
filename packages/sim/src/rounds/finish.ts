import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { RulesPlayer } from './types.ts';

/**
 * Race rules: players qualify in finish order (tick, then sub-tick). When the
 * quota fills, everyone still running is eliminated, ranked by course progress.
 * When the clock runs out, the unfinished are eliminated the same way. Falls
 * follow the round's `fallBehavior` (usually respawn at the last checkpoint).
 */
export class FinishRules extends BaseRules {
  readonly mode = 'finish' as const;
  private qualified = 0;

  override onFinishLine(p: RulesPlayer, tick: number, subTick: number): void {
    if (this.finished || p.status !== PlayerRoundStatus.Playing) return;
    p.finishTick = tick;
    p.finishSubTick = subTick;
    p.progress = 1;
    this.host.qualify(p);
    this.qualified++;
    if (this.qualified >= this.qualifyTarget) {
      this.eliminateRemaining();
      this.finishRound();
    } else {
      this.checkDone();
    }
  }

  protected override tickRules(): void {
    this.checkDone();
  }

  protected onTimeUp(): void {
    this.eliminateRemaining();
  }
}
