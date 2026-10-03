/**
 * Adaptive resolution: nudges the scene render scale to hold a target frame
 * time. Uses an exponential moving average with asymmetric hysteresis — drop
 * fast when over budget (a hitch is worse than blur), climb slowly when there is
 * headroom (avoids oscillating every second).
 */

/** Options for {@link AdaptiveResolution}. */
export interface AdaptiveResolutionOptions {
  /** Target frame time in ms (e.g. 16.67 for 60 FPS). */
  targetMs: number;
  /** Lowest allowed scale. Default 0.5. */
  min?: number;
  /** Highest allowed scale. Default 1. */
  max?: number;
  /** Scale change per adjustment. Default 0.1. */
  step?: number;
  /** Starting scale. Default `max`. */
  initial?: number;
  /** Called when the scale changes. */
  onChange?: (scale: number) => void;
}

/**
 * Frame-time driven resolution controller.
 *
 * @example
 * const adaptive = new AdaptiveResolution({ targetMs: 16.7, onChange: (s) => post.setSettings({ resolutionScale: s }) });
 * // every frame:
 * adaptive.sample(dt * 1000);
 */
export class AdaptiveResolution {
  /** Current scale. */
  scale: number;
  enabled = true;
  private ema: number;
  private overFor = 0;
  private underFor = 0;
  private cooldown = 0;
  private readonly opts: Required<Omit<AdaptiveResolutionOptions, 'onChange'>> & Pick<AdaptiveResolutionOptions, 'onChange'>;

  constructor(opts: AdaptiveResolutionOptions) {
    this.opts = {
      targetMs: opts.targetMs,
      min: opts.min ?? 0.5,
      max: opts.max ?? 1,
      step: opts.step ?? 0.1,
      initial: opts.initial ?? opts.max ?? 1,
      onChange: opts.onChange,
    };
    this.scale = this.opts.initial;
    this.ema = opts.targetMs;
  }

  /** Smoothed frame time (ms). */
  get smoothedMs(): number {
    return this.ema;
  }

  /** Change the target (tier switch). */
  setTarget(targetMs: number, min?: number): void {
    this.opts.targetMs = targetMs;
    if (min !== undefined) this.opts.min = min;
  }

  /**
   * Feed one frame's duration.
   *
   * @param frameMs - Wall time since the previous frame.
   * @returns The (possibly updated) scale.
   */
  sample(frameMs: number): number {
    // Ignore tab-switch / breakpoint spikes; they say nothing about GPU load.
    if (frameMs > 250 || !this.enabled) return this.scale;
    const dt = frameMs / 1000;
    this.ema += (frameMs - this.ema) * Math.min(1, dt * 4);
    this.cooldown = Math.max(0, this.cooldown - dt);
    const { targetMs, min, max, step } = this.opts;

    if (this.ema > targetMs * 1.12) {
      this.overFor += dt;
      this.underFor = 0;
    } else if (this.ema < targetMs * 0.78) {
      this.underFor += dt;
      this.overFor = 0;
    } else {
      this.overFor = 0;
      this.underFor = 0;
    }

    if (this.cooldown > 0) return this.scale;
    let next = this.scale;
    if (this.overFor > 0.5 && this.scale > min) next = Math.max(min, this.scale - step);
    else if (this.underFor > 2.5 && this.scale < max) next = Math.min(max, this.scale + step * 0.5);
    if (next !== this.scale) {
      this.scale = Math.round(next * 100) / 100;
      this.overFor = 0;
      this.underFor = 0;
      this.cooldown = 1;
      this.opts.onChange?.(this.scale);
    }
    return this.scale;
  }
}
