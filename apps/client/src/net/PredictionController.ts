/**
 * Client-side prediction for the local Tumbler.
 *
 * The local player runs ahead of the server in a MatchSim in `predict` mode:
 * every fixed step applies the local input immediately (instant response),
 * records the input and the predicted state by sequence number, and sends the
 * input. When a snapshot says "after your input S you were HERE", the state
 * predicted for S is compared with the server's; on divergence (> 5 cm or a
 * different character state) the controller rewinds to the server state and
 * replays every unacknowledged input. The visible jump this would cause is
 * hidden by a render offset that decays over ~100 ms (or snaps above 2 m).
 *
 * Time: the predict sim runs AHEAD of the server's match time by RTT/2 plus the
 * server's input buffer, so an input applied locally at sim time t is applied
 * by the server at (nearly) the same match time t, and obstacles posed from
 * `pose(t)` line up for both. The lead is first estimated from RTT, then
 * servoed with the measured time at which the server really applied each input.
 */
import {
  InputHistory,
  SeqRing,
  copyInput,
  copyState,
  createCharacterFullState,
  quantizeInputInPlace,
  type MatchSim,
  type NetEntityState,
} from '@tumble/netcode';
import type { CharacterFullState, CharacterInput, SimEvent } from '@tumble/sim';
import { SIM_DT, type RoundPhaseId, type Vec3 } from '@tumble/shared';

/** Tuning for {@link PredictionController}. */
export interface PredictionOptions {
  /** Position error (m) above which a correction is applied. */
  errorThreshold?: number;
  /** Corrections larger than this (m) snap instead of smoothing. */
  snapDistance?: number;
  /** Time for the visual correction offset to decay to ~5% (ms). */
  smoothingMs?: number;
  /** Extra lead over RTT/2 covering the server's input jitter buffer (ms). */
  inputBufferMs?: number;
  /** Local time further than this (s) from target is reset instead of slewed. */
  hardResyncSeconds?: number;
  /** Max fraction by which the local step rate is sped up/slowed down to converge. */
  maxRateAdjust?: number;
}

/** Hooks the controller needs from the outside world. */
export interface PredictionHost {
  /** Authoritative match time estimate (s), e.g. `NetClient.matchTime()`. */
  matchTime(): number;
  /** Smoothed RTT (ms). */
  rttMs(): number;
  /** Sends input `seq` (with redundancy) to the server. */
  sendInput(seq: number, history: InputHistory): void;
  /** Locally predicted events (jump/land/dive…) for immediate feedback. */
  onPredictedEvent?(event: SimEvent): void;
}

/** Optional sim extension: move match time without side effects (preferred over setPhase for replays). */
interface TimeSettable {
  setTime?(time: number): void;
}

/**
 * Owns prediction for one local player in one round.
 *
 * @example
 * const pc = new PredictionController(predictSim, net.playerId, host);
 * // every frame:
 * pc.advance(frameDtMs, () => input.sample());
 * pc.renderPosition(out);
 * // every snapshot:
 * pc.reconcile(snap.ackedInputSeq, localEntityFromSnapshot);
 */
export class PredictionController {
  readonly history = new InputHistory(256);
  /** Corrections applied (diagnostics). */
  corrections = 0;
  /** Inputs replayed across all corrections. */
  replayed = 0;
  /** Largest correction distance seen (m). */
  maxCorrection = 0;

  private readonly predicted = new SeqRing<CharacterFullState>(256, createCharacterFullState);
  private readonly scratch = createCharacterFullState();
  private readonly scratchInput: CharacterInput = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
  private readonly offset: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly before: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly opts: Required<PredictionOptions>;
  private acc = 0;
  private phase: RoundPhaseId = 0;
  private lastAcked = -1;
  private readonly seqTimes = new Float64Array(256);
  private timeErr = 0;
  /** Input-production clock (s): paces how many inputs we generate, independent of the sim's time label. */
  private prodTime = 0;
  private started = false;
  /** Offset of the sim's time label from {@link prodTime} (s), servoed from the measured {@link timeError}. */
  private timeTrim = 0;
  /** Fraction of a step left in the accumulator, for render interpolation. */
  alpha = 0;

  /**
   * @param sim - A MatchSim created with `mode: 'predict'` and `localPlayerId`.
   * @param localPlayerId - The local player's id.
   * @param host - Clock, RTT, input sending.
   * @param opts - Tuning.
   */
  constructor(
    readonly sim: MatchSim,
    readonly localPlayerId: number,
    private readonly host: PredictionHost,
    opts: PredictionOptions = {},
  ) {
    this.opts = {
      errorThreshold: 0.05,
      snapDistance: 2,
      smoothingMs: 100,
      inputBufferMs: 50,
      hardResyncSeconds: 0.25,
      maxRateAdjust: 0.08,
      ...opts,
    };
  }

