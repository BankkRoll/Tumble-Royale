/**
 * Refunds on the player side: the policy, purchase history with eligibility,
 * self-service refunds of store purchases and real-money refund requests.
 *
 * Policy (also in `docs/design/ECONOMY.md`, "Refunds"):
 *
 * - **Self-service** covers store cosmetics and bundles paid in Gumballs or
 *   Gems, within {@link SELF_REFUND_WINDOW_DAYS} days of the purchase and at
 *   most {@link SELF_REFUND_LIMIT} times per rolling
 *   {@link SELF_REFUND_LIMIT_WINDOW_DAYS} days. The refund is immediate: every
 *   item the purchase granted is taken away (a bundle is refunded whole),
 *   loadouts wearing them fall back to the defaults, and the full price comes
 *   back as one `store_refund` ledger row with ref `refund:<purchaseId>`.
 *   Wearing an item does not block its refund: the game does not record what
 *   was worn in which show, and the short window plus the yearly limit bound
 *   "wear it for a week, then refund" instead.
 * - **Excluded:** Season Pass premium (its rewards unlock at once and feed
 *   progression) and the Crown Shard shop (spent shards no longer count
 *   toward a Crown, so giving them back would rewrite Crown progress).
 * - **Real money:** a Gem pack may be *requested* back within
 *   {@link REAL_MONEY_REFUND_WINDOW_DAYS} days. Staff decide
 *   (`refundAdmin.ts`); Gems move only when Stripe's `charge.refunded`
 *   webhook arrives, through the existing reversal logic in `reversals.ts`
 *   (Gems taken back, shortfall booked as Gem debt, cosmetics kept).
 * - **Once per purchase.** `refunds.purchase_id` is unique and every refund
 *   runs under the buyer's wallet lock, so a double-submitted or concurrent
 *   refund applies once and the repeat replays the first answer.
 */
import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { storeSetById } from '@tumble/content/progression';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { refuseDuringMaintenance } from '../liveops/state.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { inventoryItems, purchases, refunds } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { ApiError, badRequest, isUniqueViolation, notFound, parse } from '../http/errors.ts';
import { revokeCosmetic } from '../inventory/revoke.ts';
import { applyLedger, lockWallet, type Wallet } from './ledger.ts';
import { readWallet } from './wallet.ts';

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

/** Days after a store purchase during which the player may refund it. */
export const SELF_REFUND_WINDOW_DAYS = 7;
/** Self-service refunds allowed per rolling {@link SELF_REFUND_LIMIT_WINDOW_DAYS}. */
export const SELF_REFUND_LIMIT = 3;
/** Length of the self-service limit's rolling window, in days. */
export const SELF_REFUND_LIMIT_WINDOW_DAYS = 365;
/** Days after a Gem pack purchase during which the player may request a refund. */
export const REAL_MONEY_REFUND_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/** `self_service`: store purchase refunded at once; `real_money`: Gem pack request for staff. */
export type RefundKind = 'self_service' | 'real_money';

/** Every status a `refunds` row can hold (see the table's doc in `schema.ts`). */
export type RefundStatus =
  'completed' | 'pending' | 'processing' | 'manual' | 'refunded' | 'partially_refunded' | 'denied' | 'failed';

/** Real-money statuses staff can still approve or deny. */
export const DECIDABLE_REFUND_STATUSES: readonly RefundStatus[] = ['pending', 'failed'];

/** Why a purchase cannot be refunded; also the API error code. */
export type RefundRefusal =
  | 'refund_not_refundable'
  | 'refund_not_completed'
  | 'refund_already_refunded'
  | 'refund_already_requested'
  | 'refund_payment_reversed'
  | 'refund_window_expired'
  | 'refund_limit_reached'
  | 'refund_item_missing';

