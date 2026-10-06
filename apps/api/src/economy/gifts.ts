/**
 * Gifting: buying a store item for a friend with your own Gumballs or Gems.
 *
 * Responsibilities:
 * - The policy ({@link giftEligibility}), pure so every rule is testable on
 *   its own: only accounts (not guests) at least {@link GIFT_MIN_ACCOUNT_DAYS}
 *   old may send, only to mutual friends of at least
 *   {@link GIFT_MIN_FRIEND_DAYS}, at most {@link GIFT_DAILY_LIMIT} a UTC day,
 *   never to a suspended player, a full inbox, a player who owns the item or
 *   already has it waiting in another unopened gift.
 * - Sending: the sender's charge (`gift` / `gift:<id>`) and the gift row
 *   commit together; the recipient gets the items when they open it.
 * - Opening, declining (sender refunded), cancelling an unopened gift (sender
 *   refunded), and the {@link GIFT_AUTO_ACCEPT_DAYS}-day auto-accept.
 * - Settling gifts when either account is deleted, and the staff reversal.
 *
 * Money integrity: every refund is one `gift_refund` / `gift:<id>` ledger row,
 * which the ledger's unique key makes impossible to apply twice. Every
 * operation locks both players' profile rows (in id order, so two players
 * gifting each other cannot deadlock) before it reads anything it decides on,
 * so a double submit, two senders racing to gift one item to the same friend,
 * or a decline racing a cancel all serialise and the loser sees the winner's
 * result.
 *
 * Gifts are not purchases: they never appear in `GET /purchases`, so neither
 * side can self-refund one. Policy text lives in `docs/design/ECONOMY.md`.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, or, gt, sql } from 'drizzle-orm';
import { filterChat } from '@tumble/shared';
import { storeSetById } from '@tumble/content/progression';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx, Tx } from '../db/client.ts';
import { bans, friendships, gifts, inventoryItems, profiles, users } from '../db/schema.ts';
import { activeBans, requireUser } from '../http/auth.ts';
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  parse,
} from '../http/errors.ts';
import { revokeCosmetic } from '../inventory/revoke.ts';
import { refuseDuringMaintenance } from '../liveops/state.ts';
import type { SocialRef } from '../realtime/notifier.ts';
import { friendIds, socialRef } from '../social/friends.ts';
import { dayKey, nextUtcMidnight } from '../util/time.ts';
import { applyLedger, lockWallet, type Wallet } from './ledger.ts';
import { currentRotation, priceOffer, type StoreRotation } from './store.ts';
import { grantCosmetic, readWallet } from './wallet.ts';
import { checkWishlistAlert, removeFromWishlist } from './wishlist.ts';

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

/** Days two players must have been friends before either can gift the other. */
export const GIFT_MIN_FRIEND_DAYS = 3;
/** Days an account must exist before it can send gifts. */
export const GIFT_MIN_ACCOUNT_DAYS = 7;
/** Gifts one player may send per UTC day (cancelled and declined ones count too). */
export const GIFT_DAILY_LIMIT = 5;
/** Unopened gifts one player may hold at once. */
export const GIFT_INBOX_LIMIT = 30;
/** Days after which an unopened gift opens by itself. */
export const GIFT_AUTO_ACCEPT_DAYS = 30;
/** Longest gift message, in characters. */
export const GIFT_MESSAGE_MAX = 80;

const DAY_MS = 86_400_000;

/** Where a gift stands. */
export type GiftStatus = 'pending' | 'opened' | 'declined' | 'cancelled' | 'returned' | 'reversed';

/** Why a gift was sent back without the recipient choosing to (`gifts.note`). */
export type GiftNote = 'recipient_owns' | 'recipient_deleted' | 'staff';

/** Why a gift cannot be sent; also the API error code. */
export type GiftRefusal =
  | 'gift_account_required'
  | 'gift_account_too_new'
  | 'gift_daily_limit'
  | 'gift_not_friends'
  | 'gift_friendship_too_new'
  | 'gift_recipient_unavailable'
  | 'gift_inbox_full'
  | 'gift_already_owned'
  | 'gift_already_pending';

const REFUSAL_STATUS: Readonly<Record<GiftRefusal, number>> = {
  gift_account_required: 403,
  gift_account_too_new: 403,
  gift_daily_limit: 429,
  gift_not_friends: 403,
  gift_friendship_too_new: 403,
  gift_recipient_unavailable: 409,
  gift_inbox_full: 409,
  gift_already_owned: 409,
  gift_already_pending: 409,
};

/** The facts about the sender the policy reads. */
export interface GiftSenderFacts {
  isGuest: boolean;
  /** Account creation. */
  createdAt: Date;
  /** Gifts sent since 00:00 UTC today, whatever became of them. */
  sentToday: number;
}

/** The facts about one would-be recipient the policy reads. */
export interface GiftRecipientFacts {
  /** When the friendship was accepted, or null when they are not friends. */
  friendsSince: Date | null;
  /** Either player blocked the other. */
  blocked: boolean;
  /** Under an active full suspension. */
  suspended: boolean;
  /** Unopened gifts waiting for them. */
  pendingCount: number;
  /** Cosmetic ids in their unopened gifts. */
  pendingItems: ReadonlySet<string>;
  /** Cosmetic ids they own. */
  owned: ReadonlySet<string>;
}

/** Whether a gift may be sent. */
export type GiftEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: GiftRefusal;
      /** Player-facing explanation. */
      message: string;
      /** When the refusal lifts, if it lifts by itself. */
      retryAt?: Date;
    };

