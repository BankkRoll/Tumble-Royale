import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimEvent } from '@tumble/sim';
import { HAPTIC_PATTERNS, HapticMapper, HapticThrottle, playHaptic } from '../src/input/haptics.ts';
import { InputSystem } from '../src/input/inputSystem.ts';
import { fakePad, installFakeDom, setButton } from './fakeDom.ts';

const pos = { x: 0, y: 0, z: 0 };
const ME = 3;

describe('HapticMapper', () => {
  const kinds = (events: SimEvent[], localId = ME): (string | null)[] => {
    const m = new HapticMapper();
    return events.map((e) => m.map(e, localId)?.kind ?? null);
  };

  it('maps the local player events to their cues', () => {
    expect(
      kinds([
        { type: 'stun', player: ME, pos, strength: 12 },
        { type: 'grabStart', player: 7, target: ME, targetKind: 'player' },
        { type: 'bounce', player: ME, pos },
        { type: 'eliminated', player: ME, place: 30 },
        { type: 'qualified', player: ME, place: 2 },
      ]),
    ).toEqual(['stunned', 'grabbed', 'bounce', 'eliminated', 'qualified']);
  });

  it('ignores other players, and grabs of props or by yourself', () => {
    expect(
      kinds([
        { type: 'stun', player: 9, pos, strength: 20 },
        { type: 'eliminated', player: 9, place: 1 },
        { type: 'grabStart', player: ME, target: 9, targetKind: 'player' },
        { type: 'grabStart', player: 7, target: ME, targetKind: 'prop' },
        { type: 'bounce', player: 9, pos },
      ]),
    ).toEqual([null, null, null, null, null]);
  });

  it('tells a dive belly-flop from an ordinary landing', () => {
    expect(
      kinds([
        { type: 'dive', player: ME, pos },
        { type: 'land', player: ME, pos, impact: 4 },
        { type: 'land', player: ME, pos, impact: 4 },
        { type: 'land', player: ME, pos, impact: 12 },
      ]),
    ).toEqual([null, 'diveImpact', null, 'hardLanding']);
  });

  it('a stun or respawn cancels the pending dive impact', () => {
    expect(
      kinds([
        { type: 'dive', player: ME, pos },
        { type: 'respawn', player: ME, pos },
        { type: 'land', player: ME, pos, impact: 2 },
      ]),
    ).toEqual([null, null, null]);
  });

  it('scales stuns with strength within the motor range', () => {
    const m = new HapticMapper();
    const soft = m.map({ type: 'stun', player: ME, pos, strength: 7 }, ME)!.pattern;
    const hard = m.map({ type: 'stun', player: ME, pos, strength: 40 }, ME)!.pattern;
    expect(soft.strong).toBeLessThan(hard.strong);
    expect(hard.strong).toBeLessThanOrEqual(1);
    expect(hard.strong).toBe(HAPTIC_PATTERNS.stunned.strong);
  });

  it('does nothing without a local player', () => {
    expect(kinds([{ type: 'eliminated', player: -1, place: 1 }], -1)).toEqual([null]);
  });
});

describe('HapticThrottle', () => {
  it('spaces repeats of a kind and stacks of different kinds', () => {
    const t = new HapticThrottle({ globalMs: 100, perKindMs: 300 });
    expect(t.allow('bounce', 0)).toBe(true);
    expect(t.allow('bounce', 200)).toBe(false);
    expect(t.allow('grabbed', 50)).toBe(false);
    expect(t.allow('grabbed', 150)).toBe(true);
    expect(t.allow('bounce', 320)).toBe(true);
  });

  it('lets elimination through right after another effect', () => {
    const t = new HapticThrottle({ globalMs: 100, perKindMs: 300 });
    expect(t.allow('stunned', 0)).toBe(true);
    expect(t.allow('eliminated', 10)).toBe(true);
  });
});

describe('playing haptics', () => {
  afterEach(() => vi.unstubAllGlobals());
  const pattern = { durationMs: 100, strong: 0.5, weak: 1.4 };

  it('plays dual-rumble on the gamepad with clamped motors', () => {
    const pad = fakePad();
    expect(playHaptic(pattern, pad)).toBe(true);
    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', {
      startDelay: 0,
      duration: 100,
      strongMagnitude: 0.5,
      weakMagnitude: 1,
    });
  });

  it('skips pads without an actuator', () => {
    expect(playHaptic(pattern, { vibrationActuator: null })).toBe(false);
    expect(playHaptic(pattern, null)).toBe(false);
  });

  it('routes through the last-used device', () => {
    const dom = installFakeDom();
    const pad = fakePad();
    dom.pads.push(pad);
    const input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
    expect(input.rumble(pattern)).toBe(false); // keyboard
    setButton(pad, 0, true);
    input.sample(0, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    expect(input.lastDevice).toBe('gamepad');
    expect(input.rumble(pattern)).toBe(true);
    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
    input.applyTouch({ move: { x: 0, y: 0 }, jump: true, dive: false, grab: false });
    expect(input.rumble(pattern)).toBe(true);
    expect(dom.vibrate).toHaveBeenCalledWith(100);
    input.dispose();
  });
});
