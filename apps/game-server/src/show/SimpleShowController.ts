/**
 * Minimal built-in show flow so the server runs standalone: one round, played
 * on a loop — COUNTDOWN → PLAYING → ROUND_END → RESULTS → (next loop).
 * The match team's ShowDirector replaces this through {@link RoomDeps.createShowController}.
 */
import type { MatchPlayerInfo, PlayerRoundStatusId, RoundResultEntry } from '@tumble/netcode';
import { RoundPhase, ShowPhase, type RoundPhaseId, type ShowPhaseId } from '@tumble/shared';
import type { ShowController, ShowEvent, ShowRoundPlan, ShowTickContext } from '../room/types.ts';

/** Options for {@link SimpleShowController}. */
export interface SimpleShowOptions {
  /** Round played every loop. */
  roundId: string;
  /** PLAYING length before the round ends (unless the sim finishes it first). */
  playSeconds?: number;
  countdownSeconds?: number;
  roundEndSeconds?: number;
  resultsSeconds?: number;
  /** Loops before the show ends; Infinity for a dev server. */
  loops?: number;
}

/**
 * Single-round loop show controller.
 *
 * @example
 * createShowController: () => new SimpleShowController({ roundId: 'dev-arena', playSeconds: 120 })
 */
export class SimpleShowController implements ShowController {
  private phase: ShowPhaseId = ShowPhase.PreShow;
  private roundPhase: RoundPhaseId = RoundPhase.Loading;
  private phaseTime = 0;
  private plan: ShowRoundPlan | null = null;
  private players: MatchPlayerInfo[] = [];
  private seed = 0;
  private loop = 0;
  private readonly events: ShowEvent[] = [];
  private readonly fates = new Map<number, { status: PlayerRoundStatusId; place: number }>();
  private readonly left = new Set<number>();
  private readonly opts: Required<SimpleShowOptions>;

  /** @param opts - Round and timings. */
  constructor(opts: SimpleShowOptions) {
    this.opts = {
      playSeconds: 120,
      countdownSeconds: 3,
      roundEndSeconds: 1.5,
      resultsSeconds: 5,
      loops: Infinity,
      ...opts,
    };
  }

  get showPhase(): ShowPhaseId {
    return this.phase;
  }

  start(players: readonly MatchPlayerInfo[], seed: number): void {
    this.players = [...players];
    this.seed = seed >>> 0;
    this.setShowPhase(ShowPhase.InRound);
    this.startRound();
  }

  onTick(dt: number, ctx: ShowTickContext): void {
    if (this.phase !== ShowPhase.InRound) return;
    this.phaseTime += dt;
    switch (this.roundPhase) {
      case RoundPhase.Countdown:
        if (this.phaseTime >= this.opts.countdownSeconds) this.setRoundPhase(RoundPhase.Playing, 0);
        break;
      case RoundPhase.Playing:
        if (this.phaseTime >= this.opts.playSeconds || ctx.status?.finished)
          this.setRoundPhase(RoundPhase.RoundEnd);
        break;
      case RoundPhase.RoundEnd:
        if (this.phaseTime >= this.opts.roundEndSeconds) {
          this.setRoundPhase(RoundPhase.Results);
          this.events.push({ type: 'roundEnd', roundId: this.opts.roundId, results: this.results(ctx) });
        }
        break;
      case RoundPhase.Results:
        if (this.phaseTime >= this.opts.resultsSeconds) {
          this.loop++;
          if (this.loop >= this.opts.loops) {
            this.setShowPhase(ShowPhase.Ended);
            this.events.push({
              type: 'showEnd',
              winners: this.plan ? [...this.plan.playerIds] : [],
              rounds: [{ roundId: this.opts.roundId, qualified: this.plan ? [...this.plan.playerIds] : [] }],
            });
          } else {
            this.startRound();
          }
        }
        break;
    }
  }

  onPlayerFate(playerId: number, status: PlayerRoundStatusId, place: number): void {
    this.fates.set(playerId, { status, place });
  }

  onPlayerLeft(playerId: number): void {
    this.left.add(playerId);
  }

  currentRound(): ShowRoundPlan | null {
    return this.plan;
  }

  drainEvents(): ShowEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private startRound(): void {
    this.fates.clear();
    this.plan = {
      roundId: this.opts.roundId,
      stage: this.loop,
      seed: (this.seed + this.loop * 0x9e3779b1) >>> 0,
      playerIds: this.players.filter((p) => !this.left.has(p.id)).map((p) => p.id),
    };
    this.events.push({ type: 'roundStart', plan: this.plan });
    this.setRoundPhase(RoundPhase.Countdown, -this.opts.countdownSeconds);
  }

  private results(ctx: ShowTickContext): RoundResultEntry[] {
    const ids = this.plan?.playerIds ?? [];
    return ids.map((id, i) => {
      const fate = this.fates.get(id);
      const st = ctx.status?.players.get(id);
      return {
        id,
        status: fate?.status ?? st?.status ?? 0,
        place: fate?.place ?? st?.place ?? i + 1,
        score: st?.score ?? 0,
      };
    });
  }

  private setRoundPhase(phase: RoundPhaseId, time?: number): void {
    this.roundPhase = phase;
    this.phaseTime = 0;
    this.events.push(
      time === undefined ? { type: 'roundPhase', phase } : { type: 'roundPhase', phase, time },
    );
  }

  private setShowPhase(phase: ShowPhaseId): void {
    this.phase = phase;
    this.events.push({ type: 'showPhase', phase });
  }
}
