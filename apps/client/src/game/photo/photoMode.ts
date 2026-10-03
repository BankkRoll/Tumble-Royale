/**
 * Photo mode (client only).
 *
 * Responsibilities:
 * - render the live view through a free orbit camera of its own (the view's
 *   camera keeps doing its job underneath, so leaving restores it exactly);
 * - read mouse drag / wheel, WASD + Q/E, gamepad sticks/triggers/bumpers and
 *   one/two-finger touch into {@link PhotoControls};
 * - apply the UI's FOV and filter (CSS filter on the canvas while composing,
 *   the same filter baked into the saved image);
 * - capture the frame right after it renders (the drawing buffer is still
 *   valid within the same task on WebGL and WebGPU, so no
 *   `preserveDrawingBuffer`) and download it as a PNG with an optional logo.
 *
 * The scene keeps running: rounds never pause for one player.
 */
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { fonts, ui } from '@tumble/ui';
import type { PostPipeline } from '@tumble/render/post';
import { firstStandardPad, PAD_BUTTON } from '../../input/gamepadNav.ts';
import { radialDeadzone } from '../../input/inputSystem.ts';
import type { GameView } from '../views/types.ts';
import type { SceneDirector } from '../views/sceneDirector.ts';
import {
  NO_PHOTO_CONTROLS,
  PHOTO_FILTERS,
  photoCameraPosition,
  photoFilename,
  photoStateFromCamera,
  stepPhotoCamera,
  type PhotoCameraState,
  type PhotoControls,
  type Vec3Like,
} from './photoCamera.ts';

/** Radians of orbit per CSS pixel of drag. */
const DRAG_RAD = 0.006;
/** Focus speed (m/s) for keys and the left stick, scaled by distance. */
const MOVE_SPEED = 6;
/** Orbit speed (rad/s) at full right-stick tilt. */
const STICK_ORBIT = 2.4;

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1],
  KeyS: [0, 0, -1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyQ: [0, -1, 0],
  KeyE: [0, 1, 0],
};

/**
 * Free camera, filters and capture for the active view.
 *
 * @example
 * const photo = new PhotoMode(canvas, post, director);
 * photo.enter();
 * // per frame
 * photo.update(realDt); post.render(); photo.afterRender();
 */
