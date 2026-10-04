/**
 * Challenge definitions and rotation.
 *
 * Responsibilities:
 * - The metrics a challenge can count from a show.
 * - The daily/weekly rotation pool, the per-season seasonal pool and the
 *   permanent milestone list, all zod-validated at load (unique ids, reward
 *   cosmetics that exist and are `challenge`-source).
 * - Deterministic picks per period ({@link pickChallenges}) so every server
 *   and client derive the same set from the period key alone.
 */
import { Rng, hashString } from '@tumble/shared';
import { z } from 'zod';
import { getCosmetic } from '../cosmetics/index.ts';

/** Stats a challenge can count. The game server reports these per show. */
export const ChallengeMetricSchema = z.enum([
  'showsPlayed',
  'roundsPlayed',
  'roundsQualified',
  'racesQualified',
  'survivalsQualified',
  'teamRoundsWon',
  'huntRoundsQualified',
  'logicRoundsQualified',
  'finalsReached',
  'crowns',
  'jumps',
  'dives',
  'grabs',
  'checkpoints',
  'bounces',
  'topTenFinishes',
  'emotes',
  /** Shows played after queueing together with a party. */
  'partyShows',
]);

/** A challenge metric id. */
export type ChallengeMetric = z.output<typeof ChallengeMetricSchema>;

/**
 * How long a challenge lives: `daily` and `weekly` rotate at 00:00 UTC (ISO
 * weeks), `seasonal` lasts the live season, `milestone` never expires.
 */
export const ChallengeCadenceSchema = z.enum(['daily', 'weekly', 'seasonal', 'milestone']);

/** A challenge cadence. */
export type ChallengeCadence = z.output<typeof ChallengeCadenceSchema>;

/** One challenge definition. */
export const ChallengeDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  cadence: ChallengeCadenceSchema,
  /** Player-facing text; `{n}` is replaced by the target. */
  description: z.string(),
  metric: ChallengeMetricSchema,
  target: z.number().int().positive(),
  rewardXp: z.number().int().min(0),
  rewardGumballs: z.number().int().min(0).default(0),
  /**
   * Gems paid on claim. Weekly challenges ignore this and pay
   * `GEM_EARN.weeklyChallenge` instead, so the weekly rate stays one knob.
   */
  rewardGems: z.number().int().min(0).default(0),
  /** A `challenge`-source cosmetic granted on claim (seasonal and milestone only). */
  rewardCosmetic: z.string().optional(),
});

/** A validated challenge. */
export type ChallengeDef = z.output<typeof ChallengeDefSchema>;

/** Active challenges per rotating cadence. Milestones are all active at once. */
export const CHALLENGE_SLOTS = { daily: 3, weekly: 6, seasonal: 8 } as const;

/** Cadences drawn from a pool per period (everything but milestones). */
export type RotatingCadence = keyof typeof CHALLENGE_SLOTS;

const d = (
  id: string,
  description: string,
  metric: ChallengeMetric,
  target: number,
  rewardXp: number,
  rewardGumballs = 0,
) => ({
  id,
  cadence: 'daily' as const,
  description,
  metric,
  target,
  rewardXp,
  rewardGumballs,
});
const w = (
  id: string,
  description: string,
  metric: ChallengeMetric,
  target: number,
  rewardXp: number,
  rewardGumballs = 0,
) => ({
  ...d(id, description, metric, target, rewardXp, rewardGumballs),
  cadence: 'weekly' as const,
});