/** Whether a purchase can be refunded now, and how. */
export type RefundEligibility =
  | {
      eligible: true;
      kind: RefundKind;
      /** End of the refund window. */
      until: Date;
    }
  | {
      eligible: false;
      reason: RefundRefusal;
      /** Player-facing explanation. */
      message: string;
      /** When the refusal lifts (the limit), if it ever does. */
      retryAt?: Date;
    };

/** The facts about a purchase the policy reads. */
export interface RefundablePurchase {
  kind: string;
  status: string;
  /** When the purchase completed (falls back to creation). */
  at: Date;
  /** Cosmetic ids it granted. */
  items: readonly string[];
}

/** The facts about the buyer the policy reads. */
export interface RefundContext {
  /** The purchase's existing refund row, if any. */
  existing: { kind: string; status: string } | null;
  /** Cosmetic ids the buyer owns now. */
  owned: ReadonlySet<string>;
  /** Times of the buyer's self-service refunds inside the rolling limit window. */
  recentSelfRefunds: readonly Date[];
  now: Date;
}

const REVERSED_STATUSES = new Set(['partially_refunded', 'refunded', 'disputed', 'charged_back']);

/**
 * Applies the refund policy to one purchase. Pure, so every rule and
 * boundary is testable without a database.
 *
 * Windows are half-open: a purchase made at `t` is refundable while
 * `now < t + window`.
 *
 * @param purchase - The purchase.
 * @param ctx - The buyer's refund history, inventory and the time.
 * @returns Eligible with the refund kind, or the refusal and its reason.
 * @example
 * refundEligibility(
 *   { kind: 'cosmetic', status: 'completed', at, items: ['hat.top'] },
 *   { existing: null, owned: new Set(['hat.top']), recentSelfRefunds: [], now },
 * ); // { eligible: true, kind: 'self_service', until: at + 7 days }
 */
export function refundEligibility(purchase: RefundablePurchase, ctx: RefundContext): RefundEligibility {
  const no = (reason: RefundRefusal, message: string, retryAt?: Date): RefundEligibility => ({
    eligible: false,
    reason,
    message,
    ...(retryAt ? { retryAt } : {}),
  });
  if (purchase.kind === 'pass_premium')
    return no(
      'refund_not_refundable',
      'Season Pass upgrades unlock rewards straight away and can’t be refunded.',
    );
  if (purchase.kind === 'shard_item')
    return no('refund_not_refundable', 'Crown Shard shop items can’t be refunded.');
  if (purchase.kind !== 'cosmetic' && purchase.kind !== 'gem_pack')
    return no('refund_not_refundable', 'This purchase can’t be refunded.');
  const realMoney = purchase.kind === 'gem_pack';

  if (ctx.existing) {
    if (ctx.existing.status === 'denied')
      return no('refund_already_requested', 'Your refund request for this purchase was declined.');
    if (ctx.existing.kind === 'real_money' && ctx.existing.status !== 'refunded')
      return no('refund_already_requested', 'You already asked for this refund.');
    return no('refund_already_refunded', 'This purchase was already refunded.');
  }
  if (realMoney && REVERSED_STATUSES.has(purchase.status))
    return no('refund_payment_reversed', 'This payment was already refunded or disputed.');
  if (purchase.status === 'refunded')
    return no('refund_already_refunded', 'This purchase was already refunded.');
  if (purchase.status !== 'completed')
    return no('refund_not_completed', 'This purchase never completed, so there is nothing to refund.');

  const windowDays = realMoney ? REAL_MONEY_REFUND_WINDOW_DAYS : SELF_REFUND_WINDOW_DAYS;
  const until = new Date(purchase.at.getTime() + windowDays * DAY_MS);
  if (ctx.now.getTime() >= until.getTime())
    return no('refund_window_expired', `Refunds are only possible within ${windowDays} days of buying.`);
  if (realMoney) return { eligible: true, kind: 'real_money', until };

  const windowStart = ctx.now.getTime() - SELF_REFUND_LIMIT_WINDOW_DAYS * DAY_MS;
  const recent = ctx.recentSelfRefunds
    .map((d) => d.getTime())
    .filter((t) => t > windowStart)
    .sort((a, b) => a - b);
  if (recent.length >= SELF_REFUND_LIMIT) {
    const retryAt = new Date(
      recent[recent.length - SELF_REFUND_LIMIT]! + SELF_REFUND_LIMIT_WINDOW_DAYS * DAY_MS,
    );
    return no(
      'refund_limit_reached',
      `You’ve used all ${SELF_REFUND_LIMIT} store refunds for the year.`,
      retryAt,
    );
  }
  if (purchase.items.length === 0 || purchase.items.some((id) => !ctx.owned.has(id)))
    return no('refund_item_missing', 'Something this purchase gave you is no longer in your locker.');
  return { eligible: true, kind: 'self_service', until };
}

