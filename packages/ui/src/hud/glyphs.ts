/**
 * Control glyphs for prompts: the bound key on keyboard, the standard-mapping
 * button on a gamepad (matching the client's fixed pad layout).
 */
import { keyLabel } from '../screens/overlays/SettingsSheet.tsx';
import type { BindAction, HudState, Keybinds } from '../store/types.ts';

/** Gamepad button per action (client `InputSystem` / gamepad navigation layout). */
export const PAD_GLYPHS: Record<BindAction, string> = {
  moveForward: 'Ⓛ',
  moveBack: 'Ⓛ',
  moveLeft: 'Ⓛ',
  moveRight: 'Ⓛ',
  jump: 'Ⓐ',
  dive: 'Ⓧ',
  grab: 'RT',
  emoteWheel: 'Ⓨ',
  emote1: 'D-pad up',
  emote2: 'D-pad right',
  emote3: 'D-pad down',
  emote4: 'D-pad left',
  spectatePrev: 'LB',
  spectateNext: 'RB',
  pause: 'Start',
};

/**
 * The prompt glyph for an action on the last-used device.
 *
 * @param action - Rebindable action.
 * @param device - `hud.device`.
 * @param binds - Current keybinds (keyboard labels follow rebinding).
 * @returns Glyph text, empty for touch (the on-screen buttons are the prompt).
 * @example
 * controlGlyph('jump', 'gamepad', binds); // 'Ⓐ'
 */
export function controlGlyph(action: BindAction, device: HudState['device'], binds: Keybinds): string {
  if (device === 'gamepad') return PAD_GLYPHS[action];
  if (device === 'touch') return '';
  return keyLabel(binds[action][0] || binds[action][1] || '');
}