/** The daily/weekly rotation pool. */
export const CHALLENGE_POOL: readonly ChallengeDef[] = z
  .array(ChallengeDefSchema)
  .parse([
    d('d-play-3', 'Play {n} shows', 'showsPlayed', 3, 600, 30),
    d('d-qualify-5', 'Qualify from {n} rounds', 'roundsQualified', 5, 700, 30),
    d('d-race-3', 'Qualify from {n} races', 'racesQualified', 3, 600),
    d('d-survive-2', 'Survive {n} survival rounds', 'survivalsQualified', 2, 600),
    d('d-team-2', 'Win {n} team rounds', 'teamRoundsWon', 2, 650),
    d('d-jump-150', 'Jump {n} times', 'jumps', 150, 500),
    d('d-dive-40', 'Dive {n} times', 'dives', 40, 500),
    d('d-grab-25', 'Grab other Tumblers {n} times', 'grabs', 25, 550),
    d('d-bounce-20', 'Use bounce pads {n} times', 'bounces', 20, 500),
    d('d-check-15', 'Reach {n} checkpoints', 'checkpoints', 15, 500),
    d('d-final-1', 'Reach a final', 'finalsReached', 1, 800, 40),
    d('d-emote-10', 'Emote {n} times', 'emotes', 10, 400),
    w('w-play-15', 'Play {n} shows', 'showsPlayed', 15, 2500, 150),
    w('w-qualify-30', 'Qualify from {n} rounds', 'roundsQualified', 30, 3000, 150),
    w('w-race-15', 'Qualify from {n} races', 'racesQualified', 15, 2500),
    w('w-survive-10', 'Survive {n} survival rounds', 'survivalsQualified', 10, 2500),
    w('w-team-8', 'Win {n} team rounds', 'teamRoundsWon', 8, 2500),
    w('w-hunt-5', 'Qualify from {n} hunt rounds', 'huntRoundsQualified', 5, 2200),
    w('w-logic-4', 'Qualify from {n} logic rounds', 'logicRoundsQualified', 4, 2200),
    w('w-final-5', 'Reach {n} finals', 'finalsReached', 5, 3500, 200),
    w('w-crown-1', 'Win a Crown', 'crowns', 1, 4000, 300),
    w('w-top10-5', 'Finish in the top 10 {n} times', 'topTenFinishes', 5, 3000),
    w('w-dive-200', 'Dive {n} times', 'dives', 200, 2000),
    w('w-grab-120', 'Grab other Tumblers {n} times', 'grabs', 120, 2200),
  ]);

const s = (
  id: string,
  description: string,
  metric: ChallengeMetric,
  target: number,
  rewardXp: number,
  extra: { gumballs?: number; gems?: number; cosmetic?: string } = {},
) => ({
  id,
  cadence: 'seasonal' as const,
  description,
  metric,
  target,
  rewardXp,
  rewardGumballs: extra.gumballs ?? 0,
  rewardGems: extra.gems ?? 0,
  ...(extra.cosmetic ? { rewardCosmetic: extra.cosmetic } : {}),
});
const m = (...args: Parameters<typeof s>) => ({ ...s(...args), cadence: 'milestone' as const });

/**
 * Shared checks for the seasonal and milestone lists: one cadence, unique
 * ids, and cosmetic rewards that exist and are `challenge`-source (never sold,
 * never on a pass, so a challenge is their only way in).
 */
