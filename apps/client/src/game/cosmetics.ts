/**
 * Cosmetics glue between the three loadout shapes the client juggles:
 *
 * - `@tumble/content` catalog items and `CosmeticLoadout` (data, ids);
 * - `@tumble/ui` `CosmeticItem` / `Loadout` / `TumblerColors` (locker + avatars);
 * - `@tumble/render` `TumblerLoadout` (3D Tumblers).
 *
 * Also generates deterministic bot looks so every scene (pre-show, rounds,
 * wall, podium) dresses the same bot identically.
 */
import {
  COSMETICS,
  DEFAULT_LOADOUT,
  getCosmetic,
  getCosmeticInSlot,
  randomLoadout,
  type CosmeticItem as ContentItem,
} from '@tumble/content/cosmetics';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { Rng, hashString } from '@tumble/shared';
import type {
  AvatarHat,
  CosmeticItem as UiItem,
  CosmeticSlot as UiSlot,
  EmoteSlot,
  Loadout as UiLoadout,
  PatternId as UiPattern,
  ShowPlayer,
  TumblerColors,
} from '@tumble/ui';

// -----------------------------------------------------------------------------
// Patterns
// -----------------------------------------------------------------------------

const UI_PATTERNS: readonly UiPattern[] = [
  'plain',
  'stripes',
  'dots',
  'checker',
  'zigzag',
  'stars',
  'gradient',
  'galaxy',
  'camo',
];

/**
 * Maps a UI pattern to the shader pattern id the render resolver accepts.
 *
 * @param p - UI pattern.
 * @returns Raw `PatternId` from `@tumble/content`.
 */
export function uiPatternToContent(p: UiPattern): string {
  if (p === 'plain') return 'solid';
  // The UI's star pattern has no shader twin; sprinkles reads closest at Tumbler scale.
  if (p === 'stars') return 'sprinkles';
  return p;
}

/**
 * Maps a loadout pattern (cosmetic id or raw id) to the closest UI pattern.
 *
 * @param pattern - `pattern.*` id or raw pattern id.
 */
export function contentPatternToUi(pattern: string): UiPattern {
  const raw = getCosmeticInSlot(pattern, 'pattern')?.pattern ?? pattern;
  if (raw === 'solid') return 'plain';
  if (raw === 'sprinkles') return 'stars';
  return (UI_PATTERNS as readonly string[]).includes(raw) ? (raw as UiPattern) : 'plain';
}

// -----------------------------------------------------------------------------
// Loadouts
// -----------------------------------------------------------------------------

/** UI slots that live in `Loadout.items`. */
type ItemSlot = keyof UiLoadout['items'];

/**
 * Converts the locker's loadout into a render loadout.
 *
 * @param l - UI loadout.
 * @returns A loadout every Tumbler factory understands.
 */
export function uiLoadoutToTumbler(l: UiLoadout): TumblerLoadout {
  const emotes = [...l.emotes];
  for (const e of DEFAULT_LOADOUT.emotes) if (emotes.length < 4 && !emotes.includes(e)) emotes.push(e);
  return {
    colors: [l.colors.primary, l.colors.secondary, l.colors.tertiary ?? DEFAULT_LOADOUT.colors[2]],
    pattern: uiPatternToContent(l.colors.pattern),
    face: l.items.face ?? DEFAULT_LOADOUT.face,
    upper: l.items.upper ?? null,
    lower: l.items.lower ?? null,
    headwear: l.items.headwear ?? null,
    back: l.items.back ?? null,
    emotes: emotes.slice(0, 4) as [string, string, string, string],
    celebration: l.items.celebration ?? DEFAULT_LOADOUT.celebration,
    victoryPose: l.items.victory ?? DEFAULT_LOADOUT.victoryPose,
    nameplate: l.items.nameplate ?? DEFAULT_LOADOUT.nameplate,
    trail: l.items.trail ?? null,
  };
}

/**
 * Builds a fresh UI loadout from colours (first launch, defaults).
 *
 * @param name - Loadout name.
 * @param colors - Body colours.
 */
export function defaultUiLoadout(name: string, colors: TumblerColors): UiLoadout {
  return {
    name,
    colors,
    items: {
      face: DEFAULT_LOADOUT.face,
      celebration: DEFAULT_LOADOUT.celebration,
      victory: DEFAULT_LOADOUT.victoryPose,
      nameplate: DEFAULT_LOADOUT.nameplate,
    },
    emotes: [...DEFAULT_LOADOUT.emotes],
  };
}

