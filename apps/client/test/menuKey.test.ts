import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputSystem } from '../src/input/inputSystem.ts';
import { installFakeDom } from './fakeDom.ts';

describe('menu binding', () => {
  let input: InputSystem;
  beforeEach(() => {
    input = new InputSystem({ element: installFakeDom().element, settings: { pointerLock: false } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('defaults to Escape', () => {
    expect(input.isBound('menu', 'Escape')).toBe(true);
    expect(input.isBound('menu', 'KeyP')).toBe(false);
  });

  it('follows a rebind', () => {
    input.setBinding('menu', ['KeyP', 'Tab']);
    expect(input.isBound('menu', 'KeyP')).toBe(true);
    expect(input.isBound('menu', 'Tab')).toBe(true);
    expect(input.isBound('menu', 'Escape')).toBe(false);
    expect(input.isBound('jump', 'KeyP')).toBe(false);
  });
});