export class PhotoMode {
  private view: GameView | null = null;
  private readonly camera = new PerspectiveCamera(50, 1, 0.05, 2000);
  private state: PhotoCameraState | null = null;
  private anchor: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pending: PhotoControls = { ...NO_PHOTO_CONTROLS };
  private capturePending = false;
  private readonly unlisten: (() => void)[] = [];
  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();
  private readonly stick = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly post: PostPipeline,
    private readonly director: SceneDirector,
  ) {}

  /** Whether photo mode is running. */
  get active(): boolean {
    return this.view !== null;
  }

  /**
   * Starts photo mode on the current view.
   *
   * @returns False when there is no 3D view to photograph.
   */
  enter(): boolean {
    const view = this.director.view;
    // The replay viewer owns the camera, keys and pad while it is open.
    if (!view || this.view || ui.getState().replay !== null) return false;
    this.view = view;
    const src = view.camera;
    src.getWorldPosition(this.tmp);
    src.getWorldDirection(this.fwd);
    this.state = photoStateFromCamera(this.tmp, this.fwd, src.fov);
    this.anchor = { ...this.state.target };
    this.camera.near = src.near;
    this.camera.far = src.far;
    this.post.setView(view.scene, this.camera);
    if (document.pointerLockElement) document.exitPointerLock();
    ui.getState().setPhoto({ active: true, fov: Math.round(src.fov) });
    this.listen();
    this.apply();
    return true;
  }

  /** Leaves photo mode and hands rendering back to the view's camera. */
  exit(): void {
    const view = this.view;
    if (!view) return;
    this.view = null;
    this.state = null;
    for (const u of this.unlisten.splice(0)) u();
    this.keys.clear();
    this.pointers.clear();
    this.capturePending = false;
    this.canvas.style.filter = '';
    // A view swap while composing already pointed the pipeline at the new view.
    if (this.director.view === view) this.post.setView(view.scene, view.camera);
    ui.getState().setPhoto({ active: false });
  }

  /** Saves the next rendered frame. */
  capture(): void {
    if (this.view) this.capturePending = true;
  }

  /**
   * Advances the camera. Call once per frame before rendering.
   *
   * @param dt - Real frame time (s).
   */
  update(dt: number): void {
    const s = this.state;
    if (!this.view || !s) return;
    // The show moved on (next screen swapped the scene): nothing left to photograph.
    if (this.director.view !== this.view) {
      this.exit();
      return;
    }
    const c = this.pending;
    const speed = MOVE_SPEED * Math.max(0.6, s.distance / 6) * dt;
    for (const code of this.keys) {
      const m = MOVE_KEYS[code];
      if (!m) continue;
      c.moveX += m[0] * speed;
      c.moveY += m[1] * speed;
      c.moveZ += m[2] * speed;
    }
    this.readPad(c, dt, speed);
    const ui0 = ui.getState().photo;
    s.fov = ui0.fov;
    stepPhotoCamera(s, c, this.anchor);
    if (Math.round(s.fov) !== ui0.fov) ui.getState().setPhoto({ fov: Math.round(s.fov) });
    this.pending = { ...NO_PHOTO_CONTROLS };
    this.apply();
  }

  /** Call right after the frame rendered: performs a pending capture. */
  afterRender(): void {
    if (!this.capturePending || !this.view) return;
    this.capturePending = false;
    const p = ui.getState().photo;
    void savePhoto(this.canvas, PHOTO_FILTERS[p.filter], p.watermark).then(
      () => ui.getState().pushToast({ kind: 'success', title: 'Photo saved', icon: '📸', durationMs: 2200 }),
      () => ui.getState().pushToast({ kind: 'warning', title: "Couldn't save the photo", durationMs: 3000 }),
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private apply(): void {
    const s = this.state;
    if (!s) return;
    const cam = this.camera;
    photoCameraPosition(s, cam.position);
    cam.lookAt(s.target.x, s.target.y, s.target.z);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (cam.fov !== s.fov || cam.aspect !== w / h) {
      cam.fov = s.fov;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    const filter = PHOTO_FILTERS[ui.getState().photo.filter];
    const css = filter === 'none' ? '' : filter;
    if (this.canvas.style.filter !== css) this.canvas.style.filter = css;
  }

  private readPad(c: PhotoControls, dt: number, speed: number): void {
    if (typeof navigator.getGamepads !== 'function') return;
    const pad = firstStandardPad(navigator.getGamepads());
    if (!pad) return;
    const left = radialDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), 0.18, this.stick);
    c.moveX += left.x * speed;
    c.moveZ += left.y * speed;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    const right = radialDeadzone(rx, ry, 0.18, { x: 0, y: 0 });
    c.orbitYaw += right.x * STICK_ORBIT * dt;
    c.orbitPitch += right.y * STICK_ORBIT * 0.7 * dt;
    const v = (i: number): number => pad.buttons[i]?.value ?? 0;
    c.moveY += (v(PAD_BUTTON.RT) - v(PAD_BUTTON.LT)) * speed;
    const lb = pad.buttons[PAD_BUTTON.LB]?.pressed ? 1 : 0;
    const rb = pad.buttons[PAD_BUTTON.RB]?.pressed ? 1 : 0;
    c.fov += (lb - rb) * 40 * dt;
  }

  private listen(): void {
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.unlisten.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    // Capture phase, so Esc leaves photo mode before menus or the round see it.
    on(
      window,
      'keydown',
      (e) => {
        if (e.code === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.exit();
          return;
        }
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        if (MOVE_KEYS[e.code]) {
          this.keys.add(e.code);
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    on(window, 'keyup', (e) => this.keys.delete(e.code), { capture: true });
    on(window, 'blur', () => this.keys.clear());
    on(this.canvas, 'pointerdown', (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    on(this.canvas, 'pointermove', (e) => this.onPointerMove(e));
    const up = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
    };
    on(this.canvas, 'pointerup', up);
    on(this.canvas, 'pointercancel', up);
    on(
      this.canvas,
      'wheel',
      (e) => {
        e.preventDefault();
        this.pending.zoom += -Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60);
      },
      { passive: false },
    );
  }

  /**
   * One pointer orbits. Two pointers pinch to zoom and drag their midpoint to
   * move the focus (touch).
   */
  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (this.pointers.size === 1) {
      this.pending.orbitYaw += dx * DRAG_RAD;
      this.pending.orbitPitch += dy * DRAG_RAD;
    } else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0) this.pending.zoom += Math.log(after / before) / Math.log(1 / 0.9);
        const k = (this.state?.distance ?? 6) * 0.0015;
        // Half the finger's motion, since the midpoint moves half as far.
        this.pending.moveX -= dx * k * 0.5;
        this.pending.moveZ += dy * k * 0.5;
      }
    }
    prev.x = e.clientX;
    prev.y = e.clientY;
  }
}

/**
 * Copies the canvas (with the filter baked in and an optional logo) into a
 * PNG and downloads it.
 */
async function savePhoto(source: HTMLCanvasElement, filter: string, watermark: boolean): Promise<void> {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.filter = filter;
  ctx.drawImage(source, 0, 0, w, h);
  ctx.filter = 'none';
  if (watermark) drawWatermark(ctx, w, h);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('encode failed');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = photoFilename(new Date());
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The TUMBLE ROYALE sticker wordmark in the bottom-right corner. */
function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.045));
  const pad = size * 0.8;
  ctx.save();
  ctx.translate(w - pad, h - pad);
  ctx.rotate(-0.05);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.font = `${size}px ${fonts.display}`;
  const line = (text: string, y: number, fill: string): void => {
    ctx.lineWidth = size * 0.28;
    ctx.strokeStyle = '#2b1a5e';
    ctx.strokeText(text, 0, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, y);
  };
  ctx.globalAlpha = 0.92;
  line('ROYALE', 0, '#ffd23f');
  line('TUMBLE', -size * 0.95, '#ffffff');
  ctx.restore();
}
