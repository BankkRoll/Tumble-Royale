/**
 * Settings bindings → input layer.
 *
 * Responsibilities:
 * - turn the UI's two-slot keyboard bindings (`Settings.controls.keybinds`)
 *   into the input system's full keymap, keeping the input layer's extra
 *   default keys (C and Right Ctrl for dive, Right Shift for grab) while an
 *   action is on its defaults.
 */
import { DEFAULT_KEYBINDS, type BindAction, type Keybinds } from '@tumble/ui';
import { DEFAULT_KEYMAP, INPUT_ACTIONS, type InputAction, type Keymap } from '../input/index.ts';

/** UI rebindable action → input system action (spectate keys are read by the show session). */
export const BIND_TO_INPUT: Readonly<Partial<Record<BindAction, InputAction>>> = {
  moveForward: 'forward',
  moveBack: 'back',
  moveLeft: 'left',
  moveRight: 'right',
  jump: 'jump',
  dive: 'dive',
  grab: 'grab',
  emoteWheel: 'emoteWheel',
  emote1: 'emote1',
  emote2: 'emote2',
  emote3: 'emote3',
  emote4: 'emote4',
  pause: 'menu',
};

const slotsOf = (pair: readonly string[] | undefined): string[] =>
  (Array.isArray(pair) ? pair : []).filter((c): c is string => typeof c === 'string' && c !== '');

/**
 * The input keymap for a set of UI keybinds. Every action is always present,
 * so applying it after "Reset to defaults" really restores the defaults
 * instead of leaving the previous custom keys live until a reload.
 *
 * An action still on its UI default gets the input layer's richer default
 * list, minus any extra key the player has since put on another action (so
 * binding Jump to C does not also dive).
 *
 * @param binds - `Settings.controls.keybinds` (missing actions use defaults).
 * @returns A complete keymap.
 * @example
 * input.setKeymap(keymapFromKeybinds(settings.controls.keybinds));
 */
export function keymapFromKeybinds(binds: Partial<Keybinds>): Keymap {
  const owner = new Map<string, BindAction>();
  const uiCodes = {} as Record<BindAction, string[]>;
  for (const bind of Object.keys(DEFAULT_KEYBINDS) as BindAction[]) {
    uiCodes[bind] = slotsOf(binds[bind] ?? DEFAULT_KEYBINDS[bind]);
    for (const code of uiCodes[bind]) if (!owner.has(code)) owner.set(code, bind);
  }
  const out = {} as Keymap;
  for (const a of INPUT_ACTIONS) out[a] = [...DEFAULT_KEYMAP[a]];
  for (const [bind, action] of Object.entries(BIND_TO_INPUT) as [BindAction, InputAction][]) {
    const codes = uiCodes[bind];
    const defaults = slotsOf(DEFAULT_KEYBINDS[bind]);
    const onDefaults = codes.length === defaults.length && codes.every((c, i) => c === defaults[i]);
    if (!onDefaults) {
      out[action] = [...new Set(codes)];
      continue;
    }
    out[action] = DEFAULT_KEYMAP[action].filter((code) => {
      const by = owner.get(code);
      return by === undefined || by === bind || codes.includes(code);
    });
  }
  return out;
}
