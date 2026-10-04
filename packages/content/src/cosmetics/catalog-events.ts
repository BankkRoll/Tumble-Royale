/**
 * Limited-time event cosmetics. Each one is a reward on exactly one event's
 * points track (`progression/events.ts`) and is never sold, so missing the
 * event means missing the item until it returns. Built only from existing
 * palettes, patterns, meshes, plates, banners, trails and footstep packs.
 */
import { itemMeta } from './pricing.ts';
import type { CosmeticItemInput, Rarity } from './schema.ts';

const event = (rarity: Rarity) => itemMeta(rarity, 'event');

// -----------------------------------------------------------------------------
// Moonlit Mischief (autumn)
// -----------------------------------------------------------------------------

const moonlitMischief: CosmeticItemInput[] = [
  {
    id: 'color.moonlit-pumpkin',
    slot: 'color',
    name: 'Moonlit Pumpkin',
    description: 'Lantern orange under a violet moon.',
    colors: ['#ff8a3d', '#5b2a86', '#fff1c9'],
    ...event('uncommon'),
  },
  {
    id: 'pattern.bat-zigzag',
    slot: 'pattern',
    name: 'Bat Wing Zigzag',
    description: 'Jagged wings flapping across your belly.',
    pattern: 'zigzag',
    scale: 1.4,
    angle: -12,
    ...event('rare'),
  },
  {
    id: 'nameplate.moonlit',
    slot: 'nameplate',
    name: 'Night Parade',
    description: 'Glows like a jack-o-lantern grin.',
    plate: { style: 'neon', bg: '#2a1240', bg2: '#5b2a86', text: '#ffd23f', border: '#ff8a3d' },
    ...event('rare'),
  },
  {
    id: 'banner.moonlit',
    slot: 'banner',
    name: 'Harvest Moon',
    description: 'Stars over the pumpkin patch.',
    banner: { motif: 'stars', colors: ['#2a1240', '#ff8a3d', '#ffd23f'] },
    ...event('epic'),
  },
  {
    id: 'headwear.mischief-horns',
    slot: 'headwear',
    name: 'Mischief Horns',
    description: 'Tiny, pointy and up to no good.',
    mesh: 'horns',
    tint: ['#ff8a3d', '#5b2a86'],
    ...event('epic'),
  },
  {
    id: 'trail.wisp',
    slot: 'trail',
    name: 'Will-o-Wisp',
    description: 'Ghostly bubbles that follow you home.',
    trail: { kind: 'bubbles', colors: ['#b8f7ff', '#c7a6ff', '#ffffff'] },
    ...event('legendary'),
  },
];

// -----------------------------------------------------------------------------
// Frostbite Frolic (winter)
// -----------------------------------------------------------------------------

const frostbiteFrolic: CosmeticItemInput[] = [
  {
    id: 'color.glacier-glow',
    slot: 'color',
    name: 'Glacier Glow',
    description: 'Glacier blue with a snowdrift belly.',
    colors: ['#7cc8ff', '#ffffff', '#2b4c9b'],
    ...event('uncommon'),
  },
  {
    id: 'pattern.snow-diamonds',
    slot: 'pattern',
    name: 'Snow Crystals',
    description: 'Every crystal is a little bit different. Promise.',
    pattern: 'diamonds',
    scale: 1.6,
    angle: 45,
    ...event('rare'),
  },
  {
    id: 'nameplate.frostbite',
    slot: 'nameplate',
    name: 'Icicle Ticket',
    description: 'Admit one to the snowball fight.',
    plate: { style: 'ticket', bg: '#e8f6ff', bg2: '#bfe3ff', text: '#1d3a75', border: '#7cc8ff' },
    ...event('rare'),
  },
  {
    id: 'headwear.frost-beanie',
    slot: 'headwear',
    name: 'Frost Pom Beanie',
    description: 'Knitted by a very patient snowman.',
    mesh: 'beanie-pom',
    tint: ['#7cc8ff', '#ffffff'],
    ...event('epic'),
  },
  {
    id: 'banner.frostbite',
    slot: 'banner',
    name: 'First Snowfall',
    description: 'Soft clouds and fresh powder.',
    banner: { motif: 'clouds', colors: ['#bfe3ff', '#ffffff', '#7cc8ff'] },
    ...event('epic'),
  },
  {
    id: 'footsteps.jingle-steps',
    slot: 'footsteps',
    name: 'Jingle Steps',
    description: 'Jingle with every step.',
    pack: 'bell',
    ...event('legendary'),
  },
];

/** Every event cosmetic, in event order. */
export const EVENT_COLLECTION: readonly CosmeticItemInput[] = [...moonlitMischief, ...frostbiteFrolic];
