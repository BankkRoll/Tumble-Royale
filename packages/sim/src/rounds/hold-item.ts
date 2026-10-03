import type { SimEvent } from '../events.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { RulesHost, RulesPlayer } from './types.ts';

/** Seconds a fresh holder is protected from having the item snatched straight back. */
export const STEAL_COOLDOWN_SECONDS = 1;

/**
 * Hunt rules (tails, keys). A seeded subset of players starts holding the
 * item; grabbing a holder steals it.
 *
 * - `holdAtEnd` (default): whoever holds an item at the buzzer qualifies.
 * - `scoreOverTime`: every second held scores a point; the top
 *   `qualifyTarget` scorers qualify. Half as many items are handed out so
 *   there is something to chase.
 *
 * Hold time is tracked in `score` in both variants and breaks ties.
 */
export class HoldItemRules extends BaseRules {
  readonly mode = 'holdItem' as const;
  /** Tick at which each player (by index) last acquired the item. */
  private acquiredTick: number[] = [];

  override init(host: RulesHost): void {
    super.init(host);
    this.acquiredTick = new Array<number>(host.players.length).fill(-1e9);
    const ids = host.players.map((p) => p.id).sort((a, b) => a - b);
    host.rng.shuffle(ids);
    const items =
      this.scoring === 'scoreOverTime' ? Math.max(1, Math.floor(this.qualifyTarget / 2)) : this.qualifyTarget;
    for (let i = 0; i < ids.length; i++) {
      const p = host.playerById(ids[i] as number);
      if (p) host.setHasItem(p, i < items);
    }
  }

  private get scoring(): 'holdAtEnd' | 'scoreOverTime' {
    return this.options.holdItemScoring ?? 'holdAtEnd';
  }

  override onEvent(e: SimEvent): void {
    if (e.type !== 'grabStart' || e.targetKind !== 'player' || this.finished) return;
    const thief = this.host.playerById(e.player);
    const victim = this.host.playerById(e.target);
    if (!thief || !victim || thief.hasItem || !victim.hasItem) return;
    if (thief.status !== PlayerRoundStatus.Playing || victim.status !== PlayerRoundStatus.Playing) return;
    const vi = this.host.players.indexOf(victim);
    const cooldownTicks = Math.round(STEAL_COOLDOWN_SECONDS / this.dt);
    if (this.host.tick - (this.acquiredTick[vi] as number) < cooldownTicks) return;
    this.transfer(victim, thief);
  }

  override onForfeit(p: RulesPlayer): void {
    if (p.hasItem) {
      const heirs = this.host.players.filter(
        (q) => q !== p && !q.hasItem && q.status === PlayerRoundStatus.Playing,
      );
      this.host.setHasItem(p, false);
      if (heirs.length > 0) this.give(this.host.rng.pick(heirs));
    }
    super.onForfeit(p);
  }

  protected override tickRules(): void {
    for (const p of this.host.players) {
      if (p.hasItem && p.status === PlayerRoundStatus.Playing) {
        p.score += this.dt;
        p.scoreTick = this.host.tick;
      }
    }
    this.checkDone();
  }

  protected onTimeUp(): void {
    if (this.scoring === 'scoreOverTime') {
      const list = this.playingSorted();
      for (let i = 0; i < list.length && i < this.qualifyTarget; i++)
        this.host.qualify(list[i] as RulesPlayer);
      this.eliminateRemaining();
      return;
    }
    const holders = this.playingSorted(byHoldThenStanding);
    for (const p of holders) if (p.hasItem) this.host.qualify(p);
    this.eliminateRemaining();
  }

  private transfer(from: RulesPlayer, to: RulesPlayer): void {
    this.host.setHasItem(from, false);
    this.give(to);
  }

  private give(p: RulesPlayer): void {
    this.host.setHasItem(p, true);
    this.acquiredTick[this.host.players.indexOf(p)] = this.host.tick;
  }
}

function byHoldThenStanding(a: RulesPlayer, b: RulesPlayer): number {
  if (a.hasItem !== b.hasItem) return a.hasItem ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  return a.id - b.id;
}