// -----------------------------------------------------------------------------
// Data access
// -----------------------------------------------------------------------------

type PurchaseRow = typeof purchases.$inferSelect;
type RefundRow = typeof refunds.$inferSelect;

/** Cosmetic ids a purchase granted (the stored response's `items`, else its item id). */
export function purchaseItems(row: Pick<PurchaseRow, 'kind' | 'itemId' | 'response'>): string[] {
  if (row.kind === 'gem_pack' || row.kind === 'pass_premium') return [];
  const stored = (row.response as { items?: unknown } | null)?.items;
  if (Array.isArray(stored) && stored.every((x) => typeof x === 'string')) return stored as string[];
  return row.itemId.startsWith('bundle:') ? [] : [row.itemId];
}

const purchaseAt = (row: Pick<PurchaseRow, 'completedAt' | 'createdAt'>): Date =>
  row.completedAt ?? row.createdAt;

async function recentSelfRefunds(db: DbOrTx, userId: string, now: Date): Promise<Date[]> {
  const rows = await db
    .select({ at: refunds.createdAt })
    .from(refunds)
    .where(
      and(
        eq(refunds.userId, userId),
        eq(refunds.kind, 'self_service'),
        gt(refunds.createdAt, new Date(now.getTime() - SELF_REFUND_LIMIT_WINDOW_DAYS * DAY_MS)),
      ),
    );
  return rows.map((r) => r.at);
}

async function ownedSet(db: DbOrTx, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: inventoryItems.cosmeticId })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  return new Set(rows.map((r) => r.id));
}

// -----------------------------------------------------------------------------
// Refunding
// -----------------------------------------------------------------------------

/** Answer of `POST /purchases/:purchaseId/refund`, replayed on a repeat. */
export interface RefundResult {
  refundId: string;
  purchaseId: string;
  kind: RefundKind;
  status: RefundStatus;
  /** What came back (self-service) or will be refunded (real money, minor units). */
  credit: { currency: string; amount: number };
  /** Cosmetic ids taken away. */
  items: string[];
  /** Loadout slots that wore a removed item and now use the defaults. */
  loadoutsChanged: number[];
  wallet: Wallet;
  /** True when this answers a repeat of an earlier refund. */
  replayed: boolean;
}

function resultOf(
  row: RefundRow,
  wallet: Wallet,
  loadoutsChanged: number[],
  replayed: boolean,
): RefundResult {
  return {
    refundId: row.id,
    purchaseId: row.purchaseId,
    kind: row.kind as RefundKind,
    status: row.status as RefundStatus,
    credit: { currency: row.currency, amount: row.amount },
    items: row.items as string[],
    loadoutsChanged,
    wallet,
    replayed,
  };
}

/**
 * Refunds a store purchase (self-service) or files a Gem pack refund request,
 * whichever the purchase allows. Idempotent per purchase: a repeat, even a
 * concurrent one, returns the first refund with `replayed: true`.
 *
 * @param ctx - Shared services.
 * @param userId - The buyer.
 * @param purchaseId - Purchase to refund.
 * @param reason - The player's reason; required for a real-money request.
 * @returns The refund.
 * @throws {ApiError} 404 unknown purchase (or someone else's), 409 with a
 *   {@link RefundRefusal} code when the policy refuses, 400
 *   `reason_required` for a real-money request without a reason.
 */
