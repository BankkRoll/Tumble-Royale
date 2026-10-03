/**
 * The local player's account data: profile, wallet, locker, loadouts, season
 * pass, challenges and match history, persisted in `localStorage`.
 *
 * Responsibilities:
 * - first-launch guest creation and persistence (survives reloads);
 * - projections into every `@tumble/ui` data shape the menus render;
 * - locker mutations (equip, colours, loadout slots, randomise);
 * - end-of-show rewards through `@tumble/content/progression`, with level-ups,
 *   pass tiers, unlock reveals, challenge progress and history.
 *
 * The online API (when reachable) is the authority for a signed-in account;
 * this store remains the offline source of truth and the cache the UI reads.
 */
import { COSMETICS, DEFAULT_LOADOUT, getCosmetic, randomLoadout } from '@tumble/content/cosmetics';
import {
  CHALLENGE_POOL,
  SEASON_PASS,
  computeShowRewards,
  levelForXp,
  SHARDS_PER_CROWN,
  passTierForXp,
  pickChallenges,
  type ChallengeDef,
  type ChallengeMetric,
} from '@tumble/content/progression';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { Rng, hashString, type RoundType } from '@tumble/shared';
import type {
  ChallengesData,
  CosmeticItem as UiItem,
  CosmeticSlot as UiSlot,
  InventoryData,
  Loadout as UiLoadout,
  MatchHistoryEntry,
  PassTier,
  ProfileData,
  RewardsSummary,
  SeasonPassData,
  StoreData,
  StoreOffer,
  TumblerColors,
} from '@tumble/ui';
import {
  avatarHat,
  contentPatternToUi,
  defaultUiLoadout,
  levelUpUnlock,
  lockerItems,
  uiItem,
  uiLoadoutToTumbler,
} from './cosmetics.ts';
import { loadJson, removeJson, saveJson } from './storage.ts';

// -----------------------------------------------------------------------------
// Persisted shape
// -----------------------------------------------------------------------------

/** Per-period challenge counters. */
interface ChallengeCounters {
  period: string;
  counts: Partial<Record<ChallengeMetric, number>>;
  claimed: string[];
}

/** What is written to storage. Additive changes only; `version` gates migrations. */
interface SavedProfile {
  version: 1;
  id: string;
  name: string;
  tag: string;
  totalXp: number;
  seasonXp: number;
  gumballs: number;
  gems: number;
  crowns: number;
  crownShards: number;
  owned: string[];
  loadouts: UiLoadout[];
  activeLoadout: number;
  stats: {
    shows: number;
    finals: number;
    roundsQualified: number;
    bestStreak: number;
    streak: number;
    roundCounts: Record<string, number>;
    /** Added later: rounds entered, gameplay totals, per-round records. Optional for old saves. */
    roundsPlayed?: number;
    totals?: { jumps: number; dives: number; grabs: number; emotes: number };
    perRound?: Record<string, { type: RoundType; played: number; qualified: number; bestTime?: number }>;
  };
  /** Tumblers met in shows on this device (the offline Hall of Fame), by name. */
  opponents?: Record<string, OpponentRecord>;
  history: MatchHistoryEntry[];
  tutorialAnswered: boolean;
  lastShowDay: string;
  daily: ChallengeCounters;
  weekly: ChallengeCounters;
  passClaimed: string[];
  premiumPass: boolean;
}

/** One finished show, as the runner saw it from the local player's seat. */
/** A Tumbler the local player has shared a show with. */
export interface OpponentRecord {
  colors: TumblerColors;
  isBot: boolean;
  faced: number;
  crowns: number;
  /** Best final placement (1 = Crown). */
  best: number;
  lastSeen: number;
}

export interface ShowResultForProfile {
  playlistName: string;
  rounds: MatchHistoryEntry['rounds'];
  /** Everyone else in the show (offline Hall of Fame). */
  field?: { name: string; colors: TumblerColors; isBot: boolean; place: number; crowned: boolean }[];
  reachedFinal: boolean;
  wonCrown: boolean;
  place: number;
  participants: number;
  quit: boolean;
  /** Gameplay counters for challenges. */
  counters: Partial<Record<ChallengeMetric, number>>;
}

