/**
 * Touch input model fed by the HUD's on-screen controls.
 *
 * The React HUD (`@tumble/ui` `TouchControls`) owns the touch surface: the
 * floating joystick, the action buttons and the camera-drag area. It reports
 * level snapshots through the `touchInput` intent and drag deltas through
 * `touchLook`; this model turns those into the same latches and look deltas
 * the keyboard and gamepad produce, so a tap shorter than a sim step is never
 * lost.
 */
import { ButtonLatch } from './latch.ts';

/** Action buttons on the touch HUD. */
export type TouchButton = 'jump' | 'dive' | 'grab' | 'emote';

/** One `touchInput` snapshot from the HUD. */
export interface TouchSnapshot {
  /** Joystick vector, x right / y forward, magnitude ≤ 1. */
  move: { x: number; y: number };
  jump: boolean;
  dive: boolean;
  grab: boolean;
  /** Emote wheel button held (optional: the HUD toggles the wheel itself). */
  emote?: boolean;
}

const BUTTONS: readonly TouchButton[] = ['jump', 'dive', 'grab', 'emote'];

/**
 * Latched touch state, sampled by the input system each fixed step.
 *
 * @example
 * const t = new TouchState();
 * t.apply({ move: { x: 0, y: 1 }, jump: true, dive: false, grab: false });
 * t.buttons.jump.sample(); // true
 */
export class TouchState {
  /** Joystick vector, x right / y forward, magnitude ≤ 1. */
  readonly stick = { x: 0, y: 0 };
  /** Button latches. */
  readonly buttons: Record<TouchButton, ButtonLatch> = {
    jump: new ButtonLatch(),
    dive: new ButtonLatch(),
    grab: new ButtonLatch(),
    emote: new ButtonLatch(),
  };
  /** Accumulated camera drag in CSS pixels since the last read. */
  lookDx = 0;
  lookDy = 0;
  private readonly held: Record<TouchButton, boolean> = {
    jump: false,
    dive: false,
    grab: false,
    emote: false,
  };

  /**
   * Applies a HUD snapshot: buttons that changed press or release their latch.
   *
   * @param s - Snapshot from the `touchInput` intent.
   * @returns True when anything is active (stick deflected or a button held).
   */
  apply(s: TouchSnapshot): boolean {
    const x = Number.isFinite(s.move.x) ? s.move.x : 0;
    const y = Number.isFinite(s.move.y) ? s.move.y : 0;
    const len = Math.hypot(x, y);
    // The HUD clamps already; this guards against a stale or synthetic payload.
    const k = len > 1 ? 1 / len : 1;
    this.stick.x = x * k;
    this.stick.y = y * k;
    let any = len > 0;
    for (const b of BUTTONS) {
      const down = b === 'emote' ? (s.emote ?? false) : s[b];
      any ||= down;
      if (down === this.held[b]) continue;
      this.held[b] = down;
      if (down) this.buttons[b].press();
      else this.buttons[b].release();
    }
    return any;
  }

  /**
   * Adds a camera drag.
   *
   * @param dx - CSS pixels right.
   * @param dy - CSS pixels down.
   */
  addLook(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.lookDx += dx;
    if (Number.isFinite(dy)) this.lookDy += dy;
  }

  /** Releases everything (blur, menus). */
  reset(): void {
    this.stick.x = 0;
    this.stick.y = 0;
    this.lookDx = 0;
    this.lookDy = 0;
    for (const b of BUTTONS) {
      this.held[b] = false;
      this.buttons[b].reset();
    }
  }
}
