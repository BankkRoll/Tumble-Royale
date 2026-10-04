/**
 * Gem pack payments after checkout: crediting, refunds, chargebacks and debt.
 *
 * Policy (also in `docs/design/ECONOMY.md`, "Refunds and chargebacks"):
 *
 * - **Reconcile, don't replay.** For each Stripe PaymentIntent we keep what
 *   Stripe last told us (`payment_reversals`: cumulative refunded amount,
 *   dispute status) and how many Gems that has already taken back. Every
 *   event updates those facts and then moves the Gems by the difference
 *   between the target and what was already reversed. Duplicated,
 *   out-of-order and late events therefore converge on the same ledger.
 * - **Target.** An open or lost dispute takes back the whole pack. Otherwise a
 *   refund takes back `ceil(gems × refunded / charged)`: a partial refund
 *   removes a proportional share, rounded against the player so a refund never
 *   leaves Gems that were not paid for. A won dispute (or an inquiry closed
 *   without a chargeback) drops the dispute's share again, and only the
 *   refund's share, if any, stays reversed.
 * - **Append-only.** Every change is a new ledger row (`gem_reversal`,
 *   `gem_restore`, `debt_repayment`); earlier rows are never edited.
 * - **Debt.** Gems already spent cannot be taken, so the uncovered part becomes
 *   Gem debt. Every later Gem credit (match rewards, restores, an admin
 *   adjustment) repays the debt first, and Gem checkout answers 402
 *   `payment_debt` until it is zero. Admins can write debt off with
 *   `POST /internal/payments/debt/:userId/forgive`.
 * - **Idempotent.** Each Stripe event id is recorded in `stripe_events` in the
 *   same transaction as its effects; a redelivery is acknowledged and ignored.
 * - **Ordering.** A refund or dispute that arrives before the checkout
 *   completion is stored against the PaymentIntent and applied the moment the
 *   completion credits the pack. Events for unknown sessions or charges are
 *   acknowledged (200) without effect so Stripe stops retrying them.
 * - **Failed refunds** (`amount_refunded` going down) are ignored: the
 *   highest amount seen wins, and support restores Gems by hand. A
 *   `refund.failed` event marks the player's refund request `failed` so
 *   staff see it (`refunds.ts`).
 * - **Refund requests** follow the purchase: a full or partial refund moves
 *   the player's `real_money` request to `refunded` / `partially_refunded`.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { paymentReversals, purchases, stripeEvents } from '../db/schema.ts';
import { applyLedger, lockWallet, readGemDebt, revokeGems } from './ledger.ts';
import { markRefundFailed, syncRefundRequest } from './refunds.ts';
import type { DisputeOutcome, PaymentEvent } from './payments.ts';
import { readWallet } from './wallet.ts';

/** Purchase statuses a Gem pack can move through after it completed. */
export type GemPurchaseStatus = 'completed' | 'partially_refunded' | 'refunded' | 'disputed' | 'charged_back';

type Reversal = typeof paymentReversals.$inferSelect;

/**
 * Gems that should currently be taken back for a payment.
 *
 * @param gems - Gems the pack granted.
 * @param chargedCents - Amount charged.
 * @param state - Stripe facts for the payment.
 * @example
 * reversalTarget(1100, 999, { amountRefundedCents: 500, disputeStatus: null }); // 551
 */
export function reversalTarget(
  gems: number,
  chargedCents: number,
  state: Pick<Reversal, 'amountRefundedCents' | 'disputeStatus'>,
): number {
  if (state.disputeStatus === 'open' || state.disputeStatus === 'lost') return gems;
  if (chargedCents <= 0 || state.amountRefundedCents <= 0) return 0;
  const share = Math.min(state.amountRefundedCents, chargedCents) / chargedCents;
  return Math.min(gems, Math.ceil(gems * share));
}

function statusFor(target: number, gems: number, dispute: string | null): GemPurchaseStatus {
  if (dispute === 'open') return 'disputed';
  if (dispute === 'lost') return 'charged_back';
  if (target <= 0) return 'completed';
  return target >= gems ? 'refunded' : 'partially_refunded';
}

/**
 * Credits a Gem pack exactly once and records its PaymentIntent. Must run in a
 * transaction; applies any refund or dispute that arrived first.
 *
 * @returns The buyer when Gems moved, otherwise null (unknown, not a pack, already credited).
 */
