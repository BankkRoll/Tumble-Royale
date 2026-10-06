/**
 * The Crown Shard shop: `GET /shop/shards` and `POST /shop/shards/buy`.
 *
 * The weekly shelf is a pure function of the ISO week (content
 * `shardShopAt`), so every instance agrees without storing it. Purchases
 * follow the store's idempotency model: the `purchases` row is inserted first
 * inside the transaction, so a concurrent retry with the same key blocks on
 * the unique index and then replays the stored response.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { inventoryItems, purchases } from '../db/schema.ts';
import { optionalUser, requireUser } from '../http/auth.ts';
import { ApiError, conflict, isUniqueViolation, parse } from '../http/errors.ts';
import { applyLedger, lockWallet, type Wallet } from './ledger.ts';
import { grantCosmetic, readWallet } from './wallet.ts';

const BuyBody = z.object({ offerId: z.string().min(3).max(64) });

/** Response of `POST /shop/shards/buy`, stored and replayed verbatim on retries. */
export interface ShardPurchaseResult {
  purchaseId: string;
  offerId: string;
  price: { currency: 'crown_shards'; amount: number };
  wallet: Wallet;
  replayed: boolean;
}

function replay(row: typeof purchases.$inferSelect, offerId: string): ShardPurchaseResult {
  if (row.kind !== 'shard_item' || row.itemId !== offerId)
    throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
  if (row.status !== 'completed' || !row.response)
    throw conflict('purchase_in_progress', 'A purchase with this key is still being processed');
  return { ...(row.response as ShardPurchaseResult), replayed: true };
}

/**
 * Buys this week's shard offer.
 *
 * @param ctx - API context.
 * @param userId - Buyer.
 * @param key - Idempotency-Key.
 * @param offerId - Cosmetic id on this week's shelf.
 * @throws {ApiError} 404 `offer_not_available`, 409 `already_owned` / key reuse, 402 `insufficient_funds`.
 */
export async function buyShardOffer(
  ctx: AppContext,
  userId: string,
  key: string,
  offerId: string,
): Promise<ShardPurchaseResult> {
  const findExisting = async (db: DbOrTx) =>
    (
      await db
        .select()
        .from(purchases)
        .where(and(eq(purchases.userId, userId), eq(purchases.idempotencyKey, key)))
    )[0];
  try {
    return await ctx.db.transaction(async (tx) => {
      // SECURITY: ownership is read under the wallet lock, or two purchases
      // with different keys both see "not owned" and both pay.
      await lockWallet(tx, userId);
      const existing = await findExisting(tx);
      if (existing) return replay(existing, offerId);
      const offer = ctx.catalog.shardShop(ctx.now()).offers.find((o) => o.itemId === offerId);
      if (!offer)
        throw new ApiError(404, 'offer_not_available', 'That item is not in the Crown Shard shop this week');
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
        kind: 'shard_item',
        itemId: offerId,
        currency: 'crown_shards',
        price: offer.price,
        status: 'pending',
      });
      await applyLedger(tx, {
        userId,
        currency: 'crown_shards',
        delta: -offer.price,
        reason: 'shard_shop',
        ref: purchaseId,
      });
      await grantCosmetic(tx, userId, offerId, 'shards');
      const result: ShardPurchaseResult = {
        purchaseId,
        offerId,
        price: { currency: 'crown_shards', amount: offer.price },
        wallet: await readWallet(tx, userId),
        replayed: false,
      };
      await tx
        .update(purchases)
        .set({ status: 'completed', response: result, completedAt: ctx.now() })
        .where(eq(purchases.id, purchaseId));
      return result;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findExisting(ctx.db);
      if (existing) return replay(existing, offerId);
    }
    throw err;
  }
}

/**
 * Registers the shard shop routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 * @param idempotencyKey - Header reader shared with the store.
 */
export function registerShardShopRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  idempotencyKey: (req: Parameters<typeof requireUser>[1]) => string,
): void {
  app.get('/shop/shards', async (req) => {
    const auth = await optionalUser(ctx, req);
    const now = ctx.now();
    const shelf = ctx.catalog.shardShop(now);
    let owned = new Set<string>();
    let balance: number | null = null;
    if (auth) {
      const rows = await ctx.db
        .select({ id: inventoryItems.cosmeticId })
        .from(inventoryItems)
        .where(eq(inventoryItems.userId, auth.userId));
      owned = new Set(rows.map((r) => r.id));
      balance = (await readWallet(ctx.db, auth.userId)).crownShards;
    }
    return {
      week: shelf.week,
      refreshesAt: shelf.refreshesAt,
      secondsRemaining: Math.max(0, Math.floor((Date.parse(shelf.refreshesAt) - now.getTime()) / 1000)),
      shardsPerCrown: ctx.catalog.shardsPerCrown,
      balance,
      offers: shelf.offers.map((o) => ({
        offerId: o.itemId,
        item: ctx.cosmetics.get(o.itemId) ?? null,
        price: { currency: 'crown_shards' as const, amount: o.price },
        owned: owned.has(o.itemId),
      })),
    };
  });

  app.post(
    '/shop/shards/buy',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const key = idempotencyKey(req);
      const { offerId } = parse(BuyBody, req.body);
      const result = await buyShardOffer(ctx, auth.userId, key, offerId);
      if (!result.replayed) await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...result.wallet });
      return result;
    },
  );
}
