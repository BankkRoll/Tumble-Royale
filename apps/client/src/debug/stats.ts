import type { WebGPURenderer } from 'three/webgpu';

/** Extra key/value rows shown under the frame stats. */
export type StatRows = Record<string, string | number>;

/**
 * Lightweight FPS / frame-time / draw-call overlay. Updates the DOM at 4 Hz so
 * the overlay itself never shows up in the frame budget.
 */
export class StatsOverlay {
  readonly el: HTMLDivElement;
  fps = 0;
  frameMs = 0;
  private frames = 0;
  private accTime = 0;
  private worstMs = 0;
  private rows: StatRows = {};

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:50;padding:6px 9px;border-radius:8px;' +
      'background:rgba(20,12,40,.62);color:#e9f3ff;font:12px/1.35 ui-monospace,Consolas,monospace;' +
      'pointer-events:none;white-space:pre;min-width:150px';
    parent.appendChild(this.el);
  }

  /** Sets a persistent extra row (e.g. backend, ping, tick time). */
  set(key: string, value: string | number): void {
    this.rows[key] = value;
  }

  /** Call once per rendered frame. */
  update(dtSeconds: number, renderer: WebGPURenderer): void {
    const ms = dtSeconds * 1000;
    this.frames++;
    this.accTime += dtSeconds;
    if (ms > this.worstMs) this.worstMs = ms;
    if (this.accTime < 0.25) return;

    this.fps = this.frames / this.accTime;
    this.frameMs = (this.accTime / this.frames) * 1000;
    const info = renderer.info.render;
    let text =
      `FPS   ${this.fps.toFixed(0)}\n` +
      `frame ${this.frameMs.toFixed(2)} ms (max ${this.worstMs.toFixed(1)})\n` +
      `draws ${info.drawCalls}  tris ${(info.triangles / 1000).toFixed(1)}k`;
    for (const [k, v] of Object.entries(this.rows)) text += `\n${k.padEnd(5)} ${v}`;
    this.el.textContent = text;

    this.frames = 0;
    this.accTime = 0;
    this.worstMs = 0;
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? 'block' : 'none';
  }
}
