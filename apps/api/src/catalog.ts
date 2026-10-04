/**
 * Server-side view of content data: cosmetics, playlists, the season pass,
 * challenges, achievements, the login ladder, limited-time events, the
 * collection log, show rewards, the level curve and Gem packs.
 *
 * Responsibilities:
 * - Adapt `@tumble/content/{cosmetics,progression,shows}` into the narrow
 *   shapes the backend reads, so route code never depends on content internals.
 * - Own backend-only economy data content does not define (Gem packs,
 *   level-up Gumballs).
 * - Resolve the live season from the content schedule against a clock
 *   ({@link clockedCatalog}), so seasons roll over without a deploy.
 */
import { COSMETICS, DEFAULT_LOADOUT, type CosmeticItem } from '@tumble/content/cosmetics';
import {
  ACHIEVEMENT_METRIC_KIND,
  ACHIEVEMENTS,
  ALL_CHALLENGES,
  achievementDescription,
  collectionLog,
  computeShowRewards,
  eventChallengeTitle,
  GEM_EARN,
  levelForXp as contentLevelForXp,
  LIVE_EVENTS,
  LOGIN_STREAK_LADDER,
  MILESTONE_CHALLENGES,
  nextSeason as contentNextSeason,
  passForSeason,
  pickChallenges as contentPickChallenges,
  seasonAt as contentSeasonAt,
  seasonById,
  shardShopAt,
  SHARDS_PER_CROWN,
  type AchievementCategory,
  type AchievementMetric as ContentAchievementMetric,
  type ChallengeDef,
  type ChallengeMetric as ContentChallengeMetric,
  type CollectionFilter,
  type CollectionLog,
  type EventMetric,
  type EventPointsRules,
  type GemEarnRules,
  type Grant,
  type PassReward,
  type Season,
  type ShardShopRotation,
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
  source: 'default' | 'store' | 'pass' | 'challenge' | 'event' | 'shards';
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
  /** `s<number>`; keys pass progress, ratings and season leaderboards. */
  id: string;
  /** 1-based season number. */
  number: number;
  name: string;
  /** Short theme name, e.g. `Sugar Rush`. */
  theme: string;
  /** Inclusive start, ISO-8601 UTC. */
  startsAt: string;
  /** Exclusive end (the next season's start), ISO-8601 UTC. */
  endsAt: string;
  /** Content pass track the season plays. */
  passTrackId: string;
  premiumPriceGems: number;
  tiers: readonly CatalogPassTier[];
}

/** Stat a challenge counts (content's `ChallengeMetric`). */
export type ChallengeMetric = ContentChallengeMetric;

/** How long a challenge lives: rotating daily/weekly, the live season, or forever. */
export type ChallengePeriod = 'daily' | 'weekly' | 'seasonal' | 'milestone';

/** A challenge definition. */
export interface CatalogChallenge {
  id: string;
  period: ChallengePeriod;
  title: string;
  metric: ChallengeMetric;
  target: number;
  /** XP (player + pass) granted on claim. */
  rewardXp: number;
  rewardGumballs: number;
  /** Gems on claim (weekly challenges pay `gemEarn.weeklyChallenge` instead). */
  rewardGems: number;
  /** Cosmetic granted on claim, if any. */
  rewardCosmetic: string | null;
}

/** Stat an achievement counts (content's `AchievementMetric`). */
export type AchievementMetric = ContentAchievementMetric;

/** Something an achievement or a login day grants: a pass-style reward or account XP. */
export type CatalogGrant = CatalogReward | { type: 'xp'; amount: number };

/** An achievement definition. */
export interface CatalogAchievement {
  /** Stable id; stored per player, never renamed. */
  id: string;
  category: AchievementCategory;
  title: string;
  /** Description with the target filled in. */
  description: string;
  metric: AchievementMetric;
  /** How the metric accumulates (see content `ACHIEVEMENT_METRIC_KIND`). */
  kind: 'sum' | 'max' | 'gauge';
  target: number;
  hidden: boolean;
  series: { id: string; tier: number; tiers: number } | null;
  rewards: readonly CatalogGrant[];
}

/** One day of the daily login ladder. */
export interface CatalogLoginDay {
  /** 1-based day within the cycle. */
  day: number;
  rewards: readonly CatalogGrant[];
}

