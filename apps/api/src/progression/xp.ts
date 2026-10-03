/**
 * XP, level-ups, season pass XP and generic reward grants.
 */
import { and, eq, sql } from 'drizzle-orm';
import { passProgress, type Catalog, type CatalogReward } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { profiles, seasonPassProgress } from '../db/schema.ts';
import { applyLedger, type LedgerReason } from '../economy/ledger.ts';
import { grantCosmetic } from '../economy/wallet.ts';

/** Result of {@link addXp}. */
export interface XpResult {
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  /** Gumballs granted for level-ups. */
  levelGumballs: number;
  passXp: number;
  /** Pass tiers cleared before/after. */
  passTierBefore: number;
  passTierAfter: number;
}

/**
 * Adds player XP (with level-up Gumballs) and the same amount of pass XP for
 * the current season. Not idempotent on its own: callers guard with their own
 * key (match id, challenge row) before calling.
 *
 * @param tx - Open transaction.
 * @param catalog - Level curve, season.
 * @param userId - Player.
 * @param amount - XP to add (>= 0).
 */
export async function addXp(tx: DbOrTx, catalog: Catalog, userId: string, amount: number): Promise<XpResult> {
  const gain = Math.max(0, Math.round(amount));
  const [p] = await tx
    .select({ xp: profiles.xp })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  const xpBefore = p?.xp ?? 0;
  const xpAfter = xpBefore + gain;
  const levelBefore = catalog.levelForXp(xpBefore).level;
  const levelAfter = catalog.levelForXp(xpAfter).level;
  await tx
    .update(profiles)
    .set({ xp: xpAfter, level: levelAfter, updatedAt: sql`now()` })
    .where(eq(profiles.userId, userId));
  let levelGumballs = 0;
  for (let lv = levelBefore + 1; lv <= levelAfter; lv++) {
    const r = await applyLedger(tx, {
      userId,
      currency: 'gumballs',
      delta: catalog.gumballsPerLevel,
      reason: 'level_reward',
      ref: `level:${lv}`,
    });
    if (r.applied) levelGumballs += catalog.gumballsPerLevel;
  }
  const pass = await addPassXp(tx, catalog, userId, gain);
  return { xpBefore, xpAfter, levelBefore, levelAfter, levelGumballs, passXp: gain, ...pass };
}

/** Adds pass XP for the active season, creating the progress row on first use. */
export async function addPassXp(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  amount: number,
): Promise<{ passTierBefore: number; passTierAfter: number }> {
  const seasonId = catalog.season.id;
  await tx.insert(seasonPassProgress).values({ userId, seasonId }).onConflictDoNothing();
  const where = and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, seasonId));
  const [row] = await tx
    .select({ xp: seasonPassProgress.xp })
    .from(seasonPassProgress)
    .where(where)
    .for('update');
  const before = row?.xp ?? 0;
  const after = before + Math.max(0, amount);
  await tx
    .update(seasonPassProgress)
    .set({ xp: after, updatedAt: sql`now()` })
    .where(where);
  return {
    passTierBefore: passProgress(catalog, before).tier,
    passTierAfter: passProgress(catalog, after).tier,
  };
}

/**
 * Grants a reward. Currency rewards are idempotent on `(reason, ref)`;
 * cosmetics are idempotent by ownership.
 *
 * @returns The reward with whether this call granted it.
 */
export async function grantReward(
  tx: DbOrTx,
  userId: string,
  reward: CatalogReward,
  reason: LedgerReason,
  ref: string,
): Promise<CatalogReward & { granted: boolean }> {
  if (reward.type === 'cosmetic') {
    const granted = await grantCosmetic(
      tx,
      userId,
      reward.id,
      reason === 'pass_reward' ? 'pass' : 'challenge',
    );
    return { ...reward, granted };
  }
  const r = await applyLedger(tx, { userId, currency: reward.type, delta: reward.amount, reason, ref });
  return { ...reward, granted: r.applied };
}
