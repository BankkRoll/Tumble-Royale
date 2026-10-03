/**
 * Server-side input jitter buffer: one per connected player.
 *
 * Clients send one input per 60 Hz step; the network delivers them in bursts.
 * The buffer holds a small adaptive backlog (2–6 inputs = 1–3 server ticks) so
 * the sim can consume exactly one input per step. Policy when the next input is
 * not there:
 *   - a LATER input exists → the expected one was lost (redundancy failed):
 *     repeat the last input and move on;
 *   - nothing later has arrived → underrun: repeat the last input but do NOT
 *     advance, so the backlog grows by one and absorbs the jitter that caused it.
 * A backlog persistently above target is trimmed one input at a time to keep
 * input latency from creeping up after a burst.
 */
import type { CharacterInput } from '@tumble/sim';

/** Tuning for {@link InputJitterBuffer}. */
export interface JitterBufferOptions {
  /** Minimum target backlog in inputs (2 = one server tick). */
  minDepth?: number;
  /** Maximum target backlog in inputs (6 = three server ticks). */
  maxDepth?: number;
  /** Ring capacity in inputs. */
  capacity?: number;
  /** Client step length (ms). */
  stepMs?: number;
}

const FIELDS = 5;

/**
 * Orders and paces one player's inputs.
 *
 * @example
 * buf.push(seq, input, nowMs);            // for each input in a batch
 * const seq = buf.next(scratchInput);     // once per sim step
 * sim.setInput(playerId, scratchInput);
 */
export class InputJitterBuffer {
  private readonly minDepth: number;
  private readonly maxDepth: number;
  private readonly capacity: number;
  private readonly stepMs: number;
  private readonly seqs: Float64Array;
  private readonly vals: Float64Array;
  private readonly last: CharacterInput = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
  private started = false;
  private nextSeq = 0;
  private newest = -1;
  private lastArrival = -1;
  private lastArrivalSeq = -1;
  private jitterMs = 0;
  private overCount = 0;
  private calmArrivals = 0;

  /** Current adaptive backlog target, in inputs. */
  targetDepth: number;
  /** Sequence of the input applied by the most recent {@link next}, or -1. */
  lastConsumedSeq = -1;
  /** Inputs that never arrived (repeated instead). */
  missed = 0;
  /** Steps where the buffer ran dry. */
  underruns = 0;
  /** Inputs that arrived after their step was already simulated. */
  late = 0;
  /** Inputs discarded to trim excess latency. */
  trimmed = 0;

  /** @param opts - Optional tuning. */
  constructor(opts: JitterBufferOptions = {}) {
    this.minDepth = opts.minDepth ?? 2;
    this.maxDepth = opts.maxDepth ?? 6;
    this.capacity = opts.capacity ?? 64;
    this.stepMs = opts.stepMs ?? 1000 / 60;
    this.seqs = new Float64Array(this.capacity).fill(-1);
    this.vals = new Float64Array(this.capacity * FIELDS);
    this.targetDepth = this.minDepth;
  }

  /** Inputs buffered at or after the next one to consume. */
  get depth(): number {
    return this.started ? Math.max(0, this.newest - this.nextSeq + 1) : this.newest < 0 ? 0 : 1;
  }

  /** Smoothed arrival jitter estimate (ms). */
  get jitter(): number {
    return this.jitterMs;
  }

  /** Newest sequence received, or -1. */
  get newestSeq(): number {
    return this.newest;
  }

  /**
   * Stores one input. Duplicates (redundant copies) and late inputs are ignored.
   *
   * @param nowMs - Arrival time, for jitter estimation.
   * @returns True if the input was new and stored.
   */
  push(seq: number, input: CharacterInput, nowMs: number): boolean {
    if (this.started && seq < this.nextSeq) {
      if (seq > this.lastConsumedSeq - this.capacity && this.seqs[seq % this.capacity] !== seq) this.late++;
      return false;
    }
    if (this.started && seq - this.nextSeq >= this.capacity) {
      // The client jumped far ahead (long stall on its side): restart pacing from the new stream.
      this.started = false;
      this.seqs.fill(-1);
      this.newest = -1;
    }
    const slot = seq % this.capacity;
    if (this.seqs[slot] === seq) return false;
    this.seqs[slot] = seq;
    const o = slot * FIELDS;
    this.vals[o] = input.moveX;
    this.vals[o + 1] = input.moveZ;
    this.vals[o + 2] = input.yaw;
    this.vals[o + 3] = input.buttons;
    this.vals[o + 4] = input.emote;
    if (seq > this.newest) {
      this.trackArrival(seq, nowMs);
      this.newest = seq;
    }
    return true;
  }

