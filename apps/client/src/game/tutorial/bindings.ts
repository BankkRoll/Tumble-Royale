/**
 * Prompt glyphs for the player's actual controls: rebound keyboard keys from
 * settings, fixed gamepad glyphs, or the touch buttons' own labels.
 */
import type { Keybinds } from '@tumble/ui';
import { keyLabel, type TutorialDevice } from '@tumble/ui/tutorial';

/** Actions the tutorial talks about. */
export type PromptAction = 'move' | 'camera' | 'jump' | 'dive' | 'grab' | 'skip' | 'confirm';

const GAMEPAD: Record<PromptAction, string[]> = {
  move: ['Left stick'],
  camera: ['Right stick'],
  jump: ['Ⓐ'],
  dive: ['Ⓧ'],
  grab: ['RT'],
  skip: ['Start'],
  confirm: ['Ⓐ'],
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

/**
 * Chips for one action on the given device.
 *
 * @param action - What the prompt asks for.
 * @param device - Last input device used.
 * @param binds - Current keyboard bindings (settings).
 * @returns One or more chip labels (alternatives).
 * @example
 * promptKeys('dive', 'keyboard', settings.controls.keybinds) // ['L-Ctrl', 'LMB']
 */
export function promptKeys(action: PromptAction, device: TutorialDevice, binds: Keybinds): string[] {
  if (device === 'gamepad') return GAMEPAD[action];
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
