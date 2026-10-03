/**
 * Scene director: owns the active {@link GameView}, swaps views (normally
 * while the Tumble Wipe covers the screen), points the post pipeline at the
 * new scene/grade, and disposes the old view so GPU memory never accumulates.
 *
 * While an opaque loading screen hides the canvas the director is
 * {@link SceneDirector.covered}: the app skips updating and rendering the 3D
 * view, and the next view can be precompiled ({@link SceneDirector.precompile})
 * so its first visible frame does not hitch.
 */
import { PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { NEUTRAL_GRADE, disableFrustumCulling, type PostPipeline } from '@tumble/render/post';
import type { GameView } from './types.ts';

const UP = new Vector3(0, 1, 0);

/** An empty stand-in shown while the next view loads, so the previous one can be freed first. */
class LoadingView implements GameView {
  readonly kind = 'loading';
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  readonly grade = NEUTRAL_GRADE;
  update(): void {}
  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
  dispose(): void {}
}

/**
 * Holds exactly one live view at a time.
 *
 * @example
 * director.show(new MenuView(...));
 * // per frame
 * if (!director.covered) { director.update(dt, realDt); post.render(); }
 */
export class SceneDirector {
  private current: GameView | null = null;
  private overlay: GameView | null = null;
  private readonly afterSwap: (() => void)[] = [];
  private width = 1;
  private height = 1;
  private hidden = false;
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

  /** True while a loading screen hides the canvas: skip update and render. */
  get covered(): boolean {
    return this.hidden;
  }

  /**
   * Activates `view`, disposing the previous one, and resumes rendering.
   *
   * @param view - The new view (ownership transfers to the director).
   */
  show(view: GameView): void {
    this.hidden = false;
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
   * Frees the current view and stops rendering until {@link reveal}: call
   * once an opaque loading screen covers the canvas, before building the next
   * view, so the old scene's GPU memory is gone before the new one allocates.
   */
  showLoading(): void {
    if (this.current?.kind !== 'loading') this.show(new LoadingView());
    this.hidden = true;
  }

  /** Resumes updating and rendering (the loading screen is about to leave). */
  reveal(): void {
    this.hidden = false;
  }

  /**
   * Shows `view` while still covered, compiles its shaders and pipelines for
   * the real scene pass, then renders it once off-screen (uploads geometry
   * and textures, builds shadow pipelines) so its first visible frame is
   * cheap.
   *
   * @param view - The fully built view (ownership transfers to the director).
   * @param onProgress - Compile progress (0..1).
   */
  async precompile(view: GameView, onProgress?: (fraction: number) => void): Promise<void> {
    if (this.current !== view) this.show(view);
    this.hidden = true;
    // NOTE: renderer.compileAsync is skipped on purpose. Against the bloom pass it
    // fails on WebGPU and never settles; against the default target it took ~7 s
    // on a cold cache and did not warm the pipelines the real frames use. The
    // hidden render below builds exactly those, in a fraction of the time.
    onProgress?.(1);
    if (this.current !== view) return;
    // The loading screen hides this frame; everything in the scene is drawn once, frustum or not.
    view.camera.updateMatrixWorld();
    const restore = disableFrustumCulling(view.scene);
    try {
      this.post.render();
    } finally {
      restore();
    }
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
    this.hidden = false;
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
