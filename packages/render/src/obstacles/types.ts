import type { Object3D } from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime, ObstacleType } from '@tumble/sim';
import type { ThemeId } from '@tumble/shared';

/** Context handed to obstacle visual factories. */
export interface ObstacleVisualContext {
  theme: ThemeId;
  /** Same speed scale the sim uses, so visuals mirror `pose(t)` exactly. */
  speedScale: number;
  /** Show seed, for seeded visual layouts (door gauntlet) that must match the sim. */
  seed: number;
}

/**
 * Renderable mirror of an obstacle. Moving parts are posed from the sim
 * module's pure `pose(t)`, so visuals never need network state for them.
 */
export interface ObstacleVisual {
  readonly object: Object3D;
  /**
   * @param t - Match time in seconds (same clock as the sim).
   * @param dt - Frame delta for purely cosmetic motion (particles, wobble).
   * @param runtime - The predicted/replicated runtime, for non-pure state (tiles, doors, tilt).
   */
  update(t: number, dt: number, runtime?: ObstacleRuntime): void;
  dispose(): void;
}

/** Creates a visual for one placed obstacle. */
export type ObstacleVisualFactory = (
  instance: ObstacleInstance,
  ctx: ObstacleVisualContext,
) => ObstacleVisual;

/** Visual factories keyed by obstacle type. Each obstacle set exports a partial map. */
export type ObstacleVisualSet = Partial<Record<ObstacleType, ObstacleVisualFactory>>;
