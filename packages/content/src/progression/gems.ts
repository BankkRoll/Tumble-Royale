/**
 * Free Gem earn paths. Gems are the premium currency, but every Gem-priced
 * thing (the Premium Pass, Legendary/Mythic store items) must be reachable by
 * playing. These are the non-purchase sources besides the pass tracks; the
 * numbers and the per-season budget they add up to are documented in
 * docs/design/ECONOMY.md.
 */
import { z } from 'zod';

/** Gem payouts for play. */
export const GemEarnRulesSchema = z.object({
  /** Each weekly challenge claimed. */
  weeklyChallenge: z.number().int().min(0),
  /** The first Crown won on a UTC day. */
  firstCrownOfDay: z.number().int().min(0),
  /** Account levels between milestone payouts. */
  levelMilestoneEvery: z.number().int().positive(),
  /** Paid on each milestone level. */
  levelMilestone: z.number().int().min(0),
});

/** Validated Gem earn rules. */
export type GemEarnRules = z.output<typeof GemEarnRulesSchema>;

/** The live Gem earn rules. */
export const GEM_EARN: GemEarnRules = GemEarnRulesSchema.parse({
  weeklyChallenge: 10,
  firstCrownOfDay: 15,
  levelMilestoneEvery: 10,
  levelMilestone: 100,
});

/**
 * Gems for reaching one account level (non-zero only on milestones).
 *
 * @param level - The level just reached.
 * @param rules - Earn rules.
 * @example
 * levelMilestoneGems(20); // 100
 * levelMilestoneGems(21); // 0
 */
export function levelMilestoneGems(level: number, rules: GemEarnRules = GEM_EARN): number {
  return level > 0 && level % rules.levelMilestoneEvery === 0 ? rules.levelMilestone : 0;
}

/**
 * Gems for a level range gained in one go (several milestones can pass at once).
 *
 * @param from - Level before (exclusive).
 * @param to - Level after (inclusive).
 * @param rules - Earn rules.
 */
export function levelRangeGems(from: number, to: number, rules: GemEarnRules = GEM_EARN): number {
  let gems = 0;
  for (let lv = from + 1; lv <= to; lv++) gems += levelMilestoneGems(lv, rules);
  return gems;
}
