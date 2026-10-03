import { z } from 'zod';
import { COSMETICS, CosmeticSlotSchema, RaritySchema, type CosmeticSlot, type Rarity } from '../cosmetics/index.ts';

/** Tiers in a season pass. */
export const PASS_TIERS = 100;

/** One reward on a pass tier. */
export const PassRewardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cosmetic'),
    /**
     * Cosmetics catalogue id. Real `pass`-source items from `/content/cosmetics`
     * fill the best tiers first; the rest are placeholders (`pass.<season>.<track>.<slot>.<tier>`)
     * that the locker shows as "coming soon" until art lands.
     */
    itemId: z.string(),
    slot: CosmeticSlotSchema,
    rarity: RaritySchema,
  }),
  z.object({ kind: z.literal('gumballs'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('gems'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('crownShards'), amount: z.number().int().positive() }),
]);

/** A pass reward. */
export type PassReward = z.output<typeof PassRewardSchema>;

/** One tier: XP cost and rewards on each track. */
export const PassTierSchema = z.object({
  tier: z.number().int().min(1),
  /** XP needed to clear this tier. */
  xp: z.number().int().positive(),
  free: z.array(PassRewardSchema),
  premium: z.array(PassRewardSchema),
});

/** A whole season. */
export const SeasonPassSchema = z.object({
  seasonId: z.string(),
  name: z.string(),
  /** Premium track price in Gems. */
  premiumPriceGems: z.number().int().positive(),
  tiers: z
    .array(PassTierSchema)
    .length(PASS_TIERS)
    .refine((t) => t.every((x, i) => x.tier === i + 1), 'tiers must be 1..100 in order'),
});

/** A validated season pass. */
export type SeasonPass = z.output<typeof SeasonPassSchema>;
type Slot = CosmeticSlot;

const SLOT_CYCLE: readonly Slot[] = [
  'color',
  'emote',
  'headwear',
  'nameplate',
  'pattern',
  'upper',
  'banner',
  'lower',
  'face',
  'trail',
  'back',
  'celebration',
  'footsteps',
];

const RARITY_ORDER: readonly Rarity[] = RaritySchema.options;

/** Catalogue items unlocked through the pass, commonest first. */
const passItems = COSMETICS.filter((c) => c.source === 'pass')
  .slice()
  .sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity) || (a.id < b.id ? -1 : 1));

function placeholder(season: string, slot: Slot, tier: number, rarity: Rarity, track: 'free' | 'premium'): PassReward {
  return { kind: 'cosmetic', itemId: `pass.${season}.${track}.${slot}.${tier}`, slot, rarity };
}

/**
 * Season 1 layout: tier cost ramps gently from 900 to 1500 XP; the free
 * track rewards every few tiers (Gumballs, shards, commons), the premium
 * track every tier with rarer cosmetics, Gems refunding most of the price
 * across the season, and a mythic victory pose at tier 100.
 */
function buildSeason1(): z.input<typeof SeasonPassSchema> {
  const season = 's1';
  const tiers: z.input<typeof PassTierSchema>[] = [];
  for (let tier = 1; tier <= PASS_TIERS; tier++) {
    const xp = Math.round((900 + 600 * ((tier - 1) / (PASS_TIERS - 1))) / 50) * 50;
    const free: PassReward[] = [];
    const premium: PassReward[] = [];
    const slot = SLOT_CYCLE[tier % SLOT_CYCLE.length] as Slot;
    if (tier % 10 === 0) free.push(placeholder(season, slot, tier, tier >= 50 ? 'rare' : 'uncommon', 'free'));
    else if (tier % 5 === 0) free.push({ kind: 'crownShards', amount: 2 });
    else if (tier % 3 === 0) free.push({ kind: 'gumballs', amount: 100 });
    else if (tier % 4 === 0) free.push(placeholder(season, 'nameplate', tier, 'common', 'free'));

    if (tier === PASS_TIERS) premium.push(placeholder(season, 'victory', tier, 'mythic', 'premium'));
    else if (tier % 25 === 0) premium.push(placeholder(season, 'upper', tier, 'legendary', 'premium'));
    else if (tier % 10 === 0) premium.push(placeholder(season, slot, tier, 'epic', 'premium'));
    else if (tier % 7 === 0) premium.push({ kind: 'gems', amount: 100 });
    else if (tier % 2 === 0) premium.push(placeholder(season, slot, tier, tier > 60 ? 'rare' : 'uncommon', 'premium'));
    else premium.push({ kind: 'gumballs', amount: 150 });
    tiers.push({ tier, xp, free, premium });
  }
  // Spread the real catalogue items evenly over the premium cosmetic tiers, commonest
  // first, so rarer items naturally sit deeper in the pass. Tier 100 stays the finale.
  const cosmeticTiers = tiers.filter((t) => t.tier < PASS_TIERS && t.premium.some((r) => r.kind === 'cosmetic'));
  passItems.forEach((item, i) => {
    const t = cosmeticTiers[Math.floor(((i + 0.5) * cosmeticTiers.length) / passItems.length)];
    if (t) t.premium = [{ kind: 'cosmetic', itemId: item.id, slot: item.slot, rarity: item.rarity }];
  });
  return { seasonId: season, name: 'Season 1: Sugar Rush', premiumPriceGems: 950, tiers };
}

/** The current season pass, validated. */
export const SEASON_PASS: SeasonPass = SeasonPassSchema.parse(buildSeason1());

/**
 * Tier reached for XP earned this season.
 *
 * @param seasonXp - XP earned since the season began.
 * @param pass - The season (defaults to the current one).
 * @returns Tiers cleared (0–100) and progress into the next.
 */
export function passTierForXp(seasonXp: number, pass: SeasonPass = SEASON_PASS): { tier: number; intoTier: number; tierXp: number } {
  let xp = Math.max(0, Math.floor(seasonXp));
  for (const t of pass.tiers) {
    if (xp < t.xp) return { tier: t.tier - 1, intoTier: xp, tierXp: t.xp };
    xp -= t.xp;
  }
  return { tier: PASS_TIERS, intoTier: 0, tierXp: 0 };
}
