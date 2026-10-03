/**
 * The contract every 3D view the game shows satisfies (menu stage, pre-show
 * arena, rounds, results backdrop, podium, player wall).
 */
import type { PerspectiveCamera, Scene } from 'three/webgpu';
import type { GradeParams } from '@tumble/render/post';

/** A renderable, updatable, disposable 3D view. */
export interface GameView {
  /** Short id for debug/hooks (`menu`, `round`, `wall`, …). */
  readonly kind: string;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Colour grade handed to the post pipeline on activation. */
  readonly grade: GradeParams;
  /**
   * Advances the view.
   *
   * @param dt - Scaled frame delta (s): time scale and slow-mo applied.
   * @param realDt - Unscaled frame delta (s), for UI-synced motion.
   */
  update(dt: number, realDt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
