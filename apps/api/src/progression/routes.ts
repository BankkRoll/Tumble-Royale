/**
 * `/seasons`, `/pass`, `/challenges`, `/achievements`, `/collection` and
 * `/streak` routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COSMETIC_SLOTS, type CatalogSeason } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import { idempotencyKey } from '../economy/routes.ts';
import { requireUser } from '../http/auth.ts';
import { parse } from '../http/errors.ts';
import { achievementsView, notifyUnlocks, unlockAchievements } from './achievements.ts';
import { challengesView, claimChallenge, rerollChallenge } from './challenges.ts';
import { collectionView } from './collection.ts';
import { claimTier, passState, unlockPremium } from './pass.ts';
import { claimLoginStreak, streakView } from './streak.ts';
import { addXp } from './xp.ts';

const ClaimTierBody = z.object({
  tier: z.number().int().min(1).max(1000),
  track: z.enum(['free', 'premium']),
});
const ChallengeIdBody = z.object({ id: z.string().uuid() });
const CollectionQuery = z
  .object({
    slot: z.enum(COSMETIC_SLOTS).optional(),
    rarity: z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']).optional(),
    owned: z.enum(['true', 'false']).optional(),
  })
  .strict();
const NoQuery = z.object({}).strict();

/** Reads are cheap but write on first view (unlocks); limited per player like other meta reads. */
const READ_RATE = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const CLAIM_RATE = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/**
 * Registers progression routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerProgressionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/seasons', async () => {
    const now = ctx.now();
    const current = ctx.catalog.season;
    const view = (s: CatalogSeason) => ({
      id: s.id,
      number: s.number,
      name: s.name,
      theme: s.theme,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
    });
    return {
      current: view(current),
      next: view(ctx.catalog.nextSeason(current)),
      secondsRemaining: Math.max(0, Math.floor((Date.parse(current.endsAt) - now.getTime()) / 1000)),
    };
  });

  app.get('/pass', async (req) => {
    const auth = await requireUser(ctx, req);
    return passState(ctx, auth.userId);
  });

  app.post('/pass/claim', async (req) => {
    const auth = await requireUser(ctx, req);
    const body = parse(ClaimTierBody, req.body);
    return claimTier(ctx, auth.userId, body.tier, body.track);
  });

  app.post('/pass/premium', async (req) => {
    const auth = await requireUser(ctx, req);
    return unlockPremium(ctx, auth.userId, idempotencyKey(req));
  });

  app.get('/challenges', async (req) => {
    const auth = await requireUser(ctx, req);
    return ctx.db.transaction((tx) => challengesView(tx, ctx.catalog, auth.userId, ctx.now()));
  });

  app.post('/challenges/reroll', async (req) => {
    const auth = await requireUser(ctx, req);
    const { id } = parse(ChallengeIdBody, req.body);
    return ctx.db.transaction((tx) => rerollChallenge(tx, ctx.catalog, auth.userId, id, ctx.now()));
  });

  app.post('/challenges/claim', async (req) => {
    const auth = await requireUser(ctx, req);
    const { id } = parse(ChallengeIdBody, req.body);
    return ctx.db.transaction((tx) => claimChallenge(tx, ctx.catalog, auth.userId, id, ctx.now()));
  });

  // Unlocks anything already earned but not yet recorded (items bought since
  // the last show, history backfilled by migration) before answering.
  app.get('/achievements', { config: READ_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    parse(NoQuery, req.query);
    const result = await ctx.db.transaction(async (tx) => {
      const unlocked = await unlockAchievements(tx, ctx.catalog, auth.userId, ctx.now());
      if (unlocked.xp > 0) await addXp(tx, ctx.catalog, auth.userId, unlocked.xp);
      return {
        ...(await achievementsView(tx, ctx.catalog, auth.userId, ctx.now())),
        newlyUnlocked: unlocked.unlocks,
      };
    });
    await notifyUnlocks(ctx, auth.userId, result.newlyUnlocked);
    return result;
  });

  app.get('/collection', { config: READ_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    const q = parse(CollectionQuery, req.query);
    return collectionView(ctx.db, ctx.catalog, auth.userId, {
      ...(q.slot ? { slot: q.slot } : {}),
      ...(q.rarity ? { rarity: q.rarity } : {}),
      ...(q.owned ? { owned: q.owned === 'true' } : {}),
    });
  });

  app.get('/streak', { config: READ_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    parse(NoQuery, req.query);
    return streakView(ctx.db, ctx.catalog, auth.userId, ctx.now());
  });

  app.post('/streak/claim', { config: CLAIM_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    if (req.body !== undefined) parse(NoQuery, req.body);
    const claim = await ctx.db.transaction((tx) => claimLoginStreak(tx, ctx.catalog, auth.userId, ctx.now()));
    await notifyUnlocks(ctx, auth.userId, claim.achievements);
    await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...claim.wallet });
    return { ...claim, view: await streakView(ctx.db, ctx.catalog, auth.userId, ctx.now()) };
  });
}
