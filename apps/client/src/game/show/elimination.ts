/**
 * The show session's side of "How you went out".
 *
 * Responsibilities:
 * - online, keep the last ~10 s of the round in a {@link ReplayTape} (the
 *   client has no full sim to replay); offline the round recorder already has
 *   everything, so nothing extra runs;
 * - when the local player is knocked out, note what the attribution needs
 *   that the recording can't say (obstacle placement, teams, how far from the
 *   finish they were);
 * - once, when the session says so, build the recording, plan the replay and
 *   hand it to the player ({@link EliminationReplays}).
 *
 * Nothing runs while the feature is off (no tape, no per-frame work).
 */
import type { RoundDefinition } from '@tumble/shared';
import type { SimEvent } from '@tumble/sim';
import { DEFAULT_TUNING } from '@tumble/sim/character';
import { causeText, finishGapSeconds, obstacleReach, type CauseObstacle } from '../replay/elimCause.ts';
import { planElimination, type EliminationFacts } from '../replay/elimination.ts';
import type { EliminationReplays } from '../replay/elimPlayer.ts';
import type { ReplayData } from '../replay/format.ts';
import { readCamera, replayMeta, type LiveRoundInfo, type RecordableView } from '../replay/live.ts';
import type { PlayerSampler, RecordableCamera, ReplayMeta } from '../replay/recorder.ts';
import { ReplayTape } from '../replay/tape.ts';
import { createPlayerSample, type PlayerSample, type RoundSource } from '../round/source.ts';

/**
 * What attribution needs from the live round at the knock-out.
 *
 * @param source - The round's render source (its sim holds the placed obstacles).
 * @param round - Round definition (finish volumes).
 * @param teams - Team per player id.
 * @param localId - Local player id.
 * @returns Facts for {@link planElimination}.
 */
export function eliminationFacts(
  source: Pick<RoundSource, 'sim' | 'sample' | 'renderTime'> | null,
  round: Pick<RoundDefinition, 'type' | 'triggers'>,
  teams: ReadonlyMap<number, number>,
  localId: number,
): EliminationFacts {
  const obstacles: CauseObstacle[] = [];
  let finishGap: number | null = null;
  if (source) {
    for (const o of source.sim.obstacleRuntimes) {
      const i = o.instance;
      obstacles.push({
        id: i.id,
        type: i.type,
        x: i.position.x,
        y: i.position.y,
        z: i.position.z,
        reach: obstacleReach(i.params as Record<string, unknown> | undefined),
      });
    }
    const me = createPlayerSample();
    if (round.type === 'race' && source.sample(localId, me)) {
      const finishes = round.triggers.filter((t) => t.kind === 'finish');
      finishGap = finishGapSeconds(me, finishes, DEFAULT_TUNING.maxSpeed);
    }
  }
  return {
    obstacles,
    teams,
    finishGap,
    ...(source ? { eliminatedAt: source.renderTime() } : {}),
  };
}

/** One knock-out waiting for its replay. */
interface Knockout {
  roundIndex: number;
  facts: EliminationFacts;
  replayed: boolean;
}

/**
 * Per-show elimination replay glue.
 *
 * @example
 * const elim = new SessionElimination(ctx.eliminations, online);
 * elim.roundStarted(info, source);   // countdown
 * elim.frame(source, view);          // every rendered frame
 * elim.event(source.renderTime(), e);
 * elim.knockedOut(index, facts);     // the local player is out
 * elim.play((id) => publicName(id), reduceMotion);
 */
export class SessionElimination {
  private tape: ReplayTape | null = null;
  private meta: ReplayMeta | null = null;
  private knockout: Knockout | null = null;
  private source: RoundSource | null = null;
  private readonly cam: RecordableCamera = { mode: 0, target: -1, yaw: 0, pitch: 0 };
  private readonly sampler: PlayerSampler = (id, out) =>
    this.source?.sample(id, out as PlayerSample) ?? false;

  /**
   * @param svc - The app's elimination replay (absent in tools and tests).
   * @param online - The show runs on a game server (keeps a tape).
   */
  constructor(
    private readonly svc: EliminationReplays | null | undefined,
    private readonly online: boolean,
  ) {}

  /** The online ring buffer for the round, if one runs (tests, memory checks). */
  get activeTape(): ReplayTape | null {
    return this.tape;
  }

  /**
   * A round's countdown began.
   *
   * @param info - The round as the recorder sees it.
   * @param source - Its render source.
   */
  roundStarted(info: LiveRoundInfo, source: RoundSource): void {
    this.reset();
    if (!this.svc || info.localId < 0 || !this.svc.enabled()) return;
    this.source = source;
    this.meta = replayMeta(info, source);
    if (this.online) this.tape = new ReplayTape(info.players.map((p) => p.id));
  }

  /**
   * One rendered frame (samples the tape on its grid).
   *
   * @param view - The live round view (camera), or null.
   */
  frame(view: RecordableView | null): void {
    const tape = this.tape;
    const src = this.source;
    if (!tape || !src?.alive) return;
    const t = src.renderTime();
    if (!tape.due(t)) return;
    tape.frame(t, this.sampler, view ? readCamera(view, this.cam) : null, src.sim.getObstacleNetStates());
  }

  /**
   * A sim event was rendered.
   *
   * @param e - The event.
   */
  event(e: SimEvent): void {
    const src = this.source;
    if (this.tape && src?.alive) this.tape.event(src.renderTime(), e);
  }

  /** True when a knock-out is noted and its replay hasn't run. */
  get pending(): boolean {
    return !!this.knockout && !this.knockout.replayed;
  }

  /**
   * The local player was knocked out (first call per round wins).
   *
   * @param roundIndex - Round index in the show.
   * @param facts - From {@link eliminationFacts} at the knock-out.
   */
  knockedOut(roundIndex: number, facts: EliminationFacts): void {
    if (!this.meta || this.knockout?.roundIndex === roundIndex) return;
    this.knockout = { roundIndex, facts, replayed: false };
  }

  /** The recording to replay: the tape online, the round recorder's offline. */
  private recording(k: Knockout): ReplayData | null {
    if (this.online) return this.meta && this.tape ? this.tape.toReplayData(this.meta) : null;
    return this.svc?.recording(k.roundIndex) ?? null;
  }

  /**
   * Plays the noted knock-out's replay (once).
   *
   * @param nameOf - Streamer Mode safe name for a player id.
   * @param still - Reduce Motion: a still frame.
   * @returns True when a replay started.
   */
  play(nameOf: (id: number) => string, still: boolean): boolean {
    const k = this.knockout;
    const svc = this.svc;
    if (!k || k.replayed || !svc) return false;
    k.replayed = true;
    if (!svc.enabled()) return false;
    const data = this.recording(k);
    const plan = data ? planElimination(data, k.facts) : null;
    if (!data || !plan) return false;
    return svc.play({ data, plan, cause: causeText(plan.cause, nameOf), still, online: this.online });
  }

  /** Forgets the round (a new round, the session ended). */
  reset(): void {
    this.tape = null;
    this.meta = null;
    this.knockout = null;
    this.source = null;
  }
}