type Refused = Extract<GiftEligibility, { eligible: false }>;

function refuse(reason: GiftRefusal, message: string, retryAt?: Date): Refused {
  return { eligible: false, reason, message, ...(retryAt ? { retryAt } : {}) };
}

/**
 * The sender-only rules: account kind, account age and the daily cap.
 *
 * @param sender - The sender's facts.
 * @param now - Current time.
 * @returns A refusal, or null when the sender may gift.
 */
export function senderGiftRefusal(
  sender: GiftSenderFacts,
  now: Date,
): Extract<GiftEligibility, { eligible: false }> | null {
  if (sender.isGuest)
    return refuse('gift_account_required', 'Link an account (Settings → Account) to send gifts.');
  const oldEnough = new Date(sender.createdAt.getTime() + GIFT_MIN_ACCOUNT_DAYS * DAY_MS);
  if (now.getTime() < oldEnough.getTime())
    return refuse(
      'gift_account_too_new',
      `Gifting unlocks ${GIFT_MIN_ACCOUNT_DAYS} days after your account was made.`,
      oldEnough,
    );
  if (sender.sentToday >= GIFT_DAILY_LIMIT)
    return refuse(
      'gift_daily_limit',
      `You've sent ${GIFT_DAILY_LIMIT} gifts today. More tomorrow!`,
      nextUtcMidnight(now),
    );
  return null;
}

/**
 * Applies the gifting policy to one sender, recipient and set of items. Pure.
 *
 * Blocks and missing friendships read the same (`gift_not_friends`), so the
 * sender can never tell a block from "not friends". Windows are half-open:
 * a friendship accepted at `t` allows gifts from `t + 3 days` on.
 *
 * @param sender - The sender's facts.
 * @param recipient - The recipient's facts.
 * @param items - Cosmetic ids the gift would grant.
 * @param now - Current time.
 * @returns Eligible, or the first rule that refuses.
 * @example
 * giftEligibility(
 *   { isGuest: false, createdAt: monthAgo, sentToday: 0 },
 *   { friendsSince: weekAgo, blocked: false, suspended: false, pendingCount: 0,
 *     pendingItems: new Set(), owned: new Set() },
 *   ['hat.top'],
 *   now,
 * ); // { eligible: true }
 */
export function giftEligibility(
  sender: GiftSenderFacts,
  recipient: GiftRecipientFacts,
  items: readonly string[],
  now: Date,
): GiftEligibility {
  const own = senderGiftRefusal(sender, now);
  if (own) return own;
  if (!recipient.friendsSince || recipient.blocked)
    return refuse('gift_not_friends', 'You can only send gifts to friends.');
  if (recipient.suspended)
    return refuse('gift_recipient_unavailable', "This player can't receive gifts right now.");
  const friendsLongEnough = new Date(recipient.friendsSince.getTime() + GIFT_MIN_FRIEND_DAYS * DAY_MS);
  if (now.getTime() < friendsLongEnough.getTime())
    return refuse(
      'gift_friendship_too_new',
      `You can gift a friend once you've been friends for ${GIFT_MIN_FRIEND_DAYS} days.`,
      friendsLongEnough,
    );
  if (items.length === 0 || items.some((id) => recipient.owned.has(id)))
    return refuse('gift_already_owned', 'They already own this.');
  if (items.some((id) => recipient.pendingItems.has(id)))
    return refuse('gift_already_pending', 'Someone already sent them this; it is waiting in their gifts.');
  if (recipient.pendingCount >= GIFT_INBOX_LIMIT)
    return refuse('gift_inbox_full', 'Their gift inbox is full. Try again after they open some.');
  return { eligible: true };
}

function refusalError(v: Refused): ApiError {
  return new ApiError(REFUSAL_STATUS[v.reason], v.reason, v.message, {
    reason: v.reason,
    ...(v.retryAt ? { retryAt: v.retryAt.toISOString() } : {}),
  });
}

// -----------------------------------------------------------------------------
// Facts
// -----------------------------------------------------------------------------

const startOfUtcDay = (now: Date): Date => new Date(`${dayKey(now)}T00:00:00.000Z`);

