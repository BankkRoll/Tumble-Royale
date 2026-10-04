/**
 * Phase lengths of the offline show director, in their own module so the
 * round view's intro clock and tests can read them without pulling in the
 * whole offline session.
 */
import type { ShowTimings } from '@tumble/sim/show';

/** Phase lengths tuned so the UI cards and the director agree (SCREENS.md §15). */
export const OFFLINE_SHOW_TIMINGS = {
  preShow: 0,
  rulesCard: 3,
  countdown: 3,
  roundEnd: 1.5,
  results: 5.5,
  transition: 0.2,
  victory: 600,
} as const satisfies Partial<ShowTimings>;
