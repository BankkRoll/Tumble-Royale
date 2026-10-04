/**
 * Limited-time events: themed windows with their own challenges and a points
 * track of tiered rewards. Data only; the account API is the only place
 * progress is recorded and rewards are paid.
 *
 * Responsibilities:
 * - The event schema and the bundled events ({@link LIVE_EVENTS}), validated
 *   at load: a bounded UTC window, featured playlists that exist, unique
 *   challenge ids, tiers numbered 1..n with strictly rising point thresholds,
 *   at most one reward of each kind per tier (each is paid under one ledger
 *   ref), cosmetics that exist and are `event`-source, and a currency total
 *   within {@link EVENT_CURRENCY_BUDGET}. Across events: unique ids, windows
 *   that never overlap, and each event cosmetic on exactly one track.
 * - Pure rules shared by the API and the offline client: an event's phase at
 *   an instant ({@link eventPhase}), how an operator override replaces the
 *   bundled window ({@link mergeEventWindow}), points for one show
 *   ({@link eventShowPoints}), what a show adds to each challenge
 *   ({@link eventChallengeIncrement}) and how many tiers a points total reaches.
 *
 * Windows are half-open like every live-ops window: live from `startsAt`
 * inclusive to `endsAt` exclusive. Event, challenge and tier ids are stored
 * per player and must never be renamed.
 */
import { windowPhase } from '@tumble/shared/liveops';
import { z } from 'zod';
import { getCosmetic } from '../cosmetics/index.ts';
import { PLAYLISTS } from '../shows/index.ts';
import { THEME_IDS } from '../themes/index.ts';
import { GrantSchema, type Grant } from './achievements.ts';

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/** Show stats an event challenge can count. */
export const EventMetricSchema = z.enum([
  'showsPlayed',
  'roundsQualified',
  'racesQualified',
  'survivalsQualified',
  'teamRoundsWon',
  'huntRoundsQualified',
  'logicRoundsQualified',
  'finalsReached',
  'crowns',
  'topTenFinishes',
]);

/** An event challenge metric. */
export type EventMetric = z.output<typeof EventMetricSchema>;

/** Icons the event tile and screen may use (a subset of the UI icon set). */
export const EventIconSchema = z.enum(['star', 'gift', 'fire', 'calendar', 'crown', 'party', 'swirl']);

/** One event challenge. Claiming it pays event points and, optionally, XP. */
export const EventChallengeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Player-facing text; `{n}` is replaced by the target. */
  description: z.string().min(4).max(80),
  metric: EventMetricSchema,
  target: z.number().int().positive(),
  /** Only shows in the event's featured playlists count. */
  eventPlaylistsOnly: z.boolean().default(false),
  /** Event points paid on claim. */
  points: z.number().int().positive(),
  /** Account (and pass) XP paid on claim. */
  rewardXp: z.number().int().min(0).default(0),
});

/** A validated event challenge. */
export type EventChallenge = z.output<typeof EventChallengeSchema>;

/** One step on the points track. */
export const EventTierSchema = z.object({
  /** 1-based, in order. */
  tier: z.number().int().positive(),
  /** Points total that unlocks the tier. */
  points: z.number().int().positive(),
  rewards: z.array(GrantSchema).min(1).max(4),
});

/** A validated tier. */
export type EventTier = z.output<typeof EventTierSchema>;

/** Points one show is worth during the event. */
export const EventPointsRulesSchema = z.object({
  /** Every show played to the end or quit. */
  perShow: z.number().int().min(0),
  perQualifiedRound: z.number().int().min(0),
  finalReached: z.number().int().min(0),
  crown: z.number().int().min(0),
  /** Applied to the whole show when it was in a featured playlist. */
  eventPlaylistMultiplier: z.number().min(1).max(5),
});

/** Validated point rules. */
export type EventPointsRules = z.output<typeof EventPointsRulesSchema>;

/**
 * Currency an event may hand out in total (tiers plus challenges), so a run
 * of events cannot quietly inflate the economy. See docs/design/ECONOMY.md §5.
 */
export const EVENT_CURRENCY_BUDGET = {
  gumballs: 2500,
  gems: 60,
  crownShards: 12,
  xp: 30_000,
} as const;

