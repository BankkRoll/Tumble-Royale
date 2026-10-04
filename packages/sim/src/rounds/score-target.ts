import type { SimEvent } from '../events.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { RulesHost, RulesPlayer } from './types.ts';

/** Points to bank when a score-target round does not set `qualification.scoreGoal`. */
export const DEFAULT_SCORE_GOAL = 5;

/**
 * Score-target hunt rules: obstacles hand out individual points (`score`
 * events with `team: -1`: a comet caught, a second spent in a sunbeam) and the
 * first players to bank the round's `scoreGoal` qualify, in the order they
 * reached it, like a race. Once the quota fills, everyone still playing is
 * eliminated by score.
 *
 * When the clock runs out first, the best scores still playing take the
 * remaining spots (earlier last point wins ties), so the round always
 * qualifies exactly its target. Falls follow the round's `fallBehavior`.
 */
export class ScoreTargetRules extends BaseRules {
  readonly mode = 'scoreTarget' as const;
  private qualified = 0;
  private goal = 1;

  override init(host: RulesHost): void {
    super.init(host);
    this.qualified = 0;
    this.goal = Math.max(1, host.round.qualification.scoreGoal ?? DEFAULT_SCORE_GOAL);
  }

  override onEvent(e: SimEvent): void {
    if (e.type !== 'score' || e.team >= 0 || this.finished) return;
    const p = this.host.playerById(e.player);
    if (!p || p.status !== PlayerRoundStatus.Playing) return;
    p.score += e.delta;
    p.scoreTick = this.host.tick;
    p.progress = Math.min(1, Math.max(0, p.score / this.goal));
    if (p.score < this.goal) return;
    p.finishTick = this.host.tick;
    this.host.qualify(p);
    this.qualified++;
    if (this.qualified >= this.qualifyTarget) {
      this.eliminateRemaining(byScore);
      this.finishRound();
    }
  }

  protected override tickRules(): void {
    this.checkDone();
  }

  protected onTimeUp(): void {
    const list = this.playingSorted(byScore);
    const spots = this.qualifyTarget - this.qualified;
    for (let i = 0; i < list.length && i < spots; i++) this.host.qualify(list[i] as RulesPlayer);
    this.eliminateRemaining(byScore);
  }
}

/** Higher score first, then whoever reached it earlier, then lower id. */
function byScore(a: RulesPlayer, b: RulesPlayer): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.scoreTick !== b.scoreTick) return a.scoreTick - b.scoreTick;
  return a.id - b.id;
}
