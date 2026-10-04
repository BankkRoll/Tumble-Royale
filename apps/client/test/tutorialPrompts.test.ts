import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS } from '@tumble/ui';
import { promptKeys } from '../src/game/tutorial/bindings.ts';

describe('tutorial prompt keys', () => {
  it('uses the default controller layout', () => {
    expect(promptKeys('jump', 'gamepad', DEFAULT_KEYBINDS)).toEqual(['Ⓐ']);
    expect(promptKeys('grab', 'gamepad', DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS)).toEqual(['RT', 'RB']);
    expect(promptKeys('skip', 'gamepad', DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS)).toEqual(['Start']);
    expect(promptKeys('move', 'gamepad', DEFAULT_KEYBINDS)).toEqual(['Left stick']);
  });

  it('follows controller remapping', () => {
    const pad = {
      ...DEFAULT_PAD_BINDS,
      jump: [1, -1] as [number, number],
      pause: [8, -1] as [number, number],
    };
    expect(promptKeys('jump', 'gamepad', DEFAULT_KEYBINDS, pad)).toEqual(['Ⓑ']);
    expect(promptKeys('skip', 'gamepad', DEFAULT_KEYBINDS, pad)).toEqual(['View']);
  });

  it('shows an unbound action as unbound rather than a button that does nothing', () => {
    const pad = { ...DEFAULT_PAD_BINDS, dive: [-1, -1] as [number, number] };
    expect(promptKeys('dive', 'gamepad', DEFAULT_KEYBINDS, pad)).toEqual(['—']);
  });

  it('follows keyboard rebinding', () => {
    expect(promptKeys('jump', 'keyboard', { ...DEFAULT_KEYBINDS, jump: ['KeyJ', ''] })).toEqual(['J']);
    expect(promptKeys('jump', 'touch', DEFAULT_KEYBINDS)).toEqual(['Jump']);
  });
});