function checkList(cadence: ChallengeCadence) {
  return (list: readonly ChallengeDef[], ctx: z.RefinementCtx): void => {
    const ids = new Set<string>();
    for (const c of list) {
      if (c.cadence !== cadence) ctx.addIssue({ code: 'custom', message: `${c.id} is not ${cadence}` });
      if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate challenge id ${c.id}` });
      ids.add(c.id);
      if (!c.rewardCosmetic) continue;
      const item = getCosmetic(c.rewardCosmetic);
      if (!item) ctx.addIssue({ code: 'custom', message: `${c.id}: unknown cosmetic ${c.rewardCosmetic}` });
      else if (item.source !== 'challenge')
        ctx.addIssue({ code: 'custom', message: `${c.id}: ${c.rewardCosmetic} is not a challenge reward` });
    }
  };
}

/**
 * Seasonal pool. Each season plays {@link CHALLENGE_SLOTS}.seasonal of these,
 * picked from the season id, and they expire with the season.
 */
export const SEASONAL_CHALLENGE_POOL: readonly ChallengeDef[] = z
  .array(ChallengeDefSchema)
  .superRefine(checkList('seasonal'))
  .parse([
    s('s-play-60', 'Play {n} shows this season', 'showsPlayed', 60, 6000, { gumballs: 400 }),
    s('s-qualify-150', 'Qualify from {n} rounds this season', 'roundsQualified', 150, 6000, {
      gumballs: 400,
    }),
    s('s-race-60', 'Qualify from {n} races this season', 'racesQualified', 60, 5000, { gumballs: 300 }),
    s('s-survive-40', 'Survive {n} survival rounds this season', 'survivalsQualified', 40, 5000, {
      gumballs: 300,
    }),
    s('s-team-30', 'Win {n} team rounds this season', 'teamRoundsWon', 30, 5000, { gumballs: 300 }),
    s('s-hunt-20', 'Qualify from {n} hunt rounds this season', 'huntRoundsQualified', 20, 4500),
    s('s-logic-15', 'Qualify from {n} logic rounds this season', 'logicRoundsQualified', 15, 4500),
    s('s-final-15', 'Reach {n} finals this season', 'finalsReached', 15, 7000, { gems: 25 }),
    s('s-crown-3', 'Win {n} Crowns this season', 'crowns', 3, 8000, { gems: 25 }),
    s('s-top10-25', 'Finish in the top 10 {n} times this season', 'topTenFinishes', 25, 5500),
    s('s-grab-500', 'Grab other Tumblers {n} times this season', 'grabs', 500, 4500),
    s('s-dive-800', 'Dive {n} times this season', 'dives', 800, 4000),
    s('s-party-20', 'Play {n} shows with a party this season', 'partyShows', 20, 6000, { gumballs: 400 }),
    s('s-emote-100', 'Emote {n} times this season', 'emotes', 100, 3500),
  ]);

/**
 * Permanent long-term goals. Every account has all of them at once; each
 * completes and pays once, ever.
 *
 * IMPORTANT: append only. A milestone's position in this list is its stored
 * slot, so reordering or removing one would hand its progress to another.
 */
export const MILESTONE_CHALLENGES: readonly ChallengeDef[] = z
  .array(ChallengeDefSchema)
  .superRefine(checkList('milestone'))
  .parse([
    m('m-play-500', 'Play {n} shows', 'showsPlayed', 500, 15000, { gumballs: 1500 }),
    m('m-qualify-2000', 'Qualify from {n} rounds', 'roundsQualified', 2000, 15000, { gumballs: 1500 }),
    m('m-final-100', 'Reach {n} finals', 'finalsReached', 100, 15000, { cosmetic: 'color.toasted' }),
    m('m-crown-50', 'Win {n} Crowns', 'crowns', 50, 20000, { gems: 100, cosmetic: 'pattern.diamonds' }),
    m('m-team-500', 'Win {n} team rounds', 'teamRoundsWon', 500, 12000, { cosmetic: 'banner.stripes' }),
    m('m-checkpoint-1000', 'Reach {n} checkpoints', 'checkpoints', 1000, 10000, {
      cosmetic: 'footsteps.jelly',
    }),
    m('m-bounce-2000', 'Use bounce pads {n} times', 'bounces', 2000, 10000, { gumballs: 1000 }),
    m('m-party-250', 'Play {n} shows with a party', 'partyShows', 250, 12000, { gumballs: 1000 }),
  ]);

/** Every challenge definition of every cadence, by id. */
export const ALL_CHALLENGES: ReadonlyMap<string, ChallengeDef> = new Map(
  [...CHALLENGE_POOL, ...SEASONAL_CHALLENGE_POOL, ...MILESTONE_CHALLENGES].map((c) => [c.id, c]),
);

/**
 * Picks the active challenges for a period. Every server and client derives
 * the same set from the period key, so no rotation needs to be stored.
 *
 * @param cadence - `daily`, `weekly` or `seasonal`.
 * @param periodKey - Day, ISO week or season id, e.g. `2026-10-02`, `2026-W40`, `s1`.
 * @param pool - Pool to draw from (defaults to the cadence's own pool).
 * @returns {@link CHALLENGE_SLOTS}[cadence] distinct challenges.
 * @example
 * pickChallenges('seasonal', 's2').length; // 8
 */
export function pickChallenges(
  cadence: RotatingCadence,
  periodKey: string,
  pool: readonly ChallengeDef[] = cadence === 'seasonal' ? SEASONAL_CHALLENGE_POOL : CHALLENGE_POOL,
): ChallengeDef[] {
  const candidates = pool.filter((c) => c.cadence === cadence);
  const rng = new Rng(hashString(`${cadence}:${periodKey}`));
  return rng.shuffle([...candidates]).slice(0, CHALLENGE_SLOTS[cadence]);
}
