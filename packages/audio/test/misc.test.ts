import { describe, expect, it } from 'vitest';
import { intensityForStatus, trackForRound } from '../src/game/bindings.ts';
import { FootstepCadence, MIN_STEP_SPEED, stepRate } from '../src/game/footsteps.ts';
import { bakeLoop } from '../src/sfx/bank.ts';

describe('footstep cadence', () => {
  it('is silent when standing and saturates when sprinting', () => {
    expect(stepRate(0)).toBe(0);
    expect(stepRate(MIN_STEP_SPEED - 0.01)).toBe(0);
    expect(stepRate(2)).toBeGreaterThan(0);
    expect(stepRate(9)).toBeGreaterThan(stepRate(3));
    expect(stepRate(100)).toBeLessThanOrEqual(5.5);
    expect(stepRate(5, 'sticky')).toBeLessThan(stepRate(5, 'normal'));
  });

  it('fires at the expected rate while grounded', () => {
    const c = new FootstepCadence(4);
    const dt = 1 / 60;
    let steps = 0;
    for (let i = 0; i < 600; i++) if (c.update(0, 6, true, 'normal', dt)) steps++;
    const expected = stepRate(6) * 10;
    expect(Math.abs(steps - expected)).toBeLessThanOrEqual(2);
  });

  it('never steps in the air or on the landing frame', () => {
    const c = new FootstepCadence(2);
    for (let i = 0; i < 120; i++) expect(c.update(1, 8, false, 'normal', 1 / 60)).toBe(false);
    expect(c.update(1, 8, true, 'normal', 1 / 60)).toBe(false);
  });

  it('ignores out-of-range players', () => {
    const c = new FootstepCadence(2);
    expect(c.update(5, 8, true, 'normal', 1)).toBe(false);
    expect(c.update(-1, 8, true, 'normal', 1)).toBe(false);
  });
});

describe('loop baking', () => {
  it('produces a seamless seam', () => {
    const period = 500;
    const xfade = 100;
    // A ramp has a hard discontinuity at the period boundary if not crossfaded.
    const data = new Float32Array(period + xfade).map((_v, i) => Math.sin(i * 0.37) * 0.5 + (i / (period + xfade)) * 0.5);
    const out = bakeLoop(data, period, xfade);
    expect(out).toHaveLength(period);
    let maxStep = 0;
    for (let i = 1; i < data.length; i++) maxStep = Math.max(maxStep, Math.abs(data[i]! - data[i - 1]!));
    // Wrapping from the end back to the start must be no rougher than any step in the source.
    expect(Math.abs(out[0]! - out[period - 1]!)).toBeLessThanOrEqual(maxStep + 1e-6);
    // Without baking, the raw wrap would jump by the ramp height.
    expect(Math.abs(data[0]! - data[period - 1]!)).toBeGreaterThan(maxStep);
  });
});

describe('round music mapping', () => {
  it('chooses finals, logic and theme tracks', () => {
    expect(trackForRound('final', 'candy')).toBe('final');
    expect(trackForRound('race', 'candy', true)).toBe('final');
    expect(trackForRound('logic', 'neon')).toBe('logic');
    expect(trackForRound('race', 'goo')).toBe('goo');
    expect(trackForRound('race', undefined)).toBe('candy');
  });

  it('raises intensity as the race fills and the clock runs down', () => {
    const early = intensityForStatus({ roundType: 'race', qualified: 2, qualifyTarget: 26 });
    const late = intensityForStatus({ roundType: 'race', qualified: 24, qualifyTarget: 26 });
    expect(late).toBeGreaterThan(early);
    expect(intensityForStatus({ roundType: 'survival', timeLeft: 20 })).toBeGreaterThanOrEqual(0.75);
    expect(intensityForStatus({ roundType: 'final', alive: 2, startPlayers: 7 })).toBe(1);
  });
});
