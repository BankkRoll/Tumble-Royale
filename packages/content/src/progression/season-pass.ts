import { z } from 'zod';
import { CosmeticSlotSchema, RaritySchema, getCosmetic } from '../cosmetics/index.ts';

/** Tiers in a season pass. */
export const PASS_TIERS = 100;

/** One reward on a pass tier. */
export const PassRewardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cosmetic'),
    /** Cosmetics catalogue id of a `pass`-source item from `/content/cosmetics`. */
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

type Currency = Exclude<PassReward, { kind: 'cosmetic' }>;
/** A cosmetic id, a currency grant, or `null` for an empty track slot. */
type Cell = string | Currency | null;

const gumballs = (amount: number): Currency => ({ kind: 'gumballs', amount });
const gems = (amount: number): Currency => ({ kind: 'gems', amount });
const shards = (amount: number): Currency => ({ kind: 'crownShards', amount });

/**
 * Season 1 rewards, one `[free, premium]` row per tier (row index + 1 = tier).
 * Kept as an explicit table so design can re-order the track by moving lines.
 */
// prettier-ignore
const SEASON1_LAYOUT: readonly (readonly [free: Cell, premium: Cell])[] = [
  /*   1 */ ['color.cherry-cola', 'emote.stretch'],
  /*   2 */ ['emote.sugar-wave', 'color.blue-raspberry'],
  /*   3 */ [gumballs(100), 'headwear.lolli-propeller'],
  /*   4 */ ['headwear.gumdrop-cone', gumballs(250)],
  /*   5 */ [null, 'face.monocle'],
  /*   6 */ [gumballs(100), 'back.taffy-tail'],
  /*   7 */ ['nameplate.lemon-pill', 'nameplate.taffy-ribbon'],
  /*   8 */ [gumballs(100), gems(100)],
  /*   9 */ ['pattern.peppermint', 'trail.candy-hearts'],
  /*  10 */ ['emote.lollipop-spin', 'pattern.sprinkles'],
  /*  11 */ ['trail.fizz', 'face.sprinkle-freckles'],
  /*  12 */ [gumballs(100), 'celebration.wiggle'],
  /*  13 */ ['banner.lemonade', shards(3)],
  /*  14 */ [gumballs(100), 'pattern.licorice-lace'],
  /*  15 */ [null, 'color.rock-candy'],
  /*  16 */ ['upper.licorice-bow', gumballs(250)],
  /*  17 */ [gumballs(100), 'headwear.cupcake-chef'],
  /*  18 */ ['face.gumdrop-gaze', gems(100)],
  /*  19 */ [gumballs(150), 'banner.gumball-machine'],
  /*  20 */ ['headwear.candy-headphones', 'back.butterscotch-wings'],
  /*  21 */ ['footsteps.gummy-squeak', 'upper.peppermint-scarf'],
  /*  22 */ [gumballs(150), 'footsteps.pogo'],
  /*  23 */ ['lower.candy-belt', gumballs(300)],
  /*  24 */ [gumballs(150), 'headwear.cat-ears'],
  /*  25 */ ['celebration.hop-hop', 'headwear.sugar-halo'],
  /*  26 */ ['headwear.mint-beanie', 'lower.gummy-ring'],
  /*  27 */ [gumballs(150), gems(100)],
  /*  28 */ ['color.marshmallow', 'nameplate.cherry-pill'],
  /*  29 */ [gumballs(150), 'face.minty-cat'],
  /*  30 */ ['back.wrapper-cape', 'headwear.ringmaster'],
  /*  31 */ ['emote.giggle', 'back.tail'],
  /*  32 */ [gumballs(150), 'banner.soda-waves'],
  /*  33 */ ['back.lunchbox', 'emote.cheer-squad'],
  /*  34 */ [gumballs(200), shards(3)],
  /*  35 */ [null, 'pattern.neapolitan'],
  /*  36 */ ['nameplate.grape-bubble', 'color.caramel-apple'],
  /*  37 */ [gumballs(200), gumballs(300)],
  /*  38 */ ['pattern.gumball-dots', gems(100)],
  /*  39 */ [gumballs(200), 'emote.curtsy'],
  /*  40 */ ['trail.mint-stars', 'face.star-gaze'],
  /*  41 */ ['banner.cotton-sky', 'color.sour-apple'],
  /*  42 */ [gumballs(200), 'headwear.jelly-feelers'],
  /*  43 */ ['upper.lemon-bow', gumballs(350)],
  /*  44 */ ['trail.sugar-sparkle', 'nameplate.golden-ticket'],
  /*  45 */ [null, 'face.racer-visor'],
  /*  46 */ [gumballs(200), 'pattern.taffy-pull'],
  /*  47 */ ['face.sugar-sleepy', gems(100)],
  /*  48 */ [gumballs(200), 'footsteps.bell'],
  /*  49 */ ['headwear.cherry-sprout', 'back.fizz-rockets'],
  /*  50 */ ['celebration.flip', 'back.cotton-candy-wings'],
  /*  51 */ ['emote.sugar-shimmy', 'celebration.twirl'],
  /*  52 */ [gumballs(250), shards(4)],
  /*  53 */ ['lower.racer-shorts', 'upper.mint-scarf'],
  /*  54 */ [gumballs(250), 'banner.night-market'],
  /*  55 */ [null, 'headwear.licorice-horns'],
  /*  56 */ ['color.pistachio', 'face.candy-specs'],
  /*  57 */ [gumballs(250), gumballs(350)],
  /*  58 */ ['nameplate.cola-ticket', gems(100)],
  /*  59 */ [gumballs(250), 'trail.hearts'],
  /*  60 */ ['upper.rush-medal', 'victory.cheer'],
  /*  61 */ ['footsteps.marshmallow', 'color.berry-swirl'],
  /*  62 */ ['pattern.ribbon-candy', 'lower.toffee-belt'],
  /*  63 */ [gumballs(250), 'pattern.gemstone'],
  /*  64 */ ['banner.sprinkle-party', 'emote.bow'],
  /*  65 */ [null, 'celebration.flex'],
  /*  66 */ ['headwear.cocoa-ears', gumballs(400)],
  /*  67 */ [gumballs(300), 'nameplate.sour-neon'],
  /*  68 */ ['emote.oops', gems(100)],
  /*  69 */ [gumballs(300), 'headwear.marshmallow-bunny'],
  /*  70 */ ['nameplate.sugar-rush', 'banner.sugar-rush'],
  /*  71 */ ['color.peach-ring', 'pattern.mini-hearts'],
  /*  72 */ [gumballs(300), shards(4)],
  /*  73 */ ['trail.sprinkles', 'victory.encore-bow'],
  /*  74 */ [gumballs(300), 'face.twirl-stache'],
  /*  75 */ ['upper.gumball-medal', 'victory.hero-gold'],
  /*  76 */ ['pattern.jelly-tile', 'upper.gold-medal'],
  /*  77 */ [gumballs(300), 'trail.taffy-rainbow'],
  /*  78 */ ['nameplate.mint-bubble', gumballs(400)],
  /*  79 */ [gumballs(300), 'banner.lollipop-land'],
  /*  80 */ ['face.swirl-eyes', 'trail.sugar-streak'],
  /*  81 */ ['back.gummy-shell', 'color.honeycomb'],
  /*  82 */ [gumballs(350), gems(100)],
  /*  83 */ ['celebration.pump', 'celebration.giddy'],
  /*  84 */ [gumballs(350), shards(5)],
  /*  85 */ [null, 'lower.floatie'],
  /*  86 */ ['face.lemon-squint', 'headwear.bunny'],
  /*  87 */ [gumballs(350), 'nameplate.ribbon'],
  /*  88 */ ['banner.mint-stripes', gumballs(450)],
  /*  89 */ [gumballs(350), 'footsteps.sleigh-bells'],
  /*  90 */ ['lower.sherbet-tutu', 'pattern.sugar-nebula'],
  /*  91 */ ['lower.lavender-tutu', 'pattern.wrapper-plaid'],
  /*  92 */ [gumballs(400), 'face.lovestruck'],
  /*  93 */ ['footsteps.candy-tap', gumballs(500)],
  /*  94 */ ['emote.who-knows', 'victory.hero'],
  /*  95 */ [null, 'color.chocolate-fudge'],
  /*  96 */ [gumballs(400), 'pattern.checker'],
  /*  97 */ ['color.root-beer', shards(5)],
  /*  98 */ [gumballs(400), 'banner.candy'],
  /*  99 */ ['pattern.cookie-crumble', 'color.licorice'],
  /* 100 */ ['color.sugar-rush', 'victory.sugar-rush'],
];