/** Longest window an event may be authored with. */
export const MAX_EVENT_DAYS = 45;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Instant = z.iso.datetime({ offset: true });

/** Currency and XP an event pays in total: every tier plus challenge XP (cosmetics not counted). */
function rewardTotals(
  tiers: readonly { rewards: readonly Grant[] }[],
  challenges: readonly { rewardXp: number }[],
): Record<keyof typeof EVENT_CURRENCY_BUDGET, number> {
  const out = { gumballs: 0, gems: 0, crownShards: 0, xp: 0 };
  for (const g of tiers.flatMap((t) => t.rewards)) if (g.kind !== 'cosmetic') out[g.kind] += g.amount;
  for (const c of challenges) out.xp += c.rewardXp;
  return out;
}

/** One limited-time event. */
export const LiveEventSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(2).max(40),
    description: z.string().min(4).max(200),
    /** Theme whose palette the event screen borrows. */
    themeId: z.string().refine((t) => (THEME_IDS as readonly string[]).includes(t), 'unknown theme'),
    /** Gradient for the menu tile and the event screen header. */
    art: z.tuple([Hex, Hex]),
    icon: EventIconSchema,
    /** Bundled window (operators can override it). */
    startsAt: Instant,
    endsAt: Instant,
    /** Playlists the event spotlights; shows in them earn more points. */
    playlistIds: z.array(z.string()).min(1),
    points: EventPointsRulesSchema,
    challenges: z.array(EventChallengeSchema).min(1).max(12),
    tiers: z.array(EventTierSchema).min(1).max(30),
  })
  .superRefine((e, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message: `${e.id}: ${message}` });
    const start = Date.parse(e.startsAt);
    const end = Date.parse(e.endsAt);
    if (end <= start) issue('endsAt must be after startsAt');
    if (end - start > MAX_EVENT_DAYS * 86_400_000) issue(`window longer than ${MAX_EVENT_DAYS} days`);
    for (const id of e.playlistIds) if (!PLAYLISTS.some((p) => p.id === id)) issue(`unknown playlist ${id}`);
    const ids = new Set<string>();
    for (const c of e.challenges) {
      if (ids.has(c.id)) issue(`duplicate challenge ${c.id}`);
      ids.add(c.id);
    }
    e.tiers.forEach((t, i) => {
      if (t.tier !== i + 1) issue(`tier ${t.tier} out of order (expected ${i + 1})`);
      const prev = e.tiers[i - 1];
      if (prev && t.points <= prev.points) issue(`tier ${t.tier} needs more points than tier ${prev.tier}`);
      const kinds = new Set<string>();
      for (const r of t.rewards) {
        // A cosmetic is paid by inventory row, currencies by one ledger ref per tier.
        const key = r.kind === 'cosmetic' ? `cosmetic:${r.itemId}` : r.kind;
        if (kinds.has(key)) issue(`tier ${t.tier} repeats a ${r.kind} reward`);
        kinds.add(key);
        if (r.kind !== 'cosmetic') continue;
        const item = getCosmetic(r.itemId);
        if (!item) issue(`tier ${t.tier}: unknown cosmetic ${r.itemId}`);
        else if (item.source !== 'event') issue(`tier ${t.tier}: ${r.itemId} is not an event cosmetic`);
      }
    });
    const totals = rewardTotals(e.tiers, e.challenges);
    for (const [k, cap] of Object.entries(EVENT_CURRENCY_BUDGET) as [keyof typeof totals, number][])
      if (totals[k] > cap) issue(`${k} total ${totals[k]} is over the per-event budget of ${cap}`);
  });

/** A validated event. */
export type LiveEvent = z.output<typeof LiveEventSchema>;

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

const xp = (amount: number): Grant => ({ kind: 'xp', amount });
const gumballs = (amount: number): Grant => ({ kind: 'gumballs', amount });
const gems = (amount: number): Grant => ({ kind: 'gems', amount });
const shards = (amount: number): Grant => ({ kind: 'crownShards', amount });
const item = (itemId: string): Grant => ({ kind: 'cosmetic', itemId });

