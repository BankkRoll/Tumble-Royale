/**
 * Design tokens for the "chunky sticker candy" look. The CSS in `ui.css`
 * mirrors these as custom properties; TS consumers (canvas confetti, inline
 * SVG, the 3D lobby) read them from here.
 */
import { TEAM_COLORS_BY_VISION } from '@tumble/shared';
import type { ColorBlindMode, Rarity, RoundType } from '../store/types.ts';

/** Core palette. */
export const palette = {
  ink: '#2b1a5e',
  inkSoft: '#4a3a86',
  sky: '#5aa9ff',
  skyDeep: '#2f7fe0',
  bubblegum: '#ff4f9a',
  grape: '#8a5cff',
  mint: '#3ee6b4',
  lemon: '#ffd23f',
  tangerine: '#ff8a3d',
  cream: '#fff7ea',
  cloud: '#ffffff',
  blush: '#ffd6f2',
} as const;

/** Rarity frame colours. Mythic is animated in CSS. */
export const rarityColors: Record<Rarity, string> = {
  common: '#b8c4d6',
  uncommon: '#5fd16a',
  rare: '#3fa9ff',
  epic: '#b05cff',
  legendary: '#ffb021',
  mythic: '#ff5fd2',
};

/** Rarity display names. */
export const rarityLabels: Record<Rarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
  mythic: 'Mythic',
};

/** Round type badge styling. */
export const roundTypeStyle: Record<RoundType, { label: string; color: string; icon: string }> = {
  race: { label: 'RACE', color: '#ff8a3d', icon: '🏁' },
  survival: { label: 'SURVIVAL', color: '#8a5cff', icon: '⏳' },
  team: { label: 'TEAM', color: '#3fa9ff', icon: '🤝' },
  hunt: { label: 'HUNT', color: '#ff4f9a', icon: '🎯' },
  logic: { label: 'LOGIC', color: '#3ec7c7', icon: '🧠' },
  final: { label: 'FINAL', color: '#ffb021', icon: '👑' },
};

/** Candy colours offered by the quick colour picker (welcome + locker). */
export const tumblerSwatches: readonly string[] = [
  '#ff4f9a',
  '#ff8a3d',
  '#ffd23f',
  '#9be34f',
  '#3ee6b4',
  '#3ec7e6',
  '#5aa9ff',
  '#7b6cff',
  '#b05cff',
  '#ff7ad9',
  '#ffffff',
  '#3a3550',
  '#ff6b6b',
  '#ffb3c7',
  '#c9f27a',
  '#8ff0ff',
  '#c7b8ff',
  '#a0703c',
];

/** Confetti / celebration colour sets. */
export const confettiSets = {
  candy: [
    palette.bubblegum,
    palette.lemon,
    palette.mint,
    palette.sky,
    palette.grape,
    palette.tangerine,
    palette.cloud,
  ],
  qualified: [palette.mint, palette.lemon, palette.cloud, '#9be34f'],
  victory: [
    palette.lemon,
    '#ffb021',
    palette.bubblegum,
    palette.mint,
    palette.sky,
    palette.cloud,
    palette.grape,
  ],
  levelUp: [palette.lemon, palette.grape, palette.cloud, palette.sky],
} as const;

/** Good / bad / warn semantic colours per colour-blind mode; team colours come from the shared 3D palette. */
export const semanticColors: Record<
  ColorBlindMode,
  { good: string; bad: string; warn: string; teams: [string, string, string, string] }
> = {
  off: {
    good: '#3ee6b4',
    bad: '#ff4f9a',
    warn: '#ff8a3d',
    teams: [...TEAM_COLORS_BY_VISION.off],
  },
  protanopia: {
    good: '#3fa9ff',
    bad: '#ffb021',
    warn: '#ffe14d',
    teams: [...TEAM_COLORS_BY_VISION.protanopia],
  },
  deuteranopia: {
    good: '#3fa9ff',
    bad: '#ff8a3d',
    warn: '#ffe14d',
    teams: [...TEAM_COLORS_BY_VISION.deuteranopia],
  },
  tritanopia: {
    good: '#3ec7c7',
    bad: '#ff4f6b',
    warn: '#ff9ad5',
    teams: [...TEAM_COLORS_BY_VISION.tritanopia],
  },
};

/** Font stacks (loaded by `mountUI` from Google Fonts unless disabled). */
export const fonts = {
  display: "'Lilita One', 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif",
  body: "'Fredoka', 'Nunito', 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif",
} as const;

/** Google Fonts stylesheet URL for the two faces. */
export const FONT_STYLESHEET_URL =
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Lilita+One&display=swap';

/** Shade a hex colour by `amount` (-1 = black … 1 = white). */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const mix = (c: number): number => Math.round((t - c) * p + c);
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
}

/** Perceived luminance 0..1 (for picking ink vs white text on a colour). */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
