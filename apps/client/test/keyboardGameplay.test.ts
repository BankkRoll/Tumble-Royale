/**
 * While a menu owns input the keyboard drives the menu only: arrowing the
 * in-round pause menu never walks the Tumbler, Space presses the focused
 * control instead of jumping, and keys held across the switch behave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, type CharacterInput } from '@tumble/sim/character';
import { InputSystem } from '../src/input/inputSystem.ts';
import { installFakeDom, type FakeDom } from './fakeDom.ts';

const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

describe('keyboard gameplay switch', () => {
  let dom: FakeDom;
  let input: InputSystem;
  const step = (): CharacterInput => input.sample(0, blank());
  const moving = (): boolean => {
    const s = step();
    return s.moveX !== 0 || s.moveZ !== 0;
  };

  /** Dispatches a key and reports whether the input system prevented its default. */
  function key(type: 'keydown' | 'keyup', code: string): boolean {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, ctrlKey: false, repeat: false });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }

  beforeEach(() => {
    dom = installFakeDom();
    input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('arrowing a menu over the round moves nothing', () => {
    input.setKeyboardGameplay(false);
    key('keydown', 'ArrowUp');
    key('keydown', 'KeyW');
    expect(moving()).toBe(false);
    key('keyup', 'ArrowUp');
    key('keyup', 'KeyW');
    input.setKeyboardGameplay(true);
    key('keydown', 'ArrowUp');
    expect(moving()).toBe(true);
  });

  it('leaves Space to the focused control while a menu owns the keys', () => {
    input.setKeyboardGameplay(false);
    expect(key('keydown', 'Space')).toBe(false);
    expect(step().buttons & Button.Jump).toBe(0);
    key('keyup', 'Space');
    input.setKeyboardGameplay(true);
    expect(key('keydown', 'Space')).toBe(true);
    expect(step().buttons & Button.Jump).not.toBe(0);
  });

  it('opening a menu lets go of held keys', () => {
    key('keydown', 'KeyW');
    expect(moving()).toBe(true);
    input.setKeyboardGameplay(false);
    expect(moving()).toBe(false);
  });

  it('a movement key held as the menu closes walks at once; a held Space does not jump', () => {
    input.setKeyboardGameplay(false);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    expect(input.movementKeyHeld()).toBe(true);
    input.setKeyboardGameplay(true);
    const s = step();
    expect(s.moveX !== 0 || s.moveZ !== 0).toBe(true);
    expect(s.buttons & Button.Jump).toBe(0);
  });
});
