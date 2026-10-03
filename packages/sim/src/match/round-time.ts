import type { RoundDefinition } from '@tumble/shared';

/** Shortest allowed round timer scale (half-length rounds). */
export const ROUND_TIME_SCALE_MIN = 0.5;
/** Longest allowed round timer scale (double-length rounds). */
export const ROUND_TIME_SCALE_MAX = 2;

/**
 * Clamps a round timer scale to [{@link ROUND_TIME_SCALE_MIN}, {@link ROUND_TIME_SCALE_MAX}].
 * Non-finite or missing values mean "unscaled".
 *
 * @param scale - Requested scale (private-show "timer" option, ticket field).
 * @returns The scale the show will actually use.
 * @example
 * clampRoundTimeScale(3); // 2
 */
export function clampRoundTimeScale(scale: number | null | undefined): number {
  if (scale === null || scale === undefined || !Number.isFinite(scale)) return 1;
  return Math.min(ROUND_TIME_SCALE_MAX, Math.max(ROUND_TIME_SCALE_MIN, scale));
}

/**
 * Returns the round with its timer (and overtime) scaled. Untimed rounds and a
 * scale of 1 return the same object. Seconds are rounded to whole seconds so
 * HUD timers, round cards and the director's play limit show the same numbers.
 *
 * @param round - Parsed round definition.
 * @param scale - Already clamped scale (see {@link clampRoundTimeScale}).
 * @returns The round to simulate.
 */
export function scaleRoundTimer(round: RoundDefinition, scale: number): RoundDefinition {
  const d = round.duration;
  if (scale === 1 || d.seconds <= 0) return round;
  return {
    ...round,
    duration: {
      ...d,
      seconds: Math.max(1, Math.round(d.seconds * scale)),
      overtimeSeconds: Math.round(d.overtimeSeconds * scale),
    },
  };
}
