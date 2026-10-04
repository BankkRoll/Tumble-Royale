/**
 * Graphics quality: picks the tier (forced, saved, or a silent first-launch
 * benchmark), applies it to the renderer and post pipeline, runs adaptive
 * resolution, and folds in the player's graphics settings.
 */
import type { WebGPURenderer } from 'three/webgpu';
import type { PostPipeline } from '@tumble/render/post';
import {
  AdaptiveResolution,
  QUALITY_TIERS,
  TierGovernor,
  applyQualityToRenderer,
  getQualityPreset,
  runBenchmark,
  type QualityPreset,
  type QualityTier,
} from '@tumble/render/quality';
import type { Settings } from '@tumble/ui';
import { loadJson, saveJson } from './storage.ts';

/** Persisted benchmark outcome. */
interface SavedQuality {
  tier: QualityTier;
  avgFrameMs: number;
  at: number;
}

/**
 * Owns the active {@link QualityPreset}.
 *
 * @example
 * const q = new QualityManager(renderer);
 * await q.init(cfg.tier, settings.graphics.quality);
 * q.attachPost(post);
 * // per frame: q.sample(frameMs);
 */
export class QualityManager {
  preset: QualityPreset = getQualityPreset('medium');
  /** Benchmark tier (the meaning of "auto"). */
  autoTier: QualityTier = 'medium';
  /** Benchmark frame time, when it ran this session or was saved. */
  benchmarkMs = -1;
  readonly adaptive: AdaptiveResolution;
  private readonly governor: TierGovernor;
  private post: PostPipeline | null = null;
  private userScale = 1;
  private forced: QualityTier | null = null;
  /** The player picked Auto (the governor may only move Auto). */
  private auto = false;
  private shadows = true;
  private postFx = true;
  private readonly listeners = new Set<(p: QualityPreset) => void>();

  constructor(private readonly renderer: WebGPURenderer) {
    this.adaptive = new AdaptiveResolution({
      targetMs: this.preset.targetFrameMs,
      min: this.preset.minRenderScale,
      onChange: () => this.pushResolution(),
    });
    this.governor = new TierGovernor({ targetMs: this.preset.targetFrameMs });
  }

  /**
   * Resolves the starting tier: a forced tier wins, then the player's choice,
   * then a saved benchmark, else runs the silent benchmark once and saves it.
   *
   * @param forced - `?tier=` override.
   * @param setting - Player's graphics setting.
   * @param onProgress - Called while the benchmark runs.
   */
  async init(
    forced: QualityTier | null,
    setting: Settings['graphics']['quality'],
    onProgress?: (label: string) => void,
  ): Promise<void> {
    const saved = loadJson<SavedQuality>('quality');
    if (saved) {
      this.autoTier = saved.tier;
      this.benchmarkMs = saved.avgFrameMs;
    } else if (!forced) {
      onProgress?.('Polishing the Crown…');
      try {
        const r = await runBenchmark(this.renderer, { durationMs: 1800 });
        this.autoTier = r.tier;
        this.benchmarkMs = r.avgFrameMs;
        saveJson('quality', {
          tier: r.tier,
          avgFrameMs: r.avgFrameMs,
          at: Date.now(),
        } satisfies SavedQuality);
      } catch (err) {
        console.warn('[quality] benchmark failed, using medium', err);
        this.autoTier = 'medium';
      }
    }
    this.forced = forced;
    this.auto = setting === 'auto';
    this.setTier(forced ?? (setting === 'auto' ? this.autoTier : setting));
  }

  /** Current tier. */
  get tier(): QualityTier {
    return this.preset.tier;
  }

  /** Hands the pipeline to drive (resolution scale, structural settings). */
  attachPost(post: PostPipeline): void {
    this.post = post;
    this.pushPost();
  }

  /**
   * Subscribes to tier changes (scenes rebuild detail on their next load).
   *
   * @returns Unsubscribe function.
   */
  onChange(fn: (p: QualityPreset) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Switches tier live. */
  setTier(tier: QualityTier): void {
    this.preset = getQualityPreset(tier);
    applyQualityToRenderer(this.renderer, this.preset);
    this.renderer.shadowMap.enabled = this.renderer.shadowMap.enabled && this.shadows;
    this.adaptive.setTarget(this.preset.targetFrameMs, this.preset.minRenderScale);
    this.adaptive.scale = this.preset.renderScale;
    this.governor.reset(this.preset.targetFrameMs);
    this.pushPost();
    for (const fn of this.listeners) fn(this.preset);
  }

  /** Applies the player's graphics settings section. */
  applySettings(g: Settings['graphics']): void {
    this.userScale = Math.max(0.5, Math.min(1, g.resolutionScale));
    this.shadows = g.shadows;
    this.postFx = g.postFx;
    this.auto = g.quality === 'auto';
    // A ?tier= override (tests, support) wins over the saved preference.
    const tier = this.forced ?? (g.quality === 'auto' ? this.autoTier : g.quality);
    if (tier !== this.preset.tier) this.setTier(tier);
    else {
      this.renderer.shadowMap.enabled = this.preset.shadows !== 'off' && this.shadows;
      this.pushPost();
    }
  }

  /**
   * Feeds one frame time to adaptive resolution and, on Auto, to the tier
   * governor. A step down is saved as the new Auto tier, so the next launch
   * starts there instead of relearning it.
   *
   * @returns The tier Auto just stepped down to, else null.
   */
  sample(frameMs: number): QualityTier | null {
    this.adaptive.sample(frameMs);
    if (this.forced || !this.auto || this.preset.tier === 'low') return null;
    const spent = this.adaptive.scale <= this.preset.minRenderScale + 1e-3;
    if (!this.governor.sample(frameMs, spent)) return null;
    const lower = QUALITY_TIERS[QUALITY_TIERS.indexOf(this.preset.tier) - 1] ?? 'low';
    this.autoTier = lower;
    saveJson('quality', {
      tier: lower,
      avgFrameMs: this.benchmarkMs,
      at: Date.now(),
    } satisfies SavedQuality);
    this.setTier(lower);
    return lower;
  }

  private pushResolution(): void {
    this.post?.setSettings({ resolutionScale: this.adaptive.scale * this.userScale });
  }

  private pushPost(): void {
    if (!this.post) return;
    this.post.setSettings({
      ...this.preset.post,
      enabled: this.postFx,
      resolutionScale: this.adaptive.scale * this.userScale,
    });
  }
}
