/**
 * Gifts in the admin console:
 *
 * - `GET /internal/users/:id/gifts` (moderator) — every gift the player sent
 *   and received, with both parties and each gift's ledger rows.
 * - `POST /internal/gifts/:id/reverse` `{ reason }` (admin) — refunds the
 *   sender and, for an opened gift, takes back what the recipient still holds
 *   because of it.
 *
 * Reversing moves currency, so it needs the `admin` role and writes its audit
 * row in the reversal's own transaction.
 */
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { currenciesLedger, gifts } from '../db/schema.ts';
import { notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { announceReversal, giftViews, reverseGift, settleExpiredGifts } from './gifts.ts';

const UUID = z.string().uuid();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
const ReverseBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * Registers the gift admin routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerGiftAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/users/:id/gifts', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { limit } = parse(ListQuery, req.query);
    await settleExpiredGifts(ctx, { userId: id }, 50);
    const [sent, received] = await Promise.all([
      ctx.db.select().from(gifts).where(eq(gifts.senderId, id)).orderBy(desc(gifts.createdAt)).limit(limit),
      ctx.db
        .select()
        .from(gifts)
        .where(eq(gifts.recipientId, id))
        .orderBy(desc(gifts.createdAt))
        .limit(limit),
    ]);
    const refs = [...sent, ...received].map((g) => `gift:${g.id}`);
    const ledger =
      refs.length === 0
        ? []
        : await ctx.db
            .select({
              userId: currenciesLedger.userId,
              currency: currenciesLedger.currency,
              delta: currenciesLedger.delta,
              reason: currenciesLedger.reason,
              ref: currenciesLedger.ref,
              createdAt: currenciesLedger.createdAt,
            })
            .from(currenciesLedger)
            .where(
              and(
                inArray(currenciesLedger.ref, refs),
                or(eq(currenciesLedger.reason, 'gift'), eq(currenciesLedger.reason, 'gift_refund')),
              ),
            )
            .orderBy(currenciesLedger.id);
    const byGift = new Map<string, typeof ledger>();
    for (const row of ledger) {
      const key = row.ref.slice('gift:'.length);
      byGift.set(key, [...(byGift.get(key) ?? []), row]);
    }
    const withLedger = async (rows: typeof sent) =>
      (await giftViews(ctx, ctx.db, rows)).map((v) => ({ ...v, ledger: byGift.get(v.giftId) ?? [] }));
    return { userId: id, sent: await withLedger(sent), received: await withLedger(received) };
  });

  app.post('/internal/gifts/:id/reverse', async (req) => {
    const actor = await requireStaff(ctx, req, 'admin');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { reason } = parse(ReverseBody, req.body);
    const reversal = await ctx.db.transaction(async (tx) => {
      const r = await reverseGift(tx, ctx, id);
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'gift.reverse',
          targetType: 'gift',
          targetId: id,
          reason,
          details: {
            senderId: r.gift.senderId,
            recipientId: r.gift.recipientId,
            offerId: r.gift.offerId,
            price: { currency: r.gift.currency, amount: r.gift.price },
            previousStatus: r.previousStatus,
            revoked: r.revoked,
            refunded: r.refunded,
          },
        },
        tx,
      );
      return r;
    });
    await announceReversal(ctx, reversal);
    const [row] = await ctx.db.select().from(gifts).where(eq(gifts.id, id));
    if (!row) throw notFound('Gift');
    const [view] = await giftViews(ctx, ctx.db, [row]);
    return {
      gift: view,
      previousStatus: reversal.previousStatus,
      revoked: reversal.revoked,
      loadoutsChanged: reversal.loadoutsChanged,
      refunded: reversal.refunded,
    };
  });
}
