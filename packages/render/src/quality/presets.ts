import type { WebGPURenderer } from 'three/webgpu';
import type { GeometryDetail } from '../level/geometry.ts';
import type { ShadowMode } from '../environment/lighting.ts';
import type { EnvironmentDetail } from '../environment/environment.ts';
import type { PostSettings } from '../post/pipeline.ts';

/**
 * Quality presets: one table that every rendering subsystem reads, so a tier
 * switch (manual, benchmark, or adaptive fallback) is a single source of truth.
 */

/** Graphics tiers. `auto` resolves to one of the others via the benchmark. */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

/** User-facing setting (includes `auto`). */
export type QualitySetting = QualityTier | 'auto';

/** Every concrete tier in ascending cost. */
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/** Everything a tier controls. */
export interface QualityPreset {
  tier: QualityTier;
  /** Upper bound for `devicePixelRatio`. */
  maxPixelRatio: number;
  /** Starting scene-pass resolution scale; adaptive resolution moves within [minRenderScale, 1]. */
  renderScale: number;
  minRenderScale: number;
  shadows: ShadowMode;
  shadowMapSize: number;
  cascades: number;
  /** `single`: half extent (m). `csm`: max far (m). */
  shadowDistance: number;
  post: PostSettings;
  geometryDetail: GeometryDetail;
  environment: EnvironmentDetail;
  vfx: { particles: number; confetti: number; trails: number; shadows: number };
  /** Character LOD switch distances (m): LOD0 → LOD1 at `[0]`, LOD1 → LOD2 at `[1]`. */
  lodDistances: [number, number];
  /** Max simultaneous cosmetic ragdolls (spec: 8 near camera at most). */
  maxRagdolls: number;
  /** Target frame time for adaptive resolution (ms). */
  targetFrameMs: number;
}

/** Preset table. */
export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualityPreset>> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    renderScale: 0.8,
    minRenderScale: 0.55,
    shadows: 'off',
    shadowMapSize: 1024,
    cascades: 1,
    shadowDistance: 24,
    post: { enabled: true, aa: 'fxaa', bloom: false, outline: false, chromatic: false, resolutionScale: 0.8 },
    geometryDetail: 0,
    environment: {
      clouds: 16,
      islands: 6,
      balloons: 12,
      blimps: 1,
      crowd: false,
      precipitation: 600,
      streaks: 50,
    },
    vfx: { particles: 1024, confetti: 400, trails: 4, shadows: 40 },
    lodDistances: [10, 22],
    maxRagdolls: 2,
    targetFrameMs: 1000 / 30,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    renderScale: 1,
    minRenderScale: 0.6,
    shadows: 'single',
    shadowMapSize: 2048,
    cascades: 1,
    shadowDistance: 34,
    post: { enabled: true, aa: 'fxaa', bloom: true, outline: false, chromatic: true, resolutionScale: 1 },
    geometryDetail: 1,
    environment: {
      clouds: 30,
      islands: 12,
      balloons: 30,
      blimps: 2,
      crowd: true,
      precipitation: 1800,
      streaks: 120,
    },
    vfx: { particles: 3072, confetti: 1000, trails: 8, shadows: 64 },
    lodDistances: [16, 34],
    maxRagdolls: 4,
    targetFrameMs: 1000 / 60,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    renderScale: 1,
    minRenderScale: 0.7,
    shadows: 'csm',
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 160,
    post: { enabled: true, aa: 'smaa', bloom: true, outline: false, chromatic: true, resolutionScale: 1 },
    geometryDetail: 1,
    environment: {
      clouds: 40,
      islands: 16,
      balloons: 45,
      blimps: 3,
      crowd: true,
      precipitation: 3000,
      streaks: 180,
    },
    vfx: { particles: 6144, confetti: 1800, trails: 12, shadows: 64 },
    lodDistances: [24, 48],
    maxRagdolls: 8,
    targetFrameMs: 1000 / 60,
  },
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2,
    renderScale: 1,
    minRenderScale: 0.8,
    shadows: 'csm',
    shadowMapSize: 4096,
    cascades: 3,
    shadowDistance: 220,
    post: { enabled: true, aa: 'smaa', bloom: true, outline: false, chromatic: true, resolutionScale: 1 },
    geometryDetail: 2,
    environment: {
      clouds: 52,
      islands: 22,
      balloons: 60,
      blimps: 4,
      crowd: true,
      precipitation: 4500,
      streaks: 240,
    },
    vfx: { particles: 8192, confetti: 2500, trails: 16, shadows: 64 },
    lodDistances: [32, 64],
    maxRagdolls: 8,
    targetFrameMs: 1000 / 60,
  },
};

/**
 * Returns the preset for a tier (a fresh deep-ish copy so callers may tweak it).
 *
 * @param tier - Tier id.
 */
export function getQualityPreset(tier: QualityTier): QualityPreset {
  const p = QUALITY_PRESETS[tier];
  return {
    ...p,
    post: { ...p.post },
    environment: { ...p.environment },
    vfx: { ...p.vfx },
    lodDistances: [...p.lodDistances],
  };
}

/**
 * Applies the renderer-level parts of a preset (pixel ratio, shadow map on/off).
 *
 * @param renderer - Renderer.
 * @param preset - Preset.
 * @param devicePixelRatio - Defaults to `window.devicePixelRatio`.
 */
export function applyQualityToRenderer(
  renderer: WebGPURenderer,
  preset: QualityPreset,
  devicePixelRatio?: number,
): void {
  const dpr = devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  renderer.setPixelRatio(Math.min(dpr, preset.maxPixelRatio));
  renderer.shadowMap.enabled = preset.shadows !== 'off';
}

/**
 * Picks a tier from a benchmark frame time (ms per frame of the stress scene at 720p).
 *
 * @param avgMs - Mean frame time.
 * @param mobile - Touch-first device; capped at `medium` to protect battery and heat.
 */
export function tierFromFrameTime(avgMs: number, mobile = false): QualityTier {
  let tier: QualityTier;
  if (avgMs < 3.5) tier = 'ultra';
  else if (avgMs < 6.5) tier = 'high';
  else if (avgMs < 12) tier = 'medium';
  else tier = 'low';
  if (mobile && (tier === 'high' || tier === 'ultra')) tier = 'medium';
  return tier;
}