/** Checks that apply across events. */
function checkCatalogue(list: readonly LiveEvent[], ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  const rewarded = new Map<string, string>();
  for (const e of list) {
    if (ids.has(e.id)) ctx.addIssue({ code: 'custom', message: `duplicate event id ${e.id}` });
    ids.add(e.id);
    for (const t of e.tiers)
      for (const r of t.rewards) {
        if (r.kind !== 'cosmetic') continue;
        const other = rewarded.get(r.itemId);
        if (other) ctx.addIssue({ code: 'custom', message: `${r.itemId} is on both ${other} and ${e.id}` });
        rewarded.set(r.itemId, e.id);
      }
  }
  const byStart = [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1]!;
    const next = byStart[i]!;
    if (Date.parse(next.startsAt) < Date.parse(prev.endsAt))
      ctx.addIssue({ code: 'custom', message: `${next.id} overlaps ${prev.id}` });
  }
}

/** Every bundled event, earliest first. */
export const LIVE_EVENTS: readonly LiveEvent[] = z
  .array(LiveEventSchema)
  .superRefine(checkCatalogue)
  .parse([
    {
      id: 'moonlit-mischief',
      name: 'Moonlit Mischief',
      description:
        'The fairground stays open after dark. Tumble through Chaos Mode for double points and earn a spooky-sweet wardrobe before the moon sets.',
      themeId: 'sunset',
      art: ['#5b2a86', '#ff8a3d'],
      icon: 'swirl',
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-11-02T00:00:00Z',
      playlistIds: ['chaos-mode'],
      points: { perShow: 20, perQualifiedRound: 10, finalReached: 25, crown: 60, eventPlaylistMultiplier: 2 },
      challenges: [
        {
          id: 'mm-play-event-10',
          description: 'Play {n} Chaos Mode shows',
          metric: 'showsPlayed',
          target: 10,
          eventPlaylistsOnly: true,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'mm-play-25',
          description: 'Play {n} shows during the event',
          metric: 'showsPlayed',
          target: 25,
          points: 200,
          rewardXp: 2000,
        },
        {
          id: 'mm-survive-15',
          description: 'Survive {n} survival rounds',
          metric: 'survivalsQualified',
          target: 15,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'mm-race-20',
          description: 'Qualify from {n} races',
          metric: 'racesQualified',
          target: 20,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'mm-final-event-5',
          description: 'Reach {n} finals in Chaos Mode',
          metric: 'finalsReached',
          target: 5,
          eventPlaylistsOnly: true,
          points: 200,
          rewardXp: 2500,
        },
        {
          id: 'mm-crown-event-1',
          description: 'Win a Crown in Chaos Mode',
          metric: 'crowns',
          target: 1,
          eventPlaylistsOnly: true,
          points: 300,
          rewardXp: 3000,
        },
      ],
      tiers: [
        { tier: 1, points: 100, rewards: [gumballs(150)] },
        { tier: 2, points: 250, rewards: [item('color.moonlit-pumpkin')] },
        { tier: 3, points: 450, rewards: [xp(2500)] },
        { tier: 4, points: 700, rewards: [gumballs(300)] },
        { tier: 5, points: 1000, rewards: [item('pattern.bat-zigzag')] },
        { tier: 6, points: 1350, rewards: [gems(20), shards(3)] },
        { tier: 7, points: 1750, rewards: [item('nameplate.moonlit')] },
        { tier: 8, points: 2200, rewards: [gumballs(500), xp(3000)] },
        { tier: 9, points: 2700, rewards: [item('banner.moonlit')] },
        { tier: 10, points: 3250, rewards: [item('headwear.mischief-horns'), shards(4)] },
        { tier: 11, points: 3850, rewards: [gumballs(750), gems(20)] },
        { tier: 12, points: 4500, rewards: [item('trail.wisp'), gems(20)] },
      ],
    },
    {
      id: 'frostbite-frolic',
      name: 'Frostbite Frolic',
      description:
        'Snow has buried the obstacle course. Squad up in Duos and Squads for double points, win team rounds and unwrap a frosty set before the thaw.',
      themeId: 'frosty',
      art: ['#2b4c9b', '#7cc8ff'],
      icon: 'gift',
      startsAt: '2026-12-11T00:00:00Z',
      endsAt: '2027-01-08T00:00:00Z',
      playlistIds: ['duos', 'squads'],
      points: { perShow: 20, perQualifiedRound: 10, finalReached: 25, crown: 60, eventPlaylistMultiplier: 2 },
      challenges: [
        {
          id: 'ff-play-team-10',
          description: 'Play {n} Duos or Squads shows',
          metric: 'showsPlayed',
          target: 10,
          eventPlaylistsOnly: true,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'ff-team-15',
          description: 'Win {n} team rounds',
          metric: 'teamRoundsWon',
          target: 15,
          points: 200,
          rewardXp: 2000,
        },
        {
          id: 'ff-qualify-40',
          description: 'Qualify from {n} rounds',
          metric: 'roundsQualified',
          target: 40,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'ff-hunt-8',
          description: 'Qualify from {n} hunt rounds',
          metric: 'huntRoundsQualified',
          target: 8,
          points: 150,
          rewardXp: 1500,
        },
        {
          id: 'ff-top10-event-5',
          description: 'Finish in the top 10 in Duos or Squads {n} times',
          metric: 'topTenFinishes',
          target: 5,
          eventPlaylistsOnly: true,
          points: 200,
          rewardXp: 2500,
        },
        {
          id: 'ff-crown-event-1',
          description: 'Win a Crown in Duos or Squads',
          metric: 'crowns',
          target: 1,
          eventPlaylistsOnly: true,
          points: 300,
          rewardXp: 3000,
        },
      ],
      tiers: [
        { tier: 1, points: 100, rewards: [gumballs(150)] },
        { tier: 2, points: 250, rewards: [item('color.glacier-glow')] },
        { tier: 3, points: 450, rewards: [xp(2500)] },
        { tier: 4, points: 700, rewards: [gumballs(300)] },
        { tier: 5, points: 1000, rewards: [item('pattern.snow-diamonds')] },
        { tier: 6, points: 1350, rewards: [gems(20), shards(3)] },
        { tier: 7, points: 1750, rewards: [item('nameplate.frostbite')] },
        { tier: 8, points: 2200, rewards: [gumballs(500), xp(3000)] },
        { tier: 9, points: 2700, rewards: [item('headwear.frost-beanie')] },
        { tier: 10, points: 3250, rewards: [item('banner.frostbite'), shards(4)] },
        { tier: 11, points: 3850, rewards: [gumballs(750), gems(20)] },
        { tier: 12, points: 4500, rewards: [item('footsteps.jingle-steps'), gems(20)] },
      ],
    },
  ]);

