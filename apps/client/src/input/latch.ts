/**
 * Edge-safe button state sampled once per fixed simulation step.
 *
 * Browser events arrive at arbitrary times between steps. Reading only "is it
 * held right now" would drop taps shorter than a step and merge a fast
 * release/re-press into one long hold. The latch remembers what happened since
 * the last sample so the sim sees every press as a rising edge.
 */
export class ButtonLatch {
  private held = 0;
  private pressedSince = false;
  private releasedSince = false;
  private lastOut = false;
  private pending = false;

  /** A source (key, mouse button, touch button) went down. Multiple sources may hold the same latch. */
  press(): void {
    if (this.held === 0) this.pressedSince = true;
    this.held++;
  }

  /** A source went up. */
  release(): void {
    if (this.held === 0) return;
    this.held--;
    if (this.held === 0) this.releasedSince = true;
  }

  /** Drops all held sources (window blur, pointer-lock loss). */
  reset(): void {
    if (this.held > 0) this.releasedSince = true;
    this.held = 0;
  }

  /** Whether any source is currently held. */
  get down(): boolean {
    return this.held > 0;
  }

  /**
   * The button value for this step.
   *
   * - tap between steps → true for one step;
   * - release + re-press between steps while it was reported held → false
   *   now and true next step, so the sim still sees a new edge.
   */
  sample(): boolean {
    let out: boolean;
    if (this.pending) {
      out = true;
      this.pending = false;
    } else if (this.lastOut && this.releasedSince && this.pressedSince) {
      out = false;
      this.pending = true;
    } else {
      out = this.held > 0 || this.pressedSince;
    }
    this.pressedSince = false;
    this.releasedSince = false;
    this.lastOut = out;
    return out;
  }
}