async function senderFacts(db: DbOrTx, userId: string, now: Date): Promise<GiftSenderFacts | null> {
  // SECURITY: read from the database, not the access token, whose guest claim
  // lags an account link by up to 15 minutes.
  const [user] = await db
    .select({ isGuest: users.isGuest, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gifts)
    .where(and(eq(gifts.senderId, userId), gte(gifts.createdAt, startOfUtcDay(now))));
  return { ...user, sentToday: Number(row?.n ?? 0) };
}

/**
 * The policy facts for several would-be recipients at once (the friend
 * picker asks about every friend), in a fixed number of queries.
 *
 * @param db - Database or transaction.
 * @param senderId - The sender.
 * @param ids - Recipients.
 * @param itemIds - The cosmetic ids whose ownership matters.
 * @param now - Current time.
 */
async function recipientFacts(
  db: DbOrTx,
  senderId: string,
  ids: string[],
  itemIds: readonly string[],
  now: Date,
): Promise<Map<string, GiftRecipientFacts>> {
  const out = new Map<string, GiftRecipientFacts>();
  if (ids.length === 0) return out;
  const [pairs, suspended, pending, owned] = await Promise.all([
    db
      .select()
      .from(friendships)
      .where(
        or(
          and(eq(friendships.userId, senderId), inArray(friendships.friendId, ids)),
          and(eq(friendships.friendId, senderId), inArray(friendships.userId, ids)),
        ),
      ),
    db
      .select({ userId: bans.userId })
      .from(bans)
      .where(
        and(
          inArray(bans.userId, ids),
          eq(bans.scope, 'all'),
          isNull(bans.revokedAt),
          or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
        ),
      ),
    db
      .select({ recipientId: gifts.recipientId, items: gifts.items })
      .from(gifts)
      .where(and(eq(gifts.status, 'pending'), inArray(gifts.recipientId, ids))),
    itemIds.length === 0
      ? Promise.resolve([] as { userId: string; cosmeticId: string }[])
      : db
          .select({ userId: inventoryItems.userId, cosmeticId: inventoryItems.cosmeticId })
          .from(inventoryItems)
          .where(and(inArray(inventoryItems.userId, ids), inArray(inventoryItems.cosmeticId, [...itemIds]))),
  ]);
  const suspendedIds = new Set(suspended.map((r) => r.userId));
  for (const id of ids) {
    out.set(id, {
      friendsSince: null,
      blocked: false,
      suspended: suspendedIds.has(id),
      pendingCount: 0,
      pendingItems: new Set(),
      owned: new Set(),
    });
  }
  for (const p of pairs) {
    const f = out.get(p.userId === senderId ? p.friendId : p.userId);
    if (!f) continue;
    // `updated_at` of an accepted row is the moment it was accepted.
    if (p.status === 'accepted') f.friendsSince = p.updatedAt;
    if (p.status === 'blocked') f.blocked = true;
  }
  for (const g of pending) {
    const f = g.recipientId ? out.get(g.recipientId) : undefined;
    if (!f) continue;
    f.pendingCount++;
    for (const id of g.items as string[]) (f.pendingItems as Set<string>).add(id);
  }
  for (const o of owned) (out.get(o.userId)?.owned as Set<string> | undefined)?.add(o.cosmeticId);
  return out;
}

/** Every cosmetic id an offer could grant, before anyone's ownership is known. */
function candidateItems(ctx: AppContext, offerId: string): string[] {
  if (offerId.startsWith('bundle:')) return [...(storeSetById(offerId)?.itemIds ?? [])];
  return ctx.cosmetics.has(offerId) ? [offerId] : [];
}

/** What one recipient's gift would cost and grant, or null when nothing by that id is sold. */
function quoteFor(
  ctx: AppContext,
  rotation: StoreRotation,
  offerId: string,
  owned: ReadonlySet<string>,
): { items: string[]; price: { currency: 'gumballs' | 'gems'; amount: number } } | null {
  const offer = priceOffer(ctx.catalog, rotation, offerId, (id) => owned.has(id));
  if (!offer) return null;
  return {
    items: offer.kind === 'bundle' ? offer.quote.missing : [offer.item.id],
    price: { currency: offer.price.currency, amount: offer.price.amount },
  };
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

type GiftRow = typeof gifts.$inferSelect;

/** A gift as either party sees it. */
export interface GiftView {
  giftId: string;
  /** Cosmetic id or `bundle:<id>`. */
  offerId: string;
  /** Item or bundle name. */
  title: string;
  items: { id: string; name: string; slot: string | null; rarity: string | null }[];
  price: { currency: string; amount: number };
  /** The sender's note: slurs masked in `text`, everything masked in `masked`. */
  message: { text: string; masked?: string } | null;
  status: GiftStatus;
  /** The price went back to the sender. */
  refunded: boolean;
  autoAccepted: boolean;
  note: GiftNote | null;
  sentAt: string;
  /** When an unopened gift opens by itself. */
  opensAutomaticallyAt: string;
  resolvedAt: string | null;
  /** The sender, while their account exists. */
  from: SocialRef | null;
  /** The recipient, while their account exists. */
  to: SocialRef | null;
}

/**
 * The display name of an offer.
 *
 * @param ctx - Shared services.
 * @param offerId - Cosmetic id or `bundle:<id>`.
 */
export function offerTitle(ctx: AppContext, offerId: string): string {
  if (offerId.startsWith('bundle:')) return storeSetById(offerId)?.name ?? 'Bundle';
  return ctx.cosmetics.get(offerId)?.name ?? offerId;
}

async function refsOf(db: DbOrTx, ids: (string | null)[]): Promise<Map<string, SocialRef>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ userId: profiles.userId, name: profiles.displayName, tag: profiles.tag })
    .from(profiles)
    .where(inArray(profiles.userId, unique));
  return new Map(rows.map((r) => [r.userId, r]));
}

/**
 * Builds {@link GiftView}s, resolving both parties' names in one query.
 *
 * @param ctx - Shared services.
 * @param db - Database or transaction.
 * @param rows - Gift rows.
 */
export async function giftViews(ctx: AppContext, db: DbOrTx, rows: GiftRow[]): Promise<GiftView[]> {
  const refs = await refsOf(
    db,
    rows.flatMap((r) => [r.senderId, r.recipientId]),
  );
  return rows.map((r) => ({
    giftId: r.id,
    offerId: r.offerId,
    title: offerTitle(ctx, r.offerId),
    items: (r.items as string[]).map((id) => {
      const c = ctx.cosmetics.get(id);
      return { id, name: c?.name ?? id, slot: c?.slot ?? null, rarity: c?.rarity ?? null };
    }),
    price: { currency: r.currency, amount: r.price },
    message: r.message ? { text: r.message, ...(r.messageMasked ? { masked: r.messageMasked } : {}) } : null,
    status: r.status as GiftStatus,
    refunded: r.refunded,
    autoAccepted: r.autoAccepted,
    note: (r.note as GiftNote | null) ?? null,
    sentAt: r.createdAt.toISOString(),
    opensAutomaticallyAt: r.expiresAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    from: (r.senderId && refs.get(r.senderId)) || null,
    to: (r.recipientId && refs.get(r.recipientId)) || null,
  }));
}

