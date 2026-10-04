/**
 * Gamepad menu navigation (docs/design/SCREENS.md §1.1).
 *
 * Turns a standard-mapping pad into the UI's navigation directions: D-pad or
 * left stick moves focus with a key-repeat style delay, A accepts, B goes
 * back, LB/RB cycle tabs and the Menu button (Start unless remapped) is
 * reported separately as `start` (the caller decides between the in-round
 * menu and Settings).
 *
 * Pure apart from the pad snapshot it is handed, so it is driven by fake pads
 * in tests and by `navigator.getGamepads()` in the game.
 */
import type { NavDirection } from '@tumble/ui';

/** What a pad did this frame. */
export type PadNavAction = NavDirection | 'start';

/** The parts of a `Gamepad` navigation reads. */
export interface PadSnapshot {
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
}

/** Repeat timing and stick threshold. */
export interface PadNavOptions {
  /** Hold time before a direction starts repeating (ms). */
  repeatDelayMs: number;
  /** Interval between repeats once repeating (ms). */
  repeatIntervalMs: number;
  /** Left-stick deflection that counts as a direction (0–1). */
  stickThreshold: number;
}

/** Defaults close to console menus: a deliberate first step, then a quick scroll. */
export const DEFAULT_PAD_NAV: Readonly<PadNavOptions> = Object.freeze({
  repeatDelayMs: 380,
  repeatIntervalMs: 110,
  stickThreshold: 0.55,
});

/** Standard-mapping button indices used by menus. */
export const PAD_BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  LS: 10,
  RS: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

const NAV_BUTTONS: readonly [number, PadNavAction][] = [
  [PAD_BUTTON.A, 'accept'],
  [PAD_BUTTON.B, 'back'],
  [PAD_BUTTON.LB, 'tabPrev'],
  [PAD_BUTTON.RB, 'tabNext'],
];

/**
 * Buttons menus always read while they own the pad (accept, back, tabs and
 * the D-pad). The remappable Menu button must stay off these, or opening a
 * menu would also press inside it.
 */
export const MENU_NAV_BUTTONS: readonly number[] = [
  PAD_BUTTON.A,
  PAD_BUTTON.B,
  PAD_BUTTON.LB,
  PAD_BUTTON.RB,
  PAD_BUTTON.Up,
  PAD_BUTTON.Down,
  PAD_BUTTON.Left,
  PAD_BUTTON.Right,
];

type Dir = 'up' | 'down' | 'left' | 'right';

const pressed = (pad: PadSnapshot, i: number): boolean => {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

/**
 * The direction a pad is pointing: the D-pad wins, else the left stick's
 * dominant axis past the threshold.
 */
export function padDirection(pad: PadSnapshot, threshold = DEFAULT_PAD_NAV.stickThreshold): Dir | null {
  if (pressed(pad, PAD_BUTTON.Up)) return 'up';
  if (pressed(pad, PAD_BUTTON.Down)) return 'down';
  if (pressed(pad, PAD_BUTTON.Left)) return 'left';
  if (pressed(pad, PAD_BUTTON.Right)) return 'right';
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) < threshold) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

/**
 * Edge and repeat tracking for one pad.
 *
 * @example
 * const nav = new GamepadNavigator();
 * // every frame
 * for (const a of nav.update(pad, performance.now(), menuOpen)) handle(a);
 */
export class GamepadNavigator {
  private readonly opts: PadNavOptions;
  private readonly prev = new Map<number, boolean>();
  private dir: Dir | null = null;
  private nextRepeat = 0;
  private edges: readonly [number, PadNavAction][] = [...NAV_BUTTONS, [PAD_BUTTON.Start, 'start']];

  constructor(opts: Partial<PadNavOptions> = {}) {
    this.opts = { ...DEFAULT_PAD_NAV, ...opts };
  }

  /**
   * Sets which buttons report `start` (the player's Menu binding). Buttons
   * menus already use for navigation are ignored, and an empty list falls
   * back to Start so a pad can always reach the menu.
   *
   * @param buttons - Standard-mapping button indices.
   * @example
   * nav.setStartButtons([PAD_BUTTON.Back]);
   */
  setStartButtons(buttons: readonly number[]): void {
    const usable = [...new Set(buttons)].filter(
      (b) => Number.isInteger(b) && b >= 0 && !MENU_NAV_BUTTONS.includes(b),
    );
    const start = usable.length ? usable : [PAD_BUTTON.Start];
    this.edges = [...NAV_BUTTONS, ...start.map((b): [number, PadNavAction] => [b, 'start'])];
  }

  /**
   * Reads one frame. State is tracked even while inactive so a button held
   * when a menu opens (the A that confirmed, the Start that opened it) never
   * fires inside it.
   *
   * @param pad - Pad snapshot, or null when none is connected.
   * @param now - Timestamp (ms).
   * @param active - Whether directions/accept/back/tabs should be reported. Start always is.
   * @returns Actions in the order they happened this frame.
   */
  update(pad: PadSnapshot | null, now: number, active: boolean): PadNavAction[] {
    const out: PadNavAction[] = [];
    if (!pad) {
      this.prev.clear();
      this.dir = null;
      return out;
    }
    const downNow = new Map<number, boolean>();
    for (const [i, action] of this.edges) {
      const down = downNow.get(i) ?? pressed(pad, i);
      downNow.set(i, down);
      const was = this.prev.get(i) ?? false;
      if (down && !was && (active || action === 'start')) out.push(action);
    }
    for (const [i, down] of downNow) this.prev.set(i, down);
    const dir = padDirection(pad, this.opts.stickThreshold);
    if (dir !== this.dir) {
      this.dir = dir;
      this.nextRepeat = now + this.opts.repeatDelayMs;
      if (dir && active) out.push(dir);
    } else if (dir && now >= this.nextRepeat) {
      this.nextRepeat = now + this.opts.repeatIntervalMs;
      if (active) out.push(dir);
    }
    return out;
  }
}

/**
 * The first connected standard-mapping pad, or null.
 *
 * @param pads - `navigator.getGamepads()`.
 */
export function firstStandardPad(pads: readonly (Gamepad | null)[] | null | undefined): Gamepad | null {
  for (const p of pads ?? []) if (p && p.connected && p.mapping === 'standard') return p;
  return null;
}
