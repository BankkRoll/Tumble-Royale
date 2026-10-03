/**
 * Season rollover on the server.
 *
 * Responsibilities:
 * - Detect the live season changing ({@link ensureSeason}) and fire the
 *   {@link onSeasonChanged} listeners exactly once per season across every API
 *   instance (the `season_rollovers` insert is the lock).
 * - Settle a player's ended seasons ({@link settleEndedSeasons}): every tier
 *   they unlocked but never claimed is granted automatically, then the row is
 *   marked settled and kept as history. See docs/design/ECONOMY.md §2.1.
 * - Grant one pass tier's rewards ({@link grantPassTier}), shared by manual
 *   claims and settlement so both write the same ledger refs and a reward can
 *   never be paid twice.
 *
 * Season XP needs no reset: progress rows are keyed by season id, so the new
 * season simply starts a fresh row.
 */
import { PASS_DUPLICATE_GUMBALLS } from '@tumble/content/progression';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { passProgress, type CatalogReward, type CatalogSeason } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { seasonPassProgress, seasonRollovers } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { grantCosmetic } from '../economy/wallet.ts';

/** A season going live. */
export interface SeasonChange {
  /** The season that ended (null only if the API never recorded one). */
  previous: CatalogSeason | null;
  current: CatalogSeason;
  /** When this instance noticed. */
  at: Date;
}

/**
 * Called once per new season, cluster-wide. Errors are logged and swallowed:
 * a failing listener must not block requests.
 */
export type SeasonChangeListener = (change: SeasonChange, ctx: AppContext) => void | Promise<void>;

const listeners = new WeakMap<AppContext, Set<SeasonChangeListener>>();
const lastSeen = new WeakMap<AppContext, string>();

/**
 * Subscribes to season changes for one API context. This is the hook the
 * ranked soft reset uses: register it in `buildApp` right after the context
 * is created.
 *
 * @param ctx - API context.
 * @param listener - Runs once when a new season goes live.
 * @returns Unsubscribe.
 * @example
 * onSeasonChanged(ctx, ({ current }) => softResetRatings(current.id));
 */
export function onSeasonChanged(ctx: AppContext, listener: SeasonChangeListener): () => void {
  const set = listeners.get(ctx) ?? new Set<SeasonChangeListener>();
  listeners.set(ctx, set);
  set.add(listener);
  return () => set.delete(listener);
}

/**
 * Records the live season and fires the change listeners when it is new.
 * Cheap on the hot path: only touches the database when this process has not
 * seen the current season yet. The very first season an empty database sees
 * is recorded without firing (there is nothing to roll over from).
 *
 * @param ctx - API context.
 * @returns The change this call announced, or null.
 */
export async function ensureSeason(ctx: AppContext): Promise<SeasonChange | null> {
  const current = ctx.catalog.season;
  if (lastSeen.get(ctx) === current.id) return null;
  const [prev] = await ctx.db
    .select({ seasonId: seasonRollovers.seasonId })
    .from(seasonRollovers)
    .where(ne(seasonRollovers.seasonId, current.id))
    .orderBy(desc(seasonRollovers.rolledAt))
    .limit(1);
  const inserted = await ctx.db
    .insert(seasonRollovers)
    .values({ seasonId: current.id, previousSeasonId: prev?.seasonId ?? null, rolledAt: ctx.now() })
    .onConflictDoNothing()
    .returning({ seasonId: seasonRollovers.seasonId });
  // Remembered only after the insert succeeded, so a failed check is retried.
  lastSeen.set(ctx, current.id);
  if (inserted.length === 0 || !prev) return null;
  const change: SeasonChange = {
    previous: ctx.catalog.seasonById(prev.seasonId) ?? null,
    current,
    at: ctx.now(),
  };
  for (const fn of listeners.get(ctx) ?? []) {
    try {
      await fn(change, ctx);
    } catch (err) {
      console.error('[seasons] season-change listener failed', err);
    }
  }
  return change;
}

/** One reward as granted, with whether this call changed anything. */
export type GrantedPassReward = CatalogReward & { granted: boolean; duplicateGumballs?: number };