  /** Where the input-production clock should be right now: server match time + RTT/2 + buffer (s). */
  targetTime(): number {
    return this.host.matchTime() + (this.host.rttMs() / 2 + this.opts.inputBufferMs) / 1000;
  }

  /**
   * Smoothed (local − server) match time at which the same input was applied (s).
   * Driven toward 0 by the time trim; non-zero means moving obstacles disagree at contact.
   */
  get timeError(): number {
    return this.timeErr;
  }

  /** Mirrors a server phase change, keeping the local time lead. */
  setPhase(phase: RoundPhaseId): void {
    this.phase = phase;
    this.started = false;
    this.sim.setPhase(phase, this.targetTime() + this.timeTrim);
  }

  /**
   * Advances local prediction by real elapsed time, running whole fixed steps.
   *
   * Two clocks are steered separately. The input-production clock is nudged
   * (±8% step rate) toward {@link targetTime} so inputs reach the server just
   * before it needs them. The sim's time label is production time plus a trim
   * servoed by the measured {@link timeError}, because WHEN the server applies
   * input S is fixed by its jitter-buffer pacing, not by our lead: changing the
   * lead only changes the server's buffer depth.
   *
   * @param frameDtMs - Real time since the last call.
   * @param sample - Produces this step's input (called once per fixed step).
   * @returns Number of fixed steps run.
   */
  advance(frameDtMs: number, sample: () => CharacterInput): number {
    const target = this.targetTime();
    let err = target - this.prodTime;
    if (!this.started || Math.abs(err) > this.opts.hardResyncSeconds) {
      this.started = true;
      this.prodTime = target;
      this.acc = 0;
      err = 0;
      this.sim.setPhase(this.currentPhase(), this.prodTime + this.timeTrim);
    }
    const k = this.opts.maxRateAdjust;
    const rate = 1 + Math.max(-k, Math.min(k, err * 2));
    this.acc += (Math.min(frameDtMs, 250) / 1000) * rate;
    let n = 0;
    while (this.acc >= SIM_DT && n < 8) {
      this.step(sample());
      this.acc -= SIM_DT;
      n++;
    }
    if (n === 8) this.acc = 0;
    this.alpha = this.acc / SIM_DT;
    this.decayOffset(frameDtMs);
    return n;
  }

  /**
   * Runs one predicted fixed step with `input` (quantised in place first so
   * prediction consumes exactly what the server will).
   *
   * @returns The input's sequence number.
   */
  step(input: CharacterInput): number {
    const inp = quantizeInputInPlace(copyInput(input, this.scratchInput));
    const seq = this.history.push(inp);
    // Apply trim changes in ≥1 ms nudges: tiny obstacle teleports nobody can see.
    const want = this.prodTime + this.timeTrim;
    if (Math.abs(want - this.sim.time) > 0.001) this.setSimTime(want);
    this.prodTime += SIM_DT;
    this.sim.setInput(this.localPlayerId, inp);
    this.sim.step();
    this.sim.getPlayerState(this.localPlayerId, this.predicted.claim(seq));
    this.seqTimes[seq % this.seqTimes.length] = this.sim.time;
    const events = this.sim.events.drain();
    if (this.host.onPredictedEvent) for (const e of events) this.host.onPredictedEvent(e);
    this.host.sendInput(seq, this.history);
    return seq;
  }

