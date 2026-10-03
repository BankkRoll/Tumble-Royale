/**
 * Replay render source: feeds the round view from a decoded recording instead
 * of a live sim. A private, never-stepped match sim (its own Rapier world)
 * provides the level colliders for camera/VFX probes and the obstacle runtimes
 * the visuals read; the playhead poses its kinematic obstacles with
 * `setTime` and restores recorded non-pure obstacle states on top. The live
 * show's sim is never touched.
 */
import type { MatchDeps, MatchPlayerInfo, MatchSimHandle } from '@tumble/sim/match';
import { createMatchSim } from '@tumble/sim/match';
import type { Rapier } from '@tumble/sim';
import type { RoundDefinition } from '@tumble/shared';
import type { PlayerSample, RoundSource } from '../round/source.ts';
import { createCursor, type ReplayTimeline, type TimelineCursor } from './timeline.ts';

/**
 * Builds the sim the replay view poses obstacles in: same round, seed, stage
 * and variation as the recording (so seeded layouts match), no players.
 *
 * @param R - Rapier.
 * @param deps - Match dependencies (controller factory, obstacle registry).
 * @param round - Round definition.
 * @param tl - Recording.
 */
export function createReplaySim(
  R: Rapier,
  deps: MatchDeps,
  round: RoundDefinition,
  tl: ReplayTimeline,
): MatchSimHandle {
  const h = tl.header;
  return createMatchSim(
    {
      R,
      round,
      seed: h.seed,
      stage: h.stage,
      players: [],
      mode: 'predict',
      localPlayerId: -1,
      ...(h.variationId ? { variationId: h.variationId } : {}),
    },
    deps,
  );
}

/**
 * {@link RoundSource} over a recording.
 *
 * @example
 * const source = new ReplayRoundSource(createReplaySim(R, deps, round, tl), tl);
 * // per frame
 * source.setTime(clock.time);
 * roundView.update(dt);
 */
export class ReplayRoundSource implements RoundSource {
  readonly players: readonly MatchPlayerInfo[];
  readonly localId: number;
  /** Where the playhead is (shared with the view for camera tracks). */
  readonly cursor: TimelineCursor = createCursor();
  private readonly obstacleIds: readonly string[];
  private disposed = false;

  /**
   * @param sim - Replay-only sim from {@link createReplaySim} (owned: disposed with the source).
   * @param timeline - Decoded recording.
   */
  constructor(
    readonly sim: MatchSimHandle,
    readonly timeline: ReplayTimeline,
  ) {
    const h = timeline.header;
    this.players = h.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, team: p.team }));
    this.localId = h.localId;
    const known = new Set(sim.obstacleRuntimes.map((o) => o.instance.id));
    // Obstacles this build doesn't have (older/newer file) are skipped rather than failing the replay.
    this.obstacleIds = h.obstacles.map((id) => (known.has(id) ? id : ''));
  }

  get alive(): boolean {
    return !this.disposed;
  }

  /**
   * Moves the playhead: poses kinematic obstacles at the recorded round time
   * and applies each obstacle's recorded state for that frame.
   *
   * @param t - Seconds from the start of the recording.
   */
  setTime(t: number): void {
    if (this.disposed) return;
    const tl = this.timeline;
    const c = tl.locate(t, this.cursor);
    this.sim.setTime?.(tl.header.startTime + c.t);
    const ids = this.obstacleIds;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      if (!id) continue;
      const state = tl.obstacleState(i, c.i);
      // Typed arrays satisfy every setNetState (indexed reads only); copying would allocate per frame.
      if (state) this.sim.setObstacleNetState(id, state as unknown as readonly number[]);
    }
    // Posing runs obstacle logic that may emit cues; nothing consumes them here.
    this.sim.events.events.length = 0;
  }

  renderTime(): number {
    return this.timeline.header.startTime + this.cursor.t;
  }

  sample(id: number, out: PlayerSample): boolean {
    if (this.disposed) return false;
    return this.timeline.samplePlayer(this.timeline.slotOf(id), this.cursor, out);
  }

  /** Frees the replay sim. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sim.dispose();
  }
}
