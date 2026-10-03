/**
 * Playback plumbing that needs no renderer: the clock (play/pause, speeds,
 * seeking, end handling), keyboard and gamepad bindings, camera cycling and
 * the per-show library ring buffer.
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_SPEEDS, ReplayClock } from '../src/game/replay/clock.ts';
import {
  FINE_STEP,
  PadCommands,
  SEEK_STEP,
  keyCommand,
  moveKey,
  nextCameraMode,
} from '../src/game/replay/controls.ts';
import { ReplayLibrary } from '../src/game/replay/library.ts';
import type { ReplayData } from '../src/game/replay/format.ts';

describe('ReplayClock', () => {
  it('plays at the chosen speed and stops at the end', () => {
    const c = new ReplayClock(10);
    expect(c.playing).toBe(true);
    c.advance(1);
    expect(c.time).toBeCloseTo(1);
    c.setSpeed(2);
    c.advance(1);
    expect(c.time).toBeCloseTo(3);
    c.setSpeed(0.25);
    c.advance(4);
    expect(c.time).toBeCloseTo(4);
    c.advance(100);
    expect(c.time).toBe(10);
    expect(c.playing).toBe(false);
    expect(c.ended).toBe(true);
  });

  it('restarts when play is pressed at the end, pauses otherwise', () => {
    const c = new ReplayClock(5);
    c.consumeJump();
    c.toggle();
    expect(c.playing).toBe(false);
    c.advance(1);
    expect(c.time).toBe(0);
    c.seek(5);
    c.toggle();
    expect(c.time).toBe(0);
    expect(c.playing).toBe(true);
  });

  it('clamps seeks, flags jumps once and handles the End key', () => {
    const c = new ReplayClock(8);
    expect(c.consumeJump()).toBe(true);
    expect(c.consumeJump()).toBe(false);
    c.seek(-4);
    expect(c.time).toBe(0);
    expect(c.consumeJump()).toBe(false);
    c.seekBy(3);
    expect(c.time).toBe(3);
    expect(c.consumeJump()).toBe(true);
    c.seek(Infinity);
    expect(c.time).toBe(8);
    c.seek(Number.NaN);
    expect(c.time).toBe(0);
  });

  it('offers 0.25×–2× and steps through them', () => {
    expect(REPLAY_SPEEDS[0]).toBe(0.25);
    expect(REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1]).toBe(2);
    const c = new ReplayClock(1);
    expect(c.speed).toBe(1);
    for (let i = 0; i < 10; i++) c.stepSpeed(1);
    expect(c.speed).toBe(2);
    for (let i = 0; i < 10; i++) c.stepSpeed(-1);
    expect(c.speed).toBe(0.25);
    c.setSpeed(1.4);
    expect(c.speed).toBe(1.5);
  });
});

describe('controls', () => {
  it('maps the keyboard', () => {
    expect(keyCommand('Space', false)).toEqual({ type: 'toggle' });
    expect(keyCommand('ArrowLeft', false)).toEqual({ type: 'seekBy', seconds: -SEEK_STEP });
    expect(keyCommand('ArrowRight', true)).toEqual({ type: 'seekBy', seconds: FINE_STEP });
    expect(keyCommand('ArrowUp', false)).toEqual({ type: 'speedStep', dir: 1 });
    expect(keyCommand('KeyC', false)).toEqual({ type: 'camera', mode: 'next' });
    expect(keyCommand('Digit3', false)).toEqual({ type: 'camera', mode: 'pov' });
    expect(keyCommand('KeyQ', false)).toEqual({ type: 'player', dir: -1 });
    expect(keyCommand('KeyE', false)).toEqual({ type: 'player', dir: 1 });
    expect(keyCommand('Escape', false)).toEqual({ type: 'exit' });
    expect(keyCommand('Home', false)).toEqual({ type: 'seek', t: 0 });
    expect(keyCommand('KeyZ', false)).toBeNull();
    expect(moveKey('KeyW')).toEqual([0, 1]);
    expect(moveKey('KeyA')).toEqual([-1, 0]);
    expect(moveKey('Space')).toBeNull();
  });

  it('fires gamepad commands on the press edge only', () => {
    const pad = new PadCommands();
    const press = (...ids: number[]): boolean[] => {
      const b = new Array<boolean>(17).fill(false);
      for (const i of ids) b[i] = true;
      return b;
    };
    expect(pad.update(press(0))).toEqual([{ type: 'toggle' }]);
    expect(pad.update(press(0))).toEqual([]);
    expect(pad.update(press())).toEqual([]);
    expect(pad.update(press(5, 7)).map((c) => c.type)).toEqual(['player', 'seekBy']);
    expect(pad.update(press(1))).toEqual([{ type: 'exit' }]);
    pad.update(press(3));
    expect(pad.zoomHeld).toBe(true);
    // A button held while the viewer opens must not fire.
    pad.reset(press(0));
    expect(pad.update(press(0))).toEqual([]);
  });

  it('cycles cameras, skipping your view without a camera track', () => {
    expect(nextCameraMode('follow', true)).toBe('free');
    expect(nextCameraMode('free', true)).toBe('pov');
    expect(nextCameraMode('pov', true)).toBe('follow');
    expect(nextCameraMode('free', false)).toBe('follow');
  });
});

function fake(roundIndex: number, bytes: number): ReplayData {
  return {
    header: { roundIndex } as ReplayData['header'],
    frames: new Uint8Array(bytes),
    events: new Uint8Array(0),
  };
}

describe('ReplayLibrary', () => {
  it('keeps the current show only', () => {
    const lib = new ReplayLibrary();
    lib.beginShow();
    lib.add(fake(0, 10));
    lib.add(fake(1, 10));
    expect(lib.list().map((e) => e.data.header.roundIndex)).toEqual([0, 1]);
    const key = lib.list()[0]!.key;
    expect(lib.get(key)?.data.header.roundIndex).toBe(0);
    lib.beginShow();
    expect(lib.list()).toHaveLength(0);
    expect(lib.get(key)).toBeUndefined();
  });

  it('replaces a re-recorded round and evicts the oldest past the budgets', () => {
    const lib = new ReplayLibrary(3, 100);
    lib.beginShow();
    lib.add(fake(0, 10));
    lib.add(fake(0, 20));
    expect(lib.list()).toHaveLength(1);
    expect(lib.totalBytes).toBe(20);
    lib.add(fake(1, 10));
    lib.add(fake(2, 10));
    lib.add(fake(3, 10));
    expect(lib.list().map((e) => e.data.header.roundIndex)).toEqual([1, 2, 3]);
    lib.add(fake(4, 95));
    expect(lib.list().map((e) => e.data.header.roundIndex)).toEqual([4]);
  });
});
