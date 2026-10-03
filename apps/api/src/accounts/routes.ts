/**
 * `/me`, `/profile/:id`, `/inventory` and `/loadouts` routes.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { authIdentities, inventoryItems, loadouts, profiles, users } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { conflict, notFound, parse } from '../http/errors.ts';
import { LOADOUT_COUNT, LoadoutItemsSchema, validateLoadout } from '../inventory/loadout.ts';
import { changeDisplayName, getProfileCard, REGIONS } from './accounts.ts';

const PatchMe = z.object({
  displayName: z.string().max(32).optional(),
  region: z.enum(REGIONS).optional(),
});
const IdParam = z.object({ id: z.string().uuid() });
const IndexParam = z.object({ index: z.coerce.number().int().min(0).max(LOADOUT_COUNT - 1) });
const PutLoadout = z.object({ name: z.string().trim().min(1).max(24).optional(), items: LoadoutItemsSchema });

/** Owned cosmetic ids for a user. */
export async function ownedSet(ctx: AppContext, userId: string): Promise<Set<string>> {
  const rows = await ctx.db.select({ id: inventoryItems.cosmeticId }).from(inventoryItems).where(eq(inventoryItems.userId, userId));
  return new Set(rows.map((r) => r.id));
}

/**
 * Registers account routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/me', async (req) => {
    const auth = await requireUser(ctx, req);
    const card = await getProfileCard(ctx.db, ctx.catalog, auth.userId);
    const [extra] = await ctx.db
      .select({ email: users.email, isGuest: users.isGuest, p: profiles })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, auth.userId));
    const linked = await ctx.db.select({ provider: authIdentities.provider }).from(authIdentities).where(eq(authIdentities.userId, auth.userId));
    return {
      ...card,
      email: extra?.email ?? null,
      isGuest: extra?.isGuest ?? true,
      wallet: { gumballs: extra?.p.gumballs ?? 0, gems: extra?.p.gems ?? 0, crownShards: extra?.p.crownShards ?? 0 },
      activeLoadout: extra?.p.activeLoadout ?? 0,
      nameChangedAt: extra?.p.nameChangedAt?.toISOString() ?? null,
      linkedProviders: [...new Set(linked.map((l) => l.provider))],
    };
  });

  app.patch('/me', async (req) => {
    const auth = await requireUser(ctx, req);
    const body = parse(PatchMe, req.body);
    return ctx.db.transaction(async (tx) => {
      let name: { displayName: string; tag: string } | undefined;
      if (body.displayName !== undefined) {
        name = await changeDisplayName(tx, auth.userId, body.displayName, ctx.now(), ctx.config.nameChangeCooldownDays);
      }
      if (body.region) await tx.update(users).set({ region: body.region }).where(eq(users.id, auth.userId));
      return { ...(name ?? {}), ...(body.region ? { region: body.region } : {}) };
    });
  });

  app.get('/profile/:id', async (req) => {
    await requireUser(ctx, req);
    const { id } = parse(IdParam, req.params);
    return getProfileCard(ctx.db, ctx.catalog, id);
  });

  app.get('/inventory', async (req) => {
    const auth = await requireUser(ctx, req);
    const rows = await ctx.db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.userId, auth.userId))
      .orderBy(asc(inventoryItems.acquiredAt));
    return {
      items: rows.map((r) => ({
        id: r.cosmeticId,
        source: r.source,
        acquiredAt: r.acquiredAt.toISOString(),
        item: ctx.cosmetics.get(r.cosmeticId) ?? null,
      })),
    };
  });

  app.get('/loadouts', async (req) => {
    const auth = await requireUser(ctx, req);
    const rows = await ctx.db.select().from(loadouts).where(eq(loadouts.userId, auth.userId));
    const [p] = await ctx.db.select({ active: profiles.activeLoadout }).from(profiles).where(eq(profiles.userId, auth.userId));
    const slots = Array.from({ length: LOADOUT_COUNT }, (_, i) => {
      const r = rows.find((x) => x.slotIndex === i);
      return r ? { index: i, name: r.name, items: r.items, updatedAt: r.updatedAt.toISOString() } : null;
    });
    return { activeIndex: p?.active ?? 0, slots };
  });

  app.put('/loadouts/:index', async (req) => {
    const auth = await requireUser(ctx, req);
    const { index } = parse(IndexParam, req.params);
    const body = parse(PutLoadout, req.body);
    validateLoadout(body.items, ctx.cosmetics, await ownedSet(ctx, auth.userId));
    const name = body.name ?? `Loadout ${index + 1}`;
    const now = ctx.now();
    await ctx.db
      .insert(loadouts)
      .values({ userId: auth.userId, slotIndex: index, name, items: body.items, updatedAt: now })
      .onConflictDoUpdate({ target: [loadouts.userId, loadouts.slotIndex], set: { name, items: body.items, updatedAt: now } });
    return { index, name, items: body.items };
  });

  app.delete('/loadouts/:index', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { index } = parse(IndexParam, req.params);
    const [p] = await ctx.db.select({ active: profiles.activeLoadout }).from(profiles).where(eq(profiles.userId, auth.userId));
    if (p?.active === index) throw conflict('loadout_active', 'Cannot delete the active loadout');
    await ctx.db.delete(loadouts).where(and(eq(loadouts.userId, auth.userId), eq(loadouts.slotIndex, index)));
    return reply.code(204).send();
  });

  app.post('/loadouts/:index/activate', async (req) => {
    const auth = await requireUser(ctx, req);
    const { index } = parse(IndexParam, req.params);
    const [row] = await ctx.db
      .select({ items: loadouts.items })
      .from(loadouts)
      .where(and(eq(loadouts.userId, auth.userId), eq(loadouts.slotIndex, index)));
    if (!row) throw notFound('Loadout');
    await ctx.db.update(profiles).set({ activeLoadout: index }).where(eq(profiles.userId, auth.userId));
    return { activeIndex: index, items: row.items };
  });
}
