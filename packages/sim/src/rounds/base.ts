import { SIM_DT, type TriggerDef } from '@tumble/shared';
import type { SimEvent } from '../events.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import type {
  FallVerdict,
  QualificationMode,
  RoundRules,
  RoundRulesOptions,
  RulesHost,
  RulesPlayer,
} from './types.ts';

/**
 * Orders players best-first for batch fate decisions: finished players by
 * finish time, then higher score, higher progress, then lower id so the order
 * is total and deterministic.
 */
export function compareStanding(a: RulesPlayer, b: RulesPlayer): number {
  const af = a.finishTick >= 0;
  const bf = b.finishTick >= 0;
  if (af !== bf) return af ? -1 : 1;
  if (af && bf) {
    if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    if (a.finishSubTick !== b.finishSubTick) return a.finishSubTick - b.finishSubTick;
  }
  if (a.score !== b.score) return b.score - a.score;
  if (a.progress !== b.progress) return b.progress - a.progress;
  return a.id - b.id;
}

/**
 * Shared behaviour for every rule set: host wiring, time-up handling with
 * optional overtime, and helpers for batch qualification/elimination.
 */
export abstract class BaseRules implements RoundRules {
  abstract readonly mode: QualificationMode;
  finished = false;
  teamScores: number[] = [];
  protected host!: RulesHost;
  /** Length of the step being processed, for per-second accumulators. */
  protected dt = SIM_DT;
  /** Reused by batch helpers so deciding fates does not allocate per call. */
  private readonly scratch: RulesPlayer[] = [];

  constructor(
    readonly qualifyTarget: number,
    protected readonly options: RoundRulesOptions,
  ) {}

  init(host: RulesHost): void {
    this.host = host;
    this.finished = false;
  }

  start(): void {}

  onFellOut(_p: RulesPlayer): FallVerdict {
    return this.host.round.fallBehavior === 'eliminate' ? 'eliminate' : 'respawn';
  }

  onFinishLine(_p: RulesPlayer, _tick: number, _subTick: number): void {}

  onTrigger(_p: RulesPlayer, _trigger: TriggerDef, _entered: boolean): void {}

  onPropTrigger(_trigger: TriggerDef, _propKey: number, _entered: boolean): void {}

  onEvent(_e: SimEvent): void {}

  onForfeit(p: RulesPlayer): void {
    if (p.status === PlayerRoundStatus.Playing) this.host.eliminate(p);
    this.checkDone();
  }

  update(dt: number): void {
    if (this.finished) return;
    this.dt = dt;
    this.tickRules();
    if (this.finished) return;
    if (this.host.timeLeft === 0) {
      if (!this.host.inOvertime && this.wantsOvertime() && this.host.requestOvertime()) return;
      this.onTimeUp();
      this.finishRound();
    }
  }

  /** Per-step logic before the clock check. */
  protected tickRules(): void {}

  /** Whether running out of regular time should go to overtime instead of deciding. */
  protected wantsOvertime(): boolean {
    return false;
  }

  /** Decide everyone still playing when the clock runs out. */
  protected abstract onTimeUp(): void;

  /** Players still Playing, best first. Returns a shared scratch array. */
  protected playingSorted(
    compare: (a: RulesPlayer, b: RulesPlayer) => number = compareStanding,
  ): RulesPlayer[] {
    const out = this.scratch;
    out.length = 0;
    for (const p of this.host.players) if (p.status === PlayerRoundStatus.Playing) out.push(p);
    out.sort(compare);
    return out;
  }

  /** Eliminates every player still Playing, worst first so places count up correctly. */
  protected eliminateRemaining(compare?: (a: RulesPlayer, b: RulesPlayer) => number): void {
    const list = this.playingSorted(compare);
    for (let i = list.length - 1; i >= 0; i--) this.host.eliminate(list[i] as RulesPlayer);
  }

  /** Qualifies every player still Playing, best first. */
  protected qualifyRemaining(compare?: (a: RulesPlayer, b: RulesPlayer) => number): void {
    const list = this.playingSorted(compare);
    for (const p of list) this.host.qualify(p);
  }

  protected countStatus(status: number): number {
    let n = 0;
    for (const p of this.host.players) if (p.status === status) n++;
    return n;
  }

  protected finishRound(): void {
    this.finished = true;
  }

  /** Marks the round finished once nobody is left Playing. */
  protected checkDone(): void {
    if (!this.finished && this.countStatus(PlayerRoundStatus.Playing) === 0) this.finishRound();
  }
}
