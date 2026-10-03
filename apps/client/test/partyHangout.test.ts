import { describe, expect, it } from 'vitest';
import {
  GRAB_MASH_PRESSES,
  GRAB_MAX_S,
  GrabStruggle,
  framePoints,
  lobbyFraming,
  menuStatus,
  statusChip,
  steerBall,
  type BallState,
} from '../src/game/views/partyLobby.ts';

describe('lobby status', () => {
  it('maps the menu to a status', () => {
    expect(menuStatus('menu', 'play', 'none')).toBe('menu');
    expect(menuStatus('menu', 'play', 'friends')).toBe('menu');
    expect(menuStatus('menu', 'locker', 'none')).toBe('locker');
    expect(menuStatus('menu', 'store', 'none')).toBe('store');
    expect(menuStatus('matchmaking', 'play', 'none')).toBe('queue');
    expect(menuStatus('menu', 'pass', 'none')).toBe('away');
    expect(menuStatus('menu', 'play', 'settings')).toBe('away');
  });

  it('puts where a member is ahead of their role', () => {
    expect(statusChip('menu', true, true)).toBe('LEADER');
    expect(statusChip('menu', false, true)).toBe('READY');
    expect(statusChip('menu', false, false)).toBe('NOT READY');
    expect(statusChip('locker', true, true)).toBe('IN LOCKER');
    expect(statusChip('store', false, false)).toBe('IN STORE');
    expect(statusChip('queue', true, true)).toBe('SEARCHING');
    expect(statusChip('away', false, true)).toBe('AWAY');
  });
});

describe('group framing', () => {
  it('centres on everyone and grows with the spread', () => {
    const out = lobbyFraming(1);
    framePoints([0, 4], [0, 0], 2, out);
    expect(out).toEqual({ cx: 2, cz: 0, spread: 2 });
    framePoints([1], [1], 1, out);
    expect(out).toEqual({ cx: 1, cz: 1, spread: 0 });
    framePoints([], [], 0, out);
    expect(out).toEqual({ cx: 0, cz: 0, spread: 0 });
  });
});

describe('grab struggle', () => {
  it('breaks free after enough jump presses', () => {
    const s = new GrabStruggle();
    expect(s.start('a')).toBe(true);
    for (let i = 0; i < GRAB_MASH_PRESSES - 1; i++) s.press();
    expect(s.update(0.1)).toBe(false);
    s.press();
    expect(s.update(0.1)).toBe(true);
    expect(s.by).toBeNull();
  });

  it('times out and refuses an instant re-grab', () => {
    const s = new GrabStruggle();
    s.start('a');
    expect(s.update(GRAB_MAX_S - 0.1)).toBe(false);
    expect(s.update(0.2)).toBe(true);
    expect(s.start('a')).toBe(false);
    s.update(1.1);
    expect(s.start('b')).toBe(true);
    expect(s.start('c')).toBe(false);
  });

  it('ignores presses while free', () => {
    const s = new GrabStruggle();
    s.press();
    s.start('a');
    expect(s.update(0.01)).toBe(false);
  });
});

describe('shared ball steering', () => {
  it('eases toward the leader and takes their velocity', () => {
    const local: BallState = [0, 0.7, 0, 0, 0, 0];
    steerBall(local, [1, 0.7, 0, 0, 0, 0], 0, 1 / 60);
    expect(local[0]).toBeGreaterThan(0);
    expect(local[0]).toBeLessThan(0.3);
    steerBall(local, [1, 0.7, 0, 2, 0, 0], 0, 1 / 60);
    expect(local[3]).toBe(2);
  });

  it('extrapolates by the state age (capped) and snaps when far off', () => {
    const local: BallState = [5, 0.7, 0, 0, 0, 0];
    steerBall(local, [0, 0.7, 0, 2, 0, 0], 10, 1 / 60);
    expect(local[0]).toBeCloseTo(0.5);
    const near: BallState = [0.5, 0.7, 0, 0, 0, 0];
    for (let i = 0; i < 120; i++) steerBall(near, [0, 0.7, 0, 0, 0, 0], 0, 1 / 60);
    expect(near[0]).toBeCloseTo(0, 3);
  });
});
