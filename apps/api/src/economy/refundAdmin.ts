/**
 * The admin console's refund queue.
 *
 * - `GET /internal/refunds` (moderator) — requests and self-service refunds,
 *   filtered by status (`open` = still awaiting a decision) and kind, paged.
 * - `GET /internal/refunds/:id` (moderator) — one refund with its purchase,
 *   the player's balances, their refund history and the purchase's ledger rows.
 * - `POST /internal/refunds/:id/approve` `{ note? }` (admin) — with Stripe
 *   configured, issues a Stripe refund for the whole payment (`processing`);
 *   otherwise marks the request `manual` for staff to refund by hand. Either
 *   way the Gems move only when Stripe's `charge.refunded` webhook arrives.
 * - `POST /internal/refunds/:id/deny` `{ reason }` (moderator) — the reason
 *   is shown to the player.
 *
 * Approving moves real money, so it needs the `admin` role; denying moves
 * nothing and moderators may do it. Every decision writes its audit row in the
 * same transaction as the status change.
 */
import { and, count, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { currenciesLedger, profiles, purchases, refunds, users } from '../db/schema.ts';
import { ApiError, conflict, notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff, type StaffActor } from '../staff/auth.ts';
import { DECIDABLE_REFUND_STATUSES, type RefundStatus } from './refunds.ts';

const UUID = z.string().uuid();
const STATUSES = [
  'completed',
  'pending',
  'processing',
  'manual',
  'refunded',
  'partially_refunded',
  'denied',
  'failed',
] as const satisfies readonly RefundStatus[];
const ListQuery = z.object({
  /** A status, `open` (pending or failed) or `all`. */
  status: z.enum([...STATUSES, 'open', 'all']).default('open'),
  kind: z.enum(['self_service', 'real_money']).optional(),
  userId: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const ApproveBody = z
  .object({ note: z.string().trim().min(3).max(500).optional() })
  .strict()
  .optional();
const DenyBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const person = {
  displayName: profiles.displayName,
  tag: profiles.tag,
};

/**
 * Registers the refund queue routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerRefundAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/refunds', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ListQuery, req.query);
    const conds: (SQL | undefined)[] = [
      q.status === 'all'
        ? undefined
        : q.status === 'open'
          ? inArray(refunds.status, [...DECIDABLE_REFUND_STATUSES])
          : eq(refunds.status, q.status),
      q.kind ? eq(refunds.kind, q.kind) : undefined,
      q.userId ? eq(refunds.userId, q.userId) : undefined,
    ];
    const where = and(...conds);
    const [rows, [{ n: total } = { n: 0 }]] = await Promise.all([
      ctx.db
        .select({
          id: refunds.id,
          userId: refunds.userId,
          purchaseId: refunds.purchaseId,
          kind: refunds.kind,
          status: refunds.status,
          currency: refunds.currency,
          amount: refunds.amount,
          items: refunds.items,
          playerReason: refunds.playerReason,
          decisionReason: refunds.decisionReason,
          decidedBy: refunds.decidedBy,
          decidedAt: refunds.decidedAt,
          lastError: refunds.lastError,
          createdAt: refunds.createdAt,
          offerId: purchases.itemId,
          purchasedAt: purchases.completedAt,
          ...person,
        })
        .from(refunds)
        .innerJoin(purchases, eq(purchases.id, refunds.purchaseId))
        .leftJoin(profiles, eq(profiles.userId, refunds.userId))
        .where(where)
        // The open queue is worked oldest first; history reads newest first.
        .orderBy(q.status === 'open' ? refunds.createdAt : desc(refunds.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      ctx.db.select({ n: count() }).from(refunds).where(where),
    ]);
    return { total, offset: q.offset, limit: q.limit, refunds: rows };
  });

  app.get('/internal/refunds/:id', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const [refund] = await ctx.db.select().from(refunds).where(eq(refunds.id, id));
    if (!refund) throw notFound('Refund');
    const [[purchase], [player], history, [{ n: purchaseCount } = { n: 0 }], ledger] = await Promise.all([
      ctx.db.select().from(purchases).where(eq(purchases.id, refund.purchaseId)),
      ctx.db
        .select({
          id: users.id,
          isGuest: users.isGuest,
          createdAt: users.createdAt,
          gumballs: profiles.gumballs,
          gems: profiles.gems,
          gemDebt: profiles.gemDebt,
          ...person,
        })
        .from(users)
        .innerJoin(profiles, eq(profiles.userId, users.id))
        .where(eq(users.id, refund.userId)),
      ctx.db
        .select({
          id: refunds.id,
          purchaseId: refunds.purchaseId,
          kind: refunds.kind,
          status: refunds.status,
          currency: refunds.currency,
          amount: refunds.amount,
          createdAt: refunds.createdAt,
        })
        .from(refunds)
        .where(eq(refunds.userId, refund.userId))
        .orderBy(desc(refunds.createdAt))
        .limit(50),
      ctx.db.select({ n: count() }).from(purchases).where(eq(purchases.userId, refund.userId)),
      ctx.db
        .select({
          currency: currenciesLedger.currency,
          delta: currenciesLedger.delta,
          balanceAfter: currenciesLedger.balanceAfter,
          reason: currenciesLedger.reason,
          ref: currenciesLedger.ref,
          createdAt: currenciesLedger.createdAt,
        })
        .from(currenciesLedger)
        .where(
          and(
            eq(currenciesLedger.userId, refund.userId),
            or(
              eq(currenciesLedger.ref, refund.purchaseId),
              eq(currenciesLedger.ref, `refund:${refund.purchaseId}`),
              like(currenciesLedger.ref, `${refund.purchaseId}:%`),
            ),
          ),
        )
        .orderBy(currenciesLedger.id),
    ]);
    return {
      refund,
      purchase: purchase
        ? {
            id: purchase.id,
            kind: purchase.kind,
            offerId: purchase.itemId,
            currency: purchase.currency,
            price: purchase.price,
            status: purchase.status,
            provider: purchase.provider,
            paymentIntent: purchase.paymentIntent,
            createdAt: purchase.createdAt,
            completedAt: purchase.completedAt,
          }
        : null,
      player: player ? { ...player, purchases: purchaseCount } : null,
      history,
      ledger,
      provider: ctx.payments.id,
    };
  });

  app.post('/internal/refunds/:id/approve', async (req) => {
    const actor = await requireStaff(ctx, req, 'admin');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const body = parse(ApproveBody, req.body ?? undefined);
    return approveRefund(ctx, req, actor, id, body?.note ?? null);
  });

  app.post('/internal/refunds/:id/deny', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { reason } = parse(DenyBody, req.body);
    const now = ctx.now();
    const row = await ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(refunds).where(eq(refunds.id, id)).for('update');
      if (!current) throw notFound('Refund');
      assertDecidable(current);
      const [updated] = await tx
        .update(refunds)
        .set({
          status: 'denied',
          decisionReason: reason,
          decidedBy: actor.label,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(refunds.id, id))
        .returning();
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'refund.deny',
          targetType: 'refund',
          targetId: id,
          reason,
          details: { userId: current.userId, purchaseId: current.purchaseId, from: current.status },
        },
        tx,
      );
      return updated!;
    });
    await ctx.notifier.notifyUser(row.userId, {
      type: 'notification',
      kind: 'info',
      title: 'Refund request declined',
      body: reason,
    });
    return { refund: row };
  });
}

function assertDecidable(row: typeof refunds.$inferSelect): void {
  if (row.kind !== 'real_money')
    throw conflict('refund_not_decidable', 'Self-service refunds complete on their own');
  if (!(DECIDABLE_REFUND_STATUSES as readonly string[]).includes(row.status))
    throw conflict('refund_already_decided', `This refund is already ${row.status}`, { status: row.status });
}

/**
 * Approves a real-money refund request.
 *
 * Two steps, because a Stripe call must not run inside a database
 * transaction: first the request moves to `processing` (or `manual`) with its
 * audit row, which also stops a second approval; then Stripe is asked to
 * refund. A Stripe failure moves the request to `failed` (approvable again,
 * with a fresh idempotency key). The `charge.refunded` webhook may land
 * before Stripe's answer does, so the second step only records the refund id
 * and never overwrites the status.
 *
 * @param ctx - Shared services.
 * @param req - The admin request (audit IP and log).
 * @param actor - The approving admin.
 * @param id - Refund id.
 * @param note - Optional staff note.
 * @returns The updated refund and how it will be paid out.
 * @throws {ApiError} 404, 409 `refund_already_decided`, 502 `payment_provider_error`.
 */
export async function approveRefund(
  ctx: AppContext,
  req: FastifyRequest,
  actor: StaffActor,
  id: string,
  note: string | null,
): Promise<{ refund: typeof refunds.$inferSelect; mode: 'stripe' | 'manual' }> {
  const now = ctx.now();
  const staged = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(refunds).where(eq(refunds.id, id)).for('update');
    if (!current) throw notFound('Refund');
    assertDecidable(current);
    const [purchase] = await tx.select().from(purchases).where(eq(purchases.id, current.purchaseId));
    if (!purchase) throw notFound('Purchase');
    if (purchase.status === 'disputed' || purchase.status === 'charged_back')
      throw conflict('refund_payment_reversed', 'This payment is disputed; the bank handles its refund', {
        status: purchase.status,
      });
    const mode: 'stripe' | 'manual' =
      ctx.payments.id === 'stripe' && purchase.paymentIntent ? 'stripe' : 'manual';
    const attempts = current.attempts + (mode === 'stripe' ? 1 : 0);
    const [updated] = await tx
      .update(refunds)
      .set({
        status: mode === 'stripe' ? 'processing' : 'manual',
        decisionReason: note,
        decidedBy: actor.label,
        decidedAt: now,
        attempts,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(refunds.id, id))
      .returning();
    await recordAudit(
      ctx,
      req,
      actor,
      {
        action: 'refund.approve',
        targetType: 'refund',
        targetId: id,
        reason: note,
        details: {
          userId: current.userId,
          purchaseId: current.purchaseId,
          amount: current.amount,
          currency: current.currency,
          mode,
          attempt: attempts,
        },
      },
      tx,
    );
    return { row: updated!, mode, paymentIntent: purchase.paymentIntent, attempts };
  });

  if (staged.mode === 'manual') {
    await ctx.notifier.notifyUser(staged.row.userId, {
      type: 'notification',
      kind: 'info',
      title: 'Refund approved',
      body: 'Your refund was approved and will be paid back to your original payment method.',
    });
    return { refund: staged.row, mode: 'manual' };
  }

  try {
    const r = await ctx.payments.refund({
      refundId: id,
      purchaseId: staged.row.purchaseId,
      paymentIntent: staged.paymentIntent!,
      amount: staged.row.amount,
      idempotencyKey: `refund:${id}:${staged.attempts}`,
    });
    const [updated] = await ctx.db
      .update(refunds)
      .set({ providerRefundId: r.providerRefundId, updatedAt: ctx.now() })
      .where(eq(refunds.id, id))
      .returning();
    await ctx.notifier.notifyUser(staged.row.userId, {
      type: 'notification',
      kind: 'info',
      title: 'Refund approved',
      body: 'Your refund is on its way back to your original payment method.',
    });
    return { refund: updated!, mode: 'stripe' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(refunds)
        .set({ status: 'failed', lastError: message.slice(0, 500), updatedAt: ctx.now() })
        .where(and(eq(refunds.id, id), eq(refunds.status, 'processing')));
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'refund.provider_failed',
          targetType: 'refund',
          targetId: id,
          details: { userId: staged.row.userId, attempt: staged.attempts, error: message.slice(0, 500) },
        },
        tx,
      );
    });
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'payment_provider_error', message);
  }
}
