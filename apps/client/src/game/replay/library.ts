/**
 * The current show's recordings: a small ring buffer keyed by round, cleared
 * when a new show starts, bounded by count and bytes so a long custom show
 * can't grow memory without limit.
 */
import type { ReplayData } from './format.ts';

/** One stored round. */
export interface ReplayEntry {
  /** Stable key (`<show>:<round index>`). */
  key: string;
  data: ReplayData;
  /** Encoded size (frames + events). */
  bytes: number;
}

/** Default number of rounds kept (a show has at most ~6). */
export const LIBRARY_CAPACITY = 8;
/** Default byte budget for all stored rounds. */
export const LIBRARY_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Per-show replay storage.
 *
 * @example
 * library.beginShow();
 * library.add(recorder.finish(outcome));
 * library.list(); // oldest first
 */
export class ReplayLibrary {
  private entries: ReplayEntry[] = [];
  private show = 0;

  /**
   * @param capacity - Max rounds kept.
   * @param maxBytes - Max total encoded bytes.
   */
  constructor(
    private readonly capacity = LIBRARY_CAPACITY,
    private readonly maxBytes = LIBRARY_MAX_BYTES,
  ) {}

  /** Drops the previous show's rounds. */
  beginShow(): void {
    this.entries = [];
    this.show++;
  }

  /** Stored rounds, oldest first. */
  list(): readonly ReplayEntry[] {
    return this.entries;
  }

  /** Total encoded bytes held. */
  get totalBytes(): number {
    let n = 0;
    for (const e of this.entries) n += e.bytes;
    return n;
  }

  /**
   * Stores a finished round (replacing an earlier recording of the same round
   * index), evicting the oldest rounds past the budgets.
   *
   * @param data - Recording.
   * @returns The stored entry.
   */
  add(data: ReplayData): ReplayEntry {
    const key = `${this.show}:${data.header.roundIndex}`;
    const entry: ReplayEntry = { key, data, bytes: data.frames.length + data.events.length };
    this.entries = this.entries.filter((e) => e.key !== key);
    this.entries.push(entry);
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.capacity || this.totalBytes > this.maxBytes)
    )
      this.entries.shift();
    return entry;
  }

  /** @returns The entry for a key, if still held. */
  get(key: string): ReplayEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }
}