  /**
   * Compares the server's state after input `ackedSeq` with the prediction and
   * corrects if they diverged.
   *
   * @param ackedSeq - `DecodedSnapshot.ackedInputSeq`.
   * @param server - The local player's entity from that snapshot.
   * @param serverMatchTime - `DecodedSnapshot.matchTime`: the server applied `ackedSeq` on the
   *   tick's last step, so this is the match time that input really ran at.
   * @returns True if a correction (rewind + replay) happened.
   */
  reconcile(ackedSeq: number, server: NetEntityState, serverMatchTime?: number): boolean {
    if (ackedSeq < 0 || ackedSeq <= this.lastAcked) return false;
    this.lastAcked = ackedSeq;
    const newest = this.history.newest;
    const pred = this.predicted.get(ackedSeq);
    if (pred && serverMatchTime !== undefined)
      this.trackTimeError(this.seqTimes[ackedSeq % this.seqTimes.length]! - serverMatchTime);
    if (!pred || newest < 0) {
      // Too old to replay from (long stall): adopt the server state as-is.
      this.adopt(server, ackedSeq);
      return true;
    }
    const dx = pred.pos.x - server.pos.x;
    const dy = pred.pos.y - server.pos.y;
    const dz = pred.pos.z - server.pos.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (err <= this.opts.errorThreshold && pred.state === server.state) return false;

    const latest = this.predicted.get(newest);
    if (latest) copyVecTo(latest.pos, this.before);
    this.overwriteReplicated(pred, server);
    this.sim.setPlayerState(this.localPlayerId, pred);

    const replaySteps = newest - ackedSeq;
    if (replaySteps > 0) {
      const now = this.sim.time;
      this.setSimTime(now - replaySteps * SIM_DT);
      for (let s = ackedSeq + 1; s <= newest; s++) {
        const inp = this.history.get(s);
        if (!inp) break;
        this.sim.setInput(this.localPlayerId, inp);
        this.sim.step();
        this.sim.getPlayerState(this.localPlayerId, this.predicted.claim(s));
      }
      // Replayed steps re-emit jumps/lands the player already saw and heard.
      this.sim.events.drain();
      this.setSimTime(now);
    }

    this.corrections++;
    this.replayed += replaySteps;
    this.maxCorrection = Math.max(this.maxCorrection, err);
    const after = this.predicted.get(newest);
    if (latest && after) {
      this.offset.x += this.before.x - after.pos.x;
      this.offset.y += this.before.y - after.pos.y;
      this.offset.z += this.before.z - after.pos.z;
      if (Math.hypot(this.offset.x, this.offset.y, this.offset.z) > this.opts.snapDistance)
        this.clearOffset();
    }
    return true;
  }

  /**
   * Render position of the local player: the last two predicted steps blended
   * by the leftover step fraction (fixed 60 Hz steps on a variable-rate
   * display), plus the decaying correction offset.
   */
  renderPosition(out: Vec3): Vec3 {
    const cur = this.predicted.get(this.history.newest);
    if (!cur) return out;
    const prev = this.predicted.get(this.history.newest - 1) ?? cur;
    const a = this.alpha;
    out.x = prev.pos.x + (cur.pos.x - prev.pos.x) * a + this.offset.x;
    out.y = prev.pos.y + (cur.pos.y - prev.pos.y) * a + this.offset.y;
    out.z = prev.pos.z + (cur.pos.z - prev.pos.z) * a + this.offset.z;
    return out;
  }

  /** The newest predicted full state (rotation, state, facing… for animation), or undefined. */
  latestState(): CharacterFullState | undefined {
    return this.predicted.get(this.history.newest);
  }

  /** Current visual correction offset (m). */
  get correctionOffset(): Readonly<Vec3> {
    return this.offset;
  }

  private trackTimeError(sample: number): void {
    // Ignore outliers from jitter-buffer underruns or a resync in flight.
    if (Math.abs(sample) > 0.5) return;
    this.timeErr += (sample - this.timeErr) * 0.2;
    this.timeTrim -= sample * 0.1;
    this.timeTrim = Math.max(-0.5, Math.min(0.5, this.timeTrim));
  }

  private adopt(server: NetEntityState, seq: number): void {
    const s = this.scratch;
    this.sim.getPlayerState(this.localPlayerId, s);
    this.overwriteReplicated(s, server);
    this.sim.setPlayerState(this.localPlayerId, s);
    copyState(s, this.predicted.claim(Math.max(seq, this.history.newest)));
    this.clearOffset();
  }

  private overwriteReplicated(dst: CharacterFullState, src: NetEntityState): void {
    copyVecTo(src.pos, dst.pos);
    dst.rot.x = src.rot.x;
    dst.rot.y = src.rot.y;
    dst.rot.z = src.rot.z;
    dst.rot.w = src.rot.w;
    copyVecTo(src.vel, dst.vel);
    // Values outside the wire range never reach here; the cast restores the sim's literal union.
    dst.state = src.state as CharacterFullState['state'];
    dst.stateTime = src.stateTime;
    dst.facing = src.facing;
    dst.flags = src.flags;
    dst.grabTarget = src.grabTarget;
  }

  private setSimTime(t: number): void {
    const sim = this.sim as MatchSim & TimeSettable;
    if (sim.setTime) sim.setTime(t);
    else sim.setPhase(this.currentPhase(), t);
  }

  private currentPhase(): RoundPhaseId {
    return this.sim.phase ?? this.phase;
  }

  private decayOffset(frameDtMs: number): void {
    // exp(-3) ≈ 5%: the offset is visually gone after `smoothingMs`.
    const k = Math.exp((-3 * frameDtMs) / this.opts.smoothingMs);
    this.offset.x *= k;
    this.offset.y *= k;
    this.offset.z *= k;
  }

  private clearOffset(): void {
    this.offset.x = 0;
    this.offset.y = 0;
    this.offset.z = 0;
  }
}

function copyVecTo(a: Vec3, b: Vec3): void {
  b.x = a.x;
  b.y = a.y;
  b.z = a.z;
}
