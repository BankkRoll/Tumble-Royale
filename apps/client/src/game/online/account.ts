/**
 * The signed-in account: mirrors the account API into the UI store and turns
 * menu intents into API calls.
 *
 * Responsibilities:
 * - load `/me`, `/inventory`, `/loadouts`, `/store`, `/gems/packs`, `/pass`,
 *   `/challenges`, `/streak`, `/achievements`, `/collection`, `/live-events`, `/friends`,
 *   `/party` and project them onto `@tumble/ui` shapes (profile card, locker,
 *   store, pass, challenges, login streak, achievements, collection log,
 *   friends, party);
 * - locker edits persisted server-side (`PUT /loadouts/:i`, activate);
 * - purchases with an `Idempotency-Key` (store items, Gem packs via the
 *   checkout — instant with the API's fake provider in dev, a Stripe redirect
 *   otherwise), pass claims + premium, challenge claim/reroll, event tier and
 *   event challenge claims;
 * - purchase history and refunds (`/purchases`): self-service store refunds
 *   and Gem pack refund requests;
 * - leaderboards and match history;
 * - social: friend requests, the party (create, join by code, ready, kick,
 *   leader's playlist, who is away playing solo) and the realtime gateway
 *   (`presence`, `friend_request`, `party_update`, `party_solo`,
 *   `party_invite`, `wallet`, …);
 * - the API's post-show reward summary → rewards screen, fetched from the API
 *   when the game server's forward is late (never estimated locally).
 *
 * The local {@link ProfileStore} stays the offline fallback; nothing here
 * writes to it except the display name.
 */
import { COSMETICS, DEFAULT_LOADOUT, getCosmetic } from '@tumble/content/cosmetics';
import {
  ACHIEVEMENT_CATEGORY_NAMES,
  SHARDS_PER_CROWN,
  levelForXp,
  passTierForXp,
  type ChallengeMetric,
} from '@tumble/content/progression';
import { getRound } from '@tumble/content/rounds';
import { getPlaylist } from '@tumble/content/shows';
import type { PlayerRewardMsg } from '@tumble/netcode';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { hashString } from '@tumble/shared';
import {
  grantText,
  maskedName,
  ui,
  type ChallengeCadence,
  type ChallengesData,
  type CollectionSourceView,
  type CosmeticItem as UiItem,
  type GrantView,
  type CosmeticSlot as UiSlot,
  type GemPackOffer,
  type LeaderboardId,
  type LeaderboardScope,
  type Loadout as UiLoadout,
  type MatchHistoryEntry,
  type NotificationItem,
  type PartyState,
  type PassReward,
  type ProfileData,
  type RankTier,
  type RewardsSummary,
  type RoundType,
  type SeasonPassData,
  type TumblerColors,
} from '@tumble/ui';
import {
  ApiError,
  idempotencyKey,
  type ApiClient,
  type ApiGrant,
  type ApiLoadoutItems,
  type ApiStreak,
  type ApiMe,
  type ApiParty,
  type ApiPass,
  type ApiPassReward,
  type ApiTutorialComplete,
  type ApiLiveEvents,
} from '../api.ts';
import { eventsView, rewardEventLines } from '../liveEvents.ts';
import {
  avatarHat,
  botLoadout,
  contentPatternToUi,
  defaultUiLoadout,
  lockerItems,
  tumblerColors,
  uiItem,
  uiLoadoutToTumbler,
  uiPatternToContent,
} from '../cosmetics.ts';
import { loadoutWithItem, profileDressing, randomizedLoadout } from '../profile.ts';
import { ClubController } from '../social/clubController.ts';
import { SocialController, type RealtimeLike } from '../social/socialController.ts';
import { onlineStoreShelves } from '../storeOffers.ts';
import {
  giftErrorText,
  giftEventToast,
  toGiftPicker,
  toGifts,
  toWishlist,
  toWishlistEntries,
  type ApiWishlist,
  type GiftEvent,
  type ItemResolver,
} from './gifts.ts';
import { refundErrorText, refundToast, toPurchaseHistory } from './purchaseHistory.ts';
import { explainGemCheckoutRefusal, gemCheckoutMode, type GemCheckoutMode } from './gemCheckout.ts';
import type { PartyLobbyLink } from '../views/partyLobbyView.ts';
import { JsonSocket, type TypedMessage } from './jsonSocket.ts';
import { partyLobbyLink } from './partyLobbyLink.ts';
import { soloNotice } from './partyPlay.ts';
import { pollShowReward, type RewardPollResult } from './rewardPoll.ts';
import { track } from '../liveOps/analytics.ts';

const LOADOUT_SLOTS = 6;

// -----------------------------------------------------------------------------
// Loadout conversion
// -----------------------------------------------------------------------------

/** The `pattern.*` cosmetic id for a UI pattern (falls back to the solid default). */
function patternItemId(p: TumblerColors['pattern']): string {
  const raw = uiPatternToContent(p);
  const item = COSMETICS.find((c) => c.slot === 'pattern' && 'pattern' in c && c.pattern === raw);
  return item?.id ?? DEFAULT_LOADOUT.pattern;
}

/**
 * Locker loadout → API body.
 *
 * @param l - UI loadout.
 */
export function uiLoadoutToApi(l: UiLoadout): ApiLoadoutItems {
  const t = uiLoadoutToTumbler(l);
  return {
    colors: [t.colors[0], t.colors[1], t.colors[2]],
    pattern: patternItemId(l.colors.pattern),
    face: t.face,
    upper: t.upper,
    lower: t.lower,
    headwear: t.headwear,
    back: t.back,
    emotes: [...t.emotes] as [string, string, string, string],
    celebration: t.celebration,
    victoryPose: t.victoryPose,
    nameplate: t.nameplate,
    trail: t.trail,
    banner: l.items.banner ?? null,
    footsteps: l.items.footsteps ?? null,
  };
}

/**
 * API loadout → locker loadout.
 *
 * @param name - Slot name.
 * @param a - API items.
 */
export function apiLoadoutToUi(name: string, a: ApiLoadoutItems): UiLoadout {
  const items: UiLoadout['items'] = {
    face: a.face,
    celebration: a.celebration,
    victory: a.victoryPose,
    nameplate: a.nameplate,
  };
  if (a.upper) items.upper = a.upper;
  if (a.lower) items.lower = a.lower;
  if (a.headwear) items.headwear = a.headwear;
  if (a.back) items.back = a.back;
  if (a.trail) items.trail = a.trail;
  if (a.banner) items.banner = a.banner;
  if (a.footsteps) items.footsteps = a.footsteps;
  return {
    name,
    colors: {
      primary: a.colors[0],
      secondary: a.colors[1],
      tertiary: a.colors[2],
      pattern: contentPatternToUi(a.pattern),
    },
    items,
    emotes: [...a.emotes],
  };
}

/** Deterministic colours for someone whose look we have not fetched. */
function guessColors(seed: string): TumblerColors {
  return tumblerColors(botLoadout(hashString(seed) >>> 0, 0, seed));
}

const RANK_TIERS: Readonly<Record<string, RankTier>> = {
  bronze: 'bronze',
  silver: 'silver',
  gold: 'gold',
  platinum: 'platinum',
  diamond: 'diamond',
  champion: 'champion',
  crown_league: 'crown',
};

