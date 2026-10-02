import { SIM_DT } from '@tumble/shared';

/**
 * Fixed-timestep accumulator. Callers feed it variable frame deltas; it invokes
 * `step` a whole number of times at exactly `dt` and reports the leftover
 * fraction for render interpolation.
 *
 * Time is always supplied by the caller, so the sim never reads a clock.
 */
export class FixedStepper {
  /** Fraction of a step left in the accumulator after the last `advance`, in [0, 1). */
  alpha = 0;
  /** Total fixed steps taken. */
  tick = 0;
  private acc = 0;

  /**
   * @param step - Invoked once per fixed step with the tick index being produced.
   * @param dt - Fixed step length in seconds.
   * @param maxSteps - Cap on steps per `advance`, preventing a spiral of death after a stall.
   */
  constructor(
    private readonly step: (tick: number) => void,
    readonly dt: number = SIM_DT,
    private readonly maxSteps = 8,
  ) {}

  /**
   * Accumulates `frameDt` seconds and runs as many fixed steps as fit.
   *
   * @returns Number of steps executed.
   */
  advance(frameDt: number): number {
    this.acc += Math.max(0, frameDt);
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      this.step(this.tick);
      this.tick++;
      this.acc -= this.dt;
      n++;
    }
    // After a long stall (tab hidden, breakpoint) drop the backlog instead of fast-forwarding.
    if (n === this.maxSteps && this.acc >= this.dt) this.acc = 0;
    this.alpha = this.acc / this.dt;
    return n;
  }

  /** Clears accumulated time and resets the tick counter. */
  reset(tick = 0): void {
    this.acc = 0;
    this.alpha = 0;
    this.tick = tick;
  }
}
