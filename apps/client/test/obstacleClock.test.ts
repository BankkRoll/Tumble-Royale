import { RoundPhase } from '@tumble/shared';
import { COUNTDOWN_SECONDS } from '@tumble/sim/match';
import { describe, expect, it } from 'vitest';
import { ObstacleClock, introPreRollSeconds } from '../src/game/round/obstacleClock.ts';

describe('obstacle clock', () => {
  it('runs a pre-roll through the intro that lands on the countdown start', () => {
    const preRoll = introPreRollSeconds(7);
    expect(preRoll).toBe(11);
    const clock = new ObstacleClock(preRoll);
    const t0 = clock.time(RoundPhase.IntroFlyover, 0, 1 / 60);
    expect(t0).toBeCloseTo(-COUNTDOWN_SECONDS - preRoll, 9);
    let t = t0;
    for (let i = 0; i < 60 * 7; i++) t = clock.time(RoundPhase.IntroFlyover, 0, 1 / 60);
    expect(t).toBeGreaterThan(t0 + 6.9);
    for (let i = 0; i < 60 * 4; i++) t = clock.time(RoundPhase.RulesCard, 0, 1 / 60);
    expect(t).toBeCloseTo(-COUNTDOWN_SECONDS, 6);
    // A late countdown holds at its start instead of running past it.
    for (let i = 0; i < 120; i++) t = clock.time(RoundPhase.RulesCard, 0, 1 / 60);
    expect(t).toBe(-COUNTDOWN_SECONDS);
  });

  it('follows the source clock outside the intro (and for replays, which never enter it)', () => {
    const clock = new ObstacleClock(11);
    expect(clock.time(RoundPhase.Countdown, -2.5, 1 / 60)).toBe(-2.5);
    expect(clock.time(RoundPhase.Playing, 12.25, 1 / 60)).toBe(12.25);
    expect(clock.time(RoundPhase.Loading, 4, 1 / 60)).toBe(4);
    // A new intro restarts the pre-roll.
    expect(clock.time(RoundPhase.IntroFlyover, 0, 1 / 60)).toBeCloseTo(-14, 9);
  });
});