/**
 * Looks up a bundled event.
 *
 * @param id - Event id.
 * @returns The event, or undefined when unknown.
 */
export function getLiveEvent(id: string): LiveEvent | undefined {
  return LIVE_EVENTS.find((e) => e.id === id);
}

// -----------------------------------------------------------------------------
// Windows
// -----------------------------------------------------------------------------

/** `upcoming` (announced), `live` (counting shows) or `ended`. */
export type EventPhase = 'upcoming' | 'live' | 'ended';

/** An event's effective window and switch. */
export interface EventWindow {
  /** ISO start (inclusive). */
  startsAt: string;
  /** ISO end (exclusive). */
  endsAt: string;
  /** Off: the event is withdrawn; it counts nothing and pays nothing. */
  enabled: boolean;
}

/** An operator override for one bundled event (API `event_overrides`). */
export interface EventOverride extends EventWindow {
  id: string;
}

/**
 * The effective window: an override replaces the bundled one wholesale.
 *
 * @param event - Bundled event.
 * @param override - Operator override, if any.
 */
export function mergeEventWindow(
  event: Pick<LiveEvent, 'startsAt' | 'endsAt'>,
  override: EventOverride | null | undefined,
): EventWindow {
  if (override) return { startsAt: override.startsAt, endsAt: override.endsAt, enabled: override.enabled };
  return { startsAt: event.startsAt, endsAt: event.endsAt, enabled: true };
}

/**
 * The phase of a window at an instant.
 *
 * @param w - Window.
 * @param nowMs - The instant (epoch ms).
 * @example
 * eventPhase({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' },
 *   Date.parse('2026-11-02T00:00:00Z')); // 'ended'
 */
export function eventPhase(w: Pick<EventWindow, 'startsAt' | 'endsAt'>, nowMs: number): EventPhase {
  const p = windowPhase(Date.parse(w.startsAt), Date.parse(w.endsAt), nowMs);
  return p === 'before' ? 'upcoming' : p === 'inside' ? 'live' : 'ended';
}