export async function creditGemPurchase(
  tx: DbOrTx,
  ctx: AppContext,
  purchaseId: string,
  providerRef: string | null,
  paymentIntent: string | null,
): Promise<string | null> {
  const [row] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).for('update');
  if (!row || row.kind !== 'gem_pack' || row.completedAt) return null;
  const pack = ctx.catalog.gemPacks.find((p) => p.id === row.itemId);
  if (!pack) throw new Error(`gem pack ${row.itemId} vanished from the catalog`);
  await applyLedger(tx, {
    userId: row.userId,
    currency: 'gems',
    delta: pack.gems,
    reason: 'gem_pack',
    ref: purchaseId,
  });
  await tx
    .update(purchases)
    .set({
      status: 'completed',
      completedAt: ctx.now(),
      ...(providerRef ? { providerRef } : {}),
      ...(paymentIntent ? { paymentIntent } : {}),
    })
    .where(eq(purchases.id, purchaseId));
  if (paymentIntent) await reconcilePayment(tx, ctx, paymentIntent);
  return row.userId;
}

/**
 * Moves the Gems of one payment to match its recorded refund/dispute state.
 * Lock order is purchase → reversal row everywhere, so concurrent events for
 * one payment cannot deadlock.
 *
 * @returns The buyer when Gems moved, otherwise null.
 */
async function reconcilePayment(tx: DbOrTx, ctx: AppContext, paymentIntent: string): Promise<string | null> {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(eq(purchases.paymentIntent, paymentIntent))
    .for('update');
  const [state] = await tx
    .select()
    .from(paymentReversals)
    .where(eq(paymentReversals.paymentIntent, paymentIntent))
    .for('update');
  if (!purchase || !state || !purchase.completedAt || purchase.kind !== 'gem_pack') return null;
  const pack = ctx.catalog.gemPacks.find((p) => p.id === purchase.itemId);
  if (!pack) throw new Error(`gem pack ${purchase.itemId} vanished from the catalog`);
  const target = reversalTarget(pack.gems, state.amountCents ?? purchase.price, state);
  const status = statusFor(target, pack.gems, state.disputeStatus);
  if (purchase.status !== status) {
    await tx.update(purchases).set({ status }).where(eq(purchases.id, purchase.id));
  }
  await syncRefundRequest(tx, ctx, purchase.id, status);
  const delta = target - state.gemsReversed;
  if (delta === 0) return null;
  const ref = `${purchase.id}:${state.adjustments + 1}`;
  if (delta > 0) await revokeGems(tx, purchase.userId, delta, ref);
  else
    await applyLedger(tx, {
      userId: purchase.userId,
      currency: 'gems',
      delta: -delta,
      reason: 'gem_restore',
      ref,
    });
  await tx
    .update(paymentReversals)
    .set({ gemsReversed: target, adjustments: state.adjustments + 1, updatedAt: ctx.now() })
    .where(eq(paymentReversals.paymentIntent, paymentIntent));
  return purchase.userId;
}

/** Locks the purchase (if known yet) before the reversal row, matching {@link reconcilePayment}. */
async function lockPurchaseByIntent(tx: DbOrTx, paymentIntent: string): Promise<void> {
  await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(eq(purchases.paymentIntent, paymentIntent))
    .for('update');
}

async function recordRefund(
  tx: DbOrTx,
  ctx: AppContext,
  e: Extract<PaymentEvent, { type: 'charge_refunded' }>,
): Promise<void> {
  const now = ctx.now();
  await tx
    .insert(paymentReversals)
    .values({
      paymentIntent: e.paymentIntent,
      chargeId: e.chargeId,
      amountCents: e.amount,
      amountRefundedCents: e.amountRefunded,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: paymentReversals.paymentIntent,
      set: {
        chargeId: e.chargeId,
        amountCents: e.amount,
        amountRefundedCents: sql`greatest(${paymentReversals.amountRefundedCents}, ${e.amountRefunded})`,
        updatedAt: now,
      },
    });
}

