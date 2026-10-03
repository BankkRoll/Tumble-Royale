/**
 * Visible ranked ladder: RP → tier + division.
 *
 * Bronze → Silver → Gold → Platinum → Diamond → Champion, each 1200 RP wide
 * with divisions III → II → I (400 RP each). Crown League is not an RP band:
 * it is Champion players inside the top 500 of their region, resolved against
 * the live leaderboard.
 */

/** Ranked tiers in ascending order. */
export const TIERS = ['unranked', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion', 'crown_league'] as const;
/** A ranked tier id. */
export type Tier = (typeof TIERS)[number];

/** RP width of one tier. */
export const TIER_WIDTH = 1200;
/** RP width of one division. */
export const DIVISION_WIDTH = 400;
/** Players per region who hold Crown League. */
export const CROWN_LEAGUE_SIZE = 500;

const LADDER: readonly Tier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion'];

/** Tier and division (3 = III lowest, 1 = I highest; 0 when not applicable). */
export interface TierInfo {
  tier: Tier;
  division: number;
}

/**
 * Maps RP to a ladder position.
 *
 * @param rp - Visible ranked points.
 * @param placementsLeft - Placement matches remaining; > 0 means unranked.
 * @param regionRank - Zero-based rank in the region leaderboard, if known.
 * @example
 * tierForRp(2500, 0); // { tier: 'gold', division: 3 }
 */
export function tierForRp(rp: number, placementsLeft: number, regionRank: number | null = null): TierInfo {
  if (placementsLeft > 0) return { tier: 'unranked', division: 0 };
  const idx = Math.min(LADDER.length - 1, Math.floor(Math.max(0, rp) / TIER_WIDTH));
  const tier = LADDER[idx]!;
  if (tier === 'champion' && regionRank !== null && regionRank < CROWN_LEAGUE_SIZE) return { tier: 'crown_league', division: 0 };
  const within = Math.max(0, rp) - idx * TIER_WIDTH;
  const division = 3 - Math.min(2, Math.floor(within / DIVISION_WIDTH));
  return { tier, division };
}

/** Display label, e.g. `GOLD II`. */
export function tierLabel(info: TierInfo): string {
  if (info.tier === 'unranked') return 'UNRANKED';
  if (info.tier === 'crown_league') return 'CROWN LEAGUE';
  return `${info.tier.toUpperCase()} ${['', 'I', 'II', 'III'][info.division] ?? ''}`.trim();
}