const LOADOUT_SLOTS = 6;

const RARITY_RANK = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/**
 * Profile banner and nameplate styling from a loadout's equipped cosmetics.
 *
 * @param l - UI loadout.
 */
export function profileDressing(l: UiLoadout): Pick<ProfileData, 'banner' | 'nameplate'> {
  const out: Pick<ProfileData, 'banner' | 'nameplate'> = {};
  const banner = l.items.banner ? getCosmetic(l.items.banner) : getCosmetic('banner.confetti');
  if (banner?.slot === 'banner')
    out.banner = { name: banner.name, motif: banner.banner.motif, colors: [...banner.banner.colors] };
  const plate = getCosmetic(l.items.nameplate ?? DEFAULT_LOADOUT.nameplate);
  if (plate?.slot === 'nameplate') out.nameplate = { name: plate.name, ...plate.plate };
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoWeek(): string {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${d.getUTCFullYear()}-W${week}`;
}

function nextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function randomTag(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Puts one locker item into a loadout (emotes go to the front of the wheel).
 *
 * @param l - Loadout to change (not mutated).
 * @param slot - UI slot.
 * @param itemId - Cosmetic id.
 * @returns The new loadout.
 */
export function loadoutWithItem(l: UiLoadout, slot: UiSlot, itemId: string): UiLoadout {
  if (slot === 'emote')
    return { ...l, emotes: [itemId, ...l.emotes.filter((e) => e !== itemId)].slice(0, 4) };
  if (slot === 'colors') {
    const c = getCosmetic(itemId);
    if (c && c.slot === 'color')
      return {
        ...l,
        colors: { ...l.colors, primary: c.colors[0], secondary: c.colors[1], tertiary: c.colors[2] },
      };
    return l;
  }
  if (slot === 'pattern') return { ...l, colors: { ...l.colors, pattern: contentPatternToUi(itemId) } };
  return { ...l, items: { ...l.items, [slot]: itemId } };
}

/**
 * A random outfit built only from items the player owns.
 *
 * @param l - Current loadout (kept where nothing owned fits).
 * @param owns - Ownership check.
 * @param seed - Random seed.
 */
export function randomizedLoadout(l: UiLoadout, owns: (id: string) => boolean, seed: number): UiLoadout {
  const rnd = randomLoadout(new Rng(seed >>> 0));
  const pickOwned = (id: string | null): string | undefined => (id && owns(id) ? id : undefined);
  return {
    ...l,
    colors: {
      primary: rnd.colors[0],
      secondary: rnd.colors[1],
      tertiary: rnd.colors[2],
      pattern: owns(rnd.pattern) ? contentPatternToUi(rnd.pattern) : l.colors.pattern,
    },
    items: {
      ...l.items,
      face: pickOwned(rnd.face) ?? l.items.face,
      headwear: pickOwned(rnd.headwear),
      back: pickOwned(rnd.back),
      upper: pickOwned(rnd.upper),
      lower: pickOwned(rnd.lower),
    },
  };
}

/** Default colours for a brand new Tumbler (overwritten by the welcome screen). */
const NEW_COLORS: TumblerColors = {
  primary: '#ff6fb5',
  secondary: '#ffd23f',
  tertiary: '#7c5cff',
  pattern: 'plain',
};

/**
 * The local profile store.
 *
 * @example
 * const profile = new ProfileStore();
 * if (!profile.exists) profile.create('Sprinkles', colors);
 * ui.getState().setProfile(profile.uiProfile());
 */
export class ProfileStore {
  private data: SavedProfile | null;

  /**
   * @param fresh - Ignore any saved profile (first-launch testing).
   */
  constructor(fresh = false) {
    this.data = fresh ? null : this.load();
  }

  /** True once the welcome screen has created a Tumbler. */
  get exists(): boolean {
    return this.data !== null;
  }

  /** Display name ("Tumbler" before creation). */
  get name(): string {
    return this.data?.name ?? 'Tumbler';
  }

  /** Shows played (0 → the first show uses the gentle playlist). */
  get showsPlayed(): number {
    return this.data?.stats.shows ?? 0;
  }

  /** Lifetime Crowns. */
  get crowns(): number {
    return this.data?.crowns ?? 0;
  }

  /** Whether the tutorial prompt was already answered. */
  get tutorialAnswered(): boolean {
    return this.data?.tutorialAnswered ?? false;
  }

  /** Records the tutorial choice. */
  answerTutorial(): void {
    if (!this.data) return;
    this.data.tutorialAnswered = true;
    this.save();
  }

  /**
   * Creates the guest profile (welcome screen).
   *
   * @param name - Validated display name.
   * @param colors - Picked colours.
   */
  create(name: string, colors: TumblerColors): void {
    const loadouts = Array.from({ length: LOADOUT_SLOTS }, (_, i) =>
      defaultUiLoadout(`Loadout ${i + 1}`, { ...colors }),
    );
    this.data = {
      version: 1,
      id: randomId(),
      name,
      tag: randomTag(),
      totalXp: 0,
      seasonXp: 0,
      gumballs: 500,
      gems: 0,
      crowns: 0,
      crownShards: 0,
      owned: [],
      loadouts,
      activeLoadout: 0,
      stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0, streak: 0, roundCounts: {} },
      history: [],
      tutorialAnswered: false,
      lastShowDay: '',
      daily: { period: today(), counts: {}, claimed: [] },
      weekly: { period: isoWeek(), counts: {}, claimed: [] },
      passClaimed: [],
      premiumPass: false,
    };
    this.save();
  }

  /** Forgets the saved Tumbler; the welcome screen creates a new one. */
  clear(): void {
    this.data = null;
    removeJson('profile');
  }

  /** Renames the Tumbler. */
  rename(name: string): void {
    if (!this.data) return;
    this.data.name = name;
    this.save();
  }

  // ---------------------------------------------------------------------------
  // Loadouts
  // ---------------------------------------------------------------------------

  private get loadout(): UiLoadout {
    const d = this.data;
    if (!d) return defaultUiLoadout('Loadout 1', NEW_COLORS);
    return d.loadouts[d.activeLoadout] ?? (d.loadouts[0] as UiLoadout);
  }

  /** The active loadout as a 3D loadout. */
  tumblerLoadout(): TumblerLoadout {
    return uiLoadoutToTumbler(this.loadout);
  }

  /** Equipped emote ids (wheel slots 1–4). */
  emotes(): string[] {
    return this.tumblerLoadout().emotes.slice();
  }

  /**
   * Previews colours without saving (welcome screen).
   *
   * @param colors - Candidate colours.
   */
  previewLoadout(colors: TumblerColors): TumblerLoadout {
    return uiLoadoutToTumbler({ ...this.loadout, colors });
  }

  /**
   * Previews an item without equipping it (locker try-on).
   *
   * @param slot - UI slot.
   * @param itemId - Item, or null to show the equipped look.
   */
  tryOnLoadout(slot: UiSlot, itemId: string | null): TumblerLoadout {
    if (itemId === null) return this.tumblerLoadout();
    return uiLoadoutToTumbler(this.withItem(this.loadout, slot, itemId));
  }

  /** Previews several items at once (bundles) without saving. */
  tryOnMany(items: readonly { slot: UiSlot; itemId: string }[]): TumblerLoadout {
    return uiLoadoutToTumbler(items.reduce((l, it) => loadoutWithItem(l, it.slot, it.itemId), this.loadout));
  }

  private withItem(l: UiLoadout, slot: UiSlot, itemId: string): UiLoadout {
    return loadoutWithItem(l, slot, itemId);
  }

  /**
   * Equips an owned item in the active loadout.
   *
   * @returns True when the item was equipped.
   */
  equip(slot: UiSlot, itemId: string): boolean {
    const d = this.data;
    if (!d || !this.owns(itemId)) return false;
    d.loadouts[d.activeLoadout] = this.withItem(this.loadout, slot, itemId);
    this.save();
    return true;
  }

  /** Switches the active loadout slot. */
  selectLoadout(index: number): void {
    const d = this.data;
    if (!d || index < 0 || index >= d.loadouts.length) return;
    d.activeLoadout = index;
    this.save();
  }

  /** Replaces the active loadout's colours. */
  setColors(colors: TumblerColors): void {
    const d = this.data;
    if (!d) return;
    d.loadouts[d.activeLoadout] = { ...this.loadout, colors };
    this.save();
  }

  /** Rolls a random outfit from owned items. */
  randomize(): void {
    const d = this.data;
    if (!d) return;
    d.loadouts[d.activeLoadout] = randomizedLoadout(
      this.loadout,
      (id) => this.owns(id),
      (Date.now() ^ hashString(d.id)) >>> 0,
    );
    this.save();
  }

  /** Whether an item is usable (default items are always owned). */
  owns(itemId: string): boolean {
    const item = getCosmetic(itemId);
    if (!item) return false;
    return item.source === 'default' || (this.data?.owned.includes(itemId) ?? false);
  }

  // ---------------------------------------------------------------------------
  // UI projections
  // ---------------------------------------------------------------------------

  /** Profile card + top bar data. */
  uiProfile(): ProfileData {
    const d = this.data;
    const lvl = levelForXp(d?.totalXp ?? 0);
    const l = this.tumblerLoadout();
    const favourite = d ? Object.entries(d.stats.roundCounts).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    const owned = new Set(d?.owned ?? []);
    return {
      id: d?.id ?? 'local',
      name: this.name,
      tag: d?.tag ?? '0000',
      level: lvl.level,
      xp: lvl.intoLevel,
      xpToNext: Math.max(1, lvl.toNext),
      gumballs: d?.gumballs ?? 0,
      gems: d?.gems ?? 0,
      crowns: d?.crowns ?? 0,
      colors: this.loadout.colors,
      hat: avatarHat(l.headwear),
      isGuest: true,
      stats: {
        shows: d?.stats.shows ?? 0,
        finals: d?.stats.finals ?? 0,
        roundsQualified: d?.stats.roundsQualified ?? 0,
        bestStreak: d?.stats.bestStreak ?? 0,
        ...(favourite ? { favouriteRound: favourite } : {}),
        wins: d?.crowns ?? 0,
        roundsPlayed: d?.stats.roundsPlayed ?? (d ? d.history.reduce((n, h) => n + h.rounds.length, 0) : 0),
        ...(d?.stats.totals ? { totals: d.stats.totals } : {}),
        bestTimes: Object.entries(d?.stats.perRound ?? {})
          .filter(([, v]) => v.bestTime !== undefined)
          .map(([round, v]) => ({ round, timeSec: v.bestTime as number }))
          .sort((a, b) => a.timeSec - b.timeSec),
        rounds: Object.entries(d?.stats.perRound ?? {})
          .map(([name, v]) => ({ name, type: v.type, played: v.played, qualified: v.qualified }))
          .sort((a, b) => b.played - a.played),
        recentForm: (d?.history ?? []).slice(0, 10).map((h) => h.result),
      },
      showcase: COSMETICS.filter((c) => owned.has(c.id))
        .sort((a, b) => RARITY_RANK.indexOf(b.rarity) - RARITY_RANK.indexOf(a.rarity))
        .slice(0, 3)
        .map((c) => uiItem(c, true)),
      linkedProviders: [],
      crownShards: d?.crownShards ?? 0,
      shardsPerCrown: SHARDS_PER_CROWN,
      ...profileDressing(this.loadout),
    };
  }

  /** Opponents met on this device, for the offline Hall of Fame. */
  opponents(): Readonly<Record<string, OpponentRecord>> {
    return this.data?.opponents ?? {};
  }

  /** Locker contents. */
  uiInventory(): InventoryData {
    const d = this.data;
    return {
      items: lockerItems(new Set(d?.owned ?? [])),
      loadouts: d?.loadouts ?? [defaultUiLoadout('Loadout 1', NEW_COLORS)],
      activeLoadout: d?.activeLoadout ?? 0,
    };
  }

  /** Today's store rotation (seeded by date so it is stable all day). */
  uiStore(): StoreData {
    const owned = new Set(this.data?.owned ?? []);
    const forSale = COSMETICS.filter((c) => c.price !== null);
    const rng = new Rng(hashString(`store:${today()}`));
    const shuffled = rng.shuffle([...forSale]);
    const offer = (c: (typeof forSale)[number], featured: boolean): StoreOffer => ({
      id: `offer:${c.id}`,
      item: uiItem(c, owned.has(c.id)),
      currency: c.price?.currency ?? 'gumballs',
      price: c.price?.amount ?? 0,
      featured,
      ...(featured ? { tag: 'FEATURED' } : {}),
    });
    const featured = shuffled.filter((c) => c.rarity === 'legendary' || c.rarity === 'epic').slice(0, 3);
    const daily = shuffled.filter((c) => !featured.includes(c)).slice(0, 8);
    return {
      featured: featured.map((c) => offer(c, true)),
      daily: daily.map((c) => offer(c, false)),
      rotationEndsAt: nextMidnight(),
    };
  }

  /**
   * Buys a store offer with the local wallet.
   *
   * @returns The bought item, or an error code.
   */
  purchase(offerId: string): { item: UiItem } | { error: 'unknown' | 'owned' | 'funds' } {
    const d = this.data;
    const id = offerId.replace(/^offer:/, '');
    const item = getCosmetic(id);
    if (!d || !item || !item.price) return { error: 'unknown' };
    if (this.owns(id)) return { error: 'owned' };
    const key = item.price.currency;
    if (d[key] < item.price.amount) return { error: 'funds' };
    d[key] -= item.price.amount;
    d.owned.push(id);
    this.save();
    return { item: uiItem(item, true) };
  }

  /** Season pass view. */
  uiPass(): SeasonPassData {
    const d = this.data;
    const owned = new Set(d?.owned ?? []);
    const claimed = new Set(d?.passClaimed ?? []);
    const prog = passTierForXp(d?.seasonXp ?? 0);
    const reward = (list: (typeof SEASON_PASS.tiers)[number]['free'], key: string): PassTier['free'] => {
      const r = list[0];
      if (!r) return undefined;
      if (r.kind === 'cosmetic') {
        const item = getCosmetic(r.itemId);
        if (item) return { item: uiItem(item, owned.has(item.id)), claimed: claimed.has(key) };
        return { currency: { kind: 'gumballs', amount: 100 }, claimed: claimed.has(key) };
      }
      if (r.kind === 'crownShards')
        return { currency: { kind: 'xp', amount: r.amount * 100 }, claimed: claimed.has(key) };
      return { currency: { kind: r.kind, amount: r.amount }, claimed: claimed.has(key) };
    };
    return {
      seasonName: SEASON_PASS.name,
      seasonNumber: 1,
      endsAt: Date.now() + 41 * 86400_000,
      currentTier: prog.tier,
      tierProgress: prog.tierXp > 0 ? prog.intoTier / prog.tierXp : 1,
      premium: d?.premiumPass ?? false,
      premiumPrice: SEASON_PASS.premiumPriceGems,
      tiers: SEASON_PASS.tiers.map((t) => ({
        tier: t.tier,
        free: reward(t.free, `${t.tier}:free`),
        premium: reward(t.premium, `${t.tier}:premium`),
      })),
    };
  }

  /**
   * Claims a cleared pass tier reward.
   *
   * @returns True when something was granted.
   */
  claimPassTier(tier: number, track: 'free' | 'premium'): boolean {
    const d = this.data;
    if (!d) return false;
    const t = SEASON_PASS.tiers[tier - 1];
    const key = `${tier}:${track}`;
    if (!t || d.passClaimed.includes(key) || passTierForXp(d.seasonXp).tier < tier) return false;
    if (track === 'premium' && !d.premiumPass) return false;
    for (const r of t[track]) {
      if (r.kind === 'cosmetic') {
        if (getCosmetic(r.itemId) && !d.owned.includes(r.itemId)) d.owned.push(r.itemId);
        else d.gumballs += 100;
      } else if (r.kind === 'gumballs') d.gumballs += r.amount;
      else if (r.kind === 'gems') d.gems += r.amount;
      else d.crownShards += r.amount;
    }
    d.passClaimed.push(key);
    this.save();
    return true;
  }

  /**
   * Unlocks the premium track with Gems.
   *
   * @returns True on success.
   */
  buyPremiumPass(): boolean {
    const d = this.data;
    if (!d || d.premiumPass || d.gems < SEASON_PASS.premiumPriceGems) return false;
    d.gems -= SEASON_PASS.premiumPriceGems;
    d.premiumPass = true;
    this.save();
    return true;
  }

  private rollPeriods(): void {
    const d = this.data;
    if (!d) return;
    if (d.daily.period !== today()) d.daily = { period: today(), counts: {}, claimed: [] };
    if (d.weekly.period !== isoWeek()) d.weekly = { period: isoWeek(), counts: {}, claimed: [] };
  }

  private activeChallenges(): { def: ChallengeDef; counters: ChallengeCounters }[] {
    const d = this.data;
    if (!d) return [];
    this.rollPeriods();
    return [
      ...pickChallenges('daily', d.daily.period, CHALLENGE_POOL).map((def) => ({ def, counters: d.daily })),
      ...pickChallenges('weekly', d.weekly.period, CHALLENGE_POOL).map((def) => ({
        def,
        counters: d.weekly,
      })),
    ];
  }

  /** Daily + weekly challenge board. */
  uiChallenges(): ChallengesData {
    const icon: Partial<Record<ChallengeMetric, string>> = {
      showsPlayed: '🎪',
      roundsPlayed: '🎲',
      roundsQualified: '✅',
      racesQualified: '🏁',
      survivalsQualified: '🌀',
      finalsReached: '👑',
      crowns: '🏆',
      jumps: '🦘',
      dives: '🤿',
      grabs: '✊',
      bounces: '🟣',
      emotes: '💃',
      checkpoints: '🚩',
    };
    const week = new Date();
    week.setDate(week.getDate() + ((8 - week.getDay()) % 7 || 7));
    week.setHours(0, 0, 0, 0);
    return {
      list: this.activeChallenges().map(({ def, counters }) => ({
        id: def.id,
        cadence: def.cadence,
        title: def.description.replace('{n}', String(def.target)),
        icon: icon[def.metric] ?? '⭐',
        metric: def.metric,
        ...(def.rewardGumballs > 0 && def.rewardXp > 0
          ? { bonus: { kind: 'xp' as const, amount: def.rewardXp } }
          : {}),
        progress: Math.min(def.target, counters.counts[def.metric] ?? 0),
        goal: def.target,
        reward:
          def.rewardGumballs > 0
            ? { kind: 'gumballs' as const, amount: def.rewardGumballs }
            : { kind: 'xp' as const, amount: def.rewardXp },
        claimed: counters.claimed.includes(def.id),
        canReroll: false,
      })),
      dailyResetsAt: nextMidnight(),
      weeklyResetsAt: week.getTime(),
    };
  }

  /**
   * Claims a completed challenge.
   *
   * @returns True when the reward was granted.
   */
  claimChallenge(id: string): boolean {
    const d = this.data;
    const c = this.activeChallenges().find((x) => x.def.id === id);
    if (!d || !c || c.counters.claimed.includes(id)) return false;
    if ((c.counters.counts[c.def.metric] ?? 0) < c.def.target) return false;
    c.counters.claimed.push(id);
    d.totalXp += c.def.rewardXp;
    d.seasonXp += c.def.rewardXp;
    d.gumballs += c.def.rewardGumballs;
    this.save();
    return true;
  }

  /** Last 20 shows, newest first. */
  uiHistory(): MatchHistoryEntry[] {
    return this.data?.history ?? [];
  }

  // ---------------------------------------------------------------------------
  // Rewards
  // ---------------------------------------------------------------------------

  /**
   * Applies a finished show: XP, Gumballs, Crowns, pass, unlocks, challenges,
   * stats and history. Persists and returns the rewards screen payload.
   *
   * @param r - What happened.
   */
  applyShow(r: ShowResultForProfile): RewardsSummary {
    const d = this.data;
    if (!d) this.create(this.name, NEW_COLORS);
    const p = this.data as SavedProfile;
    this.rollPeriods();
    const qualifiedNonFinal = r.rounds.filter(
      (x, i) => x.qualified && !(r.reachedFinal && i === r.rounds.length - 1),
    ).length;
    const firstShowOfDay = p.lastShowDay !== today();
    const breakdown = computeShowRewards({
      roundsPlayed: r.rounds.length,
      roundsQualified: qualifiedNonFinal,
      reachedFinal: r.reachedFinal,
      wonCrown: r.wonCrown,
      place: r.place,
      participants: r.participants,
      quit: r.quit,
      firstShowOfDay,
    });

    const before = levelForXp(p.totalXp);
    const passBefore = passTierForXp(p.seasonXp);
    const challengeBefore = this.activeChallenges().map(({ def, counters }) => ({
      def,
      from: counters.counts[def.metric] ?? 0,
    }));

    p.totalXp += breakdown.xp;
    p.seasonXp += breakdown.xp;
    p.gumballs += breakdown.gumballs;
    p.crownShards += breakdown.crownShards;
    p.crowns += breakdown.crowns;
    p.lastShowDay = today();
    p.stats.shows++;
    if (r.reachedFinal) p.stats.finals++;
    p.stats.roundsQualified += r.rounds.filter((x) => x.qualified).length;
    p.stats.streak = r.wonCrown ? p.stats.streak + 1 : 0;
    p.stats.bestStreak = Math.max(p.stats.bestStreak, p.stats.streak);
    for (const x of r.rounds) p.stats.roundCounts[x.name] = (p.stats.roundCounts[x.name] ?? 0) + 1;
    p.stats.roundsPlayed =
      (p.stats.roundsPlayed ?? p.history.reduce((n, h) => n + h.rounds.length, 0)) + r.rounds.length;
    const totals = (p.stats.totals ??= { jumps: 0, dives: 0, grabs: 0, emotes: 0 });
    totals.jumps += r.counters.jumps ?? 0;
    totals.dives += r.counters.dives ?? 0;
    totals.grabs += r.counters.grabs ?? 0;
    totals.emotes += r.counters.emotes ?? 0;
    const perRound = (p.stats.perRound ??= {});
    for (const x of r.rounds) {
      const rec = (perRound[x.name] ??= { type: x.type, played: 0, qualified: 0 });
      rec.played++;
      if (x.qualified) rec.qualified++;
      if (x.timeSec !== undefined && (rec.bestTime === undefined || x.timeSec < rec.bestTime))
        rec.bestTime = x.timeSec;
    }
    if (r.field) {
      const opp = (p.opponents ??= {});
      for (const o of r.field) {
        const rec = (opp[o.name] ??= {
          colors: o.colors,
          isBot: o.isBot,
          faced: 0,
          crowns: 0,
          best: o.place,
          lastSeen: 0,
        });
        rec.faced++;
        rec.colors = o.colors;
        if (o.crowned) rec.crowns++;
        rec.best = Math.min(rec.best, o.place);
        rec.lastSeen = Date.now();
      }
      // Keep the Hall of Fame bounded: drop the least notable, least recent names.
      const names = Object.keys(opp);
      if (names.length > 300) {
        names
          .sort(
            (a, b) =>
              opp[a]!.crowns - opp[b]!.crowns ||
              opp[a]!.faced - opp[b]!.faced ||
              opp[a]!.lastSeen - opp[b]!.lastSeen,
          )
          .slice(0, names.length - 300)
          .forEach((n) => delete opp[n]);
      }
    }

    const counters: Partial<Record<ChallengeMetric, number>> = {
      ...r.counters,
      showsPlayed: 1,
      roundsPlayed: r.rounds.length,
      roundsQualified: r.rounds.filter((x) => x.qualified).length,
      racesQualified: r.rounds.filter((x) => x.qualified && x.type === 'race').length,
      survivalsQualified: r.rounds.filter((x) => x.qualified && x.type === 'survival').length,
      huntRoundsQualified: r.rounds.filter((x) => x.qualified && x.type === 'hunt').length,
      logicRoundsQualified: r.rounds.filter((x) => x.qualified && x.type === 'logic').length,
      teamRoundsWon: r.rounds.filter((x) => x.qualified && x.type === 'team').length,
      finalsReached: r.reachedFinal ? 1 : 0,
      crowns: r.wonCrown ? 1 : 0,
      topTenFinishes: r.place <= 10 ? 1 : 0,
    };
    for (const box of [p.daily, p.weekly]) {
      for (const [k, v] of Object.entries(counters) as [ChallengeMetric, number][])
        box.counts[k] = (box.counts[k] ?? 0) + v;
    }

    const after = levelForXp(p.totalXp);
    const passAfter = passTierForXp(p.seasonXp);
    const owned = new Set(p.owned);
    const unlocks: UiItem[] = [];
    for (let lv = before.level + 1; lv <= after.level; lv++) {
      const item = levelUpUnlock(owned, lv);
      if (!item) continue;
      owned.add(item.id);
      p.owned.push(item.id);
      unlocks.push(uiItem(item, true));
    }

    p.history.unshift({
      id: `local-${Date.now()}`,
      time: Date.now(),
      playlist: r.playlistName,
      rounds: r.rounds,
      result: r.wonCrown ? 'crown' : r.reachedFinal ? 'final' : 'eliminated',
      xp: breakdown.xp,
      place: r.place,
      participants: r.participants,
      gumballs: breakdown.gumballs,
    });
    p.history.length = Math.min(p.history.length, 20);
    this.save();

    const challenges = challengeBefore
      .map(({ def, from }) => ({
        def,
        from,
        to: (def.cadence === 'daily' ? p.daily : p.weekly).counts[def.metric] ?? 0,
      }))
      .filter((c) => c.to > c.from)
      .slice(0, 3)
      .map((c) => ({
        title: c.def.description.replace('{n}', String(c.def.target)),
        from: Math.min(c.from, c.def.target),
        to: Math.min(c.to, c.def.target),
        goal: c.def.target,
      }));

    return {
      xpLines: breakdown.lines.filter((l) => l.xp > 0).map((l) => ({ label: l.label, xp: l.xp })),
      levelFrom: { level: before.level, xp: before.intoLevel, xpToNext: Math.max(1, before.toNext) },
      levelTo: { level: after.level, xp: after.intoLevel, xpToNext: Math.max(1, after.toNext) },
      gumballs: breakdown.gumballs,
      crowns: breakdown.crowns,
      pass: {
        tierFrom: passBefore.tier,
        tierTo: passAfter.tier,
        progressFrom: passBefore.tierXp > 0 ? passBefore.intoTier / passBefore.tierXp : 1,
        progressTo: passAfter.tierXp > 0 ? passAfter.intoTier / passAfter.tierXp : 1,
      },
      unlocks,
      ...(challenges.length ? { challenges } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): SavedProfile | null {
    const p = loadJson<SavedProfile>('profile');
    if (
      !p ||
      p.version !== 1 ||
      typeof p.name !== 'string' ||
      !Array.isArray(p.loadouts) ||
      p.loadouts.length === 0
    )
      return null;
    p.activeLoadout = Math.max(0, Math.min(p.loadouts.length - 1, p.activeLoadout | 0));
    p.owned = Array.isArray(p.owned) ? p.owned : [];
    p.passClaimed = Array.isArray(p.passClaimed) ? p.passClaimed : [];
    return p;
  }

  private save(): void {
    if (this.data) saveJson('profile', this.data);
  }
}

/** Default look for emote id fallbacks when the profile has none yet. */
export const DEFAULT_EMOTES: readonly string[] = DEFAULT_LOADOUT.emotes;
