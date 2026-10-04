/**
 * Achievements on the server: lifetime progress, unlocks and their rewards.
 *
 * Responsibilities:
 * - Record metric progress ({@link recordAchievementProgress}): running totals
 *   for `sum` metrics, best-ever values for `max` metrics. Callers are the
 *   match ingest and the login claim, each inside the transaction that also
 *   writes their own idempotency key (the `matches` row, the streak row), so a
 *   replayed or concurrent duplicate can never count twice.
 * - Unlock everything whose target is met ({@link unlockAchievements}). The
 *   `player_achievements` primary key makes each unlock, and so its grant,
 *   happen once; currency grants are also keyed `achievement:<id>` on the
 *   ledger. XP is returned rather than granted so the caller can fold it into
 *   its own `addXp` (the show's XP lines, the login claim).
 * - The player-facing view ({@link achievementsView}), which never reveals a
 *   hidden achievement before it is unlocked.
 *
 * `gauge` metrics (cosmetics owned) are read from live state on every unlock
 * pass, so an achievement for owning items unlocks on the next pass after a
 * purchase, pass claim or grant without any hook in those code paths.
 */
import { eq, sql } from 'drizzle-orm';
import type { AchievementMetric, Catalog, CatalogAchievement, CatalogGrant } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { achievementStats, inventoryItems, playerAchievements } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { grantCosmetic } from '../economy/wallet.ts';

/** Per-metric input for {@link recordAchievementProgress}. */
export interface AchievementProgressInput {
  /** Amounts to add to `sum` metrics. */
  add?: Partial<Record<AchievementMetric, number>>;
  /** Candidate values for `max` metrics (kept only when higher). */
  max?: Partial<Record<AchievementMetric, number>>;
}

/** A reward as an unlock granted it. `granted` is false for a cosmetic already owned. */
export type GrantedAchievementReward = CatalogGrant & { granted: boolean };

/** One achievement unlocked by a call. */
export interface AchievementUnlock {
  id: string;
  title: string;
  description: string;
  category: CatalogAchievement['category'];
  hidden: boolean;
  series: CatalogAchievement['series'];
  /** ISO time of the unlock (server clock). */
  unlockedAt: string;
  rewards: GrantedAchievementReward[];
}

/** Result of {@link unlockAchievements}. */
export interface UnlockResult {
  unlocks: AchievementUnlock[];
  /** XP the unlocks are worth; the caller adds it with `addXp`. */
  xp: number;
}

/**
 * Adds to `sum` metrics and raises `max` metrics. Values that are not
 * positive integers, and metrics fed through the wrong field, are ignored.
 *
 * @param tx - Open transaction that also holds the caller's idempotency key.
 * @param catalog - Achievement definitions (for metric kinds).
 * @param userId - Player.
 * @param input - Increments and candidate maxima.
 * @param now - Server clock.
 */
export async function recordAchievementProgress(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  input: AchievementProgressInput,
  now: Date,
): Promise<void> {
  const kinds = catalog.achievementMetrics;
  const valid = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  for (const [metric, n] of Object.entries(input.add ?? {}) as [AchievementMetric, number][]) {
    if (!valid(n) || kinds[metric] !== 'sum') continue;
    await tx
      .insert(achievementStats)
      .values({ userId, metric, value: n, updatedAt: now })
      .onConflictDoUpdate({
        target: [achievementStats.userId, achievementStats.metric],
        set: { value: sql`${achievementStats.value} + ${n}`, updatedAt: now },
      });
  }
  for (const [metric, n] of Object.entries(input.max ?? {}) as [AchievementMetric, number][]) {
    if (!valid(n) || kinds[metric] !== 'max') continue;
    await tx
      .insert(achievementStats)
      .values({ userId, metric, value: n, updatedAt: now })
      .onConflictDoUpdate({
        target: [achievementStats.userId, achievementStats.metric],
        set: { value: sql`greatest(${achievementStats.value}, ${n})`, updatedAt: now },
      });
  }
}

/**
 * Catalogue cosmetics the player owns: inventory rows plus `default` items,
 * which every account owns even when it predates the item.
 */
async function ownedCosmetics(db: DbOrTx, catalog: Catalog, userId: string): Promise<number> {
  const rows = await db
    .select({ id: inventoryItems.cosmeticId })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  const inv = new Set(rows.map((r) => r.id));
  return catalog.cosmetics.filter((c) => c.source === 'default' || inv.has(c.id)).length;
}

/**
 * Current value of every metric for a player (missing rows are 0).
 *
 * @param db - Database or transaction.
 * @param catalog - Definitions and cosmetics.
 * @param userId - Player.
 */
export async function achievementValues(
  db: DbOrTx,
  catalog: Catalog,
  userId: string,
): Promise<Map<AchievementMetric, number>> {
  const rows = await db
    .select({ metric: achievementStats.metric, value: achievementStats.value })
    .from(achievementStats)
    .where(eq(achievementStats.userId, userId));
  const values = new Map(rows.map((r) => [r.metric as AchievementMetric, r.value]));
  if (catalog.achievements.some((a) => a.kind === 'gauge'))
    values.set('cosmeticsOwned', await ownedCosmetics(db, catalog, userId));
  return values;
}