// -----------------------------------------------------------------------------
// Locking and settling
// -----------------------------------------------------------------------------

/**
 * Locks both parties' profile rows in id order, then the gift row, and
 * returns the gift as it is now. Locking the profiles first, in the same
 * order as {@link sendGift}, keeps every gift operation deadlock-free.
 */
async function lockGift(tx: Tx, giftId: string): Promise<GiftRow | null> {
  const [peek] = await tx
    .select({ senderId: gifts.senderId, recipientId: gifts.recipientId })
    .from(gifts)
    .where(eq(gifts.id, giftId));
  if (!peek) return null;
  const parties = [peek.senderId, peek.recipientId].filter((x): x is string => !!x).sort();
  for (const id of parties) await lockWallet(tx, id);
  const [row] = await tx.select().from(gifts).where(eq(gifts.id, giftId)).for('update');
  return row ?? null;
}

/**
 * Closes a pending gift: refunds the sender (when asked and the sender still
 * exists) with the gift's one `gift_refund` row, and records the outcome.
 *
 * @returns Whether the sender got their currency back.
 */
async function closeGift(
  tx: Tx,
  ctx: AppContext,
  gift: GiftRow,
  status: Exclude<GiftStatus, 'pending' | 'opened'>,
  opts: { refund: boolean; note?: GiftNote },
): Promise<boolean> {
  let refunded = false;
  if (opts.refund && gift.senderId) {
    const r = await applyLedger(tx, {
      userId: gift.senderId,
      currency: gift.currency as 'gumballs' | 'gems',
      delta: gift.price,
      reason: 'gift_refund',
      ref: `gift:${gift.id}`,
    });
    refunded = r.applied || gift.refunded;
  }
  await tx
    .update(gifts)
    .set({ status, refunded: refunded || gift.refunded, note: opts.note ?? null, resolvedAt: ctx.now() })
    .where(eq(gifts.id, gift.id));
  return refunded;
}

/** Outcome of opening a gift. */
interface OpenOutcome {
  status: 'opened' | 'returned';
  /** Cosmetic ids granted (opened). */
  granted: string[];
  refunded: boolean;
}

/**
 * Opens a locked pending gift. If the recipient has meanwhile come to own
 * anything in it, nothing is granted and the gift goes back to the sender
 * instead, so nobody ever pays for an item its recipient already had.
 */
async function openLocked(tx: Tx, ctx: AppContext, gift: GiftRow, auto: boolean): Promise<OpenOutcome> {
  const items = gift.items as string[];
  const recipientId = gift.recipientId!;
  const owned = await tx
    .select({ id: inventoryItems.cosmeticId })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.userId, recipientId), inArray(inventoryItems.cosmeticId, items)));
  if (owned.length > 0) {
    const refunded = await closeGift(tx, ctx, gift, 'returned', { refund: true, note: 'recipient_owns' });
    return { status: 'returned', granted: [], refunded };
  }
  for (const id of items) await grantCosmetic(tx, recipientId, id, 'gift');
  await removeFromWishlist(tx, recipientId, [gift.offerId, ...items]);
  await tx
    .update(gifts)
    .set({ status: 'opened', autoAccepted: auto, resolvedAt: ctx.now() })
    .where(eq(gifts.id, gift.id));
  return { status: 'opened', granted: items, refunded: false };
}

/** Sends the `gift` event to both parties and fresh wallets where currency moved. */
async function announce(
  ctx: AppContext,
  gift: Pick<GiftRow, 'id' | 'senderId' | 'recipientId' | 'offerId'>,
  status: Exclude<GiftStatus, 'pending'> | 'received',
  opts: { walletOf?: string | null; autoAccepted?: boolean } = {},
): Promise<void> {
  const title = offerTitle(ctx, gift.offerId);
  const [sender, recipient] = await Promise.all([
    gift.senderId ? socialRef(ctx.db, gift.senderId) : null,
    gift.recipientId ? socialRef(ctx.db, gift.recipientId) : null,
  ]);
  const extra = opts.autoAccepted ? { autoAccepted: true } : {};
  const sends: Promise<void>[] = [];
  if (gift.recipientId)
    sends.push(
      ctx.notifier.notifyUser(gift.recipientId, {
        type: 'gift',
        giftId: gift.id,
        status,
        role: 'recipient',
        other: sender,
        title,
        ...extra,
      }),
    );
  if (gift.senderId && status !== 'received')
    sends.push(
      ctx.notifier.notifyUser(gift.senderId, {
        type: 'gift',
        giftId: gift.id,
        status,
        role: 'sender',
        other: recipient,
        title,
        ...extra,
      }),
    );
  if (opts.walletOf)
    sends.push(
      readWallet(ctx.db, opts.walletOf).then((w) =>
        ctx.notifier.notifyUser(opts.walletOf!, { type: 'wallet', ...w }),
      ),
    );
  await Promise.all(sends);
}

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

/** What `POST /gifts` sends. */
export interface SendGiftInput {
  recipientId: string;
  offerId: string;
  currency?: 'gumballs' | 'gems' | undefined;
  message?: string | undefined;
}

/** Answer of `POST /gifts`; a retried request gets the same gift with `replayed: true`. */
export interface SendGiftResult {
  gift: GiftView;
  wallet: Wallet;
  replayed: boolean;
}

