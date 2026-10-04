/**
 * Controller remapping rules (Settings → Controls → Controller).
 *
 * Responsibilities:
 * - button labels for the standard mapping;
 * - which actions may share a button (gameplay and spectating never happen at
 *   once, so RB can be both grab and spectate next; Menu works everywhere);
 * - assigning a captured button with swap-on-conflict, refusing assignments
 *   that would strand the player without a Menu button;
 * - edge detection for the "press a button" capture.
 *
 * Pure: no store or DOM access, so the rules are unit-tested directly.
 */
import { DEFAULT_PAD_BINDS, PAD_BIND_ACTION_LABELS } from './defaults.ts';
import type { PadBindAction, PadBinds } from './types.ts';

/** Standard-mapping button indices the rules refer to. */
export const PAD_INDEX = {
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
  Home: 16,
} as const;

const LABELS: readonly string[] = [
  'Ⓐ',
  'Ⓑ',
  'Ⓧ',
  'Ⓨ',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Start',
  'L3',
  'R3',
  'D-pad up',
  'D-pad down',
  'D-pad left',
  'D-pad right',
  'Home',
];

/**
 * Prompt label for a standard-mapping button.
 *
 * @param index - Button index, or -1 for an empty slot.
 * @returns e.g. `Ⓐ`, `RT`, `D-pad up`; `—` when empty.
 * @example
 * padButtonLabel(7); // 'RT'
 */
export function padButtonLabel(index: number): string {
  if (index < 0) return '—';
  return LABELS[index] ?? `Button ${index}`;
}

/**
 * Buttons menus always read while they own the pad (accept, back, tabs and
 * the D-pad). Mirrors the client's `MENU_NAV_BUTTONS`.
 */
export const PAD_MENU_BUTTONS: readonly number[] = [
  PAD_INDEX.A,
  PAD_INDEX.B,
  PAD_INDEX.LB,
  PAD_INDEX.RB,
  PAD_INDEX.Up,
  PAD_INDEX.Down,
  PAD_INDEX.Left,
  PAD_INDEX.Right,
];

/** When an action is live: in play, while spectating, or always. */
export type PadBindContext = 'play' | 'spectate' | 'always';

/** Context per remappable action. */
export const PAD_BIND_CONTEXT: Readonly<Record<PadBindAction, PadBindContext>> = {
  jump: 'play',
  dive: 'play',
  grab: 'play',
  emoteWheel: 'play',
  emote1: 'play',
  emote2: 'play',
  emote3: 'play',
  emote4: 'play',
  pause: 'always',
  spectatePrev: 'spectate',
  spectateNext: 'spectate',
};

/** Whether two actions can be pressed in the same moment (so must not share a button). */
export function padActionsClash(a: PadBindAction, b: PadBindAction): boolean {
  const ca = PAD_BIND_CONTEXT[a];
  const cb = PAD_BIND_CONTEXT[b];
  return ca === 'always' || cb === 'always' || ca === cb;
}

/** Result of {@link assignPadButton}. */
export interface PadAssignResult {
  /** The new bindings (the input object when rejected). */
  binds: PadBinds;
  /** The action that gave up the button (and took the old one), if any. */
  swappedWith: PadBindAction | null;
  /** Why the assignment was refused, or null when it applied. */
  rejected: string | null;
}

const pairOf = (binds: Partial<PadBinds>, a: PadBindAction): [number, number] => {
  const p = binds[a];
  return Array.isArray(p) && p.length === 2 ? [p[0], p[1]] : [...DEFAULT_PAD_BINDS[a]];
};

/**
 * Puts `button` on one slot of `action`. If another action that can be live
 * at the same time already uses it, the two swap (the other action takes the
 * slot's old button), mirroring keyboard rebinding. Refused when the Menu
 * action would land on a menu navigation button or lose its only button, and
 * for Home, which browsers and consoles keep for themselves.
 *
 * @param binds - Current bindings.
 * @param action - Action being bound.
 * @param slot - 0 primary, 1 secondary.
 * @param button - Standard-mapping button index.
 * @returns New bindings plus what happened.
 * @example
 * assignPadButton(DEFAULT_PAD_BINDS, 'jump', 0, 1).swappedWith; // 'dive' (B)
 */