async function recordDispute(
  tx: DbOrTx,
  ctx: AppContext,
  e: Extract<PaymentEvent, { type: 'dispute' }>,
): Promise<void> {
  const now = ctx.now();
  const [current] = await tx
    .select({ disputeId: paymentReversals.disputeId, status: paymentReversals.disputeStatus })
    .from(paymentReversals)
    .where(eq(paymentReversals.paymentIntent, e.paymentIntent))
    .for('update');
  // A closed dispute is final: a late `created` delivered after `closed`
  // must not reopen it.
  let outcome: DisputeOutcome = e.outcome;
  if (
    current?.disputeId === e.disputeId &&
    e.outcome === 'open' &&
    (current.status === 'won' || current.status === 'lost')
  ) {
    outcome = current.status;
  }
  await tx
    .insert(paymentReversals)
    .values({
      paymentIntent: e.paymentIntent,
      chargeId: e.chargeId,
      disputeId: e.disputeId,
      disputeStatus: outcome,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: paymentReversals.paymentIntent,
      set: { chargeId: e.chargeId, disputeId: e.disputeId, disputeStatus: outcome, updatedAt: now },
    });
}

/**
 * Applies one verified webhook event. Idempotent per Stripe event id.
 *
 * @param ctx - Shared services.
 * @param event - Decoded event from the payment provider.
 * @returns Whether the event was new, and the users whose wallets changed.
 */
export async function applyPaymentEvent(
  ctx: AppContext,
  event: PaymentEvent,
): Promise<{ duplicate: boolean; walletsChanged: string[] }> {
  if (event.type === 'ignored') return { duplicate: false, walletsChanged: [] };
  return ctx.db.transaction(async (tx) => {
    const fresh = await tx
      .insert(stripeEvents)
      .values({ id: event.eventId, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (fresh.length === 0) return { duplicate: true, walletsChanged: [] };

    const changed: (string | null)[] = [];
    switch (event.type) {
      case 'checkout_completed': {
        let purchaseId = event.purchaseId;
        if (!purchaseId) {
          const [row] = await tx
            .select({ id: purchases.id })
            .from(purchases)
            .where(eq(purchases.providerRef, event.providerRef));
          purchaseId = row?.id ?? null;
        }
        if (purchaseId) {
          changed.push(await creditGemPurchase(tx, ctx, purchaseId, event.providerRef, event.paymentIntent));
        }
        break;
      }
      case 'checkout_expired': {
        const where = event.purchaseId
          ? eq(purchases.id, event.purchaseId)
          : eq(purchases.providerRef, event.providerRef);
        await tx
          .update(purchases)
          .set({ status: event.status })
          .where(and(where, eq(purchases.status, 'pending'), isNull(purchases.completedAt)));
        break;
      }
      case 'charge_refunded':
        await lockPurchaseByIntent(tx, event.paymentIntent);
        await recordRefund(tx, ctx, event);
        changed.push(await reconcilePayment(tx, ctx, event.paymentIntent));
        break;
      case 'dispute':
        await lockPurchaseByIntent(tx, event.paymentIntent);
        await recordDispute(tx, ctx, event);
        changed.push(await reconcilePayment(tx, ctx, event.paymentIntent));
        break;
      case 'refund_failed':
        await markRefundFailed(tx, ctx, event);
        break;
    }
    return {
      duplicate: false,
      walletsChanged: [...new Set(changed.filter((u): u is string => u !== null))],
    };
  });
}

/**
 * Pushes fresh balances to the players whose wallets changed.
 *
 * @param ctx - Shared services.
 * @param userIds - Players to notify.
 */
export async function notifyWallets(ctx: AppContext, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    const wallet = await readWallet(ctx.db, userId);
    await ctx.notifier.notifyUser(userId, { type: 'wallet', ...wallet });
  }
}

/**
 * Writes off a player's Gem debt (support decision), as a `debt_forgiven`
 * ledger row.
 *
 * @param ctx - Shared services.
 * @param userId - Whose debt.
 * @param ref - Idempotency ref for this write-off.
 * @returns The debt that was forgiven.
 */
export async function forgiveGemDebt(ctx: AppContext, userId: string, ref: string): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    await lockWallet(tx, userId);
    const debt = await readGemDebt(tx, userId);
    if (debt <= 0) return 0;
    const r = await applyLedger(tx, {
      userId,
      currency: 'gem_debt',
      delta: -debt,
      reason: 'debt_forgiven',
      ref,
    });
    return r.applied ? debt : 0;
  });
}
