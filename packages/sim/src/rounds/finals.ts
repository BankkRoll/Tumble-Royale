import type { TriggerDef } from '@tumble/shared';
import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { FallVerdict, RulesPlayer } from './types.ts';

/** Ranks by height, then standing; the tiebreak when a final times out with several survivors. */
function byHeight(a: RulesPlayer, b: RulesPlayer): number {
  if (a.pos.y !== b.pos.y) return b.pos.y - a.pos.y;
  if (a.progress !== b.progress) return b.progress - a.progress;
  return a.id - b.id;
}

/**
 * Last-one-standing final: every fall eliminates; the final survivor wins.
 * At the buzzer (after overtime, if the round has any) the highest survivor
 * wins so the show always crowns exactly one player.
 */
export class LastStandingRules extends BaseRules {
  readonly mode = 'lastStanding' as const;

  override onFellOut(_p: RulesPlayer): FallVerdict {
    return 'eliminate';
  }

  protected override tickRules(): void {
    const alive = this.countStatus(PlayerRoundStatus.Playing);
    if (alive === 0) {
      this.finishRound();
    } else if (alive === 1 && this.host.entrants > 1) {
      this.qualifyRemaining();
      this.finishRound();
    }
  }

  protected override wantsOvertime(): boolean {
    return this.countStatus(PlayerRoundStatus.Playing) > 1;
  }

  protected onTimeUp(): void {
    const list = this.playingSorted(byHeight);
    const winner = list[0];
    if (!winner) return;
    for (let i = list.length - 1; i >= 1; i--) this.host.eliminate(list[i] as RulesPlayer);
    this.host.qualify(winner);
  }
}

/**
 * Crown-grab final: the first player to touch the `crown` trigger wins and
 * everyone else is eliminated by course progress. Falls follow the round's
 * `fallBehavior` (crown climbs respawn at checkpoints). If nobody reaches the
 * crown in time, the player closest to it wins.
 */
export class CrownGrabRules extends BaseRules {
  readonly mode = 'crownGrab' as const;

  override onTrigger(p: RulesPlayer, trigger: TriggerDef, entered: boolean): void {
    if (trigger.kind === 'crown' && entered) this.crown(p);
  }

  override onFinishLine(p: RulesPlayer, tick: number, subTick: number): void {
    // Rounds may author the crown pedestal as a finish trigger; treat it the same.
    p.finishTick = tick;
    p.finishSubTick = subTick;
    this.crown(p);
  }

  protected override tickRules(): void {
    const alive = this.countStatus(PlayerRoundStatus.Playing);
    if (alive === 0) this.finishRound();
    else if (alive === 1 && this.host.entrants > 1 && this.host.round.fallBehavior === 'eliminate') {
      this.qualifyRemaining();
      this.finishRound();
    }
  }

  protected onTimeUp(): void {
    const list = this.playingSorted();
    const winner = list[0];
    if (!winner) return;
    for (let i = list.length - 1; i >= 1; i--) this.host.eliminate(list[i] as RulesPlayer);
    this.host.qualify(winner);
  }

  private crown(p: RulesPlayer): void {
    if (this.finished || p.status !== PlayerRoundStatus.Playing) return;
    p.progress = 1;
    this.host.qualify(p);
    this.eliminateRemaining();
    this.finishRound();
  }
}
