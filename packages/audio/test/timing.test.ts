import { describe, expect, it } from 'vitest';
import {
  nextBarTime,
  nextBeatTime,
  nextBoundary,
  secondsPerBar,
  secondsPerBeat,
  secondsPerStep,
  smoothstep,
  stepAtTime,
  stepTime,
} from '../src/music/timing.ts';

describe('music timing', () => {
  it('converts tempo to durations', () => {
    expect(secondsPerBeat(120)).toBeCloseTo(0.5);
    expect(secondsPerStep(120)).toBeCloseTo(0.125);
    expect(secondsPerBar(120, 4)).toBeCloseTo(2);
    expect(secondsPerBar(150, 3)).toBeCloseTo(1.2);
  });

  it('places steps on the grid with swing only on odd steps', () => {
    expect(stepTime(10, 0, 0.125)).toBeCloseTo(10);
    expect(stepTime(10, 4, 0.125)).toBeCloseTo(10.5);
    expect(stepTime(10, 1, 0.125, 0.2)).toBeCloseTo(10 + 0.125 + 0.025);
    expect(stepTime(10, 2, 0.125, 0.2)).toBeCloseTo(10.25);
  });

  it('finds the step playing at a time', () => {
    expect(stepAtTime(0, 0.124, 0.125)).toBe(0);
    expect(stepAtTime(0, 0.125, 0.125)).toBe(1);
    expect(stepAtTime(1, 0.5, 0.125)).toBe(-4);
  });

  it('quantises to the next boundary, inclusive of exact hits', () => {
    expect(nextBoundary(10, 10.6, 0.5)).toBeCloseTo(11);
    expect(nextBoundary(10, 11, 0.5)).toBeCloseTo(11);
    expect(nextBoundary(10, 9, 0.5)).toBe(10);
    // Float error just past a boundary still counts as that boundary.
    expect(nextBoundary(0, 0.1 + 0.2, 0.3)).toBeCloseTo(0.3);
  });

  it('quantises to beats and bars of a running track', () => {
    // 120 bpm from origin 5: beats every 0.5 s, bars every 2 s.
    expect(nextBeatTime(5, 5.01, 120)).toBeCloseTo(5.5);
    expect(nextBarTime(5, 5.01, 120)).toBeCloseTo(7);
    expect(nextBarTime(5, 7.0, 120)).toBeCloseTo(7);
    expect(nextBarTime(5, 7.0001, 120)).toBeCloseTo(9);
    // 3/4 at 150 bpm: bars every 1.2 s.
    expect(nextBarTime(0, 1.3, 150, 3)).toBeCloseTo(2.4);
  });

  it('smoothstep clamps and eases', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});
