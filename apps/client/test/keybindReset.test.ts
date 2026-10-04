import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBINDS, type Keybinds } from '@tumble/ui';
import { Button, type CharacterInput } from '@tumble/sim/character';
import { keymapFromKeybinds } from '../src/game/bindings.ts';
import { InputSystem } from '../src/input/inputSystem.ts';
import { DEFAULT_KEYMAP } from '../src/input/keymap.ts';
import { installFakeDom, type FakeDom } from './fakeDom.ts';

const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

describe('keymapFromKeybinds', () => {
  it('maps untouched defaults to the input layer defaults, extra keys included', () => {
    const map = keymapFromKeybinds(DEFAULT_KEYBINDS);
    expect(map.dive).toEqual(DEFAULT_KEYMAP.dive);
    expect(map.dive).toContain('KeyC');
    expect(map.dive).toContain('ControlRight');
    expect(map.grab).toContain('ShiftRight');
    expect(map.menu).toEqual(['Escape']);
  });

  it('uses the custom keys of a rebound action', () => {
    const map = keymapFromKeybinds({ ...DEFAULT_KEYBINDS, jump: ['KeyJ', ''] });
    expect(map.jump).toEqual(['KeyJ']);
  });

  it('drops a default extra key the player moved to another action', () => {
    const map = keymapFromKeybinds({ ...DEFAULT_KEYBINDS, jump: ['KeyC', 'Space'] });
    expect(map.jump).toEqual(['KeyC', 'Space']);
    expect(map.dive).not.toContain('KeyC');
    expect(map.dive).toContain('ControlRight');
  });

  it('fills missing or malformed saved actions from defaults', () => {
    const partial = { jump: ['KeyJ', ''] } as Partial<Keybinds>;
    const map = keymapFromKeybinds(partial);
    expect(map.jump).toEqual(['KeyJ']);
    expect(map.forward).toEqual(DEFAULT_KEYMAP.forward);
  });
});

describe('rebinding then resetting applies live', () => {
  let dom: FakeDom;
  let input: InputSystem;
  const pressed = (code: string, button: number): boolean => {
    dom.key('keydown', code);
    const on = (input.sample(0, blank()).buttons & button) !== 0;
    dom.key('keyup', code);
    input.sample(0, blank());
    return on;
  };

  beforeEach(() => {
    dom = installFakeDom();
    input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('restores Space and C immediately after Reset to defaults', () => {
    input.setKeymap(keymapFromKeybinds({ ...DEFAULT_KEYBINDS, jump: ['KeyJ', ''], dive: ['KeyX', ''] }));
    expect(pressed('KeyJ', Button.Jump)).toBe(true);
    expect(pressed('Space', Button.Jump)).toBe(false);
    expect(pressed('KeyC', Button.Dive)).toBe(false);

    input.setKeymap(keymapFromKeybinds(DEFAULT_KEYBINDS));
    expect(pressed('Space', Button.Jump)).toBe(true);
    expect(pressed('KeyJ', Button.Jump)).toBe(false);
    expect(pressed('KeyC', Button.Dive)).toBe(true);
    expect(pressed('ControlRight', Button.Dive)).toBe(true);
    expect(pressed('KeyX', Button.Dive)).toBe(false);
  });

  it('rebinding one action back to its default restores that action', () => {
    input.setKeymap(keymapFromKeybinds({ ...DEFAULT_KEYBINDS, dive: ['KeyX', ''] }));
    input.setKeymap(keymapFromKeybinds({ ...DEFAULT_KEYBINDS }));
    expect(pressed('KeyC', Button.Dive)).toBe(true);
  });

  it('re-applying unchanged bindings keeps held keys held', () => {
    input.setKeymap(keymapFromKeybinds(DEFAULT_KEYBINDS));
    dom.key('keydown', 'KeyW');
    expect(input.setKeymap(keymapFromKeybinds(DEFAULT_KEYBINDS))).toBe(false);
    expect(input.sample(0, blank()).moveZ).toBe(1);
  });
});
