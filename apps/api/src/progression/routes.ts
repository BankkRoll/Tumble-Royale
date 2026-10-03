/**
 * `/pass` and `/challenges` routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { idempotencyKey } from '../economy/routes.ts';
import { requireUser } from '../http/auth.ts';
import { parse } from '../http/errors.ts';
import { challengesView, claimChallenge, rerollChallenge } from './challenges.ts';
import { claimTier, passState, unlockPremium } from './pass.ts';

const ClaimTierBody = z.object({ tier: z.number().int().min(1).max(1000), track: z.enum(['free', 'premium']) });
const ChallengeIdBody = z.object({ id: z.string().uuid() });

/**
 * Registers progression routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerProgressionRoutes(app: FastifyInstance, ctx: AppContext): void {
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
}