/**
 * UI colours of a render loadout (results grids, wall avatars, toasts).
 *
 * @param l - Render loadout.
 */
export function tumblerColors(l: TumblerLoadout): TumblerColors {
  return {
    primary: l.colors[0],
    secondary: l.colors[1],
    tertiary: l.colors[2],
    pattern: contentPatternToUi(l.pattern),
  };
}

const HATS: Readonly<Record<string, AvatarHat>> = {
  'party-cone': 'cone',
  'top-hat': 'tophat',
  'chef-hat': 'tophat',
  antenna: 'antenna',
  'bunny-ears': 'antenna',
  'cat-ears': 'antenna',
  'propeller-cap': 'cap',
  'beanie-pom': 'cap',
  headphones: 'cap',
  tiara: 'crown',
  flower: 'bow',
};

/**
 * The CSS avatar hat closest to a headwear item.
 *
 * @param headwear - Headwear cosmetic id or null.
 */
export function avatarHat(headwear: string | null): AvatarHat {
  if (!headwear) return 'none';
  const item = getCosmetic(headwear);
  return item && 'mesh' in item ? (HATS[item.mesh] ?? 'none') : 'none';
}

/**
 * Deterministic bot look: the same seed and player always produce the same outfit.
 *
 * @param showSeed - Show seed.
 * @param playerId - Player id.
 * @param name - Player name (mixed in so renamed bots differ).
 */
export function botLoadout(showSeed: number, playerId: number, name: string): TumblerLoadout {
  const rng = new Rng((showSeed ^ hashString(name) ^ Math.imul(playerId + 1, 0x9e3779b1)) >>> 0);
  return randomLoadout(rng);
}

/**
 * Builds the UI participant record for a player.
 *
 * @param id - Player id.
 * @param name - Display name.
 * @param loadout - Render loadout.
 * @param extra - Bot/local/party flags.
 */
export function showPlayer(
  id: number,
  name: string,
  loadout: TumblerLoadout,
  extra: { isBot: boolean; isLocal?: boolean; isParty?: boolean; team?: number; userId?: string },
): ShowPlayer {
  return { id, name, colors: tumblerColors(loadout), hat: avatarHat(loadout.headwear), ...extra };
}

/**
 * Parses the opaque loadout blob other clients send through the game server.
 *
 * @param blob - JSON produced by {@link encodeLoadout}, or anything else.
 * @returns The loadout, or null when the blob is not one of ours.
 */
export function decodeLoadout(blob: string): TumblerLoadout | null {
  if (!blob) return null;
  try {
    const v = JSON.parse(blob) as Partial<TumblerLoadout>;
    if (!Array.isArray(v.colors) || v.colors.length !== 3 || typeof v.pattern !== 'string') return null;
    return {
      ...DEFAULT_LOADOUT,
      ...v,
      emotes: (v.emotes ?? DEFAULT_LOADOUT.emotes) as TumblerLoadout['emotes'],
    } as TumblerLoadout;
  } catch {
    return null;
  }
}

/**
 * Serialises a loadout for the game server's opaque loadout field.
 *
 * @param l - Render loadout.
 */
export function encodeLoadout(l: TumblerLoadout): string {
  return JSON.stringify(l);
}

// -----------------------------------------------------------------------------
// Locker items
// -----------------------------------------------------------------------------

const SLOT_ICON: Readonly<Record<string, string>> = {
  color: '🎨',
  pattern: '🌀',
  face: '🙂',
  upper: '👕',
  lower: '🩳',
  headwear: '🎩',
  back: '🎒',
  emote: '💃',
  celebration: '🎉',
  victory: '🏆',
  nameplate: '🏷️',
  banner: '🚩',
  trail: '✨',
  footsteps: '👟',
};

