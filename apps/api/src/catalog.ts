/**
 * Server-side view of content data: cosmetics, playlists, the season pass,
 * challenges, show rewards, the level curve and Gem packs.
 *
 * Responsibilities:
 * - Adapt `@tumble/content/{cosmetics,progression,shows}` into the narrow
 *   shapes the backend reads, so route code never depends on content internals.
 * - Own backend-only economy data content does not define (Gem packs, season
 *   dates, level-up Gumballs).
 */
import {
  COSMETICS,
  DEFAULT_LOADOUT,
  type CosmeticItem,
} from '@tumble/content/cosmetics';
import {
  CHALLENGE_POOL,
  computeShowRewards,
  levelForXp as contentLevelForXp,
  pickChallenges as contentPickChallenges,
  SEASON_PASS,
  SHARDS_PER_CROWN,
  type ChallengeMetric as ContentChallengeMetric,
  type PassReward,
  type ShowResultFacts,
} from '@tumble/content/progression';
import { PLAYLISTS } from '@tumble/content/shows';

/** Customization slots (`CosmeticSlotSchema` in content). */
export const COSMETIC_SLOTS = [
  'color',
  'pattern',
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'emote',
  'celebration',
  'victory',
  'nameplate',
  'banner',
  'trail',
  'footsteps',
] as const;
/** A customization slot. */
export type CosmeticSlot = (typeof COSMETIC_SLOTS)[number];

/** Rarity tiers, lowest first. */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

/** Spendable store currencies. */
export type StoreCurrency = 'gumballs' | 'gems';
/** Every ledger currency. */
export type LedgerCurrency = StoreCurrency | 'crown_shards';

/** The backend's view of a cosmetic item. */
export interface CatalogCosmetic {
  /** Stable id `<prefix>.<kebab-name>`; stored in inventories, never renamed. */
  id: string;
  name: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  /** `default` items are granted to every new account. */
  source: 'default' | 'store' | 'pass' | 'challenge' | 'event';
  /** Direct store price; null when not sold. */
  price: { currency: StoreCurrency; amount: number } | null;
}

/** A matchmaking playlist ("show"). */
export interface CatalogPlaylist {
  id: string;
  name: string;
  /** Players per team: 1 solo, 2 duos, 4 squads. */
  teamSize: number;
  queue: 'casual' | 'ranked';
  /** Lobby size the matchmaker fills to. */
  maxPlayers: number;
  /** Fewest humans a show may start with when bots are not allowed. */
  minPlayers: number;
  botsAllowed: boolean;
}

/** Something granted by a pass tier. */
export type CatalogReward =
  | { type: 'cosmetic'; id: string }
  | { type: 'gumballs'; amount: number }
  | { type: 'gems'; amount: number }
  | { type: 'crown_shards'; amount: number };

/** One season pass tier. */
export interface CatalogPassTier {
  /** 1-based tier number. */
  tier: number;
  /** XP needed to clear this tier. */
  xp: number;
  free: CatalogReward[];
  premium: CatalogReward[];
}

/** Season definition including its pass. */
export interface CatalogSeason {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  premiumPriceGems: number;
  tiers: readonly CatalogPassTier[];
}

/** Stat a challenge counts (content's `ChallengeMetric`). */
export type ChallengeMetric = ContentChallengeMetric;

/** A challenge definition. */
export interface CatalogChallenge {
  id: string;
  period: 'daily' | 'weekly';
  title: string;
  metric: ChallengeMetric;
  target: number;
  /** XP (player + pass) granted on claim. */
  rewardXp: number;
  rewardGumballs: number;
}

/** A Gem pack sold for real money (Stripe). */
export interface CatalogGemPack {
  id: string;
  gems: number;
  /** Price in the smallest currency unit (cents). */
  priceCents: number;
  currency: 'usd';
  name: string;
}

/** Facts about one player's show, fed to the reward rules. */
export type ShowFacts = ShowResultFacts;

/** Itemised show payout. */
export interface ShowPayout {
  lines: { label: string; xp: number; gumballs: number; crownShards: number }[];
  xp: number;
  gumballs: number;
  crownShards: number;
}

/** Cosmetic ids per slot in a saved loadout (content `CosmeticLoadout` + banner/footsteps). */
export interface LoadoutItems {
  colors: [string, string, string];
  pattern: string;
  face: string;
  upper: string | null;
  lower: string | null;
  headwear: string | null;
  back: string | null;
  emotes: [string, string, string, string];
  celebration: string;
  victoryPose: string;
  nameplate: string;
  trail: string | null;
  banner: string | null;
  footsteps: string | null;
}

/** Everything the API reads from content. */
export interface Catalog {
  cosmetics: readonly CatalogCosmetic[];
  playlists: readonly CatalogPlaylist[];
  season: CatalogSeason;
  challenges: readonly CatalogChallenge[];
  gemPacks: readonly CatalogGemPack[];
  /** Gumballs granted per account level gained. */
  gumballsPerLevel: number;
  /** Crown Shards that convert into one Crown. */
  shardsPerCrown: number;
  /** End-of-show payout rules. */
  showRewards(facts: ShowFacts): ShowPayout;
  /** Account level for lifetime XP. */
  levelForXp(totalXp: number): { level: number; into: number; next: number };
  /** The period's challenge set before any reroll. */
  pickChallenges(period: 'daily' | 'weekly', periodKey: string): CatalogChallenge[];
  /** Starter look for new accounts. */
  defaultLoadout(): LoadoutItems;
}

