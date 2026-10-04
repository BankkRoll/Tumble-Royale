/**
 * The achievement catalogue: lifetime goals tracked by the account API from
 * reported shows, login claims and inventory, never from the client.
 *
 * Responsibilities:
 * - The metrics achievements count and how each one accumulates
 *   ({@link ACHIEVEMENT_METRIC_KIND}).
 * - Every achievement (tiered series plus hidden one-offs), validated at load:
 *   unique ids, rising targets within a series, non-empty rewards, cosmetic
 *   rewards that exist and are `challenge`-source items.
 * - The reward shape shared with the login streak ({@link GrantSchema}).
 *
 * Achievement ids are stored per player and must never be renamed.
 */
import { z } from 'zod';
import { getCosmetic } from '../cosmetics/index.ts';

/** One thing granted by an achievement or a login-streak day. */
export const GrantSchema = z.discriminatedUnion('kind', [
  /** Account XP (also counts as season pass XP online). */
  z.object({ kind: z.literal('xp'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('gumballs'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('gems'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('crownShards'), amount: z.number().int().positive() }),
  z.object({ kind: z.literal('cosmetic'), itemId: z.string().min(1) }),
]);

/** A validated grant. */
export type Grant = z.output<typeof GrantSchema>;

/**
 * Lifetime stats achievements count. Most are summed per show; see
 * {@link ACHIEVEMENT_METRIC_KIND} for the ones that are not.
 */
export const AchievementMetricSchema = z.enum([
  'showsPlayed',
  'crowns',
  'roundsQualified',
  'racesQualified',
  'survivalsQualified',
  'teamRoundsWon',
  'huntRoundsQualified',
  'logicRoundsQualified',
  'finalsReached',
  'grabs',
  'emotes',
  'partyShows',
  /** Shows finished in second place. */
  'runnerUps',
  'bestWinStreak',
  'bestLoginStreak',
  'mostGrabsInShow',
  'cosmeticsOwned',
]);

/** An achievement metric id. */
export type AchievementMetric = z.output<typeof AchievementMetricSchema>;

/**
 * How a metric accumulates:
 * - `sum`: each show adds to the lifetime total;
 * - `max`: the best value ever seen (a streak, a single-show record);
 * - `gauge`: re-read from current state (items owned), never stored as history.
 */
export const ACHIEVEMENT_METRIC_KIND: Readonly<Record<AchievementMetric, 'sum' | 'max' | 'gauge'>> = {
  showsPlayed: 'sum',
  crowns: 'sum',
  roundsQualified: 'sum',
  racesQualified: 'sum',
  survivalsQualified: 'sum',
  teamRoundsWon: 'sum',
  huntRoundsQualified: 'sum',
  logicRoundsQualified: 'sum',
  finalsReached: 'sum',
  grabs: 'sum',
  emotes: 'sum',
  partyShows: 'sum',
  runnerUps: 'sum',
  bestWinStreak: 'max',
  bestLoginStreak: 'max',
  mostGrabsInShow: 'max',
  cosmeticsOwned: 'gauge',
};

/** Groups on the achievements screen, in display order. */
export const ACHIEVEMENT_CATEGORIES = [
  'shows',
  'crowns',
  'rounds',
  'survival',
  'teams',
  'finals',
  'grabs',
  'collection',
  'social',
  'streaks',
] as const;

/** An achievement category. */
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

/** Display names for {@link ACHIEVEMENT_CATEGORIES}. */
export const ACHIEVEMENT_CATEGORY_NAMES: Readonly<Record<AchievementCategory, string>> = {
  shows: 'Shows',
  crowns: 'Crowns',
  rounds: 'Rounds',
  survival: 'Survival',
  teams: 'Teamwork',
  finals: 'Finals',
  grabs: 'Grabs',
  collection: 'Collection',
  social: 'Social',
  streaks: 'Streaks',
};

/** One achievement. */
export const AchievementDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(ACHIEVEMENT_CATEGORIES),
  /** Full title, including the tier numeral for series. */
  title: z.string().min(1),
  /** What to do; `{n}` is replaced by the target. */
  description: z.string().min(1),
  metric: AchievementMetricSchema,
  target: z.number().int().positive(),
  /** Hidden achievements show as "???" until unlocked. */
  hidden: z.boolean().default(false),
  /** Tier within a series (e.g. Crown Collector II of IV). */
  series: z
    .object({ id: z.string(), tier: z.number().int().positive(), tiers: z.number().int().positive() })
    .optional(),
  rewards: z.array(GrantSchema).min(1),
});

/** A validated achievement. */
export type AchievementDef = z.output<typeof AchievementDefSchema>;

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

const xp = (amount: number): Grant => ({ kind: 'xp', amount });
const gumballs = (amount: number): Grant => ({ kind: 'gumballs', amount });
const gems = (amount: number): Grant => ({ kind: 'gems', amount });
const shards = (amount: number): Grant => ({ kind: 'crownShards', amount });
const item = (itemId: string): Grant => ({ kind: 'cosmetic', itemId });

/** A tiered series: one achievement per `[target, rewards]` step, ids `<id>-<tier>`. */
function series(
  id: string,
  category: AchievementCategory,
  title: string,
  description: string,
  metric: AchievementMetric,
  steps: readonly (readonly [target: number, rewards: Grant[]])[],
) {
  return steps.map(([target, rewards], i) => ({
    id: `${id}-${i + 1}`,
    category,
    title: `${title} ${NUMERALS[i]}`,
    description,
    metric,
    target,
    series: { id, tier: i + 1, tiers: steps.length },
    rewards,
  }));
}

/** A hidden one-off. */
function secret(
  id: string,
  category: AchievementCategory,
  title: string,
  description: string,
  metric: AchievementMetric,
  target: number,
  rewards: Grant[],
) {
  return { id, category, title, description, metric, target, hidden: true, rewards };
}

/** Every achievement. */
export const ACHIEVEMENTS: readonly AchievementDef[] = z
  .array(AchievementDefSchema)
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    const items = new Set<string>();
    const lastTarget = new Map<string, number>();
    for (const a of list) {
      if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate achievement id ${a.id}` });
      ids.add(a.id);
      if (a.series) {
        const prev = lastTarget.get(a.series.id);
        if (prev !== undefined && a.target <= prev)
          ctx.addIssue({ code: 'custom', message: `${a.id}: series targets must rise` });
        lastTarget.set(a.series.id, a.target);
      }
      for (const r of a.rewards) {
        if (r.kind !== 'cosmetic') continue;
        const c = getCosmetic(r.itemId);
        if (!c) ctx.addIssue({ code: 'custom', message: `${a.id}: unknown cosmetic ${r.itemId}` });
        else if (c.source !== 'challenge')
          ctx.addIssue({ code: 'custom', message: `${a.id}: ${r.itemId} is not a challenge reward` });
        if (items.has(r.itemId))
          ctx.addIssue({ code: 'custom', message: `${r.itemId} is granted by two achievements` });
        items.add(r.itemId);
      }
    }
  })
  .parse([
    ...series('showtime', 'shows', 'Showtime', 'Play {n} shows', 'showsPlayed', [
      [1, [xp(250), item('trail.bubbles')]],
      [10, [xp(1000), gumballs(100)]],
      [50, [xp(3000), gumballs(250)]],
      [250, [xp(8000), gumballs(500)]],
      [1000, [xp(15000), gems(50)]],
    ]),
    ...series('crown-collector', 'crowns', 'Crown Collector', 'Win {n} Crowns', 'crowns', [
      [1, [xp(1000), gumballs(200), item('upper.medal')]],
      [5, [xp(3000), shards(5)]],
      [25, [xp(8000), gems(25)]],
      [100, [xp(15000), gems(50)]],
    ]),
    ...series('speed-demon', 'rounds', 'Speed Demon', 'Qualify from {n} races', 'racesQualified', [
      [10, [xp(500), gumballs(50)]],
      [100, [xp(2500), item('color.tangerine')]],
      [500, [xp(8000), gumballs(500)]],
    ]),
    ...series(
      'treasure-hunter',
      'rounds',
      'Treasure Hunter',
      'Qualify from {n} hunt rounds',
      'huntRoundsQualified',
      [
        [10, [xp(750), gumballs(75)]],
        [100, [xp(4000), gumballs(300)]],
      ],
    ),
    ...series('big-brain', 'rounds', 'Big Brain', 'Qualify from {n} logic rounds', 'logicRoundsQualified', [
      [10, [xp(750), gumballs(75)]],
      [100, [xp(4000), gumballs(300)]],
    ]),
    ...series(
      'still-standing',
      'survival',
      'Still Standing',
      'Survive {n} survival rounds',
      'survivalsQualified',
      [
        [10, [xp(500), gumballs(50)]],
        [100, [xp(2500), item('back.shell')]],
        [500, [xp(8000), gumballs(500)]],
      ],
    ),
    ...series('team-spirit', 'teams', 'Team Spirit', 'Win {n} team rounds', 'teamRoundsWon', [
      [10, [xp(500), gumballs(50)]],
      [100, [xp(2500), item('pattern.spots')]],
      [300, [xp(8000), gumballs(500)]],
    ]),
    ...series('finalist', 'finals', 'Finalist', 'Reach {n} finals', 'finalsReached', [
      [1, [xp(500), gumballs(100)]],
      [10, [xp(2000), item('headwear.chef')]],
      [50, [xp(6000), shards(5)]],
      [200, [xp(12000), gems(25)]],
    ]),
    ...series('grabby-hands', 'grabs', 'Grabby Hands', 'Grab other Tumblers {n} times', 'grabs', [
      [100, [xp(500), gumballs(50)]],
      [1000, [xp(3000), item('face.freckles')]],
      [10000, [xp(10000), gumballs(750)]],
    ]),
    ...series('wardrobe', 'collection', 'Wardrobe', 'Own {n} cosmetics', 'cosmeticsOwned', [
      [40, [xp(500), gumballs(100)]],
      [75, [xp(1500), gumballs(250)]],
      [150, [xp(4000), gems(25)]],
      [300, [xp(10000), gems(50)]],
    ]),
    ...series('party-animal', 'social', 'Party Animal', 'Play {n} shows with a party', 'partyShows', [
      [1, [xp(500), item('headwear.flower')]],
      [25, [xp(2500), gumballs(250)]],
      [100, [xp(6000), gumballs(500)]],
    ]),
    ...series('on-a-roll', 'streaks', 'On a Roll', 'Win {n} Crowns in a row', 'bestWinStreak', [
      [2, [xp(2000), gumballs(200)]],
      [3, [xp(5000), shards(5)]],
      [5, [xp(12000), gems(50)]],
    ]),
    ...series('regular', 'streaks', 'Regular', 'Claim a daily login {n} days in a row', 'bestLoginStreak', [
      [7, [xp(1000), gumballs(150)]],
      [30, [xp(4000), gems(25)]],
      [100, [xp(10000), gems(50)]],
    ]),
    secret('so-close', 'crowns', 'So Close', 'Finish a show in second place', 'runnerUps', 1, [
      xp(500),
      gumballs(100),
    ]),
    secret(
      'clingy',
      'grabs',
      'Clingy',
      'Grab other Tumblers {n} times in a single show',
      'mostGrabsInShow',
      40,
      [xp(1500), gumballs(150)],
    ),
    secret('dance-machine', 'social', 'Dance Machine', 'Emote {n} times', 'emotes', 500, [
      xp(2000),
      item('emote.jumping-jacks'),
    ]),
  ]);

/** Achievements by id. */
export const ACHIEVEMENTS_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(
  ACHIEVEMENTS.map((a) => [a.id, a]),
);

/**
 * Player-facing description with the target filled in.
 *
 * @param a - Achievement.
 * @example
 * achievementDescription(ACHIEVEMENTS_BY_ID.get('crown-collector-2')!); // 'Win 5 Crowns'
 */
export function achievementDescription(a: Pick<AchievementDef, 'description' | 'target'>): string {
  return a.description.replace('{n}', a.target.toLocaleString('en-US'));
}
