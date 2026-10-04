/**
 * Guards the cosmetic obstacle clock the round view poses visuals with
 * through the intro: it must run through the flyover and rules card and hand
 * over to match time on the countdown's first frame without a jump, for every
 * round's flyover length and for both directors' timings (the offline show
 * runs a shorter rules card than the server).
 */
import { ROUNDS } from '@tumble/content/rounds';
import { TUTORIAL_ROUND_INPUT } from '@tumble/content/rounds/practice-island';
import { RoundDefinitionSchema, RoundPhase } from '@tumble/shared';
import { COUNTDOWN_SECONDS } from '@tumble/sim/match';
import { DEFAULT_SHOW_TIMINGS, type ShowTimings } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import { ObstacleClock, introPreRollSeconds } from '../src/game/round/obstacleClock.ts';
import { OFFLINE_SHOW_TIMINGS } from '../src/game/show/offlineTimings.ts';

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

  it('times the pre-roll from the running director', () => {
    expect(introPreRollSeconds(7, OFFLINE_SHOW_TIMINGS)).toBe(7 + OFFLINE_SHOW_TIMINGS.rulesCard);
    expect(introPreRollSeconds(0, { introFlyover: 5, rulesCard: 2 })).toBe(7);
  });
});

const ALL_ROUNDS = [...ROUNDS, TUTORIAL_ROUND_INPUT].map((r) => RoundDefinitionSchema.parse(r));
const DIRECTORS: readonly { label: string; timings: Partial<ShowTimings> }[] = [
  { label: 'online (default timings)', timings: {} },
  { label: 'offline', timings: OFFLINE_SHOW_TIMINGS },
];

/**
 * Plays one intro the way the show director schedules it (flyover, then the
 * rules card, then COUNTDOWN from `-countdown`) at a frame delta, and returns
 * the clock's last pre-roll time, its first countdown time and the longest
 * frame (the pre-roll's first frame shows its start, so it may trail by one).
 */
function playIntro(
  flyover: number,
  timings: Partial<ShowTimings>,
  frameDt: (i: number) => number,
): { last: number; first: number; frame: number } {
  const t = { ...DEFAULT_SHOW_TIMINGS, ...timings };
  // Mirrors ShowDirector: a round without a flyover duration uses the default length.
  const intro = flyover || t.introFlyover;
  const clock = new ObstacleClock(introPreRollSeconds(flyover, timings));
  let elapsed = 0;
  let last = NaN;
  let frame = 0;
  for (let i = 0; ; i++) {
    const dt = frameDt(i);
    const phase =
      elapsed < intro
        ? RoundPhase.IntroFlyover
        : elapsed < intro + t.rulesCard
          ? RoundPhase.RulesCard
          : RoundPhase.Countdown;
    if (phase === RoundPhase.Countdown) return { last, first: clock.time(phase, -t.countdown, dt), frame };
    last = clock.time(phase, 0, dt);
    frame = Math.max(frame, dt);
    elapsed += dt;
  }
}

describe('obstacle clock over every round intro', () => {
  it('both directors start the countdown where the clock aims', () => {
    for (const d of DIRECTORS)
      expect({ ...DEFAULT_SHOW_TIMINGS, ...d.timings }.countdown, d.label).toBe(COUNTDOWN_SECONDS);
  });

  const rates = [
    { label: '60 Hz', dt: (): number => 1 / 60 },
    { label: '144 Hz', dt: (): number => 1 / 144 },
    { label: '30 Hz', dt: (): number => 1 / 30 },
    { label: 'uneven', dt: (i: number): number => (i % 3 === 0 ? 1 / 40 : 1 / 90) },
  ];
  for (const d of DIRECTORS)
    it(`hands over on the countdown start without a jump: ${d.label}`, () => {
      for (const round of ALL_ROUNDS)
        for (const rate of rates) {
          const { last, first, frame } = playIntro(round.flyover.duration, d.timings, rate.dt);
          const tag = `${round.id} ${rate.label}`;
          expect(first, tag).toBe(-COUNTDOWN_SECONDS);
          // Never past the countdown start, and at most one frame short of it (no visible pop).
          expect(last, tag).toBeLessThanOrEqual(first);
          expect(first - last, tag).toBeLessThanOrEqual(frame + 1e-9);
        }
    });
});
