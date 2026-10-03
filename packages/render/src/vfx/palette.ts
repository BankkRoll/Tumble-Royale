import { Color } from 'three/webgpu';
import { TEAM_COLORS } from '@tumble/shared';

/**
 * Art-direction colours and cached hex parsing for the VFX library.
 *
 * Responsibilities:
 * - Named palettes (candy confetti, gold, danger, safe, rainbow…) as `Color`s
 *   in the linear working space, built once.
 * - `hexColor` cache so per-spawn colour overrides never allocate after first use.
 */

const cache = new Map<string, Color>();

/**
 * Parses `hex` once and returns the shared `Color`. Never mutate the result.
 *
 * @param hex - Any CSS colour string three understands (`#rrggbb` expected).
 * @returns Cached colour in the linear working space.
 */
export function hexColor(hex: string): Color {
  let c = cache.get(hex);
  if (!c) {
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}

const list = (hexes: readonly string[]): readonly Color[] => hexes.map(hexColor);

/** Candy confetti: pastel base with saturated accents. */
export const CONFETTI_COLORS = list([
  '#ff5fa2',
  '#ffd23f',
  '#4fd6ff',
  '#7cf29a',
  '#b67dff',
  '#ff8a3d',
  '#ffffff',
  '#ff9ed2',
]);
/** Firework burst colours. */
export const FIREWORK_COLORS = list(['#ff4f8b', '#ffd23f', '#4fc3ff', '#7cf29a', '#c58bff', '#ff9a3d']);
/** Elimination balloons. */
export const BALLOON_COLORS = list(['#ff5f8f', '#ffd23f', '#5fc8ff', '#8ff0a4', '#c58bff', '#ff9a52']);
/** Crown / qualification gold, warm to pale. */
export const GOLD_COLORS = list(['#ffd23f', '#ffe98a', '#fff6cf', '#ffb627']);
/** Safe / success mint and cyan. */
export const MINT_COLORS = list(['#7cf2c0', '#9ff7ff', '#5fe3b0']);
/** Rainbow stops for trails. */
export const RAINBOW_COLORS = list([
  '#ff5f6d',
  '#ffb347',
  '#ffe66d',
  '#7cf29a',
  '#5fc8ff',
  '#a98bff',
  '#ff8bd8',
]);
/** Team colours (shared with UI). */
export const TEAM_PALETTE = list(TEAM_COLORS);

/** Named single colours. */
export const COLORS = {
  white: hexColor('#ffffff'),
  cream: hexColor('#f3e6d0'),
  dust: hexColor('#e9dcc6'),
  cloud: hexColor('#fff8fb'),
  gold: hexColor('#ffd23f'),
  mint: hexColor('#7cf2c0'),
  cyan: hexColor('#5fe0ff'),
  danger: hexColor('#ff3d8b'),
  orange: hexColor('#ff8a3d'),
  interact: hexColor('#ffe14d'),
  slime: hexColor('#8cff5a'),
  water: hexColor('#5fc8ff'),
  lava: hexColor('#ff6a2a'),
  crack: hexColor('#3a2240'),
  shadow: hexColor('#2b2148'),
  star: hexColor('#ffe14d'),
  wind: hexColor('#eefcff'),
  teleport: hexColor('#b98cff'),
} as const;
