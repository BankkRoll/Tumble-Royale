/**
 * Team colours for the 3D world, following the colour-blind setting.
 *
 * Everything that paints a team (goal zones, paint grids, team props, zone
 * markers, team smoke, nameplate dots, level pieces authored in team colours)
 * asks here instead of reading `TEAM_COLORS` directly, so the arena matches
 * the HUD's palette. Objects read the palette when they are built: a change
 * applies from the next round (or menu scene) on.
 */
import {
  TEAM_COLORS,
  TEAM_COLORS_BY_VISION,
  TEAM_SHAPES,
  type ColorVisionMode,
  type TeamShape,
} from '@tumble/shared';

let mode: ColorVisionMode = 'off';

/**
 * Selects the team palette for colour-blind players.
 *
 * @param next - Settings → Accessibility → Colour-blind mode.
 * @example
 * setTeamColorMode(settings.accessibility.colorBlind);
 */
export function setTeamColorMode(next: ColorVisionMode): void {
  mode = next in TEAM_COLORS_BY_VISION ? next : 'off';
}

/** The active colour-vision mode. */
export function teamColorMode(): ColorVisionMode {
  return mode;
}

/** The four team colours for the active mode, in team index order. */
export function teamColors(): readonly string[] {
  return TEAM_COLORS_BY_VISION[mode];
}

/**
 * A team's colour (`#rrggbb`) in the active mode.
 *
 * @param team - Team index (wraps).
 */
export function teamColor(team: number): string {
  const list = TEAM_COLORS_BY_VISION[mode];
  const i = ((Math.trunc(team) % list.length) + list.length) % list.length;
  return list[i]!;
}

/**
 * A team's shape cue (nameplates, HUD pills).
 *
 * @param team - Team index (wraps).
 */
export function teamShape(team: number): TeamShape {
  const i = ((Math.trunc(team) % TEAM_SHAPES.length) + TEAM_SHAPES.length) % TEAM_SHAPES.length;
  return TEAM_SHAPES[i]!;
}

const DEFAULT_INDEX = new Map<string, number>(TEAM_COLORS.map((c, i) => [c.toLowerCase(), i]));

/**
 * Swaps a colour authored as a default team colour (round content paints
 * team pads with `TEAM_COLORS[i]`) for the active palette's; any other
 * colour passes through.
 *
 * @param hex - Authored colour.
 * @returns The colour to render.
 */
export function remapTeamColor(hex: string): string {
  if (mode === 'off') return hex;
  const i = DEFAULT_INDEX.get(hex.toLowerCase());
  return i === undefined ? hex : teamColor(i);
}