/**
 * Resolves one layout cell into pass rewards.
 *
 * @param cell - Layout entry.
 * @param where - Tier/track label for error messages.
 * @returns Zero or one reward.
 * @throws When a cosmetic id is unknown or not a `pass`-source item.
 */
function resolveCell(cell: Cell, where: string): PassReward[] {
  if (cell === null) return [];
  if (typeof cell !== 'string') return [cell];
  const item = getCosmetic(cell);
  if (!item) throw new Error(`Season pass ${where}: unknown cosmetic ${cell}`);
  if (item.source !== 'pass') throw new Error(`Season pass ${where}: ${cell} is not a pass item`);
  return [{ kind: 'cosmetic', itemId: item.id, slot: item.slot, rarity: item.rarity }];
}

/**
 * Season 1 ("Sugar Rush") layout, built from {@link SEASON1_LAYOUT}.
 *
 * Tier cost ramps gently from 900 to 1500 XP. Every tier pays out on the
 * premium track and all but eight (the x5 "premium spotlight" tiers) on the free
 * track. About 70% of rewards are real `pass` catalogue cosmetics, rising in
 * rarity through the season; currency is filler only (Gumballs on free;
 * Gumballs, Gems and Crown Shards on premium, with 800 Gems refunding most of
 * the premium price). Every 10th tier is a showcase (rare+ free, epic+
 * premium), tiers 25/50/75 are premium legendaries and tier 100 is the mythic
 * victory pose. Each cosmetic appears at most once.
 *
 * @returns Unvalidated season data for {@link SeasonPassSchema}.
 * @throws When the layout references an unknown, non-pass or repeated cosmetic.
 */
function buildSeason1(): z.input<typeof SeasonPassSchema> {
  if (SEASON1_LAYOUT.length !== PASS_TIERS) throw new Error(`Season pass layout needs ${PASS_TIERS} rows`);
  const used = new Set<string>();
  const tiers = SEASON1_LAYOUT.map(([freeCell, premiumCell], i) => {
    const tier = i + 1;
    const xp = Math.round((900 + 600 * ((tier - 1) / (PASS_TIERS - 1))) / 50) * 50;
    const free = resolveCell(freeCell, `tier ${tier} free`);
    const premium = resolveCell(premiumCell, `tier ${tier} premium`);
    for (const r of [...free, ...premium]) {
      if (r.kind !== 'cosmetic') continue;
      if (used.has(r.itemId)) throw new Error(`Season pass tier ${tier}: ${r.itemId} is already on the pass`);
      used.add(r.itemId);
    }
    return { tier, xp, free, premium };
  });
  return { seasonId: 's1', name: 'Season 1: Sugar Rush', premiumPriceGems: 950, tiers };
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
