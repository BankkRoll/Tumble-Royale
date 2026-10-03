/**
 * Theme catalogue: one validated {@link ThemeDefinition} per `ThemeId`.
 *
 * Responsibilities: schema (palette, sky, fog, lighting, clouds, decor, void,
 * grade, bloom, weather), authored data, lookup and palette-key resolution.
 */
import type { ThemeId } from '@tumble/shared';
import { ThemeDefinitionSchema, type ThemeDefinition, type ThemePaletteKey } from './schema.ts';
import { THEME_INPUTS } from './themes.ts';

export * from './schema.ts';

const THEMES: ReadonlyMap<ThemeId, ThemeDefinition> = new Map(
  THEME_INPUTS.map((input) => {
    const theme = ThemeDefinitionSchema.parse(input);
    return [theme.id, theme] as const;
  }),
);

/** Every theme id, in catalogue order. */
export const THEME_IDS: readonly ThemeId[] = [...THEMES.keys()];

/**
 * Looks up a theme by id.
 *
 * @param id - Theme id from a round definition.
 * @returns The validated theme. Unknown ids fall back to `candy` so a typo in
 *   content never blacks out a round.
 * @example
 * const theme = getTheme(round.theme);
 * scene.fog = new Fog(theme.fog.color, theme.fog.near, theme.fog.far);
 */
export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES.get(id) ?? (THEMES.get('candy') as ThemeDefinition);
}

/** All validated themes. */
export function listThemes(): readonly ThemeDefinition[] {
  return [...THEMES.values()];
}

/**
 * Resolves a `StaticPiece.color` value — a palette key or a literal hex — to hex.
 *
 * @param theme - Active theme.
 * @param color - Palette key (`primary`, `danger`, …) or `#rrggbb`.
 * @returns A `#rrggbb` string; unknown keys resolve to the theme's primary.
 */
export function resolveThemeColor(theme: ThemeDefinition, color: string): string {
  if (color.startsWith('#')) return color;
  const palette = theme.palette as Record<string, string>;
  return palette[color] ?? theme.palette.primary;
}

/** Type guard for palette keys. */
export function isPaletteKey(theme: ThemeDefinition, key: string): key is ThemePaletteKey {
  return key in theme.palette;
}
