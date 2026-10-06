/**
 * Undo/redo over immutable snapshots. Edits that arrive in a burst under the
 * same `group` key (dragging a slider, typing in a field) merge into one step,
 * so undo takes back the whole gesture rather than every intermediate value.
 */

/** Bounded undo/redo stack. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastGroup: string | null = null;
  private lastAt = -Infinity;

  /**
   * @param present - Initial state.
   * @param limit - Most undo steps kept.
   * @param mergeMs - Same-group edits closer than this merge.
   */
  constructor(
    private present: T,
    private readonly limit = 100,
    private readonly mergeMs = 800,
  ) {}

  /** Current state. */
  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Records a new state.
   *
   * @param next - The state after the edit.
   * @param group - Edits with the same key in quick succession merge into one step.
   * @param now - Clock (ms), injectable for tests.
   */
  push(next: T, group: string | null = null, now = Date.now()): void {
    if (next === this.present) return;
    const merge = group !== null && group === this.lastGroup && now - this.lastAt < this.mergeMs;
    if (!merge) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = next;
    this.future = [];
    this.lastGroup = group;
    this.lastAt = now;
  }

  /** Steps back; returns the restored state (unchanged when there is nothing to undo). */
  undo(): T {
    const prev = this.past.pop();
    if (prev === undefined) return this.present;
    this.future.push(this.present);
    this.present = prev;
    this.lastGroup = null;
    return prev;
  }

  /** Steps forward again after an undo. */
  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    this.lastGroup = null;
    return next;
  }

  /** Starts over from `state` with no history (opening another round). */
  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.present = state;
    this.lastGroup = null;
  }
}
