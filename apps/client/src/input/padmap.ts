/**
 * Remappable gamepad buttons for gameplay.
 *
 * Bindings are standard-mapping button indices (0 = A/Cross … 15 = D-pad
 * right). Sticks are not remappable: the left stick always moves and the
 * right stick always looks. Start/menu, spectate and menu navigation are
 * read outside the input system, so they are not part of this map.
 */
import type { InputAction } from './keymap.ts';

/** Gameplay actions a pad button can press. */
export type PadAction = Extract<
  InputAction,
  'jump' | 'dive' | 'grab' | 'emoteWheel' | 'emote1' | 'emote2' | 'emote3' | 'emote4'
>;

/** Every pad action with its bound button indices. */
export type PadMap = Record<PadAction, number[]>;

/** All pad actions in a stable order. */
export const PAD_ACTIONS: readonly PadAction[] = [
  'jump',
  'dive',
  'grab',
  'emoteWheel',
  'emote1',
  'emote2',
  'emote3',
  'emote4',
];

/** Highest standard-mapping button index (16 = Home/Guide). */
export const PAD_BUTTON_MAX = 16;

/** Default layout: A jump, X/B dive, RT/RB grab, Y emote wheel, D-pad emotes. */
export const DEFAULT_PADMAP: Readonly<PadMap> = Object.freeze({
  jump: [0],
  dive: [2, 1],
  grab: [7, 5],
  emoteWheel: [3],
  emote1: [12],
  emote2: [15],
  emote3: [13],
  emote4: [14],
});

/** Whether `i` is a usable standard-mapping button index. */
export const isPadButton = (i: unknown): i is number =>
  typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= PAD_BUTTON_MAX;

/**
 * @returns A mutable copy of `base` with `overrides` applied per action;
 * invalid indices and duplicates are dropped.
 */
export function createPadMap(
  overrides: Partial<Record<PadAction, readonly number[]>> = {},
  base: Readonly<PadMap> = DEFAULT_PADMAP,
): PadMap {
  const out = {} as PadMap;
  for (const a of PAD_ACTIONS) out[a] = [...new Set((overrides[a] ?? base[a]).filter(isPadButton))];
  return out;
}
