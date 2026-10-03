/**
 * Client input system.
 *
 * Responsibilities:
 * - Keyboard + mouse (pointer lock), standard-mapping gamepads and touch, merged
 *   into one `CharacterInput` per fixed simulation step.
 * - Edge-safe buttons: presses are latched between steps so taps are never lost.
 * - Camera look deltas per rendered frame (mouse, right stick, touch drag) with
 *   sensitivity and invert-Y.
 * - Rebindable keymap.
 *
 * The sim never sees devices: humans, bots and replays all produce the same
 * `CharacterInput`.
 */
import { Button, type CharacterInput } from '@tumble/sim/character';
import { ButtonLatch } from './latch.ts';
import { createKeymap, mouseCode, INPUT_ACTIONS, type InputAction, type Keymap } from './keymap.ts';
import { TouchControls } from './touchControls.ts';

/** Input tuning. Mutate in place; read every frame. */
export interface InputSettings {
  /** Global look sensitivity multiplier. */
  sensitivity: number;
  /** Invert vertical look for every device. */
  invertY: boolean;
  /** Radians of yaw per pixel of mouse movement (before `sensitivity`). */
  mouseRadPerPixel: number;
  /** Max look speed from the right stick (rad/s, before `sensitivity`). */
  gamepadLookSpeed: number;
  /** Radians per CSS pixel of touch drag (before `sensitivity`). */
  touchRadPerPixel: number;
  /** Radial deadzone for both sticks, 0–1. */
  stickDeadzone: number;
  /** Lock the pointer on click (desktop). */
  pointerLock: boolean;
}

/** Defaults tuned for a 1080p mouse at ~800 DPI and a standard controller. */
export const DEFAULT_INPUT_SETTINGS: Readonly<InputSettings> = Object.freeze({
  sensitivity: 1,
  invertY: false,
  mouseRadPerPixel: 0.0024,
  gamepadLookSpeed: 2.8,
  touchRadPerPixel: 0.006,
  stickDeadzone: 0.18,
  pointerLock: true,
});

/** Keys that mean "I'm playing now" and may grab the mouse for the camera. */
const LOCK_ON_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'dive',
]);

/** HUD elements that keep their clicks instead of locking the pointer. */
const UI_CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="dialog"], [data-nav]';

/** Which device produced the most recent meaningful input (for UI prompts). */
export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

/** Camera look delta for one rendered frame. Positive yaw turns right, positive pitch looks down. */
export interface LookDelta {
  yaw: number;
  pitch: number;
}

/** Standard-mapping gamepad button indices. */
const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

const MOVE_ACTIONS: readonly InputAction[] = ['forward', 'back', 'left', 'right'];

const PREVENT_DEFAULT_CODES = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/**
 * Merges every input device into fixed-step `CharacterInput`s and per-frame look deltas.
 *
 * @example
 * const input = new InputSystem({ element: canvas });
 * // per rendered frame
 * const look = input.readLook(dt); rig.addLook(look.yaw, look.pitch);
 * // per fixed step
 * input.sample(rig.yaw, playerInput);
 */
export class InputSystem {
  readonly settings: InputSettings;
  /** Live keymap; prefer {@link setBinding} so held keys are released cleanly. */
  readonly keymap: Keymap;
  /** Touch overlay (created lazily on the first touch-capable pointer). */
  readonly touch: TouchControls | null;
  /** Device of the last meaningful input. */
  lastDevice: InputDevice = 'keyboard';

  private readonly element: HTMLElement;
  private readonly kb = new Map<InputAction, ButtonLatch>();
  private readonly pad = new Map<InputAction, ButtonLatch>();
  private codeToActions = new Map<string, InputAction[]>();
  private readonly downCodes = new Set<string>();
  private mouseDx = 0;
  private mouseDy = 0;
  private readonly lastEmoteOut = [false, false, false, false];
  private readonly padPrev: boolean[] = [];
  private padStick = { x: 0, y: 0 };
  private readonly padLook = { x: 0, y: 0 };
  private readonly look: LookDelta = { yaw: 0, pitch: 0 };
  private readonly unlisten: (() => void)[] = [];
  private mouseActions = true;