export function assignPadButton(
  binds: PadBinds,
  action: PadBindAction,
  slot: 0 | 1,
  button: number,
): PadAssignResult {
  const refuse = (rejected: string): PadAssignResult => ({ binds, swappedWith: null, rejected });
  if (!Number.isInteger(button) || button < 0 || button >= PAD_INDEX.Home)
    return refuse(`${padButtonLabel(button)} can't be used. Pick another button.`);
  if (action === 'pause' && PAD_MENU_BUTTONS.includes(button))
    return refuse(`${padButtonLabel(button)} already moves around menus, so it can't open the menu.`);

  const next = { ...binds } as PadBinds;
  for (const a of Object.keys(DEFAULT_PAD_BINDS) as PadBindAction[]) next[a] = pairOf(binds, a);
  const mine = next[action];
  const prev = mine[slot];
  if (prev === button) return { binds: next, swappedWith: null, rejected: null };
  const other = slot === 0 ? 1 : 0;
  if (mine[other] === button) {
    mine[other] = prev;
    mine[slot] = button;
    return { binds: next, swappedWith: null, rejected: null };
  }

  let swappedWith: PadBindAction | null = null;
  for (const a of Object.keys(next) as PadBindAction[]) {
    if (a === action || !padActionsClash(a, action)) continue;
    const pair = next[a];
    const idx = pair.indexOf(button);
    if (idx < 0) continue;
    const swapped: [number, number] = [pair[0], pair[1]];
    swapped[idx] = prev;
    if (a === 'pause' && (prev < 0 || PAD_MENU_BUTTONS.includes(prev))) {
      // Menu can't take the old button; it may only give this one up if it keeps another.
      if (pair[idx === 0 ? 1 : 0] < 0)
        return refuse(`${padButtonLabel(button)} opens the menu. Move Menu to another button first.`);
      swapped[idx] = -1;
    }
    next[a] = swapped;
    swappedWith = a;
  }
  mine[slot] = button;
  return { binds: next, swappedWith, rejected: null };
}

/** Toast text for a swap, e.g. `RB was on “Grab”`. */
export function padSwapMessage(button: number, from: PadBindAction): string {
  return `${padButtonLabel(button)} was on “${PAD_BIND_ACTION_LABELS[from]}”`;
}

/** The parts of a `Gamepad` the capture reads. */
export interface PadButtonsSnapshot {
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/** Whether a button counts as pressed (analog triggers past half travel). */
export const padPressed = (pad: PadButtonsSnapshot, i: number): boolean => {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

/**
 * Edge detector for the "press a button" capture. Seeded with what is held
 * when capture starts, so the A that opened the prompt does not bind itself.
 *
 * @example
 * const cap = new PadCapture(pad);
 * // each frame
 * const b = cap.update(pad); if (b !== null) bind(b);
 */
export class PadCapture {
  private readonly prev: boolean[] = [];

  /** @param pad - The pad as capture starts, or null. */
  constructor(pad: PadButtonsSnapshot | null) {
    if (pad) for (let i = 0; i < pad.buttons.length; i++) this.prev[i] = padPressed(pad, i);
  }

  /**
   * @param pad - Current pad snapshot, or null when none is connected.
   * @returns The first newly pressed button index this frame, or null.
   */
  update(pad: PadButtonsSnapshot | null): number | null {
    if (!pad) {
      this.prev.length = 0;
      return null;
    }
    let hit: number | null = null;
    for (let i = 0; i < pad.buttons.length; i++) {
      const down = padPressed(pad, i);
      if (down && !this.prev[i] && hit === null) hit = i;
      this.prev[i] = down;
    }
    return hit;
  }
}
