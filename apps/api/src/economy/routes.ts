/**
 * Store, purchases, wallet, Gem checkout and the Stripe webhook.
 *
 * Purchases are idempotent per `(user, Idempotency-Key)`: the purchase row is
 * inserted first inside the transaction, so a concurrent retry with the same
 * key blocks on the unique index and then replays the stored response.
 * Everything sold is cosmetic; there is no code path that sells gameplay effects.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { currenciesLedger, inventoryItems, purchases } from '../db/schema.ts';
import { optionalUser, requireUser } from '../http/auth.ts';
import { ApiError, badRequest, conflict, isUniqueViolation, notFound, parse } from '../http/errors.ts';
import { applyLedger, type Wallet } from './ledger.ts';
import { grantCosmetic, readWallet } from './wallet.ts';
import { currentRotation } from './store.ts';

const PurchaseBody = z.object({
  offerId: z.string().min(3).max(64),
  currency: z.enum(['gumballs', 'gems']).optional(),
});
const CheckoutBody = z.object({ packId: z.string().min(1).max(64) });
const KeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8–128 URL-safe characters');

/** Reads and validates the `Idempotency-Key` header. */
export function idempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string') throw badRequest('idempotency_key_required', 'Idempotency-Key header is required');
  return parse(KeySchema, raw);
}

/** Response of `/purchase`, stored and replayed verbatim on retries. */
export interface PurchaseResult {
  purchaseId: string;
  offerId: string;
  price: { currency: 'gumballs' | 'gems'; amount: number };
  wallet: Wallet;
  replayed: boolean;
}

function replay(row: typeof purchases.$inferSelect, kind: string, itemId: string): PurchaseResult {
  if (row.kind !== kind || row.itemId !== itemId) {
    throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
  }
  if (row.status !== 'completed' || !row.response) {
    throw conflict('purchase_in_progress', 'A purchase with this key is still being processed');
  }
  return { ...(row.response as PurchaseResult), replayed: true };
}

/**
 * Buys a store offer with Gumballs or Gems.
 *
 * @throws {ApiError} 404 offer unavailable, 409 already owned / key reuse, 402 insufficient funds.
 */
export async function purchaseOffer(
  ctx: AppContext,
  userId: string,
  key: string,
  offerId: string,
  currency: 'gumballs' | 'gems' | undefined,
): Promise<PurchaseResult> {
  const findExisting = async (db: DbOrTx) =>
    (await db.select().from(purchases).where(and(eq(purchases.userId, userId), eq(purchases.idempotencyKey, key))))[0];
  try {
    return await ctx.db.transaction(async (tx) => {
      const existing = await findExisting(tx);
      if (existing) return replay(existing, 'cosmetic', offerId);
      const rotation = await currentRotation(tx, ctx.catalog, ctx.now());
      const offer = [...rotation.featured, ...rotation.daily].find((o) => o.offerId === offerId);
      if (!offer) throw new ApiError(404, 'offer_not_available', 'That item is not in the store today');
      if (currency && currency !== offer.price.currency) {
        throw badRequest('currency_mismatch', `This item costs ${offer.price.currency}`);
      }
      const [owned] = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.userId, userId), eq(inventoryItems.cosmeticId, offerId)));
      if (owned) throw conflict('already_owned', 'You already own this item');

      const purchaseId = randomUUID();
      await tx.insert(purchases).values({
        id: purchaseId,
        userId,
        idempotencyKey: key,
        kind: 'cosmetic',
        itemId: offerId,
        currency: offer.price.currency,
        price: offer.price.amount,
        status: 'pending',
      });
      await applyLedger(tx, { userId, currency: offer.price.currency, delta: -offer.price.amount, reason: 'purchase', ref: purchaseId });
      await grantCosmetic(tx, userId, offerId, 'store');
      const result: PurchaseResult = { purchaseId, offerId, price: offer.price, wallet: await readWallet(tx, userId), replayed: false };
      await tx
        .update(purchases)
        .set({ status: 'completed', response: result, completedAt: ctx.now() })
        .where(eq(purchases.id, purchaseId));
      return result;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findExisting(ctx.db);
      if (existing) return replay(existing, 'cosmetic', offerId);
    }
    throw err;
  }
}

/**
 * Credits a Gem pack purchase exactly once (webhook or fake provider).
 *
 * @returns True when Gems were granted by this call.
 */
export async function completeGemPurchase(ctx: AppContext, purchaseId: string, providerRef: string | null): Promise<boolean> {
  const granted = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).for('update');
    if (!row || row.kind !== 'gem_pack') return null;
    if (row.status === 'completed') return null;
    const pack = ctx.catalog.gemPacks.find((p) => p.id === row.itemId);
    if (!pack) throw new Error(`gem pack ${row.itemId} vanished from the catalog`);
    await applyLedger(tx, { userId: row.userId, currency: 'gems', delta: pack.gems, reason: 'gem_pack', ref: purchaseId });
    await tx
      .update(purchases)
      .set({ status: 'completed', completedAt: ctx.now(), ...(providerRef ? { providerRef } : {}) })
      .where(eq(purchases.id, purchaseId));
    return { userId: row.userId, wallet: await readWallet(tx, row.userId) };
  });
  if (!granted) return false;
  await ctx.notifier.notifyUser(granted.userId, { type: 'wallet', ...granted.wallet });
  return true;
}

