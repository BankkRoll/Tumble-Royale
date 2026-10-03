import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterInput } from '@tumble/sim/character';
import { Button } from '@tumble/sim/character';
import { GamepadNavigator, PAD_BUTTON, firstStandardPad, padDirection } from '../src/input/gamepadNav.ts';
import { InputSystem } from '../src/input/inputSystem.ts';
import { fakePad, installFakeDom, setButton } from './fakeDom.ts';

describe('GamepadNavigator', () => {
  const opts = { repeatDelayMs: 400, repeatIntervalMs: 100, stickThreshold: 0.5 };

  it('reports A / B / LB / RB / Start once per press', () => {
    const nav = new GamepadNavigator(opts);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.A, true);
    setButton(pad, PAD_BUTTON.LB, true);
    expect(nav.update(pad, 0, true)).toEqual(['accept', 'tabPrev']);
    expect(nav.update(pad, 16, true)).toEqual([]);
    setButton(pad, PAD_BUTTON.A, false);
    setButton(pad, PAD_BUTTON.LB, false);
    setButton(pad, PAD_BUTTON.B, true);
    setButton(pad, PAD_BUTTON.RB, true);
    setButton(pad, PAD_BUTTON.Start, true);
    expect(nav.update(pad, 32, true)).toEqual(['back', 'tabNext', 'start']);
  });

  it('repeats a held direction after the delay, then at the interval', () => {
    const nav = new GamepadNavigator(opts);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.Down, true);
    const fired: number[] = [];
    for (let t = 0; t <= 700; t += 50) if (nav.update(pad, t, true).includes('down')) fired.push(t);
    expect(fired).toEqual([0, 400, 500, 600, 700]);
  });

  it('reads the left stick dominant axis past the threshold', () => {
    const pad = fakePad();
    pad.axes[0] = 0.3;
    pad.axes[1] = -0.9;
    expect(padDirection(pad, 0.5)).toBe('up');
    pad.axes[0] = 0.8;
    pad.axes[1] = 0.2;
    expect(padDirection(pad, 0.5)).toBe('right');
    pad.axes[0] = 0.4;
    pad.axes[1] = 0;
    expect(padDirection(pad, 0.5)).toBeNull();
  });

  it('lets the D-pad win over the stick', () => {
    const pad = fakePad();
    pad.axes[0] = 1;
    setButton(pad, PAD_BUTTON.Left, true);
    expect(padDirection(pad)).toBe('left');
  });

  it('never fires a button that was already held when navigation became active', () => {
    const nav = new GamepadNavigator(opts);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.A, true);
    setButton(pad, PAD_BUTTON.Right, true);
    expect(nav.update(pad, 0, false)).toEqual([]);
    expect(nav.update(pad, 16, true)).toEqual([]);
    setButton(pad, PAD_BUTTON.A, false);
    expect(nav.update(pad, 32, true)).toEqual([]);
    setButton(pad, PAD_BUTTON.A, true);
    expect(nav.update(pad, 48, true)).toEqual(['accept']);
  });

  it('reports Start even while inactive (it opens the menu)', () => {
    const nav = new GamepadNavigator(opts);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.Start, true);
    setButton(pad, PAD_BUTTON.A, true);
    expect(nav.update(pad, 0, false)).toEqual(['start']);
  });

  it('forgets state when the pad disconnects', () => {
    const nav = new GamepadNavigator(opts);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.A, true);
    nav.update(pad, 0, true);
    expect(nav.update(null, 16, true)).toEqual([]);
    expect(nav.update(pad, 32, true)).toEqual(['accept']);
  });

  it('picks the first connected standard pad', () => {
    const odd = { ...fakePad(0), mapping: '' };
    const gone = { ...fakePad(1), connected: false };
    const good = fakePad(2);
    expect(firstStandardPad([null, odd, gone, good] as unknown as Gamepad[])).toBe(good);
    expect(firstStandardPad(null)).toBeNull();
  });
});

describe('gamepad gameplay while a menu owns the pad', () => {
  afterEach(() => vi.unstubAllGlobals());
  const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

  it('A confirms in the menu without jumping, and a held A does not jump on close', () => {
    const dom = installFakeDom();
    const pad = fakePad();
    dom.pads.push(pad);
    const input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
    input.setGamepadGameplay(false);
    setButton(pad, PAD_BUTTON.A, true);
    pad.axes[1] = -1;
    let out = input.sample(0, blank());
    expect(out.buttons & Button.Jump).toBe(0);
    expect(out.moveZ).toBe(0);
    expect(input.lastDevice).toBe('gamepad');
    input.setGamepadGameplay(true);
    out = input.sample(0, blank());
    expect(out.buttons & Button.Jump).toBe(0);
    expect(out.moveZ).toBeCloseTo(1);
    setButton(pad, PAD_BUTTON.A, false);
    input.sample(0, blank());
    setButton(pad, PAD_BUTTON.A, true);
    expect(input.sample(0, blank()).buttons & Button.Jump).toBeTruthy();
    input.dispose();
  });

  it('releases pad buttons held when a menu takes the pad', () => {
    const dom = installFakeDom();
    const pad = fakePad();
    dom.pads.push(pad);
    const input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
    setButton(pad, PAD_BUTTON.X, true);
    expect(input.sample(0, blank()).buttons & Button.Dive).toBeTruthy();
    input.setGamepadGameplay(false);
    expect(input.sample(0, blank()).buttons & Button.Dive).toBe(0);
    input.dispose();
  });
});