/**
 * Sends a gift: charges the sender and files the gift for the recipient, in
 * one transaction. Idempotent per `(sender, Idempotency-Key)`.
 *
 * @param ctx - Shared services.
 * @param senderId - The buyer.
 * @param key - The request's `Idempotency-Key`.
 * @param input - Recipient, offer, optional currency check and message.
 * @returns The gift and the sender's wallet.
 * @throws {ApiError} 400 `gift_self` / `currency_mismatch`, 402
 *   `insufficient_funds`, 403/409/429 with a {@link GiftRefusal} code, 403
 *   `gift_message_muted`, 404 `offer_not_available`, 409
 *   `idempotency_key_reused`.
 */
export async function sendGift(
  ctx: AppContext,
  senderId: string,
  key: string,
  input: SendGiftInput,
): Promise<SendGiftResult> {
  const replay = async (db: DbOrTx): Promise<SendGiftResult | null> => {
    const [row] = await db
      .select()
      .from(gifts)
      .where(and(eq(gifts.senderId, senderId), eq(gifts.idempotencyKey, key)));
    if (!row) return null;
    if (row.recipientId !== input.recipientId || row.offerId !== input.offerId)
      throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different gift');
    const [view] = await giftViews(ctx, db, [row]);
    return { gift: view!, wallet: await readWallet(db, senderId), replayed: true };
  };
  if (senderId === input.recipientId) throw badRequest('gift_self', 'Gifts are for friends!');

  let message: { text: string; masked?: string } | null = null;
  if (input.message !== undefined) {
    // SECURITY: a chat mute also silences gift notes; the gift itself may still go.
    const bans = await activeBans(ctx, senderId);
    if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
      throw forbidden('gift_message_muted', 'Chat is disabled on this account, so gifts cannot carry a note');
    message = filterChat(input.message);
  }

  try {
    const result = await ctx.db.transaction(async (tx) => {
      const existing = await replay(tx);
      if (existing) return existing;
      const [recipient] = await tx
        .select({ id: profiles.userId })
        .from(profiles)
        .where(eq(profiles.userId, input.recipientId));
      if (!recipient) throw refusalError(refuse('gift_not_friends', 'You can only send gifts to friends.'));
      // SECURITY: both wallets are locked in id order before anything is read
      // that the decision depends on (caps, pending gifts, ownership), so
      // concurrent gifts serialise and cannot both pass the checks.
      for (const id of [senderId, input.recipientId].sort()) await lockWallet(tx, id);
      const replayedLate = await replay(tx);
      if (replayedLate) return replayedLate;

      const now = ctx.now();
      const sender = await senderFacts(tx, senderId, now);
      if (!sender) throw notFound('Account');
      const facts = (
        await recipientFacts(tx, senderId, [input.recipientId], candidateItems(ctx, input.offerId), now)
      ).get(input.recipientId)!;
      const rotation = await currentRotation(tx, ctx.catalog, now);
      const quote = quoteFor(ctx, rotation, input.offerId, facts.owned);
      if (!quote) throw new ApiError(404, 'offer_not_available', 'That item is not sold in the store');
      if (input.currency && input.currency !== quote.price.currency)
        throw badRequest('currency_mismatch', `This item costs ${quote.price.currency}`);
      const verdict = giftEligibility(sender, facts, quote.items, now);
      if (!verdict.eligible) throw refusalError(verdict);

      const id = randomUUID();
      await tx.insert(gifts).values({
        id,
        senderId,
        recipientId: input.recipientId,
        idempotencyKey: key,
        offerId: input.offerId,
        items: quote.items,
        currency: quote.price.currency,
        price: quote.price.amount,
        message: message?.text ?? null,
        messageMasked: message?.masked ?? null,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + GIFT_AUTO_ACCEPT_DAYS * DAY_MS),
      });
      await applyLedger(tx, {
        userId: senderId,
        currency: quote.price.currency,
        delta: -quote.price.amount,
        reason: 'gift',
        ref: `gift:${id}`,
      });
      const [row] = await tx.select().from(gifts).where(eq(gifts.id, id));
      const [view] = await giftViews(ctx, tx, [row!]);
      return { gift: view!, wallet: await readWallet(tx, senderId), replayed: false };
    });
    if (!result.replayed) {
      await announce(
        ctx,
        { id: result.gift.giftId, senderId, recipientId: input.recipientId, offerId: input.offerId },
        'received',
      );
      await ctx.notifier.notifyUser(senderId, { type: 'wallet', ...result.wallet });
    }
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const replayed = await replay(ctx.db);
      if (replayed) return replayed;
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Opening, declining, cancelling
// -----------------------------------------------------------------------------

/** Answer of the gift actions. */
export interface GiftActionResult {
  gift: GiftView;
  /** Cosmetic ids the recipient just received (open only). */
  granted: string[];
  /** True when the gift was already in the asked-for state (a repeated tap). */
  replayed: boolean;
}

type GiftAction = 'open' | 'decline' | 'cancel';

const ACTION_RESULT: Readonly<Record<GiftAction, GiftStatus>> = {
  open: 'opened',
  decline: 'declined',
  cancel: 'cancelled',
};

/**
 * Opens or declines a gift (recipient) or cancels an unopened one (sender).
 * Declining and cancelling refund the sender in full; opening grants the
 * items with source `gift` (or returns the gift if the recipient already
 * owns something in it). Repeating the action that already happened answers
 * with the gift and `replayed: true`. A gift past its auto-accept time is
 * opened instead and the decline or cancel refused, since it was already due.
 *
 * @param ctx - Shared services.
 * @param userId - The caller.
 * @param giftId - The gift.
 * @param action - What to do.
 * @throws {ApiError} 404 when the caller is not the party the action belongs
 *   to, 409 `gift_not_pending` once the gift was settled otherwise.
 */
export async function actOnGift(
  ctx: AppContext,
  userId: string,
  giftId: string,
  action: GiftAction,
): Promise<GiftActionResult> {
  type Outcome = {
    gift: GiftRow;
    granted: string[];
    replayed: boolean;
    /** What the gift became, when this call changed it. */
    became?: Exclude<GiftStatus, 'pending'>;
    refunded?: boolean;
    autoAccepted?: boolean;
  };
  const outcome = await ctx.db.transaction(async (tx): Promise<Outcome> => {
    const gift = await lockGift(tx, giftId);
    const mine = gift && (action === 'cancel' ? gift.senderId === userId : gift.recipientId === userId);
    if (!gift || !mine) throw notFound('Gift');
    if (gift.status !== 'pending') {
      if (gift.status === ACTION_RESULT[action]) return { gift, granted: [], replayed: true };
      throw conflict('gift_not_pending', 'This gift was already settled', { status: gift.status });
    }
    // An overdue gift has already been accepted in all but bookkeeping, so it
    // can no longer be declined or cancelled for a refund.
    const overdue = gift.expiresAt.getTime() <= ctx.now().getTime();
    if (action === 'open' || overdue) {
      const r = await openLocked(tx, ctx, gift, action !== 'open');
      return {
        gift,
        granted: r.granted,
        replayed: false,
        became: r.status,
        refunded: r.refunded,
        autoAccepted: action !== 'open',
      };
    }
    const became = ACTION_RESULT[action] as 'declined' | 'cancelled';
    const refunded = await closeGift(tx, ctx, gift, became, { refund: true });
    return { gift, granted: [], replayed: false, became, refunded };
  });
  if (outcome.became) {
    await announce(ctx, outcome.gift, outcome.became, {
      walletOf: outcome.refunded ? outcome.gift.senderId : null,
      ...(outcome.autoAccepted ? { autoAccepted: true } : {}),
    });
  }
  const [row] = await ctx.db.select().from(gifts).where(eq(gifts.id, giftId));
  const [view] = await giftViews(ctx, ctx.db, [row!]);
  if (outcome.autoAccepted)
    throw conflict('gift_not_pending', 'This gift was already settled', { status: view!.status });
  return { gift: view!, granted: outcome.granted, replayed: outcome.replayed };
}

/**
 * Opens every unopened gift whose {@link GIFT_AUTO_ACCEPT_DAYS} are up (or
 * returns it when the recipient already owns its item), each in its own
 * transaction so one failure cannot hold back the rest.
 *
 * @param ctx - Shared services.
 * @param scope - Only this player's gifts (as sender or recipient), or all.
 * @param limit - Most gifts to settle in one call.
 * @returns How many gifts were settled.
 */
export async function settleExpiredGifts(
  ctx: AppContext,
  scope: { userId?: string } = {},
  limit = 200,
): Promise<number> {
  const now = ctx.now();
  const due = await ctx.db
    .select({ id: gifts.id })
    .from(gifts)
    .where(
      and(
        eq(gifts.status, 'pending'),
        lte(gifts.expiresAt, now),
        scope.userId ? or(eq(gifts.recipientId, scope.userId), eq(gifts.senderId, scope.userId)) : undefined,
      ),
    )
    .orderBy(gifts.expiresAt)
    .limit(limit);
  let settled = 0;
  for (const { id } of due) {
    try {
      const outcome = await ctx.db.transaction(async (tx) => {
        const gift = await lockGift(tx, id);
        if (!gift || gift.status !== 'pending' || gift.expiresAt.getTime() > ctx.now().getTime()) return null;
        if (!gift.recipientId) return null;
        return { gift, ...(await openLocked(tx, ctx, gift, true)) };
      });
      if (!outcome) continue;
      settled++;
      await announce(ctx, outcome.gift, outcome.status, {
        autoAccepted: outcome.status === 'opened',
        walletOf: outcome.refunded ? outcome.gift.senderId : null,
      });
    } catch {
      // Left pending; the next sweep or read tries again.
    }
  }
  return settled;
}

// -----------------------------------------------------------------------------
// Erasure and staff reversal
// -----------------------------------------------------------------------------

/** Gifts an account deletion settled, for notifications after it commits. */
export interface ErasedGifts {
  returned: Pick<GiftRow, 'id' | 'senderId' | 'recipientId' | 'offerId'>[];
}

/**
 * Settles gifts before an account is deleted, inside the deletion's
 * transaction: unopened gifts to the account go back to their senders
 * (refunded), and notes the account wrote are erased with it. Unopened gifts
 * *from* the account stay with their recipients, already paid for.
 *
 * @param tx - The deletion's transaction.
 * @param ctx - Shared services.
 * @param userId - The account being deleted.
 */
export async function settleGiftsOnErasure(tx: Tx, ctx: AppContext, userId: string): Promise<ErasedGifts> {
  const senders = await tx
    .selectDistinct({ id: gifts.senderId })
    .from(gifts)
    .where(and(eq(gifts.recipientId, userId), eq(gifts.status, 'pending')));
  // SECURITY: holding the account's own profile lock makes a gift sent to it
  // right now either land before this read (and be refunded) or wait and fail
  // once the profile is gone; never slip through unrefunded.
  const parties = [userId, ...senders.flatMap((s) => (s.id ? [s.id] : []))].sort();
  for (const id of new Set(parties)) await lockWallet(tx, id);
  const pending = await tx
    .select()
    .from(gifts)
    .where(and(eq(gifts.recipientId, userId), eq(gifts.status, 'pending')))
    .for('update');
  for (const g of pending)
    await closeGift(tx, ctx, g, 'returned', { refund: true, note: 'recipient_deleted' });
  await tx.update(gifts).set({ message: null, messageMasked: null }).where(eq(gifts.senderId, userId));
  return {
    returned: pending.map(({ id, senderId, offerId }) => ({ id, senderId, recipientId: null, offerId })),
  };
}

/**
 * Tells senders their gift came back after its recipient's account was deleted.
 *
 * @param ctx - Shared services.
 * @param settled - What {@link settleGiftsOnErasure} returned.
 */
export async function announceErasedGifts(ctx: AppContext, settled: ErasedGifts): Promise<void> {
  for (const g of settled.returned) await announce(ctx, g, 'returned', { walletOf: g.senderId });
}

/** Outcome of a staff reversal. */
export interface GiftReversal {
  gift: GiftRow;
  /** What the gift was before. */
  previousStatus: GiftStatus;
  /** Cosmetic ids taken back from the recipient. */
  revoked: string[];
  loadoutsChanged: number[];
  refunded: boolean;
}

/**
 * Staff reversal: refunds the sender in full and, for an opened gift, takes
 * back the items the recipient still holds *because of the gift* (an item
 * they have since also earned is kept, as with store refunds). Runs in the
 * caller's transaction so the audit row commits with it.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param giftId - The gift.
 * @throws {ApiError} 404 unknown gift, 409 `gift_not_reversible` once it was
 *   already declined, cancelled, returned or reversed.
 */
export async function reverseGift(tx: Tx, ctx: AppContext, giftId: string): Promise<GiftReversal> {
  const gift = await lockGift(tx, giftId);
  if (!gift) throw notFound('Gift');
  if (gift.status !== 'pending' && gift.status !== 'opened')
    throw conflict('gift_not_reversible', 'This gift was already settled and refunded', {
      status: gift.status,
    });
  const revoked: string[] = [];
  const loadouts = new Set<number>();
  if (gift.status === 'opened' && gift.recipientId) {
    for (const id of gift.items as string[]) {
      const r = await revokeCosmetic(tx, ctx, gift.recipientId, id, 'gift');
      if (!r) continue;
      revoked.push(id);
      for (const slot of r.loadouts) loadouts.add(slot);
    }
  }
  const refunded = await closeGift(tx, ctx, gift, 'reversed', { refund: true, note: 'staff' });
  return {
    gift,
    previousStatus: gift.status as GiftStatus,
    revoked,
    loadoutsChanged: [...loadouts].sort((a, b) => a - b),
    refunded,
  };
}

/**
 * Notifies both sides after a staff reversal committed.
 *
 * @param ctx - Shared services.
 * @param r - The reversal.
 */
export async function announceReversal(ctx: AppContext, r: GiftReversal): Promise<void> {
  await announce(ctx, r.gift, 'reversed', { walletOf: r.refunded ? r.gift.senderId : null });
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** `GET /gifts`. */
export interface GiftInbox {
  /** Gifts to the caller: unopened first (oldest first), then the latest settled. */
  received: GiftView[];
  /** Gifts from the caller, newest first. */
  sent: GiftView[];
  /** Unopened gifts waiting for the caller. */
  unopened: number;
  limits: {
    daily: number;
    sentToday: number;
    /** When today's count resets (00:00 UTC). */
    resetsAt: string;
    inbox: number;
  };
  policy: {
    minFriendDays: number;
    minAccountDays: number;
    autoAcceptDays: number;
    messageMax: number;
  };
}

/**
 * The caller's gifts both ways, after auto-accepting anything overdue.
 *
 * @param ctx - Shared services.
 * @param userId - The caller.
 * @param limit - Most settled gifts per direction.
 */
export async function giftInbox(ctx: AppContext, userId: string, limit = 50): Promise<GiftInbox> {
  await settleExpiredGifts(ctx, { userId }, 50);
  const now = ctx.now();
  const [pending, settledReceived, sent, sender] = await Promise.all([
    ctx.db
      .select()
      .from(gifts)
      .where(and(eq(gifts.recipientId, userId), eq(gifts.status, 'pending')))
      .orderBy(gifts.createdAt),
    ctx.db
      .select()
      .from(gifts)
      .where(and(eq(gifts.recipientId, userId), sql`${gifts.status} <> 'pending'`))
      .orderBy(desc(gifts.createdAt))
      .limit(limit),
    ctx.db.select().from(gifts).where(eq(gifts.senderId, userId)).orderBy(desc(gifts.createdAt)).limit(limit),
    senderFacts(ctx.db, userId, now),
  ]);
  const views = await giftViews(ctx, ctx.db, [...pending, ...settledReceived, ...sent]);
  return {
    received: views.slice(0, pending.length + settledReceived.length),
    sent: views.slice(pending.length + settledReceived.length),
    unopened: pending.length,
    limits: {
      daily: GIFT_DAILY_LIMIT,
      sentToday: sender?.sentToday ?? 0,
      resetsAt: nextUtcMidnight(now).toISOString(),
      inbox: GIFT_INBOX_LIMIT,
    },
    policy: {
      minFriendDays: GIFT_MIN_FRIEND_DAYS,
      minAccountDays: GIFT_MIN_ACCOUNT_DAYS,
      autoAcceptDays: GIFT_AUTO_ACCEPT_DAYS,
      messageMax: GIFT_MESSAGE_MAX,
    },
  };
}

/** One friend in the gift picker. */
export interface GiftCandidate {
  userId: string;
  name: string;
  tag: string;
  eligible: boolean;
  /** What the gift would cost for this friend (a bundle skips what they own). */
  price: { currency: string; amount: number } | null;
  reason?: GiftRefusal;
  message?: string;
  retryAt?: string;
}

/** `GET /gifts/eligibility`. */
export interface GiftPicker {
  offerId: string;
  title: string;
  /** Set when the caller cannot send any gift (guest, too new, daily cap). */
  sender: { reason: GiftRefusal; message: string; retryAt?: string } | null;
  friends: GiftCandidate[];
  sentToday: number;
  dailyLimit: number;
}

/**
 * Every friend with whether the caller could gift them this offer now, and
 * why not. Eligible friends come first, then by name.
 *
 * @param ctx - Shared services.
 * @param userId - The caller.
 * @param offerId - Cosmetic id or `bundle:<id>`.
 * @throws {ApiError} 404 `offer_not_available` when nothing by that id is sold.
 */
export async function giftPicker(ctx: AppContext, userId: string, offerId: string): Promise<GiftPicker> {
  const now = ctx.now();
  const rotation = await currentRotation(ctx.db, ctx.catalog, now);
  if (!quoteFor(ctx, rotation, offerId, new Set()))
    throw new ApiError(404, 'offer_not_available', 'That item is not sold in the store');
  const sender = await senderFacts(ctx.db, userId, now);
  if (!sender) throw notFound('Account');
  const ids = await friendIds(ctx.db, userId);
  const [facts, refs] = await Promise.all([
    recipientFacts(ctx.db, userId, ids, candidateItems(ctx, offerId), now),
    refsOf(ctx.db, ids),
  ]);
  const own = senderGiftRefusal(sender, now);
  const friends = ids.flatMap((id): GiftCandidate[] => {
    const ref = refs.get(id);
    const f = facts.get(id);
    if (!ref || !f) return [];
    const quote = quoteFor(ctx, rotation, offerId, f.owned);
    const verdict = giftEligibility(sender, f, quote?.items ?? [], now);
    return [
      {
        userId: id,
        name: ref.name,
        tag: ref.tag,
        eligible: verdict.eligible,
        price: quote ? quote.price : null,
        ...(verdict.eligible
          ? {}
          : {
              reason: verdict.reason,
              message: verdict.message,
              ...(verdict.retryAt ? { retryAt: verdict.retryAt.toISOString() } : {}),
            }),
      },
    ];
  });
  friends.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
  return {
    offerId,
    title: offerTitle(ctx, offerId),
    sender: own
      ? {
          reason: own.reason,
          message: own.message,
          ...(own.retryAt ? { retryAt: own.retryAt.toISOString() } : {}),
        }
      : null,
    friends,
    sentToday: sender.sentToday,
    dailyLimit: GIFT_DAILY_LIMIT,
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const OfferId = z.string().min(3).max(64);
const SendBody = z
  .object({
    recipientId: z.string().uuid(),
    offerId: OfferId,
    currency: z.enum(['gumballs', 'gems']).optional(),
    message: z.string().max(GIFT_MESSAGE_MAX).optional(),
  })
  .strict();
const GiftParams = z.object({ giftId: z.string().uuid() });
const PickerQuery = z.object({ offerId: OfferId });

/** Routes that move currency, for the `store.enabled` kill switch (`liveops/routes.ts`). */
export const GIFT_SPEND_ROUTES = ['/gifts', '/gifts/:giftId/decline', '/gifts/:giftId/cancel'] as const;

/**
 * Registers the player gift routes:
 *
 * - `GET /gifts` — both directions, limits and policy (auto-accepts overdue gifts first).
 * - `GET /gifts/eligibility?offerId=` — the friend picker.
 * - `POST /gifts` (`Idempotency-Key`) `{ recipientId, offerId, currency?, message? }`.
 * - `POST /gifts/:giftId/open` | `/decline` (recipient), `/cancel` (sender).
 *
 * Every mutation is refused during maintenance; those that move currency
 * also close with the store (`store.enabled`).
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 * @param idempotencyKey - Reads the request's `Idempotency-Key`.
 */
export function registerGiftRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  idempotencyKey: (req: FastifyRequest) => string,
): void {
  app.get('/gifts', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const inbox = await giftInbox(ctx, auth.userId);
    await checkWishlistAlert(ctx, auth.userId).catch((err: unknown) =>
      req.log.warn({ err }, 'wish list alert'),
    );
    return inbox;
  });

  app.get(
    '/gifts/eligibility',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const { offerId } = parse(PickerQuery, req.query);
      return giftPicker(ctx, auth.userId, offerId);
    },
  );

  app.post('/gifts', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const key = idempotencyKey(req);
    const body = parse(SendBody, req.body);
    await refuseDuringMaintenance(ctx);
    return sendGift(ctx, auth.userId, key, body);
  });

  for (const action of ['open', 'decline', 'cancel'] as const) {
    app.post(
      `/gifts/:giftId/${action}`,
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => {
        const auth = await requireUser(ctx, req);
        const { giftId } = parse(GiftParams, req.params);
        await refuseDuringMaintenance(ctx);
        return actOnGift(ctx, auth.userId, giftId, action);
      },
    );
  }
}