  /**
   * @param opts.element - Focus/pointer-lock target, usually the game canvas.
   * @param opts.touchParent - Where touch controls are mounted.
   * @param opts.keymap - Binding overrides.
   * @param opts.settings - Setting overrides.
   * @param opts.enableTouch - Create touch controls (default: when the device reports touch support).
   */
  constructor(opts: {
    element: HTMLElement;
    touchParent?: HTMLElement;
    keymap?: Partial<Keymap>;
    settings?: Partial<InputSettings>;
    enableTouch?: boolean;
  }) {
    this.element = opts.element;
    this.settings = { ...DEFAULT_INPUT_SETTINGS, ...opts.settings };
    this.keymap = createKeymap(opts.keymap);
    for (const a of INPUT_ACTIONS) {
      this.kb.set(a, new ButtonLatch());
      this.pad.set(a, new ButtonLatch());
    }
    this.rebuildCodeIndex();

    const touchCapable =
      opts.enableTouch ?? (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    this.touch = touchCapable ? new TouchControls(this.element, opts.touchParent) : null;

    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.listen(this.element, 'mousedown', (e) => this.onMouseButton(e as MouseEvent, true));
    this.listen(window, 'mousedown', (e) => this.onWindowMouseDown(e as MouseEvent));
    this.listen(window, 'mouseup', (e) => this.onMouseButton(e as MouseEvent, false));
    this.listen(window, 'mousemove', (e) => this.onMouseMove(e as MouseEvent));
    this.listen(this.element, 'contextmenu', (e) => e.preventDefault());
    this.listen(document, 'pointerlockchange', () => {
      if (document.pointerLockElement !== this.element) this.releaseMouseButtons();
    });
  }

  /** Whether the pointer is currently locked to the game element. */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /** False while menus suppress mouse gameplay (see {@link setMouseActions}). */
  get mouseActionsEnabled(): boolean {
    return this.mouseActions;
  }

  /**
   * Menu mode switch. With mouse actions off, mouse buttons never press
   * gameplay actions, the pointer is never locked and mouse look is ignored;
   * keyboard, gamepad and touch keep working. Shows keep the default (on).
   *
   * @param enabled - False in menus, true in shows.
   * @example
   * input.setMouseActions(false); // main menu lobby
   */
  setMouseActions(enabled: boolean): void {
    if (enabled === this.mouseActions) return;
    this.mouseActions = enabled;
    if (enabled) return;
    this.releaseMouseButtons();
    this.mouseDx = 0;
    this.mouseDy = 0;
    if (this.pointerLocked) document.exitPointerLock();
  }

  /**
   * Whether a movement key is held right now (WASD/arrows as bound).
   *
   * @param ignoreArrows - Skip arrow keys (menus use them for focus navigation).
   * @returns True when any bound movement key is down.
   */
  movementKeyHeld(ignoreArrows = false): boolean {
    for (const a of MOVE_ACTIONS) {
      for (const code of this.keymap[a]) {
        if (ignoreArrows && code.startsWith('Arrow')) continue;
        if (this.downCodes.has(code)) return true;
      }
    }
    return false;
  }

  /** Whether the emote wheel key/button is held (UI shows the wheel). */
  get emoteWheelOpen(): boolean {
    return (
      (this.kb.get('emoteWheel')?.down ?? false) ||
      (this.pad.get('emoteWheel')?.down ?? false) ||
      (this.touch?.buttons.emote.down ?? false)
    );
  }

  /**
   * Rebinds an action. Keys currently held for the old binding are released.
   *
   * @example
   * input.setBinding('dive', ['KeyC', 'Mouse0']);
   */
  setBinding(action: InputAction, codes: string[]): void {
    this.keymap[action] = [...codes];
    this.releaseAll();
    this.rebuildCodeIndex();
  }

  /**
   * Fills `out` for one fixed simulation step. Call exactly once per step.
   *
   * @param yaw - Camera yaw (the rig's `yaw`).
   * @param out - Input object to fill (reused; never allocated here).
   * @returns `out`.
   */
  sample(yaw: number, out: CharacterInput): CharacterInput {
    this.pollGamepad();
    const kb = (a: InputAction): ButtonLatch => this.kb.get(a)!;
    const pad = (a: InputAction): ButtonLatch => this.pad.get(a)!;

    // Movement: the strongest device wins so a resting stick never cancels the keyboard.
    let mx = (kb('right').down ? 1 : 0) - (kb('left').down ? 1 : 0);
    let mz = (kb('forward').down ? 1 : 0) - (kb('back').down ? 1 : 0);
    const kl = Math.hypot(mx, mz);
    if (kl > 1) {
      mx /= kl;
      mz /= kl;
    }
    const pl = Math.hypot(this.padStick.x, this.padStick.y);
    if (pl > Math.hypot(mx, mz)) {
      mx = this.padStick.x;
      mz = this.padStick.y;
    }
    const t = this.touch;
    if (t && Math.hypot(t.stick.x, t.stick.y) > Math.hypot(mx, mz)) {
      mx = t.stick.x;
      mz = t.stick.y;
      this.lastDevice = 'touch';
    }
    out.moveX = mx;
    out.moveZ = mz;
    out.yaw = yaw;

    let b = 0;
    // Every latch is sampled every step (no short-circuit) so none keeps stale edges.
    const jump = [kb('jump').sample(), pad('jump').sample(), t?.buttons.jump.sample() ?? false];
    const dive = [kb('dive').sample(), pad('dive').sample(), t?.buttons.dive.sample() ?? false];
    const grab = [kb('grab').sample(), pad('grab').sample(), t?.buttons.grab.sample() ?? false];
    const wheel = [kb('emoteWheel').sample(), pad('emoteWheel').sample(), t?.buttons.emote.sample() ?? false];
    if (jump.includes(true)) b |= Button.Jump;
    if (dive.includes(true)) b |= Button.Dive;
    if (grab.includes(true)) b |= Button.Grab;
    if (wheel.includes(true)) b |= Button.Emote;
    out.buttons = b;

    // Emotes fire on the press edge only; holding a number key does not loop the emote.
    out.emote = 0;
    const slots: InputAction[] = ['emote1', 'emote2', 'emote3', 'emote4'];
    for (let i = 0; i < 4; i++) {
      const a = slots[i]!;
      const on = kb(a).sample() || pad(a).sample();
      if (on && !this.lastEmoteOut[i] && out.emote === 0) out.emote = i + 1;
      this.lastEmoteOut[i] = on;
    }
    return out;
  }

  /**
   * Camera look delta accumulated since the last call. Call once per rendered
   * frame. Positive yaw turns right, positive pitch looks down.
   *
   * @param dt - Frame delta (s), for rate-based stick look.
   * @returns A reused object; copy if you need to keep it.
   */
  readLook(dt: number): LookDelta {
    const s = this.settings;
    this.pollGamepad();
    const inv = s.invertY ? -1 : 1;
    let yaw = this.mouseDx * s.mouseRadPerPixel;
    let pitch = this.mouseDy * s.mouseRadPerPixel;
    this.mouseDx = 0;
    this.mouseDy = 0;
    // Squared response gives fine aim near centre and fast turns at full tilt.
    const lx = this.padLook.x;
    const ly = this.padLook.y;
    yaw += Math.sign(lx) * lx * lx * s.gamepadLookSpeed * dt;
    pitch += Math.sign(ly) * ly * ly * s.gamepadLookSpeed * 0.7 * dt;
    const t = this.touch;
    if (t) {
      yaw += t.lookDx * s.touchRadPerPixel;
      pitch += t.lookDy * s.touchRadPerPixel;
      t.lookDx = 0;
      t.lookDy = 0;
    }
    this.look.yaw = yaw * s.sensitivity;
    this.look.pitch = pitch * s.sensitivity * inv;
    return this.look;
  }

  /**
   * Releases every held key and button. Call when focus moves to a text field
   * (chat): its keyup never reaches the game, so a held W would stay pressed.
   */
  releaseKeys(): void {
    this.releaseAll();
  }

  /** Requests pointer lock (must be called from a user gesture). */
  lockPointer(): void {
    if (!this.mouseActions || this.pointerLocked) return;
    // NOTE: browsers refuse a re-lock for about a second after Esc releases it; a later key or click retries.
    const req = this.element.requestPointerLock?.() as Promise<void> | undefined;
    req?.catch?.(() => undefined);
  }

  /** Removes all listeners and touch DOM. */
  dispose(): void {
    for (const u of this.unlisten) u();
    this.unlisten.length = 0;
    this.touch?.dispose();
    if (this.pointerLocked) document.exitPointerLock();
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    // Debug panels and text fields keep their keys.
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
      return;
    const actions = this.codeToActions.get(e.code);
    if (!actions) return;
    if (PREVENT_DEFAULT_CODES.has(e.code) || e.ctrlKey) e.preventDefault();
    if (down) {
      if (this.downCodes.has(e.code)) return;
      this.downCodes.add(e.code);
      for (const a of actions) this.kb.get(a)!.press();
      this.lastDevice = 'keyboard';
      // NOTE: a keypress counts as a user gesture, so the camera grabs the
      // mouse as soon as the player starts moving instead of waiting for a click.
      if (this.settings.pointerLock && actions.some((a) => LOCK_ON_ACTIONS.has(a))) this.lockPointer();
    } else {
      if (!this.downCodes.delete(e.code)) return;
      for (const a of actions) this.kb.get(a)!.release();
    }
  }

  /** Clicks outside the canvas (on the HUD layer) still lock, unless they hit a real control. */
  private onWindowMouseDown(e: MouseEvent): void {
    if (e.target === this.element || !this.mouseActions || !this.settings.pointerLock || this.pointerLocked)
      return;
    const target = e.target as Element | null;
    if (target?.closest?.(UI_CONTROL_SELECTOR)) return;
    this.lockPointer();
  }

  private onMouseButton(e: MouseEvent, down: boolean): void {
    if (!this.mouseActions) return;
    if (down && this.settings.pointerLock && !this.pointerLocked) {
      // The click that captures the pointer is not a gameplay press.
      this.lockPointer();
      return;
    }
    if (this.settings.pointerLock && !this.pointerLocked && down) return;
    const code = mouseCode(e.button);
    const actions = this.codeToActions.get(code);
    if (!actions) return;
    if (down) {
      if (this.downCodes.has(code)) return;
      this.downCodes.add(code);
      for (const a of actions) this.kb.get(a)!.press();
      this.lastDevice = 'keyboard';
    } else {
      if (!this.downCodes.delete(code)) return;
      for (const a of actions) this.kb.get(a)!.release();
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.mouseActions || !this.pointerLocked) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  }

  private pollGamepad(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected && p.mapping === 'standard') {
        gp = p;
        break;
      }
    }
    if (!gp) {
      this.padStick.x = this.padStick.y = 0;
      this.padLook.x = this.padLook.y = 0;
      return;
    }
    const dz = this.settings.stickDeadzone;
    this.padStick = radialDeadzone(gp.axes[0] ?? 0, -(gp.axes[1] ?? 0), dz, this.padStick);
    radialDeadzone(gp.axes[2] ?? 0, gp.axes[3] ?? 0, dz, this.padLook);

