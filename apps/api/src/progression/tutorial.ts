/**
 * `POST /me/tutorial-complete`: the one-time Practice Island reward for an
 * account (XP + the Fresh Mint nameplate, `TUTORIAL_REWARD` in
 * `@tumble/content/progression`).
 *
 * Idempotency: the grant runs in one transaction that first locks the
 * player's `profiles` row, then looks for the account's audit row in `events`
 * (name {@link TUTORIAL_GRANT_EVENT}). Concurrent calls serialise on the row
 * lock, so exactly one of them writes the audit row and grants; every other
 * call answers `granted: false`.
 */
import { TUTORIAL_REWARD } from '@tumble/content/progression';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { events, profiles } from '../db/schema.ts';
import { grantCosmetic } from '../economy/wallet.ts';
import { requireUser } from '../http/auth.ts';
import { notFound } from '../http/errors.ts';
import { addXp } from './xp.ts';

/**
 * Audit event written once per account when the reward is granted.
 *
 * SECURITY: the colon is outside the public `/events` name pattern
 * (`[a-z0-9_.]`), so a client cannot forge this row.
 */
export const TUTORIAL_GRANT_EVENT = 'grant:tutorial_complete';

/** Response of `POST /me/tutorial-complete`. */
export interface TutorialCompleteResult {
  /** True when this call granted the reward; false on every repeat. */
  granted: boolean;
  /** XP added by this call (0 on repeats). */
  xp: number;
  /** Cosmetic id unlocked by this call, or null (repeat, or already owned). */
  unlock: string | null;
  /** Account level and total XP after the call. */
  level: number;
  totalXp: number;
}

/**
 * Grants the tutorial reward once per account.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services (catalog for levels/season, cosmetics index).
 * @param userId - The account.
 * @returns What was granted.
 */
export async function completeTutorial(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
): Promise<TutorialCompleteResult> {
  const [p] = await tx
    .select({ xp: profiles.xp, level: profiles.level })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  if (!p) throw notFound('Profile not found');
  const [done] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.name, TUTORIAL_GRANT_EVENT)))
    .limit(1);
  if (done) return { granted: false, xp: 0, unlock: null, level: p.level, totalXp: p.xp };

  const cosmeticId = ctx.cosmetics.has(TUTORIAL_REWARD.cosmeticId) ? TUTORIAL_REWARD.cosmeticId : null;
  const unlocked = cosmeticId ? await grantCosmetic(tx, userId, cosmeticId, 'tutorial') : false;
  const xp = await addXp(tx, ctx.catalog, userId, TUTORIAL_REWARD.xp);
  await tx.insert(events).values({
    userId,
    name: TUTORIAL_GRANT_EVENT,
    props: { xp: TUTORIAL_REWARD.xp, cosmeticId, unlocked, xpBefore: xp.xpBefore, xpAfter: xp.xpAfter },
  });
  return {
    granted: true,
    xp: TUTORIAL_REWARD.xp,
    unlock: unlocked ? cosmeticId : null,
    level: xp.levelAfter,
    totalXp: xp.xpAfter,
  };
}

/**
 * Registers the tutorial reward route.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerTutorialRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/me/tutorial-complete', async (req) => {
    const auth = await requireUser(ctx, req);
    return ctx.db.transaction((tx) => completeTutorial(tx, ctx, auth.userId));
  });
}
