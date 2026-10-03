/**
 * Final-round rules. A final always crowns exactly one player:
 *
 * - {@link LastStandingRules}: every fall eliminates; the last survivor wins.
 * - {@link CrownGrabRules}: first to the crown wins; closest climber at the buzzer.
 *
 * Both defer fall eliminations to the end of the step ({@link SameStepFalls}),
 * so when the last players all drop in the same tick (a shared plunge, goo
 * swallowing a huddle) the height tiebreak picks a winner instead of the round
 * ending with nobody qualified.
 */
import type { TriggerDef } from '@tumble/shared';
import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { FallVerdict, RulesHost, RulesPlayer } from './types.ts';

/** Ranks by height, then standing; the tiebreak when a final times out with several survivors. */
function byHeight(a: RulesPlayer, b: RulesPlayer): number {
  if (a.pos.y !== b.pos.y) return b.pos.y - a.pos.y;
  if (a.progress !== b.progress) return b.progress - a.progress;
  return a.id - b.id;
}

/**
 * Collects the players who fell during one step and decides their fate once
 * the step's falls are all in.
 *
 * The host eliminates on an `'eliminate'` verdict immediately, in slot order,
 * so the last player processed would otherwise take the "last one falling"
 * spot by array index alone and, worse, the round would end with zero
 * survivors. Falls are instead answered with `'respawn'` (the host parks the
 * body for the respawn delay) and resolved in the same step's `update`, long
 * before any respawn could fire.
 */
class SameStepFalls {
  private readonly players: RulesPlayer[] = [];
  /** Height at the moment of the fall; `pos` keeps moving until resolution. */
  private readonly heights: number[] = [];
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(p: RulesPlayer): void {
    for (let i = 0; i < this.count; i++) if (this.players[i] === p) return;
    this.players[this.count] = p;
    this.heights[this.count] = p.pos.y;
    this.count++;
  }

  /**
   * Eliminates every pending faller. When nobody else is still standing, the
   * best of them (highest at the fall, then progress, then lowest id) wins
   * instead.
   *
   * @returns The crowned faller, if one was needed.
   */
  resolve(host: RulesHost): RulesPlayer | undefined {
    const n = this.count;
    if (n === 0) return undefined;
    this.count = 0;
    // Insertion sort, best first: n is tiny and this avoids a closure allocation.
    for (let i = 1; i < n; i++) {
      const p = this.players[i] as RulesPlayer;
      const h = this.heights[i] as number;
      let j = i - 1;
      while (j >= 0 && this.better(p, h, this.players[j] as RulesPlayer, this.heights[j] as number)) {
        this.players[j + 1] = this.players[j] as RulesPlayer;
        this.heights[j + 1] = this.heights[j] as number;
        j--;
      }
      this.players[j + 1] = p;
      this.heights[j + 1] = h;
    }
    let standing = 0;
    for (const p of host.players) if (p.status === PlayerRoundStatus.Playing) standing++;
    const crownOne = standing === n;
    for (let i = n - 1; i >= (crownOne ? 1 : 0); i--) host.eliminate(this.players[i] as RulesPlayer);
    const winner = crownOne ? (this.players[0] as RulesPlayer) : undefined;
    if (winner) host.qualify(winner);
    return winner;
  }

  clear(): void {
    this.players.length = 0;
    this.heights.length = 0;
    this.count = 0;
  }

  private better(a: RulesPlayer, ah: number, b: RulesPlayer, bh: number): boolean {
    if (ah !== bh) return ah > bh;
    if (a.progress !== b.progress) return a.progress > b.progress;
    return a.id < b.id;
  }
}

/**
 * Last-one-standing final: every fall eliminates; the final survivor wins.
 * Players falling together on the last tick are separated by the height
 * tiebreak. At the buzzer (after overtime, if the round has any) the highest
 * survivor wins so the show always crowns exactly one player.
 */
export class LastStandingRules extends BaseRules {
  readonly mode = 'lastStanding' as const;
  private readonly falls = new SameStepFalls();

  override init(host: RulesHost): void {
    super.init(host);
    this.falls.clear();
  }

  override onFellOut(p: RulesPlayer): FallVerdict {
    // A solo final (practice, dev pages) has nobody to out-last; a fall is just a loss.
    if (this.host.entrants <= 1) return 'eliminate';
    this.falls.add(p);
    return 'respawn';
  }

  protected override tickRules(): void {
    if (this.falls.resolve(this.host)) {
      this.eliminateRemaining();
      this.finishRound();
      return;
    }
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
 * `fallBehavior` (crown climbs respawn at checkpoints; with `eliminate`, the
 * same same-tick tiebreak as {@link LastStandingRules} applies). If nobody
 * reaches the crown in time, the player closest to it wins.
 */
export class CrownGrabRules extends BaseRules {
  readonly mode = 'crownGrab' as const;
  private readonly falls = new SameStepFalls();

  override init(host: RulesHost): void {
    super.init(host);
    this.falls.clear();
  }

  override onFellOut(p: RulesPlayer): FallVerdict {
    const verdict = super.onFellOut(p);
    if (verdict !== 'eliminate' || this.host.entrants <= 1) return verdict;
    this.falls.add(p);
    return 'respawn';
  }

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
    if (this.falls.resolve(this.host)) {
      this.eliminateRemaining();
      this.finishRound();
      return;
    }
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