/** One challenge of a limited-time event. */
export interface CatalogEventChallenge {
  /** Stable id within the event; stored per player, never renamed. */
  id: string;
  title: string;
  metric: EventMetric;
  target: number;
  /** Only shows in the event's featured playlists count. */
  eventPlaylistsOnly: boolean;
  /** Event points paid on claim. */
  points: number;
  /** Account (and pass) XP paid on claim. */
  rewardXp: number;
}

/** One step on an event's points track. */
export interface CatalogEventTier {
  /** 1-based. */
  tier: number;
  /** Points total that unlocks it. */
  points: number;
  rewards: readonly CatalogGrant[];
}

/** A limited-time event with its bundled window. */
export interface CatalogEvent {
  /** Stable id; keys progress, claims and ledger refs, never renamed. */
  id: string;
  name: string;
  description: string;
  themeId: string;
  art: readonly [string, string];
  icon: string;
  /** Bundled start (inclusive), ISO-8601 UTC; operators can override it. */
  startsAt: string;
  /** Bundled end (exclusive), ISO-8601 UTC. */
  endsAt: string;
  playlistIds: readonly string[];
  points: EventPointsRules;
  challenges: readonly CatalogEventChallenge[];
  tiers: readonly CatalogEventTier[];
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
  /**
   * The live season. On {@link CONTENT_CATALOG} this reads the wall clock; the
   * API context wraps the catalog with {@link clockedCatalog} so it follows
   * the injected clock instead.
   */
  readonly season: CatalogSeason;
  /** The season live at an instant. */
  seasonAt(at: Date): CatalogSeason;
  /** The season after `season`. */
  nextSeason(season: CatalogSeason): CatalogSeason;
  /** A season by id, or undefined when malformed. */
  seasonById(id: string): CatalogSeason | undefined;
  /** The Crown Shard shop shelf live at an instant. */
  shardShop(at: Date): ShardShopRotation;
  /** Free Gem payouts for play. */
  gemEarn: GemEarnRules;
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
  /** The period's challenge set before any reroll (`periodKey` is a day, ISO week or season id). */
  pickChallenges(period: 'daily' | 'weekly' | 'seasonal', periodKey: string): CatalogChallenge[];
  /**
   * Permanent milestones in slot order. Append-only: an index is the stored slot.
   */
  milestoneChallenges: readonly CatalogChallenge[];
  /** Every achievement, in display order. */
  achievements: readonly CatalogAchievement[];
  /**
   * How each achievement metric accumulates. Covers metrics no achievement
   * uses yet, so their history is already there when one does.
   */
  achievementMetrics: Readonly<Record<AchievementMetric, CatalogAchievement['kind']>>;
  /** The daily login ladder, day 1 first. */
  loginLadder: readonly CatalogLoginDay[];
  /** Every limited-time event, earliest first. */
  events: readonly CatalogEvent[];
  /** The collection log over an ownership predicate. */
  collection(owns: (cosmeticId: string) => boolean, filter?: CollectionFilter): CollectionLog;
  /** Starter look for new accounts. */
  defaultLoadout(): LoadoutItems;
}

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

function toChallenge(c: ChallengeDef): CatalogChallenge {
  return {
    id: c.id,
    period: c.cadence,
    title: c.description.replace('{n}', String(c.target)),
    metric: c.metric,
    target: c.target,
    rewardXp: c.rewardXp,
    rewardGumballs: c.rewardGumballs,
    rewardGems: c.rewardGems,
    rewardCosmetic: c.rewardCosmetic ?? null,
  };
}

function toGrant(g: Grant): CatalogGrant {
  switch (g.kind) {
    case 'xp':
      return { type: 'xp', amount: g.amount };
    case 'cosmetic':
      return { type: 'cosmetic', id: g.itemId };
    case 'gumballs':
      return { type: 'gumballs', amount: g.amount };
    case 'gems':
      return { type: 'gems', amount: g.amount };
    case 'crownShards':
      return { type: 'crown_shards', amount: g.amount };
  }
}

const challengeById = new Map<string, CatalogChallenge>(
  [...ALL_CHALLENGES.values()].map((c) => [c.id, toChallenge(c)]),
);

