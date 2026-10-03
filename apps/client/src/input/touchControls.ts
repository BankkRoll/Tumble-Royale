/**
 * Minimal on-screen touch controls: a floating virtual joystick on the left
 * half, camera drag on the right half, and Jump / Dive / Grab / Emote buttons.
 *
 * Deliberately plain DOM with inline styles; the UI team restyles it later via
 * the `data-touch` attributes. Hidden until the first touch so desktop players
 * never see it.
 */
import { ButtonLatch } from './latch.ts';

/** Buttons exposed by {@link TouchControls}. */
export type TouchButton = 'jump' | 'dive' | 'grab' | 'emote';

const JOYSTICK_RADIUS = 60;

/**
 * Touch input surface. Owns its DOM; call {@link dispose} to remove it.
 */
export class TouchControls {
  /** Joystick vector, x right / y forward, magnitude ≤ 1. */
  readonly stick = { x: 0, y: 0 };
  /** Button latches, sampled by the input system each fixed step. */
  readonly buttons: Record<TouchButton, ButtonLatch> = {
    jump: new ButtonLatch(),
    dive: new ButtonLatch(),
    grab: new ButtonLatch(),
    emote: new ButtonLatch(),
  };
  /** Accumulated camera drag in CSS pixels since the last read. */
  lookDx = 0;
  lookDy = 0;
  /** True once any touch has been seen. */
  active = false;

  private readonly root: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOx = 0;
  private stickOy = 0;
  private lookId: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private readonly unlisten: (() => void)[] = [];

  /**
   * @param surface - Element receiving joystick/look touches (usually the canvas).
   * @param parent - Where the overlay DOM is appended.
   */
  constructor(
    private readonly surface: HTMLElement,
    parent: HTMLElement = document.body,
  ) {
    this.root = document.createElement('div');
    this.root.dataset.touch = 'root';
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40;display:none;user-select:none;-webkit-user-select:none';

    this.base = document.createElement('div');
    this.base.dataset.touch = 'stick';
    this.base.style.cssText =
      `position:absolute;width:${JOYSTICK_RADIUS * 2}px;height:${JOYSTICK_RADIUS * 2}px;margin:-${JOYSTICK_RADIUS}px 0 0 -${JOYSTICK_RADIUS}px;` +
      'border-radius:50%;background:rgba(255,255,255,.18);border:3px solid rgba(255,255,255,.55);display:none';
    this.knob = document.createElement('div');
    this.knob.style.cssText =
      'position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:rgba(255,255,255,.85)';
    this.base.appendChild(this.knob);
    this.root.appendChild(this.base);

    const pad = document.createElement('div');
    pad.style.cssText =
      'position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));' +
      'display:grid;grid-template-columns:repeat(2,76px);gap:12px;pointer-events:auto';
    const mk = (name: TouchButton, label: string, color: string): void => {
      const b = document.createElement('div');
      b.dataset.touch = name;
      b.textContent = label;
      b.style.cssText =
        `width:76px;height:76px;border-radius:50%;background:${color};color:#fff;display:grid;place-items:center;` +
        'font:700 14px system-ui,sans-serif;text-shadow:0 1px 0 rgba(0,0,0,.25);box-shadow:0 4px 0 rgba(0,0,0,.18);touch-action:none';
      const latch = this.buttons[name];
      const down = (e: PointerEvent): void => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.style.transform = 'scale(.92)';
        latch.press();
      };
      const up = (e: PointerEvent): void => {
        e.preventDefault();
        b.style.transform = '';
        latch.release();
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      pad.appendChild(b);
    };
    mk('grab', 'GRAB', 'rgba(255,210,63,.85)');
    mk('emote', 'EMOTE', 'rgba(124,92,255,.8)');
    mk('dive', 'DIVE', 'rgba(255,111,181,.85)');
    mk('jump', 'JUMP', 'rgba(92,225,230,.9)');
    this.root.appendChild(pad);
    parent.appendChild(this.root);

    const onDown = (e: PointerEvent): void => this.onDown(e);
    const onMove = (e: PointerEvent): void => this.onMove(e);
    const onUp = (e: PointerEvent): void => this.onUp(e);
    surface.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    this.unlisten.push(
      () => surface.removeEventListener('pointerdown', onDown),
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onUp),
    );
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    if (!this.active) {
      this.active = true;
      this.root.style.display = 'block';
    }
    const rect = this.surface.getBoundingClientRect();
    const leftHalf = e.clientX - rect.left < rect.width / 2;
    if (leftHalf && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOx = e.clientX;
      this.stickOy = e.clientY;
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.style.display = 'block';
      this.setKnob(0, 0);
    } else if (!leftHalf && this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.stickOx;
      let dy = e.clientY - this.stickOy;
      const l = Math.hypot(dx, dy);
      if (l > JOYSTICK_RADIUS) {
        // Drag the joystick origin along so reversing direction is instant.
        this.stickOx += (dx / l) * (l - JOYSTICK_RADIUS);
        this.stickOy += (dy / l) * (l - JOYSTICK_RADIUS);
        this.base.style.left = `${this.stickOx}px`;
        this.base.style.top = `${this.stickOy}px`;
        dx = (dx / l) * JOYSTICK_RADIUS;
        dy = (dy / l) * JOYSTICK_RADIUS;
      }
      this.stick.x = dx / JOYSTICK_RADIUS;
      this.stick.y = -dy / JOYSTICK_RADIUS;
      this.setKnob(dx, dy);
    } else if (e.pointerId === this.lookId) {
      this.lookDx += e.clientX - this.lookX;
      this.lookDy += e.clientY - this.lookY;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stick.x = 0;
      this.stick.y = 0;
      this.base.style.display = 'none';
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }

  private setKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Releases everything (e.g. on blur). */
  reset(): void {
    this.stickId = null;
    this.lookId = null;
    this.stick.x = 0;
    this.stick.y = 0;
    this.base.style.display = 'none';
    for (const b of Object.values(this.buttons)) b.reset();
  }

  /** Removes DOM and listeners. */
  dispose(): void {
    for (const u of this.unlisten) u();
    this.root.remove();
  }
}