export async function refundPurchase(
  ctx: AppContext,
  userId: string,
  purchaseId: string,
  reason: string | undefined,
): Promise<RefundResult> {
  const replay = async (db: DbOrTx): Promise<RefundResult | null> => {
    const [row] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.purchaseId, purchaseId), eq(refunds.userId, userId)));
    return row ? resultOf(row, await readWallet(db, userId), [], true) : null;
  };
  try {
    return await ctx.db.transaction(async (tx) => {
      // SECURITY: the wallet lock serialises every refund and purchase of this
      // player, so the limit count and the "already refunded" check below
      // cannot race a second request.
      await lockWallet(tx, userId);
      const [purchase] = await tx
        .select()
        .from(purchases)
        .where(and(eq(purchases.id, purchaseId), eq(purchases.userId, userId)))
        .for('update');
      if (!purchase) throw notFound('Purchase');
      const replayed = await replay(tx);
      if (replayed) return replayed;

      const now = ctx.now();
      const items = purchaseItems(purchase);
      const verdict = refundEligibility(
        { kind: purchase.kind, status: purchase.status, at: purchaseAt(purchase), items },
        {
          existing: null,
          owned: await ownedSet(tx, userId),
          recentSelfRefunds: await recentSelfRefunds(tx, userId, now),
          now,
        },
      );
      if (!verdict.eligible) {
        throw new ApiError(409, verdict.reason, verdict.message, {
          reason: verdict.reason,
          ...(verdict.retryAt ? { retryAt: verdict.retryAt.toISOString() } : {}),
        });
      }

      if (verdict.kind === 'real_money') {
        if (!reason) throw badRequest('reason_required', 'Tell us why you want this payment refunded');
        const [row] = await tx
          .insert(refunds)
          .values({
            userId,
            purchaseId,
            kind: 'real_money',
            status: 'pending',
            currency: purchase.currency,
            amount: purchase.price,
            items: [],
            playerReason: reason,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return resultOf(row!, await readWallet(tx, userId), [], false);
      }

      const [row] = await tx
        .insert(refunds)
        .values({
          userId,
          purchaseId,
          kind: 'self_service',
          status: 'completed',
          currency: purchase.currency,
          amount: purchase.price,
          items,
          playerReason: reason ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await applyLedger(tx, {
        userId,
        currency: purchase.currency as 'gumballs' | 'gems',
        delta: purchase.price,
        reason: 'store_refund',
        ref: `refund:${purchaseId}`,
      });
      const loadoutsChanged = new Set<number>();
      for (const id of items) {
        const revoked = await revokeCosmetic(tx, ctx, userId, id);
        for (const slot of revoked?.loadouts ?? []) loadoutsChanged.add(slot);
      }
      await tx.update(purchases).set({ status: 'refunded' }).where(eq(purchases.id, purchaseId));
      return resultOf(
        row!,
        await readWallet(tx, userId),
        [...loadoutsChanged].sort((a, b) => a - b),
        false,
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const replayed = await replay(ctx.db);
      if (replayed) return replayed;
    }
    throw err;
  }
}

/**
 * Moves a real-money refund request along when Stripe reports money moving
 * back (called from the reversal reconciliation, inside its transaction).
 * A request Stripe failed stays `failed` until staff approve it again, so a
 * stale `charge.refunded` cannot hide the failure.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param purchaseId - The Gem pack purchase.
 * @param purchaseStatus - Its status after reconciliation.
 */
export async function syncRefundRequest(
  tx: DbOrTx,
  ctx: AppContext,
  purchaseId: string,
  purchaseStatus: string,
): Promise<void> {
  if (purchaseStatus !== 'refunded' && purchaseStatus !== 'partially_refunded') return;
  await tx
    .update(refunds)
    .set({ status: purchaseStatus, updatedAt: ctx.now() })
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.kind, 'real_money'),
        inArray(refunds.status, ['pending', 'processing', 'manual', 'partially_refunded']),
      ),
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks a real-money refund `failed` after Stripe reported the refund failed
 * or was canceled. Gems already taken back are not re-credited
 * automatically (same rule as a lowered `amount_refunded`): support restores
 * them, and staff can approve the request again.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param e - The decoded event.
 * @returns The request's owner when a request changed, else null.
 */
export async function markRefundFailed(
  tx: DbOrTx,
  ctx: AppContext,
  e: { providerRefundId: string; refundId: string | null; failureReason: string | null },
): Promise<string | null> {
  // SECURITY: the metadata id is ours, but it is still checked to be a UUID
  // before it reaches a uuid column, so a malformed value cannot fail the event.
  const byId = e.refundId && UUID_RE.test(e.refundId) ? eq(refunds.id, e.refundId) : undefined;
  const rows = await tx
    .update(refunds)
    .set({
      status: 'failed',
      lastError: `Stripe could not complete the refund${e.failureReason ? ` (${e.failureReason})` : ''}`,
      updatedAt: ctx.now(),
    })
    .where(
      and(
        byId ?? eq(refunds.providerRefundId, e.providerRefundId),
        eq(refunds.kind, 'real_money'),
        inArray(refunds.status, ['processing', 'manual', 'refunded', 'partially_refunded']),
      ),
    )
    .returning({ userId: refunds.userId });
  return rows[0]?.userId ?? null;
}

// -----------------------------------------------------------------------------
// Purchase history
// -----------------------------------------------------------------------------

/** One purchase in the player's history. */
export interface PurchaseHistoryEntry {
  purchaseId: string;
  kind: string;
  /** Offer id (cosmetic id, `bundle:<id>`, Gem pack id, season id). */
  offerId: string;
  title: string;
  items: { id: string; name: string; slot: string | null }[];
  /** Gem packs: Gems the pack granted. */
  gems?: number;
  price: { currency: string; amount: number };
  status: string;
  purchasedAt: string;
  refund: {
    refundId: string;
    kind: RefundKind;
    status: RefundStatus;
    requestedAt: string;
    /** The staff reason shown on a denial. */
    decisionReason: string | null;
  } | null;
  eligibility:
    | { eligible: true; kind: RefundKind; until: string }
    | { eligible: false; reason: RefundRefusal; message: string; retryAt?: string };
}

/** `GET /purchases`. */
export interface PurchaseHistory {
  purchases: PurchaseHistoryEntry[];
  selfRefunds: {
    used: number;
    limit: number;
    windowDays: number;
    /** When the oldest counted refund leaves the window, if the limit is reached. */
    nextAvailableAt: string | null;
  };
  policy: { selfServiceWindowDays: number; realMoneyWindowDays: number };
}

function titleOf(ctx: AppContext, row: PurchaseRow): string {
  switch (row.kind) {
    case 'gem_pack':
      return ctx.catalog.gemPacks.find((p) => p.id === row.itemId)?.name ?? 'Gem pack';
    case 'pass_premium':
      return 'Season Pass premium';
    default:
      if (row.itemId.startsWith('bundle:')) return storeSetById(row.itemId)?.name ?? 'Bundle';
      return ctx.cosmetics.get(row.itemId)?.name ?? row.itemId;
  }
}

/**
 * The player's completed purchases, newest first, each with its refund and
 * whether it can be refunded now.
 *
 * @param ctx - Shared services.
 * @param userId - The buyer.
 * @param limit - Most purchases to return.
 */
export async function purchaseHistory(
  ctx: AppContext,
  userId: string,
  limit: number,
): Promise<PurchaseHistory> {
  const now = ctx.now();
  const [rows, refundRows, owned, recent] = await Promise.all([
    ctx.db
      .select()
      .from(purchases)
      .where(and(eq(purchases.userId, userId), isNotNull(purchases.completedAt)))
      .orderBy(desc(purchases.completedAt))
      .limit(limit),
    ctx.db.select().from(refunds).where(eq(refunds.userId, userId)),
    ownedSet(ctx.db, userId),
    recentSelfRefunds(ctx.db, userId, now),
  ]);
  const byPurchase = new Map(refundRows.map((r) => [r.purchaseId, r]));
  const entries = rows.map((row): PurchaseHistoryEntry => {
    const refund = byPurchase.get(row.id) ?? null;
    const items = purchaseItems(row);
    const verdict = refundEligibility(
      { kind: row.kind, status: row.status, at: purchaseAt(row), items },
      { existing: refund, owned, recentSelfRefunds: recent, now },
    );
    const pack = row.kind === 'gem_pack' ? ctx.catalog.gemPacks.find((p) => p.id === row.itemId) : undefined;
    return {
      purchaseId: row.id,
      kind: row.kind,
      offerId: row.itemId,
      title: titleOf(ctx, row),
      items: items.map((id) => ({
        id,
        name: ctx.cosmetics.get(id)?.name ?? id,
        slot: ctx.cosmetics.get(id)?.slot ?? null,
      })),
      ...(pack ? { gems: pack.gems } : {}),
      price: { currency: row.currency, amount: row.price },
      status: row.status,
      purchasedAt: purchaseAt(row).toISOString(),
      refund: refund
        ? {
            refundId: refund.id,
            kind: refund.kind as RefundKind,
            status: refund.status as RefundStatus,
            requestedAt: refund.createdAt.toISOString(),
            decisionReason: refund.status === 'denied' ? refund.decisionReason : null,
          }
        : null,
      eligibility: verdict.eligible
        ? { eligible: true, kind: verdict.kind, until: verdict.until.toISOString() }
        : {
            eligible: false,
            reason: verdict.reason,
            message: verdict.message,
            ...(verdict.retryAt ? { retryAt: verdict.retryAt.toISOString() } : {}),
          },
    };
  });
  const sorted = recent.map((d) => d.getTime()).sort((a, b) => a - b);
  const limited = sorted.length >= SELF_REFUND_LIMIT;
  return {
    purchases: entries,
    selfRefunds: {
      used: sorted.length,
      limit: SELF_REFUND_LIMIT,
      windowDays: SELF_REFUND_LIMIT_WINDOW_DAYS,
      nextAvailableAt: limited
        ? new Date(
            sorted[sorted.length - SELF_REFUND_LIMIT]! + SELF_REFUND_LIMIT_WINDOW_DAYS * DAY_MS,
          ).toISOString()
        : null,
    },
    policy: {
      selfServiceWindowDays: SELF_REFUND_WINDOW_DAYS,
      realMoneyWindowDays: REAL_MONEY_REFUND_WINDOW_DAYS,
    },
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const RefundParams = z.object({ purchaseId: z.string().uuid() });
const RefundBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .strict()
  .optional();
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

/**
 * Registers the player refund routes:
 *
 * - `GET /purchases` — history with refund status and eligibility.
 * - `POST /purchases/:purchaseId/refund` `{ reason? }` — refund a store
 *   purchase, or request a Gem pack refund (reason required). Closed with
 *   the store (`store.enabled`, via `STORE_SPEND_ROUTES`) and during
 *   maintenance.
 *
 * Guests may use both: a guest's store purchases are as refundable as anyone's.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerRefundRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/purchases', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { limit } = parse(HistoryQuery, req.query);
    return purchaseHistory(ctx, auth.userId, limit);
  });

  app.post(
    '/purchases/:purchaseId/refund',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const { purchaseId } = parse(RefundParams, req.params);
      const body = parse(RefundBody, req.body ?? undefined);
      await refuseDuringMaintenance(ctx);
      const result = await refundPurchase(ctx, auth.userId, purchaseId, body?.reason);
      if (!result.replayed && result.kind === 'self_service')
        await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...result.wallet });
      return result;
    },
  );
}