/** Season 1 calendar; content defines the pass, not its dates. */
const SEASON_DATES = { startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' };

const GEM_PACKS: readonly CatalogGemPack[] = [
  { id: 'gems.500', gems: 500, priceCents: 499, currency: 'usd', name: 'Handful of Gems' },
  { id: 'gems.1100', gems: 1100, priceCents: 999, currency: 'usd', name: 'Pouch of Gems' },
  { id: 'gems.2800', gems: 2800, priceCents: 2499, currency: 'usd', name: 'Chest of Gems' },
  { id: 'gems.6000', gems: 6000, priceCents: 4999, currency: 'usd', name: 'Vault of Gems' },
];

function toCosmetic(c: CosmeticItem): CatalogCosmetic {
  return { id: c.id, name: c.name, slot: c.slot, rarity: c.rarity, source: c.source, price: c.price };
}

function toReward(r: PassReward): CatalogReward {
  switch (r.kind) {
    case 'cosmetic':
      return { type: 'cosmetic', id: r.itemId };
    case 'gumballs':
      return { type: 'gumballs', amount: r.amount };
    case 'gems':
      return { type: 'gems', amount: r.amount };
    case 'crownShards':
      return { type: 'crown_shards', amount: r.amount };
  }
}

const challengeById = new Map<string, CatalogChallenge>(
  CHALLENGE_POOL.map((c) => [
    c.id,
    {
      id: c.id,
      period: c.cadence,
      title: c.description.replace('{n}', String(c.target)),
      metric: c.metric,
      target: c.target,
      rewardXp: c.rewardXp,
      rewardGumballs: c.rewardGumballs,
    },
  ]),
);

/** The catalog backed by `@tumble/content`. */
export const CONTENT_CATALOG: Catalog = {
  cosmetics: COSMETICS.map(toCosmetic),
  playlists: PLAYLISTS.map((p) => ({
    id: p.id,
    name: p.name,
    teamSize: p.partySize ?? 1,
    queue: p.ranked ? 'ranked' : 'casual',
    maxPlayers: p.maxPlayers,
    minPlayers: p.minPlayers,
    botsAllowed: p.botsAllowed,
  })),
  season: {
    id: SEASON_PASS.seasonId,
    name: SEASON_PASS.name,
    ...SEASON_DATES,
    premiumPriceGems: SEASON_PASS.premiumPriceGems,
    tiers: SEASON_PASS.tiers.map((t) => ({ tier: t.tier, xp: t.xp, free: t.free.map(toReward), premium: t.premium.map(toReward) })),
  },
  challenges: [...challengeById.values()],
  gemPacks: GEM_PACKS,
  gumballsPerLevel: 100,
  shardsPerCrown: SHARDS_PER_CROWN,
  showRewards: (facts) => {
    const r = computeShowRewards(facts);
    return { lines: r.lines, xp: r.xp, gumballs: r.gumballs, crownShards: r.crownShards };
  },
  levelForXp: (xp) => {
    const r = contentLevelForXp(xp);
    return { level: r.level, into: r.intoLevel, next: r.toNext };
  },
  pickChallenges: (period, key) => contentPickChallenges(period, key).map((c) => challengeById.get(c.id)!),
  defaultLoadout: () => ({
    ...DEFAULT_LOADOUT,
    colors: [...DEFAULT_LOADOUT.colors],
    emotes: [...DEFAULT_LOADOUT.emotes],
    banner: null,
    footsteps: null,
  }),
};

/** Returns the catalog in use. */
export function loadCatalog(): Catalog {
  return CONTENT_CATALOG;
}

/** Index of cosmetics by id for O(1) validation. */
export function cosmeticIndex(catalog: Catalog): ReadonlyMap<string, CatalogCosmetic> {
  return new Map(catalog.cosmetics.map((c) => [c.id, c]));
}

/**
 * Cosmetics every new account owns: all `default` items plus anything the
 * default loadout wears (so the starter look always validates).
 */
export function starterItems(catalog: Catalog): string[] {
  const d = catalog.defaultLoadout();
  const worn = [d.pattern, d.face, d.upper, d.lower, d.headwear, d.back, ...d.emotes, d.celebration, d.victoryPose, d.nameplate, d.trail, d.banner, d.footsteps];
  const ids = new Set(catalog.cosmetics.filter((c) => c.source === 'default').map((c) => c.id));
  for (const id of worn) if (id) ids.add(id);
  return [...ids];
}

/**
 * Season pass progress for an XP total.
 *
 * @returns Tiers cleared (0–max), XP into the next tier and that tier's cost.
 */
export function passProgress(catalog: Catalog, seasonXp: number): { tier: number; intoTier: number; tierXp: number } {
  let xp = Math.max(0, Math.floor(seasonXp));
  for (const t of catalog.season.tiers) {
    if (xp < t.xp) return { tier: t.tier - 1, intoTier: xp, tierXp: t.xp };
    xp -= t.xp;
  }
  return { tier: catalog.season.tiers.length, intoTier: 0, tierXp: 0 };
}