const ACHIEVEMENT_LIST: readonly CatalogAchievement[] = ACHIEVEMENTS.map((a) => ({
  id: a.id,
  category: a.category,
  title: a.title,
  description: achievementDescription(a),
  metric: a.metric,
  kind: ACHIEVEMENT_METRIC_KIND[a.metric],
  target: a.target,
  hidden: a.hidden,
  series: a.series ?? null,
  rewards: a.rewards.map(toGrant),
}));

const seasonCache = new Map<string, CatalogSeason>();

/** Content season → catalog season, memoised so tier tables are built once per season. */
function toSeason(s: Season): CatalogSeason {
  const hit = seasonCache.get(s.id);
  if (hit) return hit;
  const pass = passForSeason(s);
  const season: CatalogSeason = {
    id: s.id,
    number: s.number,
    name: s.name,
    theme: s.theme,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    passTrackId: s.passTrackId,
    premiumPriceGems: pass.premiumPriceGems,
    tiers: pass.tiers.map((t) => ({
      tier: t.tier,
      xp: t.xp,
      free: t.free.map(toReward),
      premium: t.premium.map(toReward),
    })),
  };
  seasonCache.set(s.id, season);
  return season;
}

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
  get season() {
    return toSeason(contentSeasonAt(new Date()));
  },
  seasonAt: (at) => toSeason(contentSeasonAt(at)),
  nextSeason: (s) => toSeason(contentNextSeason(s)),
  seasonById: (id) => {
    const s = seasonById(id);
    return s ? toSeason(s) : undefined;
  },
  shardShop: (at) => shardShopAt(at),
  gemEarn: GEM_EARN,
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
  milestoneChallenges: MILESTONE_CHALLENGES.map((c) => challengeById.get(c.id)!),
  achievements: ACHIEVEMENT_LIST,
  achievementMetrics: ACHIEVEMENT_METRIC_KIND,
  loginLadder: LOGIN_STREAK_LADDER.map((d) => ({ day: d.day, rewards: d.rewards.map(toGrant) })),
  events: LIVE_EVENTS.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    themeId: e.themeId,
    art: e.art,
    icon: e.icon,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    playlistIds: e.playlistIds,
    points: e.points,
    challenges: e.challenges.map((c) => ({
      id: c.id,
      title: eventChallengeTitle(c),
      metric: c.metric,
      target: c.target,
      eventPlaylistsOnly: c.eventPlaylistsOnly,
      points: c.points,
      rewardXp: c.rewardXp,
    })),
    tiers: e.tiers.map((t) => ({ tier: t.tier, points: t.points, rewards: t.rewards.map(toGrant) })),
  })),
  collection: (owns, filter) => collectionLog(owns, filter),
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

/**
 * A view of `base` whose `season` follows `now` instead of the wall clock, so
 * an injected clock (tests, replays) sees seasons roll over.
 *
 * @param base - Catalog to wrap.
 * @param now - Clock.
 * @returns A catalog delegating every other member to `base`.
 */
export function clockedCatalog(base: Catalog, now: () => Date): Catalog {
  const view = Object.create(base) as Catalog;
  Object.defineProperty(view, 'season', { get: () => base.seasonAt(now()), enumerable: true });
  return view;
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
  const worn = [
    d.pattern,
    d.face,
    d.upper,
    d.lower,
    d.headwear,
    d.back,
    ...d.emotes,
    d.celebration,
    d.victoryPose,
    d.nameplate,
    d.trail,
    d.banner,
    d.footsteps,
  ];
  const ids = new Set(catalog.cosmetics.filter((c) => c.source === 'default').map((c) => c.id));
  for (const id of worn) if (id) ids.add(id);
  return [...ids];
}

/**
 * Season pass progress for an XP total.
 *
 * @param season - Season whose tier table applies (defaults to the live one).
 * @returns Tiers cleared (0–max), XP into the next tier and that tier's cost.
 */
export function passProgress(
  catalog: Catalog,
  seasonXp: number,
  season: CatalogSeason = catalog.season,
): { tier: number; intoTier: number; tierXp: number } {
  let xp = Math.max(0, Math.floor(seasonXp));
  for (const t of season.tiers) {
    if (xp < t.xp) return { tier: t.tier - 1, intoTier: xp, tierXp: t.xp };
    xp -= t.xp;
  }
  return { tier: season.tiers.length, intoTier: 0, tierXp: 0 };
}
