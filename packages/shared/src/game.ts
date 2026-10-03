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

/** Colour-vision modes (Settings → Accessibility → Colour-blind mode). */
export type ColorVisionMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';

/**
 * Team colours per colour-vision mode, in team index order. The 3D world and
 * the UI both read these so a team looks the same on the HUD and in the arena.
 * Each alternate palette keeps all four teams further apart than the default
 * palette does once simulated for that deficiency (Machado 2009), using
 * orange / blue / white / violet families.
 */
export const TEAM_COLORS_BY_VISION: Readonly<
  Record<ColorVisionMode, readonly [string, string, string, string]>
> = {
  off: TEAM_COLORS,
  protanopia: ['#ffb021', '#3fa9ff', '#f0f0f0', '#7b6cff'],
  deuteranopia: ['#ff8a3d', '#3fa9ff', '#f0f0f0', '#6a2fb0'],
  tritanopia: ['#ff4f6b', '#3ec7c7', '#f0f0f0', '#7b3a8a'],
};

/** Shape cue per team index, so team is never told by colour alone. */
export const TEAM_SHAPES = ['circle', 'square', 'triangle', 'diamond'] as const;

/** A team's shape cue. */
export type TeamShape = (typeof TEAM_SHAPES)[number];
