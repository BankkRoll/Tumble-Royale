/**
 * Clock the round view poses obstacle visuals with.
 *
 * Match time only advances from COUNTDOWN on, so during the intro flyover and
 * the rules card every `pose(t)` obstacle would sit frozen at one pose: the
 * camera tours a course where nothing swings. The sim must not run early
 * (determinism, nobody may move yet), so the view runs a cosmetic pre-roll
 * clock instead, timed to land on the countdown's first instant. Players are
 * frozen through those phases, so the visual/collider mismatch is never
 * touchable.
 */
import { RoundPhase, type RoundPhaseId } from '@tumble/shared';
import { COUNTDOWN_SECONDS } from '@tumble/sim/match';
import { DEFAULT_SHOW_TIMINGS, type ShowTimings } from '@tumble/sim/show';

/** Phases whose sim time is frozen while the course is already on screen. */
function isPreRoll(phase: RoundPhaseId): boolean {
  return phase === RoundPhase.IntroFlyover || phase === RoundPhase.RulesCard;
}

/**
 * Seconds of intro shown before the countdown for a round's flyover.
 *
 * @param flyoverSeconds - The round's `flyover.duration` (0 falls back to the director default).
 * @param timings - Overrides the running director was built with (the offline show shortens the rules card).
 * @returns Flyover plus rules card, as the show director schedules them.
 * @example
 * introPreRollSeconds(round.flyover.duration, source.showTimings);
 */
export function introPreRollSeconds(
  flyoverSeconds: number,
  timings: Partial<Pick<ShowTimings, 'introFlyover' | 'rulesCard'>> = {},
): number {
  const t = { ...DEFAULT_SHOW_TIMINGS, ...timings };
  return (flyoverSeconds || t.introFlyover) + t.rulesCard;
}

/**
 * Obstacle visual clock: the source's render time, except through the intro
 * where it runs a pre-roll from `-(countdown + preRoll)` up to the countdown start.
 *
 * @example
 * const clock = new ObstacleClock(introPreRollSeconds(round.flyover.duration));
 * // per frame
 * const t = clock.time(source.sim.phase, source.renderTime(), dt);
 */
export class ObstacleClock {
  private preview: number | null = null;

  /** @param preRoll - Expected intro length before the countdown, seconds. */
  constructor(private readonly preRoll: number) {}

  /**
   * @param phase - Current round phase of the sim.
   * @param renderTime - The source's interpolated match time.
   * @param dt - Frame delta (seconds, already time-scaled).
   * @returns Time to pose obstacle visuals at.
   */
  time(phase: RoundPhaseId, renderTime: number, dt: number): number {
    if (!isPreRoll(phase)) {
      this.preview = null;
      return renderTime;
    }
    const end = -COUNTDOWN_SECONDS;
    // NOTE: a slow load can stretch the intro past the schedule; holding at the countdown start beats a backwards jump.
    this.preview = this.preview === null ? end - this.preRoll : Math.min(this.preview + Math.max(0, dt), end);
    return this.preview;
  }
}
