/**
 * The daily login reward ladder. One claim per UTC day; consecutive days grow
 * the streak, a missed day resets it to 1, and the ladder repeats every
 * {@link LOGIN_STREAK_CYCLE} days with the biggest reward on the last day.
 * The account API is the only place a claim happens.
 */
import { z } from 'zod';
import { GrantSchema, type Grant } from './achievements.ts';

/** Days in one turn of the ladder. */
export const LOGIN_STREAK_CYCLE = 7;

/** One day of the ladder. */
export const LoginStreakDaySchema = z.object({
  /** 1-based day within the cycle. */
  day: z.number().int().min(1).max(LOGIN_STREAK_CYCLE),
  /** Currency and XP only: a cosmetic could not be granted again on the next cycle. */
  rewards: z.array(GrantSchema.refine((g) => g.kind !== 'cosmetic', 'no cosmetics on the ladder')).min(1),
});

/** A validated ladder day. */
export type LoginStreakDay = z.output<typeof LoginStreakDaySchema>;

/** The ladder, day 1 first. */
export const LOGIN_STREAK_LADDER: readonly LoginStreakDay[] = z
  .array(LoginStreakDaySchema)
  .length(LOGIN_STREAK_CYCLE)
  .refine((days) => days.every((d, i) => d.day === i + 1), 'ladder days must be 1..7 in order')
  .parse([
    { day: 1, rewards: [{ kind: 'gumballs', amount: 50 }] },
    { day: 2, rewards: [{ kind: 'xp', amount: 500 }] },
    { day: 3, rewards: [{ kind: 'gumballs', amount: 75 }] },
    { day: 4, rewards: [{ kind: 'xp', amount: 750 }] },
    { day: 5, rewards: [{ kind: 'gumballs', amount: 100 }] },
    { day: 6, rewards: [{ kind: 'crownShards', amount: 3 }] },
    {
      day: 7,
      rewards: [
        { kind: 'gumballs', amount: 250 },
        { kind: 'gems', amount: 20 },
        { kind: 'xp', amount: 1500 },
      ],
    },
  ]);

/**
 * The ladder day a streak lands on.
 *
 * @param streak - Consecutive days including the one being claimed (>= 1).
 * @returns The day 1..7 and its rewards.
 * @example
 * loginStreakDay(8).day; // 1 (the second week starts over)
 */
export function loginStreakDay(streak: number): LoginStreakDay {
  const n = Math.max(1, Math.floor(streak));
  return LOGIN_STREAK_LADDER[(n - 1) % LOGIN_STREAK_CYCLE] as LoginStreakDay;
}

/**
 * Total value of a set of grants per kind (for summaries and the economy budget).
 *
 * @param grants - Rewards to add up.
 */
export function sumGrants(
  grants: readonly Grant[],
): Partial<Record<Exclude<Grant['kind'], 'cosmetic'>, number>> {
  const out: Partial<Record<Exclude<Grant['kind'], 'cosmetic'>, number>> = {};
  for (const g of grants) if (g.kind !== 'cosmetic') out[g.kind] = (out[g.kind] ?? 0) + g.amount;
  return out;
}
