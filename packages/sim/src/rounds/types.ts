/**
 * Round rule contracts. A {@link RoundRules} instance decides who qualifies and
 * who is eliminated for one round; the match sim (its {@link RulesHost}) feeds
 * it gameplay facts (finish crossings, falls, triggers, obstacle events) and
 * applies the fates it decides.
 *
 * Rules never touch Rapier or controllers directly, which keeps them unit
 * testable with a plain fake host.
 */
import type { Rng, RoundDefinition, TriggerDef, Vec3 } from '@tumble/shared';
import type { EventSink, SimEvent } from '../events.ts';
import type { PlayerRoundStatusId } from '../match/types.ts';

/** How a round decides qualification (mirrors `RoundDefinition.qualification.mode`). */
export type QualificationMode = RoundDefinition['qualification']['mode'];

/** What happens to a player who fell out of the level. */
export type FallVerdict = 'respawn' | 'eliminate';

/**
 * Mutable per-player bookkeeping shared by the host and the rules. The host
 * owns the array; rules read it and change fates only through the host.
 */
export interface RulesPlayer {
  readonly id: number;
  /** Team index for team rounds, else -1. */
  team: number;
  readonly isBot: boolean;
  status: PlayerRoundStatusId;
  /** Round score: team contribution, hold time, etc. */
  score: number;
  /** Course progress 0–1 (races, crown climbs) or survival fraction. */
  progress: number;
  /** Final place within the round (1 = best), 0 while undecided. */
  place: number;
  /** Tick at which the finish line was crossed, -1 if not. */
  finishTick: number;
  /** Fraction of the step [0, 1) at which the finish line was crossed. */
  finishSubTick: number;
  /** Holding the round item (tail, key) in hunt rounds. */
  hasItem: boolean;
  /** Tick of the last score change; earlier is better on ties. */
  scoreTick: number;
  /** Highest checkpoint index reached. */
  checkpoint: number;
  /** World position, refreshed by the host every step. */
  readonly pos: Vec3;
  /** Left the show or failed to load; treated as eliminated at the next decision. */
  forfeited: boolean;
}

/** The match sim as seen by round rules. */
export interface RulesHost {
  readonly round: RoundDefinition;
  readonly players: readonly RulesPlayer[];
  readonly events: EventSink;
  readonly tick: number;
  /** Seconds since PLAYING began. */
  readonly time: number;
  /** Seconds left on the clock including overtime; -1 if untimed. */
  readonly timeLeft: number;
  readonly inOvertime: boolean;
  /** Seeded generator for rule-level randomness (initial tail holders). */
  readonly rng: Rng;
  /** Number of players who started the round. */
  readonly entrants: number;
  playerById(id: number): RulesPlayer | undefined;
  /** Marks `p` qualified with the next best place and emits `qualified`. No-op unless Playing. */
  qualify(p: RulesPlayer): void;
  /** Marks `p` eliminated with the next worst place and emits `eliminated`. No-op unless Playing. */
  eliminate(p: RulesPlayer): void;
  /** Gives or takes the round item (tail), keeping character flags in sync. */
  setHasItem(p: RulesPlayer, has: boolean): void;
  /**
   * Asks to enter OVERTIME.
   *
   * @returns False when the round has no overtime or is already in it.
   */
  requestOvertime(): boolean;
  /**
   * Adds the team points currently held by obstacles (painted floor, golden
   * eggs resting in nests) into `out`, indexed by team. Optional: hosts
   * without such obstacles may omit it.
   *
   * @returns True when at least one obstacle contributes.
   */
  obstacleTeamScores?(out: number[]): boolean;
}

/**
 * Optional obstacle runtime extension: a mechanic whose state is worth team
 * points (paint grids, nest bonuses). Read every step by team rules through
 * {@link RulesHost.obstacleTeamScores}; the points are a live level, not a
 * stream of `score` events, so painting does not spam horns.
 */
export interface TeamScoreSource {
  /** Adds this obstacle's current points per team into `out` (index = team). */
  addTeamScores(out: number[]): void;
}

/** Tunables that do not live in the round definition. */
export interface RoundRulesOptions {
  /** Overrides the computed qualification target (the show director's shrink curve). */
  qualifyTarget?: number;
  /** Survival-like modes end early once survivors drop to the target. Default true. */
  endEarlyAtQuota?: boolean;
  /** Hunt rounds: `holdAtEnd` (whoever holds at the buzzer) or `scoreOverTime`. Default `holdAtEnd`. */
  holdItemScoring?: 'holdAtEnd' | 'scoreOverTime';
  /** Team rounds: points per second for every player standing in their team's zone. */
  zonePointsPerSecond?: number;
}

/**
 * One round's qualification logic. Created per round by `createRoundRules`.
 * Every callback runs inside the authoritative step, in a fixed order, so the
 * rules are deterministic as long as their inputs are.
 */
export interface RoundRules {
  readonly mode: QualificationMode;
  /** Players expected to qualify (1 for finals). */
  readonly qualifyTarget: number;
  /** True once every entrant's fate is decided. */
  readonly finished: boolean;
  /** Team totals for team rounds, else empty. */
  readonly teamScores: readonly number[];
  /** Called once before the countdown (assign tails, reset scores). */
  init(host: RulesHost): void;
  /** Called once when PLAYING starts. */
  start(): void;
  /** A player fell below killY / into a void / touched a lethal surface. */
  onFellOut(p: RulesPlayer): FallVerdict;
  /** A player crossed a finish trigger; calls arrive sorted by sub-tick within a step. */
  onFinishLine(p: RulesPlayer, tick: number, subTick: number): void;
  /** A player entered or left a round trigger (checkpoint, zone, goal, nest, crown). */
  onTrigger(p: RulesPlayer, trigger: TriggerDef, entered: boolean): void;
  /** A non-player collider (prop) entered or left a round trigger. `propKey` is stable per prop. */
  onPropTrigger(trigger: TriggerDef, propKey: number, entered: boolean): void;
  /** Gameplay events emitted this step by obstacles and controllers (scores, grabs, props). */
  onEvent(e: SimEvent): void;
  /** Per-step update while PLAYING/OVERTIME: timers, time-up and quota checks. */
  update(dt: number): void;
  /** A player left mid-round. */
  onForfeit(p: RulesPlayer): void;
}
