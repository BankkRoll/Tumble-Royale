/**
 * Sequence-keyed ring buffers for client prediction: the inputs the client
 * sent (for redundancy and replay) and the states it predicted after each one
 * (for reconciliation against the server).
 */
import type { CharacterInput } from '@tumble/sim';

/**
 * Fixed-capacity ring of preallocated items keyed by a monotonically increasing
 * sequence number. Writing sequence `s` evicts `s - capacity`.
 */
export class SeqRing<T> {
  private readonly items: T[];
  private readonly seqs: Float64Array;
  /** Newest sequence stored, or -1. */
  newest = -1;

  /**
   * @param capacity - Number of slots (≥ the longest replay you expect: RTT + jitter at 60 Hz).
   * @param create - Factory for the preallocated slot objects.
   */
  constructor(
    readonly capacity: number,
    create: () => T,
  ) {
    this.items = Array.from({ length: capacity }, create);
    this.seqs = new Float64Array(capacity).fill(-1);
  }

  /**
   * Claims the slot for `seq` and returns its object for the caller to overwrite.
   * Contents are stale until written.
   */
  claim(seq: number): T {
    const i = seq % this.capacity;
    this.seqs[i] = seq;
    if (seq > this.newest) this.newest = seq;
    return this.items[i]!;
  }

  /** @returns The item for `seq`, or undefined if never stored or evicted. */
  get(seq: number): T | undefined {
    if (seq < 0) return undefined;
    const i = seq % this.capacity;
    return this.seqs[i] === seq ? this.items[i] : undefined;
  }

  /** True when `seq` is still stored. */
  has(seq: number): boolean {
    return seq >= 0 && this.seqs[seq % this.capacity] === seq;
  }

  /** Forgets everything. */
  clear(): void {
    this.seqs.fill(-1);
    this.newest = -1;
  }
}

/** Copies an input field by field (no allocation). */
export function copyInput(src: CharacterInput, dst: CharacterInput): CharacterInput {
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.yaw = src.yaw;
  dst.buttons = src.buttons;
  dst.emote = src.emote;
  return dst;
}

/**
 * Ring of the local player's inputs by sequence number.
 *
 * @example
 * const seq = history.push(input);           // each fixed step
 * history.collectRecent(seq, 3, batchInputs); // redundancy for the InputBatch
 * for (let s = ackedSeq + 1; s <= history.newest; s++) replay(history.get(s)!);
 */
export class InputHistory extends SeqRing<CharacterInput> {
  private nextSeq = 0;

  /** @param capacity - Slots; 256 covers > 4 s of 60 Hz inputs. */
  constructor(capacity = 256) {
    super(capacity, () => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 }));
  }

  /** Sequence the next {@link push} will get. */
  get next(): number {
    return this.nextSeq;
  }

  /**
   * Stores a copy of `input` under the next sequence number.
   *
   * @returns The sequence assigned.
   */
  push(input: CharacterInput): number {
    const seq = this.nextSeq++;
    copyInput(input, this.claim(seq));
    return seq;
  }

  /**
   * Fills `out` (newest first) with up to `count` inputs ending at `newestSeq`.
   *
   * @returns How many were written.
   */
  collectRecent(newestSeq: number, count: number, out: CharacterInput[]): number {
    let n = 0;
    for (let s = newestSeq; s > newestSeq - count && s >= 0 && n < out.length; s--) {
      const it = this.get(s);
      if (!it) break;
      copyInput(it, out[n++]!);
    }
    return n;
  }

  /** Resets sequence numbering (new session). */
  resetSequence(start = 0): void {
    this.clear();
    this.nextSeq = start;
  }
}
