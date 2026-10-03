import { z } from 'zod';

/** Crown Shards that combine into one Crown. */
export const SHARDS_PER_CROWN = 60;

/** Payout amounts for one show outcome component. */
export const PayoutSchema = z.object({
  xp: z.number().int().min(0),
  gumballs: z.number().int().min(0),
  crownShards: z.number().int().min(0).default(0),
});

/**
 * End-of-show reward rules. Rewards are cosmetic progress only (XP, pass
 * tiers, Gumballs, Crown Shards); nothing here affects gameplay.
 */
export const RewardRulesSchema = z.object({
  /** Finishing a show at all, whatever happened. */
  participation: PayoutSchema,
  /** Each round played (qualified or not). */
  perRoundPlayed: PayoutSchema,
  /** Each round qualified from (not counting the final). */
  perRoundQualified: PayoutSchema,
  /** Reaching the final. */
  reachedFinal: PayoutSchema,
  /** Winning the Crown (shared in duos/squads). */
  crown: PayoutSchema,
  /** Extra XP by final placement percentile: top 10%, 25%, 50%. */
  placementBonus: z.object({ top10: z.number().int(), top25: z.number().int(), top50: z.number().int() }),
  /** Multiplier on the first show of the day. */
  firstShowOfDayMultiplier: z.number().min(1).default(2),
  /** Leaving mid-show forfeits everything but participation of rounds played. */
  quitterKeepsRoundRewards: z.boolean().default(true),
});

/** Validated reward rules. */
export type RewardRules = z.output<typeof RewardRulesSchema>;

/** The live reward rules. */
export const REWARD_RULES: RewardRules = RewardRulesSchema.parse({
  participation: { xp: 150, gumballs: 15 },
  perRoundPlayed: { xp: 40, gumballs: 5 },
  perRoundQualified: { xp: 90, gumballs: 15 },
  reachedFinal: { xp: 250, gumballs: 60, crownShards: 1 },
  crown: { xp: 900, gumballs: 250, crownShards: 0 },
  placementBonus: { top10: 150, top25: 80, top50: 30 },
  firstShowOfDayMultiplier: 2,
  quitterKeepsRoundRewards: true,
});

/** Facts about one player's show, as reported by the game server. */
export interface ShowResultFacts {
  roundsPlayed: number;
  /** Non-final rounds qualified from. */
  roundsQualified: number;
  reachedFinal: boolean;
  wonCrown: boolean;
  /** Final placement (1 = Crown) and field size. */
  place: number;
  participants: number;
  /** Left before the show ended. */
  quit: boolean;
  firstShowOfDay: boolean;
}

/** Itemised payout for the rewards screen. */
export interface RewardBreakdown {
  lines: { label: string; xp: number; gumballs: number; crownShards: number }[];
  xp: number;
  gumballs: number;
  crownShards: number;
  /** Whole Crowns won outright (shards convert separately via {@link SHARDS_PER_CROWN}). */
  crowns: number;
}

/**
 * Computes a player's end-of-show rewards. Pure: the API calls this with
 * server-reported facts, keyed by match id for idempotent grants.
 *
 * @param facts - What happened in the show.
 * @param rules - Reward table (defaults to {@link REWARD_RULES}).
 * @returns The itemised payout.
 */
export function computeShowRewards(facts: ShowResultFacts, rules: RewardRules = REWARD_RULES): RewardBreakdown {
  const lines: RewardBreakdown['lines'] = [];
  const add = (label: string, p: z.output<typeof PayoutSchema>, times = 1): void => {
    if (times <= 0) return;
    lines.push({ label, xp: p.xp * times, gumballs: p.gumballs * times, crownShards: p.crownShards * times });
  };
  if (!facts.quit) add('Show played', rules.participation);
  if (!facts.quit || rules.quitterKeepsRoundRewards) {
    add('Rounds played', rules.perRoundPlayed, facts.roundsPlayed);
    add('Rounds qualified', rules.perRoundQualified, facts.roundsQualified);
  }
  if (!facts.quit) {
    if (facts.reachedFinal) add('Reached the final', rules.reachedFinal);
    if (facts.wonCrown) add('CROWN!', rules.crown);
    const pct = facts.participants > 0 ? facts.place / facts.participants : 1;
    const bonus =
      pct <= 0.1 ? rules.placementBonus.top10 : pct <= 0.25 ? rules.placementBonus.top25 : pct <= 0.5 ? rules.placementBonus.top50 : 0;
    if (bonus > 0) lines.push({ label: 'Placement bonus', xp: bonus, gumballs: 0, crownShards: 0 });
  }
  let xp = lines.reduce((s, l) => s + l.xp, 0);
  if (facts.firstShowOfDay && !facts.quit && rules.firstShowOfDayMultiplier > 1) {
    const extra = Math.round(xp * (rules.firstShowOfDayMultiplier - 1));
    lines.push({ label: 'First show of the day', xp: extra, gumballs: 0, crownShards: 0 });
    xp += extra;
  }
  return {
    lines,
    xp,
    gumballs: lines.reduce((s, l) => s + l.gumballs, 0),
    crownShards: lines.reduce((s, l) => s + l.crownShards, 0),
    crowns: facts.wonCrown && !facts.quit ? 1 : 0,
  };
}