/**
 * Registers economy routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerEconomyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/store', async (req) => {
    const auth = await optionalUser(ctx, req);
    const now = ctx.now();
    const rotation = await currentRotation(ctx.db, ctx.catalog, now);
    let owned = new Set<string>();
    if (auth) {
      const rows = await ctx.db.select({ id: inventoryItems.cosmeticId }).from(inventoryItems).where(eq(inventoryItems.userId, auth.userId));
      owned = new Set(rows.map((r) => r.id));
    }
    const mark = <T extends { offerId: string }>(o: T) => ({ ...o, owned: owned.has(o.offerId) });
    return {
      day: rotation.day,
      featured: rotation.featured.map(mark),
      daily: rotation.daily.map(mark),
      refreshesAt: rotation.refreshesAt,
      secondsRemaining: Math.max(0, Math.floor((Date.parse(rotation.refreshesAt) - now.getTime()) / 1000)),
    };
  });

  app.post('/purchase', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const key = idempotencyKey(req);
    const body = parse(PurchaseBody, req.body);
    const result = await purchaseOffer(ctx, auth.userId, key, body.offerId, body.currency);
    if (!result.replayed) await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...result.wallet });
    return result;
  });

  app.get('/wallet', async (req) => {
    const auth = await requireUser(ctx, req);
    const recent = await ctx.db
      .select()
      .from(currenciesLedger)
      .where(eq(currenciesLedger.userId, auth.userId))
      .orderBy(desc(currenciesLedger.id))
      .limit(50);
    return {
      wallet: await readWallet(ctx.db, auth.userId),
      recent: recent.map((r) => ({
        currency: r.currency,
        delta: r.delta,
        balanceAfter: r.balanceAfter,
        reason: r.reason,
        ref: r.ref,
        at: r.createdAt.toISOString(),
      })),
    };
  });

  app.get('/gems/packs', async () => ({ provider: ctx.payments.id, packs: ctx.catalog.gemPacks }));

  app.post('/gems/checkout', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const key = idempotencyKey(req);
    const { packId } = parse(CheckoutBody, req.body);
    const pack = ctx.catalog.gemPacks.find((p) => p.id === packId);
    if (!pack) throw notFound('Gem pack');

    const [existing] = await ctx.db
      .select()
      .from(purchases)
      .where(and(eq(purchases.userId, auth.userId), eq(purchases.idempotencyKey, key)));
    if (existing) {
      if (existing.kind !== 'gem_pack' || existing.itemId !== packId) {
        throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
      }
      return { ...(existing.response as object), status: existing.status, replayed: true };
    }

    const purchaseId = randomUUID();
    try {
      await ctx.db.insert(purchases).values({
        id: purchaseId,
        userId: auth.userId,
        idempotencyKey: key,
        kind: 'gem_pack',
        itemId: pack.id,
        currency: pack.currency,
        price: pack.priceCents,
        status: 'pending',
        provider: ctx.payments.id,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('purchase_in_progress', 'A checkout with this key is already being created');
      throw err;
    }
    const base = ctx.config.publicWebUrl;
    const session = await ctx.payments.createCheckout({
      purchaseId,
      userId: auth.userId,
      pack,
      successUrl: `${base}/store?checkout=success&purchase=${purchaseId}`,
      cancelUrl: `${base}/store?checkout=cancel&purchase=${purchaseId}`,
    });
    const response = { purchaseId, packId: pack.id, gems: pack.gems, checkoutUrl: session.url, provider: ctx.payments.id };
    await ctx.db.update(purchases).set({ providerRef: session.providerRef, response }).where(eq(purchases.id, purchaseId));
    if (session.completed) await completeGemPurchase(ctx, purchaseId, session.providerRef);
    return { ...response, status: session.completed ? 'completed' : 'pending', replayed: false };
  });

  app.post('/webhooks/stripe', { config: { rateLimit: false } }, async (req) => {
    const sig = req.headers['stripe-signature'];
    const event = ctx.payments.parseWebhook(req.rawBody ?? '', typeof sig === 'string' ? sig : undefined);
    if (event.type === 'checkout_completed') {
      let purchaseId = event.purchaseId;
      if (!purchaseId && event.providerRef) {
        const [row] = await ctx.db.select({ id: purchases.id }).from(purchases).where(eq(purchases.providerRef, event.providerRef));
        purchaseId = row?.id ?? null;
      }
      if (purchaseId) await completeGemPurchase(ctx, purchaseId, event.providerRef);
    } else if (event.type === 'checkout_expired' && event.purchaseId) {
      await ctx.db
        .update(purchases)
        .set({ status: 'expired' })
        .where(and(eq(purchases.id, event.purchaseId), eq(purchases.status, 'pending')));
    }
    return { received: true };
  });
}
