/**
 * Playback clock for the replay viewer: play/pause, speed steps, seeking and
 * end-of-recording handling, as plain state so it is trivially testable.
 */

/** Playback speeds offered by the viewer, slowest first. */
export const REPLAY_SPEEDS: readonly number[] = [0.25, 0.5, 1, 1.5, 2];

/**
 * Replay time keeper.
 *
 * @example
 * const clock = new ReplayClock(timeline.duration);
 * // per frame
 * const t = clock.advance(realDt);
 * if (clock.consumeJump()) resetEffects();
 */
export class ReplayClock {
  /** Seconds from the start of the recording. */
  time = 0;
  playing = true;
  private speedIndex = REPLAY_SPEEDS.indexOf(1);
  private jumped = true;

  /** @param duration - Recording length (s). */
  constructor(readonly duration: number) {}

  /** Current playback rate. */
  get speed(): number {
    return REPLAY_SPEEDS[this.speedIndex] as number;
  }

  /** True when the playhead sits at the end. */
  get ended(): boolean {
    return this.time >= this.duration;
  }

  /**
   * Moves the playhead by a real frame delta.
   *
   * @param realDt - Unscaled frame time (s).
   * @returns The new time.
   */
  advance(realDt: number): number {
    if (!this.playing) return this.time;
    this.time = Math.min(this.duration, this.time + Math.max(0, realDt) * this.speed);
    if (this.time >= this.duration) this.playing = false;
    return this.time;
  }

  /** Play/pause; playing from the end restarts. */
  toggle(): void {
    if (!this.playing && this.ended) this.seek(0);
    this.playing = !this.playing;
  }

  /**
   * Jumps to a time (clamped). Marks a discontinuity so the viewer can skip
   * the effects of everything in between.
   */
  seek(t: number): void {
    const next = Math.max(0, Math.min(this.duration, Number.isFinite(t) ? t : t > 0 ? this.duration : 0));
    if (next !== this.time) this.jumped = true;
    this.time = next;
  }

  /** Relative seek. */
  seekBy(seconds: number): void {
    this.seek(this.time + seconds);
  }

  /**
   * Sets the closest offered speed.
   *
   * @param speed - Requested rate.
   */
  setSpeed(speed: number): void {
    let best = 0;
    for (let i = 1; i < REPLAY_SPEEDS.length; i++)
      if (Math.abs((REPLAY_SPEEDS[i] as number) - speed) < Math.abs((REPLAY_SPEEDS[best] as number) - speed))
        best = i;
    this.speedIndex = best;
  }

  /** Steps the speed up or down one notch (clamped). */
  stepSpeed(dir: 1 | -1): void {
    this.speedIndex = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, this.speedIndex + dir));
  }

  /** @returns True once after each seek (and at start). */
  consumeJump(): boolean {
    const j = this.jumped;
    this.jumped = false;
    return j;
  }
}
