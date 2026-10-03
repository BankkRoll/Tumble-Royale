import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, type CharacterInput } from '@tumble/sim/character';
import { InputSystem } from '../src/input/inputSystem.ts';
import { fakePad, installFakeDom, setButton, type FakeDom } from './fakeDom.ts';

const RT = 7;
const rest = { move: { x: 0, y: 0 }, jump: false, dive: false, grab: false };
const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

describe('toggle grab', () => {
  let dom: FakeDom;
  let input: InputSystem;
  const grabbing = (): boolean => (input.sample(0, blank()).buttons & Button.Grab) !== 0;

  beforeEach(() => {
    dom = installFakeDom();
    input = new InputSystem({ element: dom.element, settings: { pointerLock: false, toggleGrab: true } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('keyboard: a tap starts holding until the next tap', () => {
    dom.key('keydown', 'ShiftLeft');
    dom.key('keyup', 'ShiftLeft');
    expect([grabbing(), grabbing(), grabbing()]).toEqual([true, true, true]);
    dom.key('keydown', 'ShiftLeft');
    expect(grabbing()).toBe(false);
    dom.key('keyup', 'ShiftLeft');
    expect(grabbing()).toBe(false);
  });

  it('holding the key does not flip it every step', () => {
    dom.key('keydown', 'ShiftLeft');
    expect([grabbing(), grabbing(), grabbing()]).toEqual([true, true, true]);
    dom.key('keyup', 'ShiftLeft');
    expect(grabbing()).toBe(true);
  });

  it('gamepad: RT toggles', () => {
    const pad = fakePad();
    dom.pads.push(pad);
    setButton(pad, RT, true);
    expect(grabbing()).toBe(true);
    setButton(pad, RT, false);
    expect(grabbing()).toBe(true);
    setButton(pad, RT, true);
    expect(grabbing()).toBe(false);
  });

  it('touch: the Grab button toggles', () => {
    input.applyTouch({ ...rest, grab: true });
    input.applyTouch(rest);
    expect([grabbing(), grabbing()]).toEqual([true, true]);
    input.applyTouch({ ...rest, grab: true });
    expect(grabbing()).toBe(false);
  });

  it('ends when the grab ends in the sim', () => {
    dom.key('keydown', 'ShiftLeft');
    dom.key('keyup', 'ShiftLeft');
    expect(grabbing()).toBe(true);
    input.endGrabToggle();
    expect(input.grabToggleActive).toBe(false);
    expect(grabbing()).toBe(false);
  });

  it('hold mode passes the button straight through', () => {
    input.settings.toggleGrab = false;
    dom.key('keydown', 'ShiftLeft');
    expect(grabbing()).toBe(true);
    dom.key('keyup', 'ShiftLeft');
    expect(grabbing()).toBe(false);
  });

  it('switching to hold mode drops a latched toggle', () => {
    dom.key('keydown', 'ShiftLeft');
    dom.key('keyup', 'ShiftLeft');
    expect(grabbing()).toBe(true);
    input.settings.toggleGrab = false;
    expect(grabbing()).toBe(false);
    input.settings.toggleGrab = true;
    expect(grabbing()).toBe(false);
  });
});