    const pressed = (i: number): boolean => {
      const b = gp.buttons[i];
      return !!b && (b.pressed || b.value > 0.5);
    };
    this.padButton(PAD.A, pressed(PAD.A), 'jump');
    this.padButton(PAD.X, pressed(PAD.X), 'dive');
    this.padButton(PAD.B, pressed(PAD.B), 'dive');
    this.padButton(PAD.RT, pressed(PAD.RT), 'grab');
    this.padButton(PAD.RB, pressed(PAD.RB), 'grab');
    this.padButton(PAD.Y, pressed(PAD.Y), 'emoteWheel');
    this.padButton(PAD.Up, pressed(PAD.Up), 'emote1');
    this.padButton(PAD.Right, pressed(PAD.Right), 'emote2');
    this.padButton(PAD.Down, pressed(PAD.Down), 'emote3');
    this.padButton(PAD.Left, pressed(PAD.Left), 'emote4');
    if (Math.hypot(this.padStick.x, this.padStick.y) > 0 || Math.hypot(this.padLook.x, this.padLook.y) > 0) {
      this.lastDevice = 'gamepad';
    }
  }

  private padButton(index: number, down: boolean, action: InputAction): void {
    const prev = this.padPrev[index] ?? false;
    if (down === prev) return;
    this.padPrev[index] = down;
    const latch = this.pad.get(action)!;
    if (down) {
      latch.press();
      this.lastDevice = 'gamepad';
    } else {
      latch.release();
    }
  }

  private releaseMouseButtons(): void {
    for (const code of [...this.downCodes]) {
      if (!code.startsWith('Mouse')) continue;
      this.downCodes.delete(code);
      for (const a of this.codeToActions.get(code) ?? []) this.kb.get(a)!.release();
    }
  }

  private releaseAll(): void {
    this.downCodes.clear();
    for (const l of this.kb.values()) l.reset();
    this.touch?.reset();
  }

  private rebuildCodeIndex(): void {
    const m = new Map<string, InputAction[]>();
    for (const a of INPUT_ACTIONS) {
      for (const code of this.keymap[a]) {
        const list = m.get(code);
        if (list) list.push(a);
        else m.set(code, [a]);
      }
    }
    this.codeToActions = m;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.unlisten.push(() => target.removeEventListener(type, fn));
  }
}

/**
 * Radial deadzone with rescale, so the usable range still reaches full deflection.
 *
 * @returns `out` with magnitude in [0, 1].
 */
export function radialDeadzone(
  x: number,
  y: number,
  deadzone: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (m <= deadzone) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = Math.min(1, (m - deadzone) / (1 - deadzone));
  out.x = (x / m) * scaled;
  out.y = (y / m) * scaled;
  return out;
}
