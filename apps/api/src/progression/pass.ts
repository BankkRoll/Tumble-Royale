/**
 * Season pass: state view, tier claims and premium unlock.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { passProgress, type CatalogReward } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { purchases, seasonPassProgress } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { readWallet } from '../economy/wallet.ts';
import { ApiError, conflict, isUniqueViolation } from '../http/errors.ts';
import { grantReward } from './xp.ts';

/** Season pass progress as shown on the pass screen. */
export interface PassState {
  seasonId: string;
  name: string;
  endsAt: string;
  xp: number;
  /** Tiers cleared (0 until the first tier's XP is earned). */
  tier: number;
  maxTier: number;
  /** XP into the next tier and its cost. */
  xpIntoTier: number;
  nextTierXp: number;
  premium: boolean;
  premiumPriceGems: number;
  tiers: {
    tier: number;
    xp: number;
    free: CatalogReward[];
    premium: CatalogReward[];
    freeClaimed: boolean;
    premiumClaimed: boolean;
    unlocked: boolean;
  }[];
}

async function loadRow(db: DbOrTx, userId: string, seasonId: string, lock: boolean) {
  await db.insert(seasonPassProgress).values({ userId, seasonId }).onConflictDoNothing();
  const q = db
    .select()
    .from(seasonPassProgress)
    .where(and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, seasonId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new Error('season pass row missing after upsert');
  return row;
}

/** Builds the pass view for a player. */
export async function passState(ctx: AppContext, userId: string): Promise<PassState> {
  const s = ctx.catalog.season;
  const row = await loadRow(ctx.db, userId, s.id, false);
  const progress = passProgress(ctx.catalog, row.xp);
  const tier = progress.tier;
  const freeClaimed = new Set(row.claimedFree);
  const premiumClaimed = new Set(row.claimedPremium);
  return {
    seasonId: s.id,
    name: s.name,
    endsAt: s.endsAt,
    xp: row.xp,
    tier,
    maxTier: s.tiers.length,
    xpIntoTier: progress.intoTier,
    nextTierXp: progress.tierXp,
    premium: row.premium,
    premiumPriceGems: s.premiumPriceGems,
    tiers: s.tiers.map((t) => ({
      tier: t.tier,
      xp: t.xp,
      free: t.free,
      premium: t.premium,
      freeClaimed: freeClaimed.has(t.tier),
      premiumClaimed: premiumClaimed.has(t.tier),
      unlocked: t.tier <= tier,
    })),
  };
}

/**
 * Claims one tier reward.
 *
 * @throws {ApiError} 404 unknown tier/empty reward, 403 locked or premium required, 409 already claimed.
 */
export async function claimTier(ctx: AppContext, userId: string, tierNo: number, track: 'free' | 'premium') {
  const s = ctx.catalog.season;
  const def = s.tiers.find((t) => t.tier === tierNo);
  const rewards = def?.[track] ?? [];
  if (!def || rewards.length === 0) throw new ApiError(404, 'not_found', 'No reward on that tier/track');
  return ctx.db.transaction(async (tx) => {
    const row = await loadRow(tx, userId, s.id, true);
    if (tierNo > passProgress(ctx.catalog, row.xp).tier)
      throw new ApiError(403, 'tier_locked', 'Tier not reached yet');
    if (track === 'premium' && !row.premium)
      throw new ApiError(403, 'premium_required', 'Unlock the premium pass first');
    const claimed = track === 'free' ? row.claimedFree : row.claimedPremium;
    if (claimed.includes(tierNo)) throw conflict('already_claimed', 'Reward already claimed');
    const granted = [];
    for (const [i, reward] of rewards.entries()) {
      granted.push(
        await grantReward(tx, userId, reward, 'pass_reward', `${s.id}:tier:${tierNo}:${track}:${i}`),
      );
    }
    const next = [...claimed, tierNo].sort((a, b) => a - b);
    await tx
      .update(seasonPassProgress)
      .set(track === 'free' ? { claimedFree: next } : { claimedPremium: next })
      .where(and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, s.id)));
    return { tier: tierNo, track, rewards: granted, wallet: await readWallet(tx, userId) };
  });
}

/**
 * Unlocks the premium track with Gems, idempotent on the Idempotency-Key.
 *
 * @throws {ApiError} 409 already premium, 402 insufficient Gems.
 */
export async function unlockPremium(ctx: AppContext, userId: string, key: string) {
  const s = ctx.catalog.season;
  const findExisting = async (db: DbOrTx) =>
    (
      await db
        .select()
        .from(purchases)
        .where(and(eq(purchases.userId, userId), eq(purchases.idempotencyKey, key)))
    )[0];
  const replay = (row: typeof purchases.$inferSelect) => {
    if (row.kind !== 'pass_premium' || row.itemId !== s.id) {
      throw conflict(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different request',
      );
    }
    return { ...(row.response as object), replayed: true };
  };
  try {
    return await ctx.db.transaction(async (tx) => {
      const existing = await findExisting(tx);
      if (existing) return replay(existing);
      const row = await loadRow(tx, userId, s.id, true);
      if (row.premium) throw conflict('already_premium', 'Premium pass already unlocked');
      const purchaseId = randomUUID();
      await tx.insert(purchases).values({
        id: purchaseId,
        userId,
        idempotencyKey: key,
        kind: 'pass_premium',
        itemId: s.id,
        currency: 'gems',
        price: s.premiumPriceGems,
        status: 'pending',
      });
      await applyLedger(tx, {
        userId,
        currency: 'gems',
        delta: -s.premiumPriceGems,
        reason: 'pass_premium',
        ref: purchaseId,
      });
      await tx
        .update(seasonPassProgress)
        .set({ premium: true })
        .where(and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, s.id)));
      const response = { purchaseId, seasonId: s.id, premium: true, wallet: await readWallet(tx, userId) };
      await tx
        .update(purchases)
        .set({ status: 'completed', response, completedAt: ctx.now() })
        .where(eq(purchases.id, purchaseId));
      return { ...response, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findExisting(ctx.db);
      if (existing) return replay(existing);
    }
    throw err;
  }
}