const ITEM_ICON: Readonly<Record<string, string>> = {
  'headwear.party-cone': '🥳',
  'headwear.top-hat': '🎩',
  'headwear.chef': '👨‍🍳',
  'headwear.tiara': '👑',
  'headwear.royal-tiara': '👑',
  'headwear.halo': '😇',
  'headwear.bunny': '🐰',
  'headwear.cat-ears': '🐱',
  'headwear.flower': '🌼',
  'headwear.sprout': '🌱',
  'headwear.headphones': '🎧',
  'headwear.horns': '😈',
  'headwear.propeller': '🚁',
  'back.jetpack': '🚀',
  'back.wings': '🦋',
  'back.shell': '🐢',
  'back.cape': '🦸',
  'back.royal-cape': '🤴',
  'emote.wave': '👋',
  'emote.laugh': '😂',
  'emote.flex': '💪',
  'emote.dance': '🕺',
  'emote.shrug': '🤷',
  'emote.facepalm': '🤦',
  'emote.bow': '🙇',
  'emote.spin': '🌪️',
  'emote.jumping-jacks': '🤸',
  'trail.rainbow': '🌈',
  'trail.hearts': '💖',
  'trail.bubbles': '🫧',
  'trail.stars': '☄️',
  'lower.tutu': '🩰',
  'face.star-shades': '🕶️',
  'face.monocle': '🧐',
  'face.mustache': '🥸',
};

const RARITY_ART: Readonly<Record<string, [string, string]>> = {
  common: ['#d6e4ff', '#a8c6ff'],
  uncommon: ['#9cf2c8', '#3ee6b4'],
  rare: ['#8cc6ff', '#5aa9ff'],
  epic: ['#c7a6ff', '#8a5cff'],
  legendary: ['#ffe27a', '#ffb021'],
  mythic: ['#ff9ad5', '#ff4f9a'],
};

/** Content slot → UI slot. */
function uiSlot(slot: ContentItem['slot']): UiSlot {
  return slot === 'color' ? 'colors' : slot;
}

/**
 * Converts a catalog item into a locker card.
 *
 * @param item - Content cosmetic.
 * @param owned - Whether the player owns it.
 */
export function uiItem(item: ContentItem, owned: boolean): UiItem {
  const art: [string, string] =
    item.slot === 'color'
      ? [item.colors[0], item.colors[1]]
      : (RARITY_ART[item.rarity] ?? ['#d6e4ff', '#a8c6ff']);
  return {
    id: item.id,
    name: item.name,
    slot: uiSlot(item.slot),
    rarity: item.rarity,
    description: item.description,
    icon: ITEM_ICON[item.id] ?? SLOT_ICON[item.slot] ?? '🎁',
    art,
    owned,
  };
}

/**
 * Every locker card, with ownership applied.
 *
 * @param owned - Ids the player owns beyond the default items.
 */
export function lockerItems(owned: ReadonlySet<string>): UiItem[] {
  return COSMETICS.map((c) => uiItem(c, c.source === 'default' || owned.has(c.id)));
}

/**
 * Emote wheel slots for a loadout (4 emotes + 4 quick pings).
 *
 * @param emotes - Equipped emote ids.
 */
export function emoteSlots(emotes: readonly string[]): EmoteSlot[] {
  const slots: EmoteSlot[] = emotes.slice(0, 4).map((id) => ({
    id,
    label: getCosmetic(id)?.name ?? id,
    icon: ITEM_ICON[id] ?? '💃',
  }));
  slots.push(
    { id: 'ping:go', label: 'Go here!', icon: '📍' },
    { id: 'ping:watch', label: 'Watch out!', icon: '⚠️' },
    { id: 'ping:nice', label: 'Nice!', icon: '👍' },
    { id: 'ping:gg', label: 'GG!', icon: '🤝' },
  );
  return slots;
}

/**
 * Picks an unowned item to reveal on level-up, seeded by the new level.
 *
 * @param owned - Owned ids.
 * @param level - Level just reached.
 * @returns A catalog item, or null when everything is owned.
 */
export function levelUpUnlock(owned: ReadonlySet<string>, level: number): ContentItem | null {
  // Crown Shard exclusives are only ever sold in the shard shop.
  const pool = COSMETICS.filter(
    (c) =>
      c.source !== 'default' &&
      c.source !== 'shards' &&
      !owned.has(c.id) &&
      c.rarity !== 'mythic' &&
      c.rarity !== 'legendary',
  );
  if (pool.length === 0) return null;
  const rng = new Rng(hashString(`level-${level}`));
  return pool[Math.floor(rng.next() * pool.length)] ?? null;
}

/** Mutable copy of an item slot map key list, for iteration in the profile store. */
export const LOADOUT_ITEM_SLOTS: readonly ItemSlot[] = [
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'celebration',
  'victory',
  'nameplate',
  'banner',
  'trail',
  'footsteps',
];