  /**
   * Produces the input for the next sim step.
   *
   * @param out - Receives the input (the last known input when missing).
   * @returns The sequence consumed, or -1 when no fresh input was applied.
   */
  next(out: CharacterInput): number {
    if (!this.started) {
      if (this.newest < 0 || this.countBuffered() < this.targetDepth) return this.repeat(out);
      this.started = true;
      this.nextSeq = this.oldestBuffered();
      const minStart = this.newest - this.targetDepth + 1;
      if (this.nextSeq < minStart) this.nextSeq = minStart;
    }

    if (this.nextSeq > this.newest) {
      this.underruns++;
      return this.repeat(out);
    }

    const seq = this.nextSeq;
    const slot = seq % this.capacity;
    if (this.seqs[slot] === seq) {
      const o = slot * FIELDS;
      out.moveX = this.last.moveX = this.vals[o]!;
      out.moveZ = this.last.moveZ = this.vals[o + 1]!;
      out.yaw = this.last.yaw = this.vals[o + 2]!;
      out.buttons = this.last.buttons = this.vals[o + 3]!;
      out.emote = this.last.emote = this.vals[o + 4]!;
    } else {
      this.missed++;
      this.repeat(out);
    }
    this.nextSeq++;
    this.lastConsumedSeq = seq;

    if (this.depth > this.targetDepth + 2) {
      if (++this.overCount > 30) {
        this.nextSeq++;
        this.trimmed++;
        this.overCount = 0;
      }
    } else {
      this.overCount = 0;
    }
    return seq;
  }

  /** Clears everything (player resumed on a new connection). */
  reset(): void {
    this.seqs.fill(-1);
    this.started = false;
    this.newest = -1;
    this.nextSeq = 0;
    this.lastConsumedSeq = -1;
    this.lastArrival = -1;
    this.lastArrivalSeq = -1;
    this.jitterMs = 0;
    this.overCount = 0;
    this.targetDepth = this.minDepth;
  }

  /** Sets the input repeated while no input is available (e.g. a disconnected player idling). */
  setIdle(yaw: number): void {
    this.last.moveX = 0;
    this.last.moveZ = 0;
    this.last.buttons = 0;
    this.last.emote = 0;
    this.last.yaw = yaw;
  }

  private repeat(out: CharacterInput): number {
    out.moveX = this.last.moveX;
    out.moveZ = this.last.moveZ;
    out.yaw = this.last.yaw;
    out.buttons = this.last.buttons;
    // Emotes are one-shot requests; replaying one would re-trigger it.
    out.emote = 0;
    return -1;
  }

  private trackArrival(seq: number, nowMs: number): void {
    if (this.lastArrival >= 0 && this.lastArrivalSeq >= 0) {
      const expected = (seq - this.lastArrivalSeq) * this.stepMs;
      const actual = nowMs - this.lastArrival;
      const dev = Math.abs(actual - expected);
      this.jitterMs += (Math.min(dev, 500) - this.jitterMs) * 0.1;
      const want = this.minDepth + Math.ceil((2 * this.jitterMs) / this.stepMs) - 1;
      const target = want < this.minDepth ? this.minDepth : want > this.maxDepth ? this.maxDepth : want;
      // Grow at once (protect against the next spike); shrink one step per ~2 s of calm.
      if (target > this.targetDepth) {
        this.targetDepth = target;
        this.calmArrivals = 0;
      } else if (target < this.targetDepth) {
        if (++this.calmArrivals > 120) {
          this.targetDepth--;
          this.calmArrivals = 0;
        }
      } else {
        this.calmArrivals = 0;
      }
    }
    this.lastArrival = nowMs;
    this.lastArrivalSeq = seq;
  }

  private countBuffered(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++)
      if (this.seqs[i]! >= 0 && this.seqs[i]! > this.newest - this.capacity) n++;
    return n;
  }

  private oldestBuffered(): number {
    let oldest = this.newest;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.seqs[i]!;
      if (s >= 0 && s > this.newest - this.capacity && s < oldest) oldest = s;
    }
    return oldest;
  }
}
