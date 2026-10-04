/**
 * Prompt glyphs for the player's actual controls: rebound keyboard keys and
 * remapped controller buttons from settings, or the touch buttons' own labels.
 */
import {
  DEFAULT_PAD_BINDS,
  padButtonLabel,
  type Keybinds,
  type PadBindAction,
  type PadBinds,
} from '@tumble/ui';
import { keyLabel, type TutorialDevice } from '@tumble/ui/tutorial';

/** Actions the tutorial talks about. */
export type PromptAction = 'move' | 'camera' | 'jump' | 'dive' | 'grab' | 'skip' | 'confirm';

/** Stick and menu-navigation prompts that are not remappable. */
const GAMEPAD_FIXED: Record<'move' | 'camera' | 'confirm', string[]> = {
  move: ['Left stick'],
  camera: ['Right stick'],
  confirm: ['Ⓐ'],
};

/** Prompt action → remappable controller action. */
const GAMEPAD_BOUND: Record<'jump' | 'dive' | 'grab' | 'skip', PadBindAction> = {
  jump: 'jump',
  dive: 'dive',
  grab: 'grab',
  skip: 'pause',
};

const TOUCH: Record<PromptAction, string[]> = {
  move: ['Joystick'],
  camera: ['Drag right side'],
  jump: ['Jump'],
  dive: ['Dive'],
  grab: ['Grab'],
  skip: ['Skip'],
  confirm: ['Tap'],
};

const labels = (codes: readonly string[] | undefined): string[] =>
  (codes ?? []).filter((c) => c !== '').map(keyLabel);

const padLabels = (pair: readonly number[] | undefined): string[] =>
  (pair ?? []).filter((b) => b >= 0).map(padButtonLabel);

/**
 * Chips for one action on the given device.
 *
 * @param action - What the prompt asks for.
 * @param device - Last input device used.
 * @param binds - Current keyboard bindings (settings).
 * @param padBinds - Current controller bindings (settings).
 * @returns One or more chip labels (alternatives).
 * @example
 * promptKeys('dive', 'keyboard', settings.controls.keybinds) // ['L-Ctrl', 'LMB']
 * promptKeys('dive', 'gamepad', binds, settings.controls.padBinds) // ['Ⓧ', 'Ⓑ']
 */
export function promptKeys(
  action: PromptAction,
  device: TutorialDevice,
  binds: Keybinds,
  padBinds: PadBinds = DEFAULT_PAD_BINDS,
): string[] {
  if (device === 'gamepad') {
    if (action === 'move' || action === 'camera' || action === 'confirm') return GAMEPAD_FIXED[action];
    const bound = padLabels(padBinds[GAMEPAD_BOUND[action]] ?? DEFAULT_PAD_BINDS[GAMEPAD_BOUND[action]]);
    return bound.length ? bound : [padButtonLabel(-1)];
  }
  if (device === 'touch') return TOUCH[action];
  switch (action) {
    case 'move': {
      const four = [binds.moveForward, binds.moveLeft, binds.moveBack, binds.moveRight].map((c) =>
        keyLabel(c?.[0] ?? ''),
      );
      const word = four.join('');
      return [word === 'WASD' ? 'WASD' : four.join(' ')];
    }
    case 'camera':
      return ['Mouse'];
    case 'jump':
      return labels(binds.jump);
    case 'dive':
      return labels(binds.dive);
    case 'grab':
      return labels(binds.grab);
    case 'skip':
      return labels(binds.pause).length ? labels(binds.pause) : ['Esc'];
    case 'confirm':
      return ['Enter'];
  }
}