// -----------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------

/** What one player's show contributes to an event. */
export interface EventShowFacts {
  playlistId: string;
  /** Rounds qualified from, the final included. */
  roundsQualified: number;
  /** Rounds qualified from, by round type (`race`, `survival`, `team`, `hunt`, `logic`, `final`). */
  qualifiedByType: Readonly<Partial<Record<string, number>>>;
  reachedFinal: boolean;
  crowned: boolean;
  placement: number;
}

/**
 * Whether a playlist is one the event spotlights.
 *
 * @param event - The event.
 * @param playlistId - Playlist the show was played in.
 */
export function inEventPlaylist(event: Pick<LiveEvent, 'playlistIds'>, playlistId: string): boolean {
  return event.playlistIds.includes(playlistId);
}

/**
 * Points one show earns.
 *
 * @param event - The event (its point rules and featured playlists).
 * @param facts - The show.
 * @returns A non-negative integer.
 * @example
 * // 20 for playing, 2 rounds × 10, doubled in Chaos Mode:
 * eventShowPoints(getLiveEvent('moonlit-mischief')!, { playlistId: 'chaos-mode', roundsQualified: 2, ... }); // 80
 */
export function eventShowPoints(
  event: Pick<LiveEvent, 'points' | 'playlistIds'>,
  facts: EventShowFacts,
): number {
  const r = event.points;
  const base =
    r.perShow +
    r.perQualifiedRound * Math.max(0, facts.roundsQualified) +
    (facts.reachedFinal ? r.finalReached : 0) +
    (facts.crowned ? r.crown : 0);
  return Math.round(base * (inEventPlaylist(event, facts.playlistId) ? r.eventPlaylistMultiplier : 1));
}

/**
 * Each event metric's value for one show.
 *
 * @param facts - The show.
 */
export function eventShowMetrics(facts: EventShowFacts): Record<EventMetric, number> {
  const q = (type: string): number => facts.qualifiedByType[type] ?? 0;
  return {
    showsPlayed: 1,
    roundsQualified: facts.roundsQualified,
    racesQualified: q('race'),
    survivalsQualified: q('survival'),
    teamRoundsWon: q('team'),
    huntRoundsQualified: q('hunt'),
    logicRoundsQualified: q('logic'),
    finalsReached: facts.reachedFinal ? 1 : 0,
    crowns: facts.crowned ? 1 : 0,
    topTenFinishes: facts.placement <= 10 ? 1 : 0,
  };
}

/**
 * What a show adds to one challenge.
 *
 * @param event - The event (featured playlists).
 * @param challenge - The challenge.
 * @param facts - The show.
 */
export function eventChallengeIncrement(
  event: Pick<LiveEvent, 'playlistIds'>,
  challenge: Pick<EventChallenge, 'metric' | 'eventPlaylistsOnly'>,
  facts: EventShowFacts,
): number {
  if (challenge.eventPlaylistsOnly && !inEventPlaylist(event, facts.playlistId)) return 0;
  return eventShowMetrics(facts)[challenge.metric];
}

/**
 * Tiers a points total reaches.
 *
 * @param event - The event.
 * @param points - Points total.
 * @returns 0..tiers.length.
 */
export function eventTiersReached(event: Pick<LiveEvent, 'tiers'>, points: number): number {
  let n = 0;
  for (const t of event.tiers) if (points >= t.points) n = t.tier;
  return n;
}

/**
 * Player-facing challenge text.
 *
 * @param c - Challenge.
 * @example
 * eventChallengeTitle({ description: 'Play {n} shows', target: 25 }); // 'Play 25 shows'
 */
export function eventChallengeTitle(c: Pick<EventChallenge, 'description' | 'target'>): string {
  return c.description.replace('{n}', c.target.toLocaleString('en-US'));
}

/**
 * Everything an event can pay in currency and XP (tiers plus challenge XP).
 *
 * @param event - The event.
 */
export function eventRewardTotals(event: LiveEvent): Record<keyof typeof EVENT_CURRENCY_BUDGET, number> {
  return rewardTotals(event.tiers, event.challenges);
}
