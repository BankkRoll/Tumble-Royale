import { Rng, hashString } from '@tumble/shared';
import { z } from 'zod';

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
]);

/** A challenge metric id. */
export type ChallengeMetric = z.output<typeof ChallengeMetricSchema>;

/** One challenge definition in the rotation pool. */
export const ChallengeDefSchema = z.object({
  id: z.string(),
  cadence: z.enum(['daily', 'weekly']),
  /** Player-facing text; `{n}` is replaced by the target. */
  description: z.string(),
  metric: ChallengeMetricSchema,
  target: z.number().int().positive(),
  rewardXp: z.number().int().min(0),
  rewardGumballs: z.number().int().min(0).default(0),
});

/** A validated challenge. */
export type ChallengeDef = z.output<typeof ChallengeDefSchema>;

/** Active challenges per cadence. */
export const CHALLENGE_SLOTS = { daily: 3, weekly: 6 } as const;

const d = (id: string, description: string, metric: ChallengeMetric, target: number, rewardXp: number, rewardGumballs = 0) => ({
  id,
  cadence: 'daily' as const,
  description,
  metric,
  target,
  rewardXp,
  rewardGumballs,
});
const w = (id: string, description: string, metric: ChallengeMetric, target: number, rewardXp: number, rewardGumballs = 0) => ({
  ...d(id, description, metric, target, rewardXp, rewardGumballs),
  cadence: 'weekly' as const,
});

/** The rotation pool. */
export const CHALLENGE_POOL: readonly ChallengeDef[] = z.array(ChallengeDefSchema).parse([
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

/**
 * Picks the active challenges for a period. Every server and client derives
 * the same set from the period key, so no rotation needs to be stored.
 *
 * @param cadence - `daily` or `weekly`.
 * @param periodKey - Day or week identifier, e.g. `2026-10-02` or `2026-W40`.
 * @param pool - Pool to draw from.
 * @returns {@link CHALLENGE_SLOTS}[cadence] distinct challenges.
 */
export function pickChallenges(
  cadence: ChallengeDef['cadence'],
  periodKey: string,
  pool: readonly ChallengeDef[] = CHALLENGE_POOL,
): ChallengeDef[] {
  const candidates = pool.filter((c) => c.cadence === cadence);
  const rng = new Rng(hashString(`${cadence}:${periodKey}`));
  return rng.shuffle([...candidates]).slice(0, CHALLENGE_SLOTS[cadence]);
}