async function grantAll(
  tx: DbOrTx,
  userId: string,
  a: CatalogAchievement,
): Promise<{ rewards: GrantedAchievementReward[]; xp: number; newItem: boolean }> {
  const ref = `achievement:${a.id}`;
  const rewards: GrantedAchievementReward[] = [];
  let xp = 0;
  let newItem = false;
  for (const r of a.rewards) {
    if (r.type === 'xp') {
      xp += r.amount;
      rewards.push({ ...r, granted: true });
    } else if (r.type === 'cosmetic') {
      const granted = await grantCosmetic(tx, userId, r.id, 'achievement');
      newItem ||= granted;
      rewards.push({ ...r, granted });
    } else {
      const res = await applyLedger(tx, {
        userId,
        currency: r.type,
        delta: r.amount,
        reason: 'achievement_reward',
        ref,
      });
      rewards.push({ ...r, granted: res.applied });
    }
  }
  return { rewards, xp, newItem };
}

/**
 * Unlocks every achievement whose target is met and grants its rewards
 * (except XP, which is returned). Repeats while an unlock granted a cosmetic,
 * since owning more items can meet a collection target.
 *
 * @param tx - Open transaction.
 * @param catalog - Definitions and cosmetics.
 * @param userId - Player.
 * @param now - Server clock (the unlock time).
 * @returns The unlocks this call made, in catalogue order, and their XP.
 */
export async function unlockAchievements(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  now: Date,
): Promise<UnlockResult> {
  const unlocks: AchievementUnlock[] = [];
  let xp = 0;
  // Bounded: each extra pass needs a new cosmetic from the pass before.
  for (let pass = 0; pass < 4; pass++) {
    const values = await achievementValues(tx, catalog, userId);
    const have = new Set(
      (
        await tx
          .select({ id: playerAchievements.achievementId })
          .from(playerAchievements)
          .where(eq(playerAchievements.userId, userId))
      ).map((r) => r.id),
    );
    let newItem = false;
    for (const a of catalog.achievements) {
      if (have.has(a.id) || (values.get(a.metric) ?? 0) < a.target) continue;
      const inserted = await tx
        .insert(playerAchievements)
        .values({ userId, achievementId: a.id, unlockedAt: now })
        .onConflictDoNothing()
        .returning({ id: playerAchievements.achievementId });
      if (!inserted.length) continue;
      const g = await grantAll(tx, userId, a);
      xp += g.xp;
      newItem ||= g.newItem;
      unlocks.push({
        id: a.id,
        title: a.title,
        description: a.description,
        category: a.category,
        hidden: a.hidden,
        series: a.series,
        unlockedAt: now.toISOString(),
        rewards: g.rewards,
      });
    }
    if (!newItem) break;
  }
  return { unlocks, xp };
}

/** Description shown for a hidden achievement that is still locked. */
export const HIDDEN_DESCRIPTION = 'Hidden achievement. Keep playing to discover it.';

/**
 * The achievements screen. Locked hidden achievements show only `???`, an
 * opaque id and their category: no title, description, metric, progress or
 * rewards that could give them away.
 *
 * @param db - Database or transaction.
 * @param catalog - Definitions and cosmetics.
 * @param userId - Player.
 */
export async function achievementsView(db: DbOrTx, catalog: Catalog, userId: string) {
  const values = await achievementValues(db, catalog, userId);
  const rows = await db.select().from(playerAchievements).where(eq(playerAchievements.userId, userId));
  const unlockedAt = new Map(rows.map((r) => [r.achievementId, r.unlockedAt]));
  let hiddenNo = 0;
  const achievements = catalog.achievements.map((a) => {
    const at = unlockedAt.get(a.id);
    if (a.hidden && !at) {
      hiddenNo++;
      return {
        id: `hidden-${hiddenNo}`,
        category: a.category,
        title: '???',
        description: HIDDEN_DESCRIPTION,
        hidden: true,
        unlocked: false,
        unlockedAt: null,
        progress: null,
        target: null,
        series: null,
        rewards: [],
      };
    }
    return {
      id: a.id,
      category: a.category,
      title: a.title,
      description: a.description,
      hidden: a.hidden,
      unlocked: Boolean(at),
      unlockedAt: at?.toISOString() ?? null,
      progress: Math.min(values.get(a.metric) ?? 0, a.target),
      target: a.target,
      series: a.series,
      rewards: a.rewards,
    };
  });
  const categories = [...new Set(catalog.achievements.map((a) => a.category))].map((id) => {
    const list = catalog.achievements.filter((a) => a.category === id);
    return { id, unlocked: list.filter((a) => unlockedAt.has(a.id)).length, total: list.length };
  });
  const known = new Set(catalog.achievements.map((a) => a.id));
  return {
    achievements,
    categories,
    unlocked: rows.filter((r) => known.has(r.achievementId)).length,
    total: catalog.achievements.length,
  };
}

/**
 * Tells the player about fresh unlocks over the realtime gateway (toast and
 * notification bell). Call after the transaction that unlocked them commits.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @param unlocks - What was unlocked.
 */
export async function notifyUnlocks(
  ctx: Pick<AppContext, 'notifier'>,
  userId: string,
  unlocks: readonly Pick<AchievementUnlock, 'title' | 'id'>[],
): Promise<void> {
  for (const u of unlocks) {
    await ctx.notifier.notifyUser(userId, {
      type: 'notification',
      kind: 'reward',
      title: 'Achievement unlocked!',
      body: u.title,
      achievementId: u.id,
    });
  }
}
