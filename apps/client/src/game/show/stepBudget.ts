/**
 * Frame-time budget for an offline show's fixed-step sim.
 *
 * An offline show simulates every bot on this device. When one fixed step
 * costs more than the real time it covers (100 Tumblers on a throttled phone
 * CPU), the stepper's catch-up turns into a spiral: each slow frame queues
 * more steps for the next one, and the game drops to 1-3 FPS while still
 * running slower than real time. This caps the steps per frame once the sim
 * can no longer keep up, trading sim speed (it was falling behind anyway) for
 * a frame rate that stays playable and responsive.
 */

/** Options for {@link StepBudget}. */
export interface StepBudgetOptions {
  /** Fixed step length in seconds. */
  stepSeconds: number;
  /** Sim time scale (`?ts=`); real time per step shrinks with it. */
  timeScale?: number;
  /** Wall time the sim may use per frame once it is over budget (ms). Default 33. */
  frameBudgetMs?: number;
  /**
   * Share of real time the sim may cost before the budget applies. Below it,
   * catch-up after a slow render frame is cheap and stays uncapped. Default 0.7.
   */
  maxLoad?: number;
}

/**
 * Tracks the cost of one fixed step and decides how many steps a frame may run.
 *
 * @example
 * const budget = new StepBudget({ stepSeconds: SIM_DT });
 * const t0 = performance.now();
 * const n = stepper.advance(dt, budget.cap(16));
 * budget.record(performance.now() - t0, n);
 */
export class StepBudget {
  private cost = 0;
  private readonly realMsPerStep: number;
  private readonly frameBudgetMs: number;
  private readonly maxLoad: number;

  constructor(opts: StepBudgetOptions) {
    this.realMsPerStep = (opts.stepSeconds * 1000) / Math.max(0.01, opts.timeScale ?? 1);
    this.frameBudgetMs = opts.frameBudgetMs ?? 33;
    this.maxLoad = opts.maxLoad ?? 0.7;
  }

  /** Smoothed wall time of one fixed step (ms); 0 before the first sample. */
  get stepMs(): number {
    return this.cost;
  }

  /** Share of real time the sim costs (1 = it can only just keep up). */
  get load(): number {
    return this.cost / this.realMsPerStep;
  }

  /**
   * Steps the next frame may run.
   *
   * @param ceiling - The stepper's own cap.
   * @returns `ceiling` while the sim keeps up, else as many steps as fit the frame budget (at least 1).
   */
  cap(ceiling: number): number {
    if (this.cost <= 0 || this.load < this.maxLoad) return ceiling;
    return Math.max(1, Math.min(ceiling, Math.floor(this.frameBudgetMs / this.cost)));
  }

  /**
   * Feeds one frame's measurement.
   *
   * @param ms - Wall time spent stepping.
   * @param steps - Steps taken in that time (frames without steps are ignored).
   */
  record(ms: number, steps: number): void {
    if (steps <= 0 || !(ms >= 0)) return;
    const per = ms / steps;
    // Fast to notice a slowdown (round start, a pile-up), slower to trust a quiet patch.
    const k = this.cost === 0 ? 1 : per > this.cost ? 0.3 : 0.08;
    this.cost += (per - this.cost) * k;
  }

  /** Forgets the measured cost (a new round has a different load). */
  reset(): void {
    this.cost = 0;
  }
}
