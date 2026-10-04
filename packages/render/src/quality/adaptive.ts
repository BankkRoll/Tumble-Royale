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
  private readonly opts: Required<Omit<AdaptiveResolutionOptions, 'onChange'>> &
    Pick<AdaptiveResolutionOptions, 'onChange'>;

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

/** Options for {@link TierGovernor}. */
export interface TierGovernorOptions {
  /** Target frame time in ms for the current tier. */
  targetMs: number;
  /** Seconds the smoothed frame time must stay over budget before stepping down. Default 8. */
  patienceS?: number;
  /** How far over the target counts as over budget (1.4 = 40 % slower). Default 1.4. */
  ratio?: number;
  /** Seconds after a step down (or a reset) before judging again. Default 6. */
  settleS?: number;
}

/**
 * Decides when Auto quality should step down a whole tier. Adaptive
 * resolution only helps a GPU-bound device: a phone whose CPU cannot hold the
 * frame rate sits at the lowest render scale and stays slow. Once resolution
 * is spent and frames stay well over budget for a while, a cheaper tier's
 * crowd, VFX and environment budgets are the next lever.
 *
 * @example
 * const gov = new TierGovernor({ targetMs: preset.targetFrameMs });
 * // every frame:
 * if (gov.sample(frameMs, adaptive.scale <= preset.minRenderScale)) quality.setTier(lower);
 */
export class TierGovernor {
  private ema: number;
  private overFor = 0;
  private settle: number;
  private readonly opts: Required<TierGovernorOptions>;

  constructor(opts: TierGovernorOptions) {
    this.opts = { patienceS: 8, ratio: 1.4, settleS: 6, ...opts };
    this.ema = opts.targetMs;
    this.settle = this.opts.settleS;
  }

  /** Smoothed frame time (ms). */
  get smoothedMs(): number {
    return this.ema;
  }

  /**
   * Feeds one frame.
   *
   * @param frameMs - Wall time since the previous frame.
   * @param resolutionSpent - True when adaptive resolution has nothing left to give.
   * @returns True when the caller should drop one tier now.
   */
  sample(frameMs: number, resolutionSpent: boolean): boolean {
    // NOTE: unlike AdaptiveResolution this keeps slow frames (a throttled phone CPU runs at
    // 300 ms a frame); only multi-second stalls (tab switch, debugger) are ignored.
    if (!(frameMs > 0) || frameMs > 2000) return false;
    const dt = frameMs / 1000;
    this.ema += (frameMs - this.ema) * Math.min(1, dt * 2);
    if (this.settle > 0) {
      this.settle -= dt;
      return false;
    }
    if (resolutionSpent && this.ema > this.opts.targetMs * this.opts.ratio) this.overFor += dt;
    else this.overFor = 0;
    if (this.overFor < this.opts.patienceS) return false;
    this.overFor = 0;
    this.settle = this.opts.settleS;
    return true;
  }

  /**
   * Starts over (tier switch).
   *
   * @param targetMs - The new tier's target frame time.
   */
  reset(targetMs: number): void {
    this.opts.targetMs = targetMs;
    this.ema = targetMs;
    this.overFor = 0;
    this.settle = this.opts.settleS;
  }
}
