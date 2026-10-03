/** Round categories. */
export type RoundType = 'race' | 'survival' | 'team' | 'hunt' | 'logic' | 'final';

/**
 * Round lifecycle, mirrored on server and client. Values are stable wire ids.
 */
export const RoundPhase = {
  Loading: 0,
  IntroFlyover: 1,
  RulesCard: 2,
  Countdown: 3,
  Playing: 4,
  Overtime: 5,
  RoundEnd: 6,
  Results: 7,
  Transition: 8,
} as const;

/** Numeric round phase id. */
export type RoundPhaseId = (typeof RoundPhase)[keyof typeof RoundPhase];

/**
 * Show lifecycle around the rounds: pre-show waiting platform, rounds, then the
 * end-of-show sequence (player wall, victory, rewards).
 */
export const ShowPhase = {
  PreShow: 0,
  InRound: 1,
  BetweenRounds: 2,
  Victory: 3,
  Ended: 4,
} as const;

/** Numeric show phase id. */
export type ShowPhaseId = (typeof ShowPhase)[keyof typeof ShowPhase];

/** Visual themes. Each maps to a palette, sky, LUT and music track in content. */
export type ThemeId =
  'candy' | 'factory' | 'frosty' | 'jungle' | 'sunset' | 'space' | 'beach' | 'neon' | 'castle' | 'goo';

/** Team colours for team rounds, in index order. */
export const TEAM_COLORS = ['#ff4f8b', '#3fa9ff', '#ffd23f', '#6ee7a8'] as const;
