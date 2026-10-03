/**
 * Clock math for the music scheduler. Everything is expressed relative to a
 * track's `origin` (the audio-clock time of step 0) so quantisation is exact
 * regardless of how late the scheduler timer fires.
 */

/** Tolerance so a boundary that is "now" within float error counts as now. */
const EPS = 1e-6;

/**
 * @param bpm - Tempo in beats per minute.
 * @returns Seconds per beat.
 */
export function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/**
 * @param bpm - Tempo.
 * @param stepsPerBeat - Grid resolution (4 = 16th notes).
 * @returns Seconds per sequencer step.
 */
export function secondsPerStep(bpm: number, stepsPerBeat = 4): number {
  return 60 / bpm / stepsPerBeat;
}

/**
 * @param bpm - Tempo.
 * @param beatsPerBar - Time signature numerator.
 * @returns Seconds per bar.
 */
export function secondsPerBar(bpm: number, beatsPerBar = 4): number {
  return (60 / bpm) * beatsPerBar;
}

/**
 * Audio-clock time of a step, with swing applied to off-beat 16ths.
 *
 * @param origin - Time of step 0.
 * @param step - Absolute step index.
 * @param stepDur - Seconds per step.
 * @param swing - 0 (straight) .. 0.5 (heavy shuffle); fraction of a step that odd steps are delayed.
 * @returns Time in seconds.
 */
export function stepTime(origin: number, step: number, stepDur: number, swing = 0): number {
  const base = origin + step * stepDur;
  return (step & 1) === 1 ? base + swing * stepDur : base;
}

/**
 * Index of the step playing at time `t` (straight grid).
 *
 * @param origin - Time of step 0.
 * @param t - Query time.
 * @param stepDur - Seconds per step.
 * @returns Step index, may be negative before the origin.
 */
export function stepAtTime(origin: number, t: number, stepDur: number): number {
  return Math.floor((t - origin) / stepDur + EPS);
}

/**
 * Next grid boundary at or after `now`.
 *
 * @param origin - Time of the grid's zero.
 * @param now - Query time.
 * @param interval - Grid spacing in seconds (a beat, a bar…).
 * @returns The earliest `origin + k * interval >= now` with integer `k >= 0`.
 * @example nextBoundary(10, 10.6, 0.5) // 11
 */
export function nextBoundary(origin: number, now: number, interval: number): number {
  if (now <= origin) return origin;
  const k = Math.ceil((now - origin) / interval - EPS);
  return origin + k * interval;
}

/**
 * Time of the next beat at or after `now`.
 *
 * @param origin - Track origin.
 * @param now - Query time.
 * @param bpm - Tempo.
 * @returns Beat-quantised time.
 */
export function nextBeatTime(origin: number, now: number, bpm: number): number {
  return nextBoundary(origin, now, secondsPerBeat(bpm));
}

/**
 * Time of the next bar line at or after `now`.
 *
 * @param origin - Track origin.
 * @param now - Query time.
 * @param bpm - Tempo.
 * @param beatsPerBar - Time signature numerator.
 * @returns Bar-quantised time.
 */
export function nextBarTime(origin: number, now: number, bpm: number, beatsPerBar = 4): number {
  return nextBoundary(origin, now, secondsPerBar(bpm, beatsPerBar));
}

/**
 * Hermite smoothstep, used to map game intensity onto layer gains.
 *
 * @param e0 - Edge where output is 0.
 * @param e1 - Edge where output is 1.
 * @param x - Input.
 * @returns 0..1.
 */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
