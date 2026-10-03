/**
 * Scene director: owns the active {@link GameView}, swaps views (normally
 * while the Tumble Wipe covers the screen), points the post pipeline at the
 * new scene/grade, and disposes the old view so GPU memory never accumulates.
 */
import { Vector3 } from 'three/webgpu';
import type { PostPipeline } from '@tumble/render/post';
import type { GameView } from './types.ts';

const UP = new Vector3(0, 1, 0);

/**
 * Holds exactly one live view at a time.
 *
 * @example
 * director.show(new MenuView(...));
 * // per frame
 * director.update(dt, realDt); post.render();
 */
export class SceneDirector {
  private current: GameView | null = null;
  private overlay: GameView | null = null;
  private readonly afterSwap: (() => void)[] = [];
  private width = 1;
  private height = 1;
  /** Camera position/forward/up of the active view (audio listener). */
  readonly listenerPos = new Vector3();
  readonly listenerFwd = new Vector3(0, 0, -1);
  readonly listenerUp = UP.clone();

  constructor(private readonly post: PostPipeline) {}

  /** The live view, or null before boot finishes. */
  get view(): GameView | null {
    return this.current;
  }

  /** Kind of the live view (`none` before the first). */
  get kind(): string {
    return this.overlay?.kind ?? this.current?.kind ?? 'none';
  }

  /** The view drawn over the live one (replay viewer), or null. */
  get overlayView(): GameView | null {
    return this.overlay;
  }

  /**
   * Draws `view` instead of the live view until {@link clearOverlay}. The live
   * view is kept (and keeps being swapped by the show) but is neither updated
   * nor rendered meanwhile.
   *
   * @param view - The overlay (ownership transfers to the director).
   */
  showOverlay(view: GameView): void {
    if (this.overlay && this.overlay !== view) this.overlay.dispose();
    this.overlay = view;
    view.resize(this.width, this.height);
    this.post.setView(view.scene, view.camera);
    this.post.setGrade(view.grade);
  }

  /** Disposes the overlay and returns the screen to the live view. */
  clearOverlay(): void {
    const o = this.overlay;
    if (!o) return;
    this.overlay = null;
    const v = this.current;
    if (v) {
      v.resize(this.width, this.height);
      this.post.setView(v.scene, v.camera);
      this.post.setGrade(v.grade);
    }
    o.dispose();
  }

  /**
   * Activates `view`, disposing the previous one.
   *
   * @param view - The new view (ownership transfers to the director).
   */
  show(view: GameView): void {
    const prev = this.current;
    this.current = view;
    view.resize(this.width, this.height);
    if (!this.overlay) {
      this.post.setView(view.scene, view.camera);
      this.post.setGrade(view.grade);
    }
    if (prev && prev !== view) prev.dispose();
    const pending = this.afterSwap.splice(0);
    for (const fn of pending) fn();
  }

  /**
   * Runs `fn` right after the next view swap (once the outgoing view is
   * disposed): resources the outgoing view still renders must outlive it.
   *
   * @param fn - Cleanup to defer.
   */
  deferUntilSwap(fn: () => void): void {
    this.afterSwap.push(fn);
  }

  /** Re-applies the grade of the active view (theme or weather changed). */
  refreshGrade(): void {
    const v = this.overlay ?? this.current;
    if (v) this.post.setGrade(v.grade);
  }

  /** Disposes the active view (show teardown). */
  clear(): void {
    this.clearOverlay();
    this.current?.dispose();
    this.current = null;
  }

  /** Propagates a canvas resize. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.current?.resize(width, height);
    this.overlay?.resize(width, height);
  }

  /**
   * Updates the active view and refreshes the audio listener from its camera.
   *
   * @param dt - Scaled delta (s).
   * @param realDt - Unscaled delta (s).
   */
  update(dt: number, realDt: number): void {
    const v = this.overlay ?? this.current;
    if (!v) return;
    v.update(dt, realDt);
    const cam = v.camera;
    cam.getWorldPosition(this.listenerPos);
    cam.getWorldDirection(this.listenerFwd);
    this.listenerUp.copy(UP).applyQuaternion(cam.quaternion);
  }
}
