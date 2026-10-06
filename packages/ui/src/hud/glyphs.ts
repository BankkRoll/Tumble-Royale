/**
 * Control glyphs for prompts, always derived from the player's live bindings:
 * the bound key on keyboard, the bound button on a gamepad (Settings →
 * Controls → Controller), nothing on touch where the on-screen buttons are
 * the prompt.
 */
import { keyLabel } from '../screens/overlays/SettingsSheet.tsx';
import { DEFAULT_PAD_BINDS } from '../store/defaults.ts';
import { padButtonLabel } from '../store/padBinds.ts';
import type { BindAction, HudState, Keybinds, PadBindAction, PadBinds } from '../store/types.ts';

type Device = HudState['device'];

/**
 * Gamepad glyph per action on the default controller layout.
 *
 * @deprecated Use {@link controlGlyph} with the player's `padBinds`; buttons are remappable.
 */
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
  spectateCamera: 'Ⓨ',
  spectateLeader: 'Ⓐ',
  spectateRoster: 'Ⓧ',
  spectatePin: 'Ⓑ',
  broadcastOverlay: 'R3',
  broadcastHelp: 'D-pad up',
  broadcastChroma: '—',
  pause: 'Start',
  pushToTalk: 'Back',
};

/** Left stick glyph: movement is never remapped. */
export const STICK_GLYPH = 'Ⓛ';

const isPadAction = (a: BindAction): a is PadBindAction => a in DEFAULT_PAD_BINDS;

/**
 * The first bound controller button for an action.
 *
 * @param action - Remappable controller action.
 * @param padBinds - Current controller bindings.
 * @returns Button label, or `—` when nothing is bound.
 * @example
 * padGlyph('grab', DEFAULT_PAD_BINDS); // 'RT'
 */
export function padGlyph(action: PadBindAction, padBinds: PadBinds = DEFAULT_PAD_BINDS): string {
  const pair = padBinds[action] ?? DEFAULT_PAD_BINDS[action];
  return padButtonLabel(pair[0] >= 0 ? pair[0] : pair[1]);
}

/**
 * The prompt glyph for an action on the last-used device.
 *
 * @param action - Rebindable action.
 * @param device - `hud.device`.
 * @param binds - Current keybinds (keyboard labels follow rebinding).
 * @param padBinds - Current controller bindings (pad labels follow remapping).
 * @returns Glyph text, empty for touch (the on-screen buttons are the prompt).
 * @example
 * controlGlyph('jump', 'gamepad', binds, padBinds); // 'Ⓐ'
 */
export function controlGlyph(
  action: BindAction,
  device: Device,
  binds: Keybinds,
  padBinds: PadBinds = DEFAULT_PAD_BINDS,
): string {
  if (device === 'gamepad') return isPadAction(action) ? padGlyph(action, padBinds) : STICK_GLYPH;
  if (device === 'touch') return '';
  return keyLabel(binds[action]?.[0] || binds[action]?.[1] || '');
}

/**
 * The movement prompt: `WASD` (or e.g. `ZQSD`, `↑ ← ↓ →`) from the bound keys,
 * the left stick on a pad.
 *
 * @param device - `hud.device`.
 * @param binds - Current keybinds.
 * @returns Glyph text, empty for touch.
 * @example
 * movementGlyph('keyboard', DEFAULT_KEYBINDS); // 'WASD'
 */
export function movementGlyph(device: Device, binds: Keybinds): string {
  if (device === 'gamepad') return STICK_GLYPH;
  if (device === 'touch') return '';
  const keys = (['moveForward', 'moveLeft', 'moveBack', 'moveRight'] as const).map((a) =>
    keyLabel(binds[a]?.[0] || binds[a]?.[1] || ''),
  );
  return keys.every((k) => k.length === 1 && /\w/.test(k)) ? keys.join('') : keys.join(' ');
}

const EMOTES = ['emote1', 'emote2', 'emote3', 'emote4'] as const;

/**
 * The emote prompt: `1–4` while emotes sit on the number row, the four bound
 * keys otherwise; `D-pad` (or the four buttons) on a pad.
 *
 * @param device - `hud.device`.
 * @param binds - Current keybinds.
 * @param padBinds - Current controller bindings.
 * @returns Glyph text, empty for touch.
 * @example
 * emoteGlyph('keyboard', DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS); // '1–4'
 */
export function emoteGlyph(device: Device, binds: Keybinds, padBinds: PadBinds = DEFAULT_PAD_BINDS): string {
  if (device === 'touch') return '';
  if (device === 'gamepad') {
    const buttons = EMOTES.map((a) => padGlyph(a, padBinds));
    return buttons.every((b) => b.startsWith('D-pad')) ? 'D-pad' : buttons.join('/');
  }
  const codes = EMOTES.map((a) => binds[a]?.[0] || binds[a]?.[1] || '');
  if (codes.every((c, i) => c === `Digit${i + 1}`)) return '1–4';
  return codes.map(keyLabel).join('/');
}