const CHALLENGE_ICON: Partial<Record<ChallengeMetric | string, string>> = {
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

/** Human message for an API error. */
function describe(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 ? 'The server could not be reached.' : err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** Hooks the account calls back into the app. */
export interface AccountHooks {
  /** The active look changed (locker edit, loadout switch, sign-in). */
  onLookChanged(): void;
  /** Party members changed (the menu stage shows them). */
  onPartyChanged(members: { userId: string; loadout: TumblerLoadout }[]): void;
  /** A party invite was accepted from a toast or deep link (switch to the party). */
  onJoinedParty?(): void;
  /** The party itself changed (members, leader, ready); null when not in one. Fires before looks load. */
  onPartyRoster?(party: ApiParty | null, selfId: string): void;
}

/**
 * The online account.
 *
 * @example
 * const account = new OnlineAccount(api, hooks);
 * if (await account.load()) account.startRealtime();
 */
export class OnlineAccount {
  me: ApiMe | null = null;
  private owned = new Set<string>();
  private loadouts: (UiLoadout | null)[] = [];
  private activeIndex = 0;
  private pass: ApiPass | null = null;
  party: ApiParty | null = null;
  private readonly cards = new Map<string, TumblerLoadout>();
  private gemCheckout: GemCheckoutMode = 'comingSoon';
  private readonly realtime: JsonSocket;
  private readonly offs: (() => void)[] = [];
  private notifications: NotificationItem[] = [];
  /** Friends, requests, blocking, reports and party chat. */
  readonly social: SocialController;
  /** The player's club, its chat and goals. */
  readonly clubs: ClubController;
  /** Party members' live menu Tumblers over the realtime gateway. */
  readonly lobbyLink: PartyLobbyLink;
  /** Last reported presence, re-sent whenever the gateway reconnects. */
  private presence: {
    status: 'online' | 'in_menu' | 'in_queue' | 'in_match';
    playlistId?: string;
    lobbyCode?: string;
  } = { status: 'in_menu' };
  private realtimeOpened = false;
  private realtimeStarted = false;
  /** Account XP and season XP before the current show, for the rewards bars. */
  private snapshotBefore: { xp: number; passXp: number } | null = null;
  /** Party members away in a solo show (from `party_solo`), shown on the party line. */
  private readonly soloMembers = new Set<string>();
  /** Bumps per reward wait so a newer show cancels an older poll. */
  private rewardWait = 0;
  /** An achievements + collection reload is running; a burst of unlock notifications shares it. */
  private unlocksInFlight = false;
  private unlocksQueued = false;

  constructor(
    readonly api: ApiClient,
    private readonly hooks: AccountHooks,
  ) {
    this.realtime = new JsonSocket({
      label: 'api-ws',
      ping: { type: 'ping' },
      url: async () => {
        const token = await api.accessToken();
        return token ? api.wsUrl(token) : null;
      },
    });
    this.lobbyLink = partyLobbyLink(this.realtime);
    this.social = new SocialController(api, this.realtime, {
      userId: () => this.userId,
      colorsOf: (id) => this.colorsOf(id),
      applyParty: (p) => this.applyParty(p),
      partyId: () => this.party?.id ?? null,
    });
    this.clubs = new ClubController(api, this.realtime, {
      userId: () => this.userId,
      applyParty: (p) => this.applyParty(p),
      notify: (kind, title, body, action) => this.addNotification(kind, title, body, action),
    });
  }

  /** The realtime gateway socket, for features that ride it (voice signalling). */
  get socket(): RealtimeLike {
    return this.realtime;
  }

  /** True once `/me` loaded. */
  get active(): boolean {
    return this.me !== null;
  }

  /** The account's id. */
  get userId(): string | null {
    return this.me?.userId ?? null;
  }

  /** Display name. */
  get name(): string {
    return this.me?.displayName ?? 'Tumbler';
  }

  /** Lifetime Crowns. */
  get crowns(): number {
    return this.me?.crowns ?? 0;
  }

  private get loadout(): UiLoadout {
    return (
      this.loadouts[this.activeIndex] ??
      this.loadouts[0] ??
      defaultUiLoadout('Loadout 1', {
        primary: '#ff6fb5',
        secondary: '#ffd23f',
        tertiary: '#7c5cff',
        pattern: 'plain',
      })
    );
  }

  /** The active loadout as a 3D look. */
  tumblerLoadout(): TumblerLoadout {
    return uiLoadoutToTumbler(this.loadout);
  }

  /** Whether the account owns an item (default items always). */
  owns(id: string): boolean {
    return getCosmetic(id)?.source === 'default' || this.owned.has(id);
  }

  // ---------------------------------------------------------------------------
  // Loading & projection
  // ---------------------------------------------------------------------------

  /**
   * Loads everything and pushes it to the UI.
   *
   * @returns False when the API refused (signed out, offline).
   */
  async load(): Promise<boolean> {
    try {
      const [me, inv, lo] = await Promise.all([this.api.me(), this.api.inventory(), this.api.loadouts()]);
      this.me = me;
      this.owned = new Set(inv.items.map((i) => i.id));
      this.applyLoadouts(lo.slots, lo.activeIndex);
    } catch (err) {
      console.warn('[account] load failed', err);
      return false;
    }
    this.pushProfile();
    this.pushInventory();
    this.hooks.onLookChanged();
    await Promise.all([
      this.refreshStore(),
      this.refreshPass(),
      this.refreshChallenges(),
      this.refreshStreak(),
      this.refreshAchievements(),
      this.refreshCollection(),
      this.refreshEvents(),
      this.refreshFriends(),
      this.refreshParty(),
      this.history(),
      this.loadWishlist(),
      this.loadGifts(),
    ]);
    return true;
  }

  /** Re-reads the wallet/profile, inventory, pass and challenges (after a show or purchase). */
  async refreshProgress(): Promise<void> {
    try {
      const [me, inv] = await Promise.all([this.api.me(), this.api.inventory()]);
      this.me = me;
      this.owned = new Set(inv.items.map((i) => i.id));
    } catch (err) {
      console.warn('[account] refresh failed', err);
      return;
    }
    this.pushProfile();
    this.pushInventory();
    await Promise.all([
      this.refreshStore(),
      this.refreshPass(),
      this.refreshChallenges(),
      this.refreshStreak(),
      this.refreshAchievements(),
      this.refreshCollection(),
      this.refreshEvents(),
      this.history(),
    ]);
  }

  private applyLoadouts(
    slots: readonly ({ name: string; items: ApiLoadoutItems } | null)[],
    active: number,
  ): void {
    this.loadouts = Array.from({ length: LOADOUT_SLOTS }, (_, i) => {
      const s = slots[i];
      return s ? apiLoadoutToUi(s.name, s.items) : null;
    });
    this.activeIndex = Math.max(0, Math.min(LOADOUT_SLOTS - 1, active));
  }

  private uiProfile(): ProfileData | null {
    const m = this.me;
    if (!m) return null;
    const ranked = m.ranked.find((r) => r.queue === 'ranked' || r.queue.includes('rank'));
    const tier = ranked ? RANK_TIERS[ranked.tier] : undefined;
    const owned = COSMETICS.filter((c) => this.owned.has(c.id) && c.source !== 'default');
    const l = this.tumblerLoadout();
    return {
      id: m.userId,
      name: m.displayName,
      tag: m.tag,
      level: m.level,
      xp: m.xp.intoLevel,
      xpToNext: Math.max(1, m.xp.toNext),
      gumballs: m.wallet.gumballs,
      gems: m.wallet.gems,
      crowns: m.crowns,
      colors: this.loadout.colors,
      hat: avatarHat(l.headwear),
      isGuest: m.isGuest,
      ...(ranked && tier
        ? {
            rank: {
              tier,
              division: Math.max(1, ranked.division),
              rp: ranked.rp,
              rpToNext: 400 - (ranked.rp % 400),
              ...(ranked.placementsLeft > 0 ? { placementsLeft: ranked.placementsLeft } : {}),
            },
          }
        : {}),
      stats: {
        shows: m.stats.showsPlayed,
        finals: m.stats.finals,
        roundsQualified: m.stats.roundsQualified,
        bestStreak: m.stats.bestWinStreak,
        wins: m.stats.wins,
        roundsPlayed: m.stats.roundsPlayed,
        ...(this.recentForm.length > 0 ? { recentForm: this.recentForm } : {}),
        ...(this.roundTally.length > 0 ? { rounds: this.roundTally } : {}),
      },
      crownShards: m.wallet.crownShards,
      shardsPerCrown: SHARDS_PER_CROWN,
      ...profileDressing(this.loadout),
      showcase: owned.slice(-3).map((c) => uiItem(c, true)),
      linkedProviders: m.linkedProviders.filter(
        (p): p is 'discord' | 'google' | 'email' => p === 'discord' || p === 'google' || p === 'email',
      ),
    };
  }

  /** Last shows' results, newest first (from `/me/matches`). */
  private recentForm: ('crown' | 'final' | 'eliminated')[] = [];
  /** Most played rounds over the recent shows. */
  private roundTally: { name: string; type: RoundType; played: number; qualified: number }[] = [];

  /**
   * Another player's public card (`/profile/:id`) as profile data.
   *
   * @param playerId - Account id.
   */
  async inspect(playerId: string): Promise<ProfileData | null> {
    try {
      const c = await this.api.profileCard(playerId);
      const look = c.loadout ? apiLoadoutToUi(c.displayName, c.loadout) : null;
      if (look) this.cards.set(c.userId, uiLoadoutToTumbler(look));
      const ranked = c.ranked?.find((r) => r.queue === 'ranked' || r.queue.includes('rank'));
      const tier = ranked ? RANK_TIERS[ranked.tier] : undefined;
      const colors = look?.colors ?? guessColors(c.userId);
      return {
        id: c.userId,
        name: c.displayName,
        tag: c.tag,
        level: c.level,
        xp: c.xp?.intoLevel ?? 0,
        xpToNext: Math.max(1, c.xp?.toNext ?? 1),
        gumballs: 0,
        gems: 0,
        crowns: c.crowns ?? 0,
        colors,
        hat: avatarHat(look?.items.headwear ?? null),
        isGuest: false,
        ...(ranked && tier
          ? {
              rank: {
                tier,
                division: Math.max(1, ranked.division),
                rp: ranked.rp,
                rpToNext: 400 - (ranked.rp % 400),
              },
            }
          : {}),
        stats: {
          shows: c.stats?.showsPlayed ?? 0,
          finals: c.stats?.finals ?? 0,
          roundsQualified: c.stats?.roundsQualified ?? 0,
          bestStreak: c.stats?.bestWinStreak ?? 0,
          wins: c.stats?.wins ?? 0,
          roundsPlayed: c.stats?.roundsPlayed ?? 0,
        },
        ...(look ? profileDressing(look) : {}),
      };
    } catch (err) {
      console.warn('[account] profile card failed', err);
      return null;
    }
  }

  private pushProfile(): void {
    const p = this.uiProfile();
    if (p) ui.getState().setProfile(p);
  }

  private pushInventory(): void {
    ui.getState().setInventory({
      items: lockerItems(this.owned),
      loadouts: this.loadouts.map((l, i) => l ?? defaultUiLoadout(`Loadout ${i + 1}`, this.loadout.colors)),
      activeLoadout: this.activeIndex,
    });
  }

  private async refreshStore(): Promise<void> {
    try {
      const [store, packs, shards] = await Promise.all([
        this.api.store(),
        this.api.gemPacks().catch(() => null),
        this.api.shardShop().catch(() => null),
      ]);
      this.gemCheckout = gemCheckoutMode(packs);
      const shardOffers = (shards?.offers ?? []).flatMap((o) => {
        const item = getCosmetic(o.offerId);
        return item
          ? [
              {
                id: `shards:${o.offerId}`,
                item: uiItem(item, o.owned || this.owns(o.offerId)),
                price: o.price.amount,
              },
            ]
          : [];
      });
      const gemPacks: GemPackOffer[] = (packs?.packs ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        gems: p.gems,
        price: new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: p.currency.toUpperCase(),
        }).format(p.priceCents / 100),
      }));
      ui.getState().setStoreData({
        ...onlineStoreShelves(store, (id) => this.owns(id)),
        gemPacks,
        gemCheckout: this.gemCheckout,
        ...(shards
          ? {
              shardShop: {
                offers: shardOffers,
                rotationEndsAt: Date.parse(shards.refreshesAt),
                shardsPerCrown: shards.shardsPerCrown,
              },
            }
          : {}),
      });
    } catch (err) {
      console.warn('[account] store failed', err);
    }
  }

  private passReward(r: ApiPassReward | undefined, claimed: boolean): PassReward | undefined {
    if (!r) return undefined;
    if (r.type === 'cosmetic') {
      const item = getCosmetic(r.id);
      return item
        ? { item: uiItem(item, this.owns(item.id)), claimed }
        : { currency: { kind: 'gumballs', amount: 100 }, claimed };
    }
    if (r.type === 'crown_shards') return { currency: { kind: 'crownShards', amount: r.amount }, claimed };
    return { currency: { kind: r.type, amount: r.amount }, claimed };
  }

  private async refreshPass(): Promise<void> {
    try {
      const p = await this.api.pass();
      this.pass = p;
      for (const s of p.settled ?? []) {
        if (s.autoGranted <= 0) continue;
        ui.getState().pushToast({
          kind: 'reward',
          title: `${s.autoGranted} unclaimed ${s.name} rewards added`,
          body: `${p.name} has begun.`,
          icon: '🎁',
        });
      }
      const data: SeasonPassData = {
        seasonName: p.name,
        seasonNumber: p.seasonNumber ?? 1,
        endsAt: Date.parse(p.endsAt),
        ...(p.next
          ? {
              nextSeason: { number: p.next.number, name: p.next.name, startsAt: Date.parse(p.next.startsAt) },
            }
          : {}),
        currentTier: p.tier,
        tierProgress: p.nextTierXp > 0 ? p.xpIntoTier / p.nextTierXp : 1,
        premium: p.premium,
        premiumPrice: p.premiumPriceGems,
        tiers: p.tiers.map((t) => ({
          tier: t.tier,
          ...(t.free[0] ? { free: this.passReward(t.free[0], t.freeClaimed) } : {}),
          ...(t.premium[0] ? { premium: this.passReward(t.premium[0], t.premiumClaimed) } : {}),
        })),
      };
      ui.getState().setPass(data);
    } catch (err) {
      console.warn('[account] pass failed', err);
    }
  }

  private async refreshChallenges(): Promise<void> {
    try {
      const c = await this.api.challenges();
      const row =
        (cadence: ChallengeCadence) =>
        (x: (typeof c.daily)[number]): ChallengesData['list'][number] => ({
          id: x.id,
          cadence,
          title: x.title,
          icon: CHALLENGE_ICON[x.metric ?? ''] ?? '⭐',
          progress: Math.min(x.progress, x.target),
          goal: x.target,
          reward:
            x.reward.gumballs > 0
              ? { kind: 'gumballs', amount: x.reward.gumballs }
              : { kind: 'xp', amount: x.reward.xp },
          ...(x.reward.gumballs > 0 && x.reward.xp > 0
            ? { bonus: { kind: 'xp' as const, amount: x.reward.xp } }
            : {}),
          ...(x.metric ? { metric: x.metric } : {}),
          ...(x.reward.gems ? { gems: x.reward.gems } : {}),
          ...(x.reward.cosmetic ? this.optionalItem(x.reward.cosmetic.id) : {}),
          claimed: x.claimed,
          canReroll: cadence === 'daily' && c.rerollsLeft > 0 && !x.completed,
        });
      ui.getState().setChallenges({
        list: [
          ...c.daily.map(row('daily')),
          ...c.weekly.map(row('weekly')),
          ...(c.seasonal ?? []).map(row('seasonal')),
          ...(c.milestone ?? []).map(row('milestone')),
        ],
        dailyResetsAt: Date.parse(c.dailyRefreshesAt),
        weeklyResetsAt: Date.parse(c.weeklyRefreshesAt),
        rerollsLeft: c.rerollsLeft,
        rerollsPerDay: 1,
        ...(c.season ? { season: { name: c.season.name, endsAt: Date.parse(c.season.endsAt) } } : {}),
      });
      for (const s of c.settled ?? []) {
        ui.getState().pushToast({
          kind: 'reward',
          title: 'Seasonal challenge paid out',
          body: `${s.title}: completed last season, rewards added.`,
          icon: '🎯',
        });
      }
    } catch (err) {
      console.warn('[account] challenges failed', err);
    }
  }

  private optionalItem(id: string): { item: UiItem } | Record<string, never> {
    const item = getCosmetic(id);
    return item ? { item: uiItem(item, this.owns(id)) } : {};
  }

  /** API reward → UI reward pill (unknown cosmetics are dropped). */
  private grantView(g: ApiGrant): GrantView | null {
    if (g.type === 'cosmetic') {
      const item = getCosmetic(g.id);
      return item ? { kind: 'item', item: uiItem(item, this.owns(g.id)) } : null;
    }
    return { kind: g.type === 'crown_shards' ? 'crownShards' : g.type, amount: g.amount };
  }

  private grantViews(list: readonly ApiGrant[]): GrantView[] {
    return list.flatMap((g) => {
      const v = this.grantView(g);
      return v ? [v] : [];
    });
  }

  private applyStreak(s: ApiStreak): void {
    ui.getState().setLoginStreak({
      streak: s.streak,
      best: s.best,
      claimedToday: s.claimedToday,
      canClaim: s.canClaim,
      nextClaimAt: Date.parse(s.nextClaimAt),
      breaksAt: s.breaksAt ? Date.parse(s.breaksAt) : null,
      next: { day: s.next.day, rewards: this.grantViews(s.next.rewards) },
      ladder: s.ladder.map((d) => ({ day: d.day, state: d.state, rewards: this.grantViews(d.rewards) })),
    });
  }

  private async refreshStreak(): Promise<void> {
    try {
      this.applyStreak(await this.api.streak());
    } catch (err) {
      console.warn('[account] login streak failed', err);
    }
  }

  private async refreshAchievements(): Promise<void> {
    try {
      const a = await this.api.achievements();
      ui.getState().setAchievements({
        list: a.achievements.map((x) => ({
          id: x.id,
          category: x.category,
          title: x.title,
          description: x.description,
          hidden: x.hidden,
          unlocked: x.unlocked,
          ...(x.unlockedAt ? { unlockedAt: Date.parse(x.unlockedAt) } : {}),
          progress: x.progress,
          target: x.target,
          ...(x.series ? { tier: { tier: x.series.tier, tiers: x.series.tiers } } : {}),
          rewards: this.grantViews(x.rewards),
        })),
        categories: a.categories.map((c) => ({
          ...c,
          name: ACHIEVEMENT_CATEGORY_NAMES[c.id as keyof typeof ACHIEVEMENT_CATEGORY_NAMES] ?? c.id,
        })),
        unlocked: a.unlocked,
        total: a.total,
      });
    } catch (err) {
      console.warn('[account] achievements failed', err);
    }
  }

  private async refreshCollection(): Promise<void> {
    try {
      const c = await this.api.collection();
      ui.getState().setCollection({
        owned: c.owned,
        total: c.total,
        percent: c.percent,
        entries: c.entries.flatMap((e) => {
          const item = getCosmetic(e.id);
          if (!item) return [];
          return [
            {
              item: uiItem(item, e.owned),
              sources: e.sources as CollectionSourceView[],
              ...(e.acquiredAt ? { acquiredAt: Date.parse(e.acquiredAt) } : {}),
            },
          ];
        }),
      });
    } catch (err) {
      console.warn('[account] collection failed', err);
    }
  }

  /**
   * Loads the events and the player's progress in them. Reading progress is
   * also what pays out an ended event, so anything it settled is toasted.
   */
  private async refreshEvents(): Promise<void> {
    try {
      const sent = Date.now();
      const [list, progress]: [ApiLiveEvents, Awaited<ReturnType<ApiClient['eventProgress']>>] =
        await Promise.all([this.api.liveEvents(), this.api.eventProgress()]);
      const now = Date.now();
      ui.getState().setEvents(
        eventsView({
          events: list.events,
          progress: progress.progress,
          enabled: list.enabled && progress.enabled,
          offsetMs: Math.round(list.serverTime - (sent + now) / 2),
          now,
          grant: (g) => this.grantView(g),
        }),
      );
      for (const s of progress.settled) {
        ui.getState().pushToast({
          kind: 'reward',
          title: `${s.name} rewards added`,
          body: 'The event ended. Everything you earned but had not claimed is now yours.',
          icon: '🎁',
        });
      }
      if (progress.settled.length) await this.refreshWalletAndInventory();
    } catch (err) {
      console.warn('[account] events failed', err);
    }
  }

  /** Re-reads the wallet and inventory only (after an event payout). */
  private async refreshWalletAndInventory(): Promise<void> {
    try {
      const [me, inv] = await Promise.all([this.api.me(), this.api.inventory()]);
      this.me = me;
      this.owned = new Set(inv.items.map((i) => i.id));
      this.pushProfile();
      this.pushInventory();
    } catch (err) {
      console.warn('[account] wallet refresh failed', err);
    }
  }

  /**
   * Claims a reached tier on an event's points track.
   *
   * @param eventId - Event id.
   * @param tier - Tier number.
   */
  async claimEventTier(eventId: string, tier: number): Promise<void> {
    try {
      await this.api.claimEventTier(eventId, tier);
      ui.getState().pushToast({ kind: 'reward', title: `Event tier ${tier} claimed!`, icon: '🎁' });
      await this.refreshProgress();
    } catch (err) {
      ui.getState().pushToast({ kind: 'error', title: "Couldn't claim that reward", body: describe(err) });
      await this.refreshEvents();
    }
  }

  /**
   * Claims a completed event challenge (its points join the track).
   *
   * @param eventId - Event id.
   * @param challengeId - Challenge id within the event.
   */
  async claimEventChallenge(eventId: string, challengeId: string): Promise<void> {
    try {
      const r = await this.api.claimEventChallenge(eventId, challengeId);
      ui.getState().pushToast({
        kind: 'reward',
        title: `+${r.points} event points`,
        ...(r.xp > 0 ? { body: `+${r.xp} XP` } : {}),
        icon: '🎯',
      });
      await this.refreshProgress();
    } catch (err) {
      ui.getState().pushToast({ kind: 'error', title: "Couldn't claim that challenge", body: describe(err) });
      await this.refreshEvents();
    }
  }

  /**
   * Reloads achievements and the collection after an unlock notification. A
   * first sign-in can unlock several backfilled achievements at once; their
   * notifications collapse into one reload plus at most one follow-up.
   */
  private refreshUnlocksSoon(): void {
    if (this.unlocksInFlight) {
      this.unlocksQueued = true;
      return;
    }
    this.unlocksInFlight = true;
    void Promise.all([this.refreshAchievements(), this.refreshCollection()]).finally(() => {
      this.unlocksInFlight = false;
      if (!this.unlocksQueued) return;
      this.unlocksQueued = false;
      this.refreshUnlocksSoon();
    });
  }

  /** Claims today's login reward; the API decides the day and the streak. */
  async claimLoginStreak(): Promise<void> {
    try {
      const r = await this.api.claimStreak();
      this.applyStreak(r.view);
      const paid = r.rewards
        .filter((g) => g.granted)
        .map((g) => this.grantView(g))
        .flatMap((g) => (g && g.kind !== 'item' ? [grantText(g)] : []));
      ui.getState().pushToast({
        kind: 'reward',
        title: r.ladderDay === 7 ? 'Day 7 bonus claimed!' : `Day ${r.ladderDay} reward claimed`,
        ...(paid.length ? { body: paid.join(' · ') } : {}),
        icon: '🔥',
      });
      await this.refreshProgress();
    } catch (err) {
      ui.getState().pushToast({
        kind: err instanceof ApiError && err.code === 'already_claimed' ? 'info' : 'error',
        title:
          err instanceof ApiError && err.code === 'already_claimed'
            ? 'Already claimed today'
            : "Couldn't claim the login reward",
        body: describe(err),
        icon: '🔥',
      });
      await this.refreshStreak();
    }
  }

  // ---------------------------------------------------------------------------
  // Locker
  // ---------------------------------------------------------------------------

  /** Previews an item on the 3D Tumbler without saving. */
  tryOnLoadout(slot: UiSlot, itemId: string | null): TumblerLoadout {
    return itemId === null
      ? this.tumblerLoadout()
      : uiLoadoutToTumbler(loadoutWithItem(this.loadout, slot, itemId));
  }

  /** Previews several items at once (bundles) without saving. */
  tryOnMany(items: readonly { slot: UiSlot; itemId: string }[]): TumblerLoadout {
    return uiLoadoutToTumbler(items.reduce((l, it) => loadoutWithItem(l, it.slot, it.itemId), this.loadout));
  }

  /** Saves `next` into the active slot (optimistic; reverted on failure). */
  private async saveActive(next: UiLoadout): Promise<boolean> {
    const i = this.activeIndex;
    const prev = this.loadouts[i] ?? null;
    this.loadouts[i] = next;
    this.pushInventory();
    this.pushProfile();
    this.hooks.onLookChanged();
    try {
      await this.api.putLoadout(i, next.name, uiLoadoutToApi(next));
      return true;
    } catch (err) {
      this.loadouts[i] = prev;
      this.pushInventory();
      this.pushProfile();
      this.hooks.onLookChanged();
      ui.getState().pushToast({
        kind: 'error',
        title: "Couldn't save your look",
        body: describe(err),
        icon: '🧥',
      });
      return false;
    }
  }

  /** Equips an owned item (persisted). */
  equip(slot: UiSlot, itemId: string): Promise<boolean> {
    if (!this.owns(itemId) && slot !== 'colors') return Promise.resolve(false);
    return this.saveActive(loadoutWithItem(this.loadout, slot, itemId));
  }

  /** Replaces the active loadout's colours (persisted). */
  setColors(colors: TumblerColors): Promise<boolean> {
    return this.saveActive({ ...this.loadout, colors });
  }

  /** Rolls a random owned outfit (persisted). */
  randomize(): Promise<boolean> {
    return this.saveActive(
      randomizedLoadout(
        this.loadout,
        (id) => this.owns(id),
        (Date.now() ^ hashString(this.me?.userId ?? 'x')) >>> 0,
      ),
    );
  }

  /** Switches the active loadout slot, creating it from the current look if empty. */
  async selectLoadout(index: number): Promise<void> {
    if (index < 0 || index >= LOADOUT_SLOTS) return;
    const prev = this.activeIndex;
    try {
      if (!this.loadouts[index]) {
        const fresh = { ...this.loadout, name: `Loadout ${index + 1}` };
        await this.api.putLoadout(index, fresh.name, uiLoadoutToApi(fresh));
        this.loadouts[index] = fresh;
      }
      await this.api.activateLoadout(index);
      this.activeIndex = index;
    } catch (err) {
      this.activeIndex = prev;
      ui.getState().pushToast({
        kind: 'error',
        title: "Couldn't switch loadouts",
        body: describe(err),
        icon: '🧥',
      });
    }
    this.pushInventory();
    this.pushProfile();
    this.hooks.onLookChanged();
  }

  /** First sign-in: carry the welcome screen's colours into slot 0. */
  async adoptWelcomeColors(colors: TumblerColors): Promise<void> {
    await this.saveActive({ ...this.loadout, colors });
  }

  // ---------------------------------------------------------------------------
  // Economy & progression
  // ---------------------------------------------------------------------------

  /** Buys a store offer (one idempotency key per attempt; retried once on a network error). */
  async purchase(offerId: string): Promise<void> {
    const key = idempotencyKey('buy');
    const s = ui.getState();
    // `shards:<id>` offers come from the Crown Shard shop; everything else is the daily store.
    const shard = offerId.startsWith('shards:');
    const itemId = shard ? offerId.slice('shards:'.length) : offerId;
    const send = () => (shard ? this.api.buyShardOffer(itemId, key) : this.api.purchase(itemId, key));
    try {
      let res;
      try {
        res = await send();
      } catch (err) {
        // A lost response may have completed server-side; the same key replays it safely.
        if (err instanceof ApiError && err.status === 0) res = await send();
        else throw err;
      }
      this.owned.add(itemId);
      if (this.me) this.me.wallet = res.wallet;
      const item = getCosmetic(itemId);
      if (!res.replayed)
        track('store_purchase', { shop: shard ? 'shards' : 'store', slot: item?.slot ?? null });
      s.pushToast({
        kind: 'reward',
        title: `${item?.name ?? 'Item'} is yours!`,
        icon: item ? uiItem(item, true).icon : '🎁',
      });
      this.pushProfile();
      this.pushInventory();
      await this.refreshStore();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      const body =
        code === 'feature_disabled'
          ? 'The store is closed for a moment. Nothing was charged; try again soon!'
          : code === 'insufficient_funds'
            ? shard
              ? 'Not enough Crown Shards — reach a few more finals!'
              : 'Not enough currency — play a few shows!'
            : code === 'already_owned'
              ? 'You already own that.'
              : describe(err);
      s.showDialog({
        id: 'purchase-failed',
        kind: 'error',
        title: 'Purchase failed',
        body,
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
    }
  }

  /** Loads Store → Purchases, keeping what is shown while it refreshes. */
  async loadPurchaseHistory(): Promise<void> {
    const s = ui.getState();
    const current = s.purchaseHistory;
    s.setPurchaseHistory(
      current
        ? { ...current, status: 'loading' }
        : {
            status: 'loading',
            entries: [],
            selfRefunds: { used: 0, limit: 0, windowDays: 0, nextAvailableAt: null },
            policy: { selfServiceWindowDays: 0, realMoneyWindowDays: 0 },
          },
    );
    try {
      s.setPurchaseHistory(toPurchaseHistory(await this.api.purchaseHistory()));
    } catch (err) {
      const latest = ui.getState().purchaseHistory!;
      s.setPurchaseHistory({ ...latest, status: 'error', error: refundErrorText(err) });
    }
  }

  /**
   * Refunds a store purchase the player confirmed, or sends a Gem pack refund
   * request. A repeat of the same purchase is answered with the first refund,
   * so a retried tap can never refund twice.
   */
  async refundPurchase(purchaseId: string, reason?: string): Promise<void> {
    const s = ui.getState();
    const entry = s.purchaseHistory?.entries.find((e) => e.purchaseId === purchaseId);
    if (s.purchaseHistory) s.setPurchaseHistory({ ...s.purchaseHistory, busyId: purchaseId });
    try {
      const r = await this.api.refundPurchase(purchaseId, reason);
      const credit = entry
        ? entry.price.currency === 'usd'
          ? `${(entry.price.amount / 100).toFixed(2)}`
          : `${r.credit.amount.toLocaleString()} ${r.credit.currency === 'gems' ? 'Gems' : 'Gumballs'}`
        : `${r.credit.amount} ${r.credit.currency}`;
      const t = refundToast(r, credit);
      s.pushToast({ kind: r.kind === 'real_money' ? 'info' : 'success', title: t.title, body: t.body });
      if (r.kind === 'self_service') {
        for (const id of r.items) this.owned.delete(id);
        await this.refreshProgress();
        const lo = await this.api.loadouts().catch(() => null);
        if (lo) {
          this.applyLoadouts(lo.slots, lo.activeIndex);
          this.pushInventory();
          this.hooks.onLookChanged();
        }
      }
    } catch (err) {
      s.showDialog({
        id: 'refund-failed',
        kind: 'error',
        title: entry?.kind === 'gem_pack' ? "Couldn't send the request" : "Couldn't refund that",
        body: refundErrorText(err),
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
    }
    await this.loadPurchaseHistory();
    const after = ui.getState().purchaseHistory;
    if (after) s.setPurchaseHistory({ ...after, busyId: null });
  }

  // ---------------------------------------------------------------------------
  // Gifts & wish lists
  // ---------------------------------------------------------------------------

  private readonly resolveItem: ItemResolver = (id) => {
    const c = getCosmetic(id);
    return c ? uiItem(c, this.owns(id)) : null;
  };

  /** The other party's name for toasts, masked under Streamer Mode. */
  private giftName(p: { userId: string; name: string; tag: string } | null): string {
    if (!p) return 'Someone';
    return ui.getState().settings.gameplay.streamerMode ? maskedName(p.userId) : p.name;
  }

  /** Loads Profile → Gifts, keeping what is shown (and a running reveal) while it refreshes. */
  async loadGifts(): Promise<void> {
    const s = ui.getState();
    const current = s.gifts;
    s.setGifts(
      current
        ? { ...current, status: 'loading' }
        : {
            status: 'loading',
            received: [],
            sent: [],
            unopened: 0,
            limits: { daily: 0, sentToday: 0, resetsAt: 0 },
            policy: { minFriendDays: 0, minAccountDays: 0, autoAcceptDays: 0, messageMax: 80 },
          },
    );
    try {
      const next = toGifts(await this.api.gifts(), this.resolveItem);
      const latest = ui.getState().gifts;
      s.setGifts({ ...next, busyId: latest?.busyId ?? null, revealed: latest?.revealed ?? null });
    } catch (err) {
      const latest = ui.getState().gifts!;
      s.setGifts({ ...latest, status: 'error', error: giftErrorText(err) });
    }
  }

  /** Opens or declines a received gift, or cancels a sent one (the latter two already confirmed). */
  async giftAction(giftId: string, action: 'open' | 'decline' | 'cancel'): Promise<void> {
    const s = ui.getState();
    if (s.gifts) s.setGifts({ ...s.gifts, busyId: giftId });
    try {
      const r = await this.api.giftAction(giftId, action);
      if (action === 'open' && r.gift.status === 'opened' && (r.granted?.length ?? 0) > 0) {
        for (const id of r.granted!) this.owned.add(id);
        this.pushInventory();
        const items = r.granted!.flatMap((id) => {
          const item = this.resolveItem(id);
          return item ? [item] : [];
        });
        const g = ui.getState().gifts;
        if (g && items.length > 0) s.setGifts({ ...g, revealed: { giftId, items } });
      } else if (action === 'open' && r.gift.status === 'returned') {
        s.pushToast({
          kind: 'info',
          title: 'You already had this one',
          body: `${r.gift.title} went back to ${this.giftName(r.gift.from)}, who got their currency back.`,
        });
      } else if (action === 'decline') {
        s.pushToast({ kind: 'info', title: 'Gift declined', body: 'The sender got their currency back.' });
      } else if (action === 'cancel') {
        s.pushToast({
          kind: 'success',
          title: 'Gift cancelled',
          body: 'Your currency is back in your wallet.',
        });
        await this.refreshProgress();
      }
    } catch (err) {
      s.showDialog({
        id: 'gift-failed',
        kind: 'error',
        title: action === 'open' ? "Couldn't open that gift" : "Couldn't do that",
        body: giftErrorText(err),
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
    }
    await this.loadGifts();
    const after = ui.getState().gifts;
    if (after) s.setGifts({ ...after, busyId: null });
  }

  /** Opens the gift sheet for an offer and asks which friends can receive it. */
  async openGiftPicker(offerId: string, recipientId?: string): Promise<void> {
    const s = ui.getState();
    const bundle = s.store?.bundles?.find((b) => b.id === offerId);
    const heroId = bundle?.item.id ?? offerId;
    const title = bundle?.title ?? getCosmetic(offerId)?.name ?? 'this item';
    const messageMax = s.gifts?.policy.messageMax || 80;
    s.setGiftPicker({
      offerId,
      title,
      item: this.resolveItem(heroId),
      status: 'loading',
      sender: null,
      friends: [],
      sentToday: s.gifts?.limits.sentToday ?? 0,
      dailyLimit: s.gifts?.limits.daily ?? 0,
      messageMax,
      recipientId: recipientId ?? null,
    });
    try {
      const p = await this.api.giftPicker(offerId);
      if (ui.getState().giftPicker?.offerId !== offerId) return;
      s.setGiftPicker(toGiftPicker(p, this.resolveItem, heroId, recipientId ?? null, messageMax));
    } catch (err) {
      const open = ui.getState().giftPicker;
      if (open?.offerId === offerId) s.setGiftPicker({ ...open, status: 'error', error: giftErrorText(err) });
    }
  }

  /**
   * Sends a gift the player confirmed. A lost answer is retried with the
   * same key, which the API replays instead of charging twice.
   */
  async sendGift(offerId: string, recipientId: string, message?: string): Promise<void> {
    const s = ui.getState();
    const picker = s.giftPicker;
    if (picker) s.setGiftPicker({ ...picker, status: 'sending' });
    const key = idempotencyKey('gift');
    const body = { recipientId, offerId, ...(message ? { message } : {}) };
    try {
      let res;
      try {
        res = await this.api.sendGift(body, key);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) res = await this.api.sendGift(body, key);
        else throw err;
      }
      if (this.me) this.me.wallet = res.wallet;
      this.pushProfile();
      s.setGiftPicker(null);
      s.pushToast({
        kind: 'success',
        title: `Gift sent to ${this.giftName(res.gift.to)}!`,
        body: 'You can cancel it under Profile → Gifts until they open it.',
      });
      await this.loadGifts();
    } catch (err) {
      s.showDialog({
        id: 'gift-failed',
        kind: 'error',
        title: "Couldn't send that gift",
        body: giftErrorText(err),
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
      if (ui.getState().giftPicker) await this.openGiftPicker(offerId, recipientId);
    }
  }

  private applyWishlist(w: ApiWishlist): void {
    ui.getState().setWishlist(toWishlist(w, this.resolveItem));
  }

  private async changeWishlist(run: () => Promise<ApiWishlist>, failure: string): Promise<void> {
    try {
      this.applyWishlist(await run());
    } catch (err) {
      const current = ui.getState().wishlist;
      ui.getState().pushToast({ kind: 'warning', title: failure, body: giftErrorText(err) });
      if (current) await this.loadWishlist();
    }
  }

  /** Loads Profile → Wish list (and the stars on store items). */
  async loadWishlist(): Promise<void> {
    try {
      this.applyWishlist(await this.api.wishlist());
    } catch (err) {
      const current = ui.getState().wishlist;
      ui.getState().setWishlist({
        ...(current ?? { entries: [], visibility: 'friends', alerts: true, limit: 50 }),
        status: 'error',
        error: giftErrorText(err),
      });
    }
  }

  /** Puts an offer on the wish list or takes it off, showing the change at once. */
  async wishlistToggle(itemId: string, on: boolean): Promise<void> {
    const s = ui.getState();
    if (s.wishlist && !on)
      s.setWishlist({ ...s.wishlist, entries: s.wishlist.entries.filter((e) => e.itemId !== itemId) });
    await this.changeWishlist(
      () => (on ? this.api.wishlistAdd(itemId) : this.api.wishlistRemove(itemId)),
      on ? "Couldn't add that to your wish list" : "Couldn't remove that",
    );
    if (on) s.pushToast({ kind: 'success', title: 'Added to your wish list' });
  }

  /** Saves a new wish list order, showing it at once. */
  async wishlistReorder(itemIds: string[]): Promise<void> {
    const s = ui.getState();
    if (s.wishlist) {
      const by = new Map(s.wishlist.entries.map((e) => [e.itemId, e]));
      s.setWishlist({ ...s.wishlist, entries: itemIds.flatMap((id) => (by.has(id) ? [by.get(id)!] : [])) });
    }
    await this.changeWishlist(() => this.api.wishlistOrder(itemIds), "Couldn't reorder your wish list");
  }

  /** Changes wish list privacy or store alerts. */
  async wishlistSettings(patch: { visibility?: 'friends' | 'nobody'; alerts?: boolean }): Promise<void> {
    const s = ui.getState();
    if (s.wishlist) s.setWishlist({ ...s.wishlist, ...patch });
    await this.changeWishlist(() => this.api.wishlistSettings(patch), "Couldn't save that setting");
  }

  /** Loads a friend's wish list onto their open profile card. */
  async loadFriendWishlist(userId: string): Promise<void> {
    const s = ui.getState();
    s.setFriendWishlist({ userId, status: 'loading', entries: [] });
    try {
      const w = await this.api.friendWishlist(userId);
      if (ui.getState().friendWishlist?.userId !== userId) return;
      s.setFriendWishlist({
        userId,
        status: 'ready',
        entries: toWishlistEntries(w.entries, this.resolveItem),
      });
    } catch (err) {
      if (ui.getState().friendWishlist?.userId !== userId) return;
      const hidden = err instanceof ApiError && err.code === 'wishlist_hidden';
      s.setFriendWishlist({ userId, status: hidden ? 'hidden' : 'error', entries: [] });
    }
  }

  private onGiftEvent(m: TypedMessage): void {
    const e = m as unknown as GiftEvent;
    if (!e.giftId) return;
    const toast = giftEventToast(e, this.giftName(e.other));
    if (toast) {
      if (e.role === 'recipient' && e.status === 'received') {
        this.addNotification('reward', toast.title, toast.body, undefined);
        ui.getState().pushToast({
          kind: 'reward',
          ...toast,
          actions: [{ id: 'gift-inbox:open', label: 'Open' }],
        });
      } else {
        ui.getState().pushToast({ kind: e.status === 'opened' ? 'reward' : 'info', ...toast });
      }
    }
    if (e.status === 'reversed' || (e.status === 'opened' && e.role === 'recipient'))
      void this.refreshProgress();
    void this.loadGifts();
  }

  private onWishlistInStore(m: TypedMessage): void {
    const items = (m.items as { title: string }[] | undefined) ?? [];
    if (items.length === 0) return;
    const title =
      items.length === 1
        ? `${items[0]!.title} is in the store today`
        : `${items.length} wish list items are in the store today`;
    this.addNotification('news', title, 'From your wish list');
    ui.getState().pushToast({
      kind: 'info',
      title,
      body: 'From your wish list',
      actions: [{ id: 'wishlist-store:today', label: 'Take a look' }],
    });
  }

  /** Buys a Gem pack: instant test credit with the dev fake provider, otherwise a Stripe redirect. */
  async buyGems(packId: string): Promise<void> {
    const s = ui.getState();
    if (this.gemCheckout === 'comingSoon') {
      s.pushToast({
        kind: 'info',
        title: 'Gems are coming soon',
        body: 'Secure checkout via Stripe is on its way.',
        icon: '💎',
      });
      return;
    }
    try {
      const r = await this.api.gemCheckout(packId, idempotencyKey('gems'));
      if (r.status === 'completed') {
        s.pushToast({
          kind: 'reward',
          title: `+${r.gems} Gems!`,
          ...(this.gemCheckout === 'test' ? { body: 'Test purchase (dev): no real money was taken.' } : {}),
          icon: '💎',
        });
        await this.refreshProgress();
      } else if (r.checkoutUrl) {
        window.location.assign(r.checkoutUrl);
      }
    } catch (err) {
      if (err instanceof ApiError && explainGemCheckoutRefusal(err.code, err.details)) return;
      const soon = err instanceof ApiError && err.code === 'payments_unavailable';
      s.showDialog({
        id: 'gems-failed',
        kind: soon ? 'info' : 'error',
        title: soon ? 'Gems are coming soon' : 'Checkout failed',
        body: soon ? 'Secure checkout via Stripe is on its way.' : describe(err),
      });
    }
  }

  /**
   * Claims the one-time Practice Island reward on the account.
   *
   * @returns The server's answer, or null when the API could not be reached.
   */
  async completeTutorial(): Promise<ApiTutorialComplete | null> {
    try {
      const r = await this.api.tutorialComplete();
      if (r.granted) void this.refreshProgress();
      return r;
    } catch (err) {
      console.warn('[account] tutorial reward failed', err);
      return null;
    }
  }

  /** Claims a pass tier reward. */
  async claimPassTier(tier: number, track: 'free' | 'premium'): Promise<void> {
    try {
      await this.api.claimPassTier(tier, track);
      ui.getState().pushToast({ kind: 'reward', title: `Tier ${tier} claimed!`, icon: '🎁' });
      await this.refreshProgress();
    } catch (err) {
      ui.getState().pushToast({
        kind: 'error',
        title: "Couldn't claim that tier",
        body: describe(err),
        icon: '🎁',
      });
    }
  }

  /** Unlocks the premium pass with Gems. */
  async buyPremiumPass(): Promise<void> {
    try {
      await this.api.unlockPremium(idempotencyKey('pass'));
      ui.getState().pushToast({ kind: 'reward', title: 'Premium pass unlocked!', icon: '⭐' });
      await this.refreshProgress();
    } catch (err) {
      const funds = err instanceof ApiError && err.code === 'insufficient_funds';
      ui.getState().showDialog({
        id: 'pass-funds',
        kind: 'error',
        title: funds ? 'Not enough Gems' : 'Unlock failed',
        body: funds
          ? 'Earn Gems from weekly challenges, your first Crown each day, level milestones and the pass.'
          : describe(err),
      });
    }
  }

  /** Claims a completed challenge. */
  async claimChallenge(id: string): Promise<void> {
    try {
      await this.api.claimChallenge(id);
      await this.refreshProgress();
    } catch (err) {
      ui.getState().pushToast({
        kind: 'error',
        title: "Couldn't claim that challenge",
        body: describe(err),
        icon: '🎯',
      });
    }
  }

  /** Rerolls a daily challenge. */
  async rerollChallenge(id: string): Promise<void> {
    try {
      await this.api.rerollChallenge(id);
      await this.refreshChallenges();
      ui.getState().pushToast({ kind: 'info', title: 'New challenge rolled!', icon: '🎲' });
    } catch (err) {
      ui.getState().pushToast({ kind: 'warning', title: "Couldn't reroll", body: describe(err), icon: '🎲' });
    }
  }

  /** Answers a leaderboard query. */
  async leaderboard(board: LeaderboardId, requested?: LeaderboardScope): Promise<void> {
    const type = board === 'weekly' ? 'crowns_weekly' : board === 'friends' ? 'crowns' : board;
    const scope: LeaderboardScope = board === 'friends' ? 'friends' : (requested ?? 'global');
    try {
      const r = await this.api.leaderboard(type, scope);
      const me = this.userId;
      const rows = r.entries.map((e) => ({
        rank: e.rank,
        playerId: e.userId,
        name: `${e.displayName}#${e.tag}`,
        value: e.score,
        colors:
          e.userId === me
            ? this.loadout.colors
            : this.cards.has(e.userId)
              ? tumblerColors(this.cards.get(e.userId)!)
              : guessColors(e.userId),
        ...(e.userId === me ? { isSelf: true } : {}),
      }));
      if (r.me && !rows.some((x) => x.isSelf)) {
        rows.push({
          rank: r.me.rank,
          playerId: r.me.userId,
          name: `${r.me.displayName}#${r.me.tag}`,
          value: r.me.score,
          colors: this.loadout.colors,
          isSelf: true,
        });
      }
      ui.getState().setLeaderboard(board, rows, { scope, source: 'api', updatedAt: Date.now() });
    } catch (err) {
      console.warn('[account] leaderboard failed', err);
      ui.getState().setLeaderboardError(board, scope, describe(err));
    }
  }

  /** Loads the last 20 shows into Match History. */
  async history(): Promise<void> {
    try {
      const { matches } = await this.api.myMatches();
      const entries: MatchHistoryEntry[] = matches.map((m) => {
        const last = m.rounds[m.rounds.length - 1];
        const reachedFinal = !!last && last.roundType === 'final' && last.played;
        return {
          id: m.id,
          time: Date.parse(m.endedAt),
          playlist: getPlaylist(m.playlistId)?.name ?? m.playlistId,
          rounds: m.rounds
            .filter((r) => r.played)
            .map((r) => ({
              name: getRound(r.roundId)?.name ?? r.roundId,
              type: r.roundType as RoundType,
              qualified: r.qualified,
            })),
          result: m.crowned ? 'crown' : reachedFinal ? 'final' : 'eliminated',
          xp: m.xp,
        };
      });
      ui.getState().setMatchHistory(entries);
      this.applyHistoryStats(entries);
    } catch (err) {
      console.warn('[account] history failed', err);
    }
  }

  /** Recent form and most-played rounds for the profile card. */
  private applyHistoryStats(entries: readonly MatchHistoryEntry[]): void {
    this.recentForm = entries.slice(0, 10).map((e) => e.result);
    const tally = new Map<string, { name: string; type: RoundType; played: number; qualified: number }>();
    for (const e of entries) {
      for (const r of e.rounds) {
        const t = tally.get(r.name) ?? { name: r.name, type: r.type, played: 0, qualified: 0 };
        t.played++;
        if (r.qualified) t.qualified++;
        tally.set(r.name, t);
      }
    }
    this.roundTally = [...tally.values()].sort((a, b) => b.played - a.played).slice(0, 6);
    this.pushProfile();
  }

  /**
   * Renames the account (first rename free, then a cooldown) and re-reads
   * `/me` for the new tag and next allowed rename.
   *
   * @throws {ApiError} `invalid_name`, `name_cooldown` or a network failure;
   *   the rename UI shows the reason inline.
   */
  async rename(name: string): Promise<void> {
    const r = await this.api.patchMe({ displayName: name });
    if (this.me && r.displayName) {
      this.me.displayName = r.displayName;
      if (r.tag) this.me.tag = r.tag;
    }
    this.me = await this.api.me().catch(() => this.me);
    this.pushProfile();
  }

  // ---------------------------------------------------------------------------
  // Rewards
  // ---------------------------------------------------------------------------

  /** Remembers XP before a show so the rewards bars start in the right place. */
  markShowStart(): void {
    this.snapshotBefore = { xp: this.me?.xp.total ?? 0, passXp: this.pass?.xp ?? 0 };
  }

  /**
   * The API's grant as the rewards screen payload.
   *
   * @param r - Reward forwarded by the game server.
   */
  rewardsSummary(r: PlayerRewardMsg): RewardsSummary {
    const before = this.snapshotBefore ?? { xp: this.me?.xp.total ?? 0, passXp: this.pass?.xp ?? 0 };
    const from = levelForXp(before.xp);
    const to = levelForXp(before.xp + r.xp.total);
    const pFrom = passTierForXp(before.passXp);
    const pTo = passTierForXp(before.passXp + r.pass.xp);
    const unlocks: UiItem[] = [];
    for (const t of this.pass?.tiers ?? []) {
      if (t.tier <= r.pass.tierBefore || t.tier > r.pass.tierAfter) continue;
      for (const rw of t.free) {
        const item = rw.type === 'cosmetic' ? getCosmetic(rw.id) : undefined;
        if (item) unlocks.push(uiItem(item, false));
      }
    }
    const rk = r.ranked;
    const tierOf = (
      info: unknown,
      rp: number,
    ): { tier: RankTier; division: number; rp: number; rpToNext: number } | null => {
      const t = info as { tier?: string; division?: number } | null;
      const tier = t?.tier ? RANK_TIERS[t.tier] : undefined;
      return tier ? { tier, division: Math.max(1, t?.division ?? 1), rp, rpToNext: 400 - (rp % 400) } : null;
    };
    const rkFrom = rk ? tierOf((rk as { tierBefore?: unknown }).tierBefore, rk.rpBefore) : null;
    const rkTo = rk ? tierOf((rk as { tierAfter?: unknown }).tierAfter, rk.rpAfter) : null;
    return {
      xpLines: r.xp.lines.filter((l) => l.amount > 0).map((l) => ({ label: l.label, xp: l.amount })),
      levelFrom: {
        level: r.level.before,
        xp: from.level === r.level.before ? from.intoLevel : 0,
        xpToNext: Math.max(1, from.toNext),
      },
      levelTo: {
        level: r.level.after,
        xp: to.level === r.level.after ? to.intoLevel : 0,
        xpToNext: Math.max(1, to.toNext),
      },
      gumballs: r.gumballs.total,
      crowns: (r.crowned ? 1 : 0) + r.crownsFromShards,
      pass: {
        tierFrom: r.pass.tierBefore,
        tierTo: r.pass.tierAfter,
        progressFrom: pFrom.tierXp > 0 ? pFrom.intoTier / pFrom.tierXp : 1,
        progressTo: pTo.tierXp > 0 ? pTo.intoTier / pTo.tierXp : 1,
      },
      unlocks,
      ...(rk && rkFrom && rkTo ? { ranked: { from: rkFrom, to: rkTo, delta: rk.rpDelta } } : {}),
      ...(r.challenges.length > 0
        ? {
            challenges: r.challenges.slice(0, 3).map((c) => ({
              title: c.title,
              from: Math.min(c.before, c.target),
              to: Math.min(c.progress, c.target),
              goal: c.target,
            })),
          }
        : {}),
      ...(r.events?.length ? { events: rewardEventLines(r.events) } : {}),
      ...(r.achievements?.length
        ? {
            achievements: r.achievements.map((a) => ({
              id: a.id,
              title: a.title,
              description: a.description,
            })),
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Social
  // ---------------------------------------------------------------------------

  /** Connects the realtime gateway and wires its events. */
  startRealtime(): void {
    if (this.realtimeStarted) return;
    this.realtimeStarted = true;
    const rt = this.realtime;
    this.social.bind();
    this.clubs.bind();
    this.offs.push(
      rt.on('wallet', (m) => {
        if (!this.me) return;
        this.me.wallet = {
          gumballs: Number(m.gumballs ?? 0),
          gems: Number(m.gems ?? 0),
          crownShards: Number(m.crownShards ?? 0),
        };
        ui.getState().setWallet({ gumballs: this.me.wallet.gumballs, gems: this.me.wallet.gems });
        this.pushProfile();
      }),
      rt.on('friend_accepted', (m) => {
        const by = m.by as { name?: string } | undefined;
        ui.getState().pushToast({
          kind: 'social',
          title: `${by?.name ?? 'Someone'} is now your friend!`,
          icon: '🤝',
        });
      }),
      rt.on('friend_request', (m) => this.onFriendRequest(m)),
      rt.on('friend_request_removed', (m) => this.resolveNotifications(String(m.userId ?? ''), 'Withdrawn')),
      rt.on('party_update', (m) => {
        const next = (m.party as ApiParty | null) ?? null;
        const promoted =
          !!this.party && this.party.leaderId !== this.userId && next?.leaderId === this.userId;
        this.applyParty(next);
        if (promoted)
          ui.getState().pushToast({
            kind: 'social',
            title: 'You lead the party now',
            body: 'Pick the show and hit Play when everyone is ready.',
          });
      }),
      rt.on('party_solo', (m) => {
        const userId = String(m.userId ?? '');
        if (!userId || m.partyId !== this.party?.id) return;
        if (m.playing === true) this.soloMembers.add(userId);
        else this.soloMembers.delete(userId);
        this.applyParty(this.party);
        const notice = soloNotice(
          {
            userId,
            name: String(m.name ?? 'A member'),
            leader: m.leader === true,
            playing: m.playing === true,
          },
          this.userId,
        );
        if (notice) ui.getState().pushToast({ kind: 'social', ...notice });
      }),
      rt.on('party_kicked', () => {
        ui.getState().pushToast({ kind: 'warning', title: 'You were removed from the party', icon: '👋' });
        this.applyParty(null);
      }),
      rt.on('party_disbanded', () => this.applyParty(null)),
      rt.on('party_invite', (m) => this.onPartyInvite(m)),
      rt.on('gift', (m) => this.onGiftEvent(m)),
      rt.on('wishlist_in_store', (m) => this.onWishlistInStore(m)),
      rt.on('notification', (m) => {
        this.addNotification(
          'reward',
          String(m.title ?? 'Reward'),
          typeof m.body === 'string' ? m.body : undefined,
        );
        const achievement = typeof m.achievementId === 'string';
        ui.getState().pushToast({
          kind: 'reward',
          title: String(m.title ?? 'Reward'),
          ...(typeof m.body === 'string' ? { body: m.body } : {}),
          icon: achievement ? '🏅' : '🎁',
        });
        if (achievement) this.refreshUnlocksSoon();
      }),
      rt.on('socket_open', () => {
        rt.send({ type: 'presence', ...this.presence });
        // Events sent while the socket was down are lost; resync once per reconnect.
        if (this.realtimeOpened) void Promise.all([this.refreshFriends(), this.refreshParty()]);
        this.realtimeOpened = true;
      }),
      ui.subscribe((s, prev) => {
        if (s.notifications !== prev.notifications) this.notifications = s.notifications.slice();
      }),
    );
    rt.start();
  }

  /**
   * Reports presence (menu, queue, match), with the playlist while queued or
   * playing and a private show code when one is shared.
   */
  setPresence(
    status: 'online' | 'in_menu' | 'in_queue' | 'in_match',
    details: { playlistId?: string; lobbyCode?: string } = {},
  ): void {
    this.presence = { status, ...details };
    if (this.realtime.connected) this.realtime.send({ type: 'presence', ...this.presence });
    else void this.api.presence(status, details).catch(() => undefined);
  }

  private addNotification(
    kind: 'invite' | 'friendRequest' | 'news' | 'reward',
    title: string,
    body?: string,
    action?: NotificationItem['action'],
  ): void {
    this.notifications = [
      {
        id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind,
        title,
        ...(body ? { body } : {}),
        ...(action ? { action } : {}),
        time: Date.now(),
      },
      ...this.notifications,
    ].slice(0, 30);
    ui.getState().setNotifications(this.notifications);
  }

  /** Marks a player's open friend-request / invite notifications as handled. */
  private resolveNotifications(userId: string, label: string, kind?: 'friendRequest' | 'partyInvite'): void {
    let changed = false;
    this.notifications = this.notifications.map((n) => {
      const who = n.action && 'userId' in n.action ? n.action.userId : null;
      if (!n.action || n.resolved || who !== userId || (kind && n.action.kind !== kind)) return n;
      changed = true;
      return { ...n, resolved: label, read: true };
    });
    if (changed) ui.getState().setNotifications(this.notifications);
    // The toast for a resolved request or invite is stale now.
    const prefixes =
      kind === 'friendRequest' ? ['friend-'] : kind === 'partyInvite' ? ['party-'] : ['friend-', 'party-'];
    const s = ui.getState();
    for (const t of s.toasts)
      if (t.actions?.some((a) => a.id.endsWith(`:${userId}`) && prefixes.some((pre) => a.id.startsWith(pre))))
        s.dismissToast(t.id);
  }

  private onFriendRequest(m: TypedMessage): void {
    const from = m.from as { userId: string; name: string; tag: string } | undefined;
    if (!from) return;
    this.addNotification('friendRequest', `${from.name}#${from.tag} wants to be friends`, undefined, {
      kind: 'friendRequest',
      userId: from.userId,
    });
    ui.getState().pushToast({
      kind: 'social',
      title: `${from.name}#${from.tag} wants to be friends`,
      icon: '🤝',
      durationMs: 0,
      actions: [
        { id: `friend-accept:${from.userId}`, label: 'Accept' },
        { id: `friend-decline:${from.userId}`, label: 'Decline' },
      ],
    });
  }

  private onPartyInvite(m: TypedMessage): void {
    const from = m.from as { userId: string; name: string; tag: string } | undefined;
    const code = String(m.code ?? '');
    if (!code || !from) return;
    this.addNotification('invite', `${from.name} invited you to their party`, undefined, {
      kind: 'partyInvite',
      userId: from.userId,
      code,
    });
    ui.getState().pushToast({
      kind: 'social',
      title: `${from.name} invited you to their party`,
      icon: '💌',
      durationMs: 0,
      actions: [
        { id: `party-join:${code}`, label: 'Join' },
        { id: `party-decline:${from.userId}`, label: 'Not now' },
      ],
    });
  }

  /**
   * Handles a social toast button.
   *
   * @returns True when the action belonged to the account.
   */
  handleToastAction(actionId: string): boolean {
    const [kind, arg] = actionId.split(':') as [string, string | undefined];
    if ((kind === 'friend-accept' || kind === 'friend-decline') && arg) {
      void this.answerFriendRequest(arg, kind === 'friend-accept' ? 'accept' : 'decline');
      return true;
    }
    if (kind === 'gift-inbox') {
      ui.getState().openProfile('gifts');
      return true;
    }
    if (kind === 'wishlist-store') {
      ui.getState().openStore('today');
      return true;
    }
    if (kind === 'party-join' && arg) {
      // The notification for the same invite is answered too.
      const invite = this.notifications.find(
        (n) => !n.resolved && n.action?.kind === 'partyInvite' && 'code' in n.action && n.action.code === arg,
      );
      if (invite?.action && 'userId' in invite.action)
        this.resolveNotifications(invite.action.userId, 'Joined', 'partyInvite');
      void this.joinParty(arg);
      return true;
    }
    if (kind === 'party-decline' && arg) {
      this.resolveNotifications(arg, 'Declined', 'partyInvite');
      this.social.declineInvite(arg);
      return true;
    }
    if (this.clubs.handleToastAction(actionId)) return true;
    return kind === 'party-ignore';
  }

  /** Accepts, declines or cancels a friend request (sheet, notification or toast). */
  async answerFriendRequest(userId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    if (action !== 'cancel')
      this.resolveNotifications(userId, action === 'accept' ? 'Accepted' : 'Declined', 'friendRequest');
    await this.social.answer(userId, action);
  }

  /** Answers a party invite from the notifications panel. */
  async answerPartyInvite(userId: string, code: string, action: 'join' | 'decline'): Promise<void> {
    this.resolveNotifications(userId, action === 'join' ? 'Joined' : 'Declined', 'partyInvite');
    if (action === 'join') await this.joinParty(code);
    else this.social.declineInvite(userId);
  }

  /** Joins a friend's party from their row. */
  async joinFriend(userId: string): Promise<void> {
    if (await this.social.joinFriend(userId)) {
      ui.getState().pushToast({
        kind: 'social',
        title: 'Joined the party!',
        body: 'Hit Ready when you are.',
      });
      this.hooks.onJoinedParty?.();
    }
  }

  /** Sends a friend request by `name#1234`. */
  async addFriend(nameTag: string): Promise<void> {
    await this.social.request(nameTag);
  }

  private async refreshFriends(): Promise<void> {
    await this.social.refresh();
  }

  private colorsOf(userId: string): TumblerColors {
    const l = this.cards.get(userId);
    return l ? tumblerColors(l) : guessColors(userId);
  }

  /** Fetches (and caches) another player's look. */
  private async lookOf(userId: string): Promise<TumblerLoadout | null> {
    const cached = this.cards.get(userId);
    if (cached) return cached;
    try {
      const card = await this.api.profileCard(userId);
      if (!card.loadout) return null;
      const l = uiLoadoutToTumbler(apiLoadoutToUi('', card.loadout));
      this.cards.set(userId, l);
      return l;
    } catch {
      return null;
    }
  }

  private async refreshParty(): Promise<void> {
    try {
      this.applyParty((await this.api.party()).party);
    } catch (err) {
      console.warn('[account] party failed', err);
      this.applyParty(null);
    }
  }

  /** Pushes the party (or a solo slot) into the UI and the menu stage. */
  private applyParty(party: ApiParty | null): void {
    this.party = party;
    this.social.onParty(party);
    const s = ui.getState();
    const me = this.me;
    if (!me) return;
    this.hooks.onPartyRoster?.(party, me.userId);
    const members = party?.members ?? [
      { userId: me.userId, displayName: me.displayName, tag: me.tag, ready: true, joinedAt: 0 },
    ];
    const leaderId = party?.leaderId ?? me.userId;
    for (const id of this.soloMembers) if (!members.some((m) => m.userId === id)) this.soloMembers.delete(id);
    const state: PartyState = {
      code: party?.code ?? '',
      maxSize: party?.maxSize ?? 4,
      members: members.map((m) => ({
        id: m.userId,
        name: m.displayName,
        ...(m.tag ? { tag: m.tag } : {}),
        colors: m.userId === me.userId ? this.loadout.colors : this.colorsOf(m.userId),
        ready: m.userId === leaderId || m.ready,
        isLeader: m.userId === leaderId,
        isSelf: m.userId === me.userId,
        ...(this.soloMembers.has(m.userId) ? { playingSolo: true } : {}),
      })),
    };
    s.setParty(state);
    const self = members.find((m) => m.userId === me.userId);
    s.setLocalReady(leaderId === me.userId || !!self?.ready);
    if (
      party &&
      party.leaderId !== me.userId &&
      party.playlistId &&
      s.selectedPlaylist !== party.playlistId
    ) {
      if (s.playlists.some((p) => p.id === party.playlistId)) s.selectPlaylist(party.playlistId);
    }
    const others = members.filter((m) => m.userId !== me.userId);
    void Promise.all(
      others.map(async (m) => ({ userId: m.userId, loadout: await this.lookOf(m.userId) })),
    ).then((looks) => {
      if (this.party !== party) return;
      this.hooks.onPartyChanged(
        looks.filter((x): x is { userId: string; loadout: TumblerLoadout } => x.loadout !== null),
      );
      // Member colours arrive with their looks; repaint the slots.
      if (looks.some((x) => x.loadout)) {
        this.social.publish();
        const cur = ui.getState().party;
        if (cur)
          ui.getState().setParty({
            ...cur,
            members: cur.members.map((m) => (m.isSelf ? m : { ...m, colors: this.colorsOf(m.id) })),
          });
      }
    });
  }

  /** Makes sure a party (and invite code) exists — opening the friends sheet creates one. */
  async ensureParty(): Promise<ApiParty | null> {
    if (this.party) return this.party;
    try {
      const { party } = await this.api.createParty();
      this.applyParty(party);
      return party;
    } catch (err) {
      console.warn('[account] create party failed', err);
      return null;
    }
  }

  /** Joins a party by invite code (deep link or toast). */
  async joinParty(code: string): Promise<boolean> {
    try {
      this.adoptJoinedParty((await this.api.joinParty(code.toUpperCase())).party);
      return true;
    } catch (err) {
      ui.getState().showDialog({
        id: 'party-join-failed',
        kind: 'error',
        title: "Couldn't join that party",
        body: describe(err),
        code: 'E-PARTY',
      });
      return false;
    }
  }

  /** Shows a party the player just joined (by code, link or invite) and welcomes them. */
  adoptJoinedParty(party: ApiParty): void {
    this.applyParty(party);
    const leader = party.members.find((m) => m.userId === party.leaderId);
    ui.getState().pushToast({
      kind: 'social',
      title: `Joined ${leader?.displayName ?? 'the'}'s party!`,
      body: 'Hit Ready when you are.',
      icon: '🎉',
    });
    this.hooks.onJoinedParty?.();
  }

  /** Leaves the party. */
  async leaveParty(): Promise<void> {
    try {
      await this.api.leaveParty();
    } catch (err) {
      console.warn('[account] leave party failed', err);
    }
    this.applyParty(null);
  }

  /** Kicks a member (leader). */
  async kick(userId: string): Promise<void> {
    try {
      this.applyParty((await this.api.kickFromParty(userId)).party);
    } catch (err) {
      ui.getState().pushToast({ kind: 'error', title: "Couldn't kick", body: describe(err) });
    }
  }

  /** Hands party leadership to a member (leader); everyone else follows via `party_update`. */
  async promote(userId: string): Promise<void> {
    try {
      this.applyParty((await this.api.promotePartyMember(userId)).party);
    } catch (err) {
      ui.getState().pushToast({ kind: 'error', title: "Couldn't hand over leadership", body: describe(err) });
    }
  }

  /** Invites a friend (creates the party if needed). */
  async invite(friendId: string): Promise<void> {
    try {
      this.applyParty((await this.api.inviteToParty(friendId)).party);
      ui.getState().pushToast({ kind: 'social', title: 'Invite sent!', icon: '💌' });
    } catch (err) {
      ui.getState().pushToast({ kind: 'warning', title: "Couldn't invite", body: describe(err), icon: '💌' });
    }
  }

  /**
   * Member ready toggle. The button flips at once; a refusal puts it back to
   * the party's last known state, and every `party_update` reconciles it.
   */
  async setReady(ready: boolean): Promise<void> {
    if (!this.party) {
      ui.getState().setLocalReady(false);
      return;
    }
    try {
      this.applyParty((await this.api.setReady(ready)).party);
    } catch (err) {
      this.applyParty(this.party);
      ui.getState().pushToast({ kind: 'error', title: "Couldn't change ready", body: describe(err) });
    }
  }

  /**
   * Leader: the matchmaker accepted the party's ticket, so the ready votes
   * are spent now (members ready up again for the next show).
   */
  async confirmQueued(): Promise<void> {
    if (!this.inParty) return;
    try {
      const { party } = await this.api.partyQueued();
      if (party) this.applyParty(party);
    } catch (err) {
      // The queue is running either way; stale votes only mean members skip one Ready.
      console.warn('[account] queued confirm failed', err);
    }
  }

  /** Tells the party this player started (or finished) a solo show. No-op outside a party. */
  async announceSolo(playing: boolean): Promise<void> {
    if (!this.inParty) return;
    try {
      const { party } = await this.api.partySolo(playing);
      if (party) this.applyParty(party);
    } catch (err) {
      console.warn('[account] solo notice failed', err);
    }
  }

  /** True when other people are in the party. */
  get inParty(): boolean {
    return (this.party?.members.length ?? 0) > 1;
  }

  /**
   * Waits for a finished show's reward from the API (the game server's
   * forward was late or lost) and shows it on the rewards screen, or says it
   * will appear on the profile. A newer wait cancels this one.
   *
   * @param matchId - The show.
   */
  async awaitShowReward(matchId: string): Promise<RewardPollResult> {
    const id = ++this.rewardWait;
    ui.getState().setRewardsPending('arriving');
    const result = await pollShowReward({
      fetch: async () => (await this.api.matchReward(matchId)).reward,
      sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
      cancelled: () => id !== this.rewardWait,
    });
    if (result.status === 'cancelled') return result;
    if (result.status === 'ready') ui.getState().setRewards(this.rewardsSummary(result.reward));
    else ui.getState().setRewardsPending('deferred');
    void this.refreshProgress();
    return result;
  }

  /** Stops any reward wait (a new show started). */
  cancelRewardWait(): void {
    this.rewardWait++;
  }

  /** Leader picks the party's playlist. */
  async setPlaylist(playlistId: string): Promise<void> {
    const p = this.party;
    if (!p || p.leaderId !== this.userId || p.members.length < 2 || p.playlistId === playlistId) return;
    try {
      this.applyParty((await this.api.setPartyPlaylist(playlistId)).party);
    } catch (err) {
      ui.getState().pushToast({
        kind: 'warning',
        title: "That show doesn't fit this party",
        body: describe(err),
        icon: '🎪',
      });
    }
  }

  /** True when the local player leads (or is solo). */
  get isLeader(): boolean {
    return !this.party || this.party.leaderId === this.userId;
  }

  /** Tears down sockets and subscriptions. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.social.dispose();
    this.clubs.dispose();
    this.realtime.stop();
  }
}
