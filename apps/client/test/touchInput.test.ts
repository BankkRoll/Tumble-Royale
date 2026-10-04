import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, type CharacterInput } from '@tumble/sim/character';
import { InputSystem } from '../src/input/inputSystem.ts';
import { TouchState } from '../src/input/touchState.ts';
import { installFakeDom, type FakeDom } from './fakeDom.ts';

const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
const rest = { move: { x: 0, y: 0 }, jump: false, dive: false, grab: false };

describe('touch → CharacterInput', () => {
  let dom: FakeDom;
  let input: InputSystem;
  beforeEach(() => {
    dom = installFakeDom({ coarse: true });
    input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('starts on touch on a coarse-pointer device', () => {
    expect(input.lastDevice).toBe('touch');
  });

  it('maps the joystick to camera-relative movement', () => {
    input.applyTouch({ ...rest, move: { x: 0.6, y: 0.8 } });
    const out = input.sample(1.25, blank());
    expect(out.moveX).toBeCloseTo(0.6);
    expect(out.moveZ).toBeCloseTo(0.8);
    expect(out.yaw).toBe(1.25);
  });

  it('keeps working in menu mode (idle play, party hangout, lobby games)', () => {
    input.setMouseActions(false);
    input.setGamepadGameplay(false);
    input.applyTouch({ ...rest, move: { x: 0, y: 1 }, jump: true });
    const out = input.sample(0, blank());
    expect(out.moveZ).toBeCloseTo(1);
    expect(out.buttons & Button.Jump).toBeTruthy();
    input.addTouchLook(10, 0);
    expect(input.readLook(1 / 60).yaw).toBeGreaterThan(0);
  });

  it('clamps an over-long stick vector to the unit disc', () => {
    input.applyTouch({ ...rest, move: { x: 3, y: 4 } });
    const out = input.sample(0, blank());
    expect(Math.hypot(out.moveX, out.moveZ)).toBeCloseTo(1);
  });

  it('keeps a jump tap shorter than one step', () => {
    input.applyTouch({ ...rest, jump: true });
    input.applyTouch(rest);
    expect(input.sample(0, blank()).buttons & Button.Jump).toBeTruthy();
    expect(input.sample(0, blank()).buttons & Button.Jump).toBe(0);
  });

  it('holds dive and grab while their buttons are held (multi-touch)', () => {
    input.applyTouch({ move: { x: -1, y: 0 }, jump: false, dive: true, grab: true });
    for (let i = 0; i < 3; i++) {
      const out = input.sample(0, blank());
      expect(out.buttons & Button.Dive).toBeTruthy();
      expect(out.buttons & Button.Grab).toBeTruthy();
      expect(out.moveX).toBeCloseTo(-1);
    }
    input.applyTouch({ move: { x: -1, y: 0 }, jump: false, dive: false, grab: true });
    const out = input.sample(0, blank());
    expect(out.buttons & Button.Dive).toBe(0);
    expect(out.buttons & Button.Grab).toBeTruthy();
  });

  it('turns camera drag into look deltas once', () => {
    input.settings.sensitivity = 2;
    input.addTouchLook(10, -5);
    input.addTouchLook(5, 0);
    const look = input.readLook(1 / 60);
    expect(look.yaw).toBeCloseTo(15 * input.settings.touchRadPerPixel * 2);
    expect(look.pitch).toBeCloseTo(-5 * input.settings.touchRadPerPixel * 2);
    expect(input.readLook(1 / 60).yaw).toBe(0);
  });

  it('lets a stronger keyboard input win over a resting stick', () => {
    input.applyTouch({ ...rest, move: { x: 0.2, y: 0 } });
    dom.key('keydown', 'KeyW');
    const out = input.sample(0, blank());
    expect(out.moveZ).toBe(1);
    expect(input.lastDevice).toBe('keyboard');
  });

  it('releases everything when the window loses focus', () => {
    input.applyTouch({ move: { x: 1, y: 0 }, jump: false, dive: true, grab: false });
    window.dispatchEvent(new Event('blur'));
    const out = input.sample(0, blank());
    expect(out.moveX).toBe(0);
    expect(out.buttons & Button.Dive).toBeTruthy(); // the press already happened this step
    expect(input.sample(0, blank()).buttons & Button.Dive).toBe(0);
  });
});

describe('TouchState', () => {
  it('ignores non-finite payload values', () => {
    const t = new TouchState();
    t.apply({ ...rest, move: { x: Number.NaN, y: 1 } });
    t.addLook(Number.POSITIVE_INFINITY, 2);
    expect(t.stick).toEqual({ x: 0, y: 1 });
    expect(t.lookDx).toBe(0);
    expect(t.lookDy).toBe(2);
  });

  it('only presses on a change, so repeated snapshots are one press', () => {
    const t = new TouchState();
    t.apply({ ...rest, grab: true });
    t.apply({ ...rest, grab: true });
    t.apply(rest);
    expect(t.buttons.grab.down).toBe(false);
  });
});
