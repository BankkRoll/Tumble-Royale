/**
 * Rebindable keymap for desktop input.
 *
 * Bindings are `KeyboardEvent.code` values (layout-independent: `KeyW` is the
 * key in the W position on AZERTY too) or `Mouse0`–`Mouse4` for mouse buttons.
 */

/** Logical actions the input layer understands. */
export type InputAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'dive'
  | 'grab'
  | 'emote1'
  | 'emote2'
  | 'emote3'
  | 'emote4'
  | 'emoteWheel';

/** Every action with its bound codes. */
export type Keymap = Record<InputAction, string[]>;

/** All actions, in a stable order (settings UI, iteration). */
export const INPUT_ACTIONS: readonly InputAction[] = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'dive',
  'grab',
  'emote1',
  'emote2',
  'emote3',
  'emote4',
  'emoteWheel',
];

/**
 * Default bindings per the spec controls table.
 *
 * NOTE: browsers never let a page intercept Ctrl+W (close tab), so Ctrl as dive
 * is risky next to WASD outside fullscreen keyboard lock. Left click and C are
 * bound too so players have a safe default.
 */
export const DEFAULT_KEYMAP: Readonly<Keymap> = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  dive: ['ControlLeft', 'ControlRight', 'Mouse0', 'KeyC'],
  grab: ['ShiftLeft', 'ShiftRight', 'Mouse2'],
  emote1: ['Digit1'],
  emote2: ['Digit2'],
  emote3: ['Digit3'],
  emote4: ['Digit4'],
  emoteWheel: ['KeyE'],
});

/** @returns A deep, mutable copy of `base` with `overrides` applied per action. */
export function createKeymap(
  overrides: Partial<Keymap> = {},
  base: Readonly<Keymap> = DEFAULT_KEYMAP,
): Keymap {
  const out = {} as Keymap;
  for (const a of INPUT_ACTIONS) out[a] = [...(overrides[a] ?? base[a])];
  return out;
}

/** Mouse button index → binding code. */
export const mouseCode = (button: number): string => `Mouse${button}`;