/**
 * Grants one tier's rewards on one track. Currency is idempotent on the
 * ledger ref `<season>:tier:<n>:<track>:<i>`; a cosmetic the player already
 * owns pays {@link PASS_DUPLICATE_GUMBALLS} instead (generated seasons reuse
 * tracks, so repeats happen).
 *
 * @param tx - Open transaction.
 * @param userId - Player.
 * @param seasonId - Season the tier belongs to.
 * @param tierNo - Tier number.
 * @param track - Track.
 * @param rewards - The tier's rewards on that track.
 */
export async function grantPassTier(
  tx: DbOrTx,
  userId: string,
  seasonId: string,
  tierNo: number,
  track: 'free' | 'premium',
  rewards: readonly CatalogReward[],
): Promise<GrantedPassReward[]> {
  const out: GrantedPassReward[] = [];
  for (const [i, reward] of rewards.entries()) {
    const ref = `${seasonId}:tier:${tierNo}:${track}:${i}`;
    if (reward.type === 'cosmetic') {
      if (await grantCosmetic(tx, userId, reward.id, 'pass')) {
        out.push({ ...reward, granted: true });
        continue;
      }
      const dup = await applyLedger(tx, {
        userId,
        currency: 'gumballs',
        delta: PASS_DUPLICATE_GUMBALLS,
        reason: 'pass_reward',
        ref: `${ref}:duplicate`,
      });
      out.push({
        ...reward,
        granted: false,
        ...(dup.applied ? { duplicateGumballs: PASS_DUPLICATE_GUMBALLS } : {}),
      });
      continue;
    }
    const r = await applyLedger(tx, {
      userId,
      currency: reward.type,
      delta: reward.amount,
      reason: 'pass_reward',
      ref,
    });
    out.push({ ...reward, granted: r.applied });
  }
  return out;
}

/** What settling one ended season did. */
export interface SettledSeason {
  seasonId: string;
  name: string;
  /** Tier rewards (tier × track) granted automatically. */
  autoGranted: number;
}

/**
 * Settles every ended, unsettled season for a player: grants unlocked
 * unclaimed rewards (free always, premium if unlocked) and marks the row
 * settled. Idempotent: settled rows are skipped and grants reuse claim refs.
 *
 * @param tx - Open transaction.
 * @param ctx - API context (catalog for the live season).
 * @param userId - Player.
 * @returns One entry per season settled by this call.
 */
export async function settleEndedSeasons(
  tx: DbOrTx,
  ctx: Pick<AppContext, 'catalog'>,
  userId: string,
): Promise<SettledSeason[]> {
  const current = ctx.catalog.season;
  const rows = await tx
    .select()
    .from(seasonPassProgress)
    .where(
      and(
        eq(seasonPassProgress.userId, userId),
        ne(seasonPassProgress.seasonId, current.id),
        isNull(seasonPassProgress.settledAt),
      ),
    )
    .for('update');
  const settled: SettledSeason[] = [];
  for (const row of rows) {
    const season = ctx.catalog.seasonById(row.seasonId);
    // Only seasons that are over; a clock running backwards must not settle the future.
    if (!season || season.number >= current.number) continue;
    const reached = passProgress(ctx.catalog, row.xp, season).tier;
    const claimedFree = new Set(row.claimedFree);
    const claimedPremium = new Set(row.claimedPremium);
    let count = 0;
    for (const t of season.tiers) {
      if (t.tier > reached) break;
      if (t.free.length > 0 && !claimedFree.has(t.tier)) {
        await grantPassTier(tx, userId, season.id, t.tier, 'free', t.free);
        claimedFree.add(t.tier);
        count++;
      }
      if (row.premium && t.premium.length > 0 && !claimedPremium.has(t.tier)) {
        await grantPassTier(tx, userId, season.id, t.tier, 'premium', t.premium);
        claimedPremium.add(t.tier);
        count++;
      }
    }
    await tx
      .update(seasonPassProgress)
      .set({
        claimedFree: [...claimedFree].sort((a, b) => a - b),
        claimedPremium: [...claimedPremium].sort((a, b) => a - b),
        settledAt: sql`now()`,
        autoGranted: count,
        updatedAt: sql`now()`,
      })
      .where(and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, row.seasonId)));
    settled.push({ seasonId: season.id, name: season.name, autoGranted: count });
  }
  return settled;
}
