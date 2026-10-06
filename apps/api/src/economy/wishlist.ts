/**
 * Wish lists: store items and bundles a player would like, in their own
 * order, that friends may look at (unless the player hides the list) and
 * gift from.
 *
 * Responsibilities:
 * - Adding (up to {@link WISHLIST_LIMIT}), removing and reordering entries.
 *   Only things the store sells qualify: a `store` cosmetic with a list price
 *   or a sellable `bundle:<id>`.
 * - Privacy: `friends` (default) or `nobody`. Anyone else asking gets the
 *   same `wishlist_hidden` answer, so a block or a hidden list is never
 *   distinguishable from not being friends.
 * - The daily alert: the first time a player's client asks for the store,
 *   the wish list or the gift inbox on a UTC day, wished-for items on that
 *   day's shelves trigger one `wishlist_in_store` event (never more than one
 *   per rotation, and never with alerts switched off).
 * - Entries leave the list once the player gets the item (purchase or gift).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { storeSetById } from '@tumble/content/progression';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { friendships, inventoryItems, wishlistItems, wishlistSettings } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { ApiError, badRequest, conflict, parse } from '../http/errors.ts';
import { dayKey } from '../util/time.ts';
import { currentRotation, priceOffer, type StoreRotation } from './store.ts';

/** Most entries on one wish list. */
export const WISHLIST_LIMIT = 50;

/** Who may see a wish list. */
export type WishlistVisibility = 'friends' | 'nobody';

/** One wish list entry as its owner or a friend sees it. */
export interface WishlistEntry {
  /** Cosmetic id or `bundle:<id>`. */
  itemId: string;
  title: string;
  kind: 'item' | 'bundle';
  /** Cosmetic ids it covers (one for an item). */
  items: string[];
  /** What it costs today (for the list's owner). */
  price: { currency: string; amount: number } | null;
  /** On one of today's shelves (featured, daily, weekly or the hero bundle). */
  inStoreToday: boolean;
  /** The list's owner already has all of it. */
  owned: boolean;
  addedAt: string;
}

/** `GET /wishlist`. */
export interface WishlistView {
  entries: WishlistEntry[];
  visibility: WishlistVisibility;
  alerts: boolean;
  limit: number;
}

/** True when the store sells this id (an item at list price or a sellable bundle). */
export function isWishable(ctx: AppContext, itemId: string): boolean {
  if (itemId.startsWith('bundle:')) {
    const set = storeSetById(itemId);
    return !!set && set.itemIds.every((id) => isWishable(ctx, id));
  }
  const c = ctx.cosmetics.get(itemId);
  return !!c && c.source === 'store' && c.price !== null;
}

/** Offer ids on today's shelves. */
export function shelfIds(rotation: StoreRotation): Set<string> {
  return new Set([
    ...rotation.featured.map((o) => o.offerId),
    ...rotation.daily.map((o) => o.offerId),
    ...rotation.weekly.map((o) => o.offerId),
    ...(rotation.heroBundle ? [rotation.heroBundle] : []),
  ]);
}

function coveredItems(itemId: string): string[] {
  return itemId.startsWith('bundle:') ? [...(storeSetById(itemId)?.itemIds ?? [])] : [itemId];
}

async function settingsOf(
  db: DbOrTx,
  userId: string,
): Promise<{ visibility: WishlistVisibility; alerts: boolean; lastAlertDay: string | null }> {
  const [row] = await db.select().from(wishlistSettings).where(eq(wishlistSettings.userId, userId));
  return {
    visibility: (row?.visibility as WishlistVisibility | undefined) ?? 'friends',
    alerts: row?.alerts ?? true,
    lastAlertDay: row?.lastAlertDay ?? null,
  };
}

async function ownedSet(db: DbOrTx, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: inventoryItems.cosmeticId })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  return new Set(rows.map((r) => r.id));
}

/**
 * A player's wish list with today's prices and shelves.
 *
 * @param ctx - Shared services.
 * @param userId - Whose list.
 */
export async function wishlistEntries(ctx: AppContext, userId: string): Promise<WishlistEntry[]> {
  const [rows, owned, rotation] = await Promise.all([
    ctx.db
      .select()
      .from(wishlistItems)
      .where(eq(wishlistItems.userId, userId))
      .orderBy(asc(wishlistItems.position), asc(wishlistItems.createdAt)),
    ownedSet(ctx.db, userId),
    currentRotation(ctx.db, ctx.catalog, ctx.now()),
  ]);
  const shelf = shelfIds(rotation);
  return rows.map((r) => {
    const bundle = r.itemId.startsWith('bundle:');
    const items = coveredItems(r.itemId);
    const offer = priceOffer(ctx.catalog, rotation, r.itemId, (id) => owned.has(id));
    return {
      itemId: r.itemId,
      title: bundle
        ? (storeSetById(r.itemId)?.name ?? 'Bundle')
        : (ctx.cosmetics.get(r.itemId)?.name ?? r.itemId),
      kind: bundle ? 'bundle' : 'item',
      items,
      price: offer && offer.price.amount > 0 ? { ...offer.price } : null,
      inStoreToday: shelf.has(r.itemId),
      owned: items.length > 0 && items.every((id) => owned.has(id)),
      addedAt: r.createdAt.toISOString(),
    };
  });
}

/**
 * Takes entries off a player's list (after they got the items). Must run in
 * the transaction that granted them.
 *
 * @param db - Open transaction.
 * @param userId - Whose list.
 * @param itemIds - Entries to remove (item or `bundle:` ids).
 */
export async function removeFromWishlist(db: DbOrTx, userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.userId, userId), inArray(wishlistItems.itemId, itemIds)));
}

/**
 * Sends the day's wish list alert if wished-for items are on today's shelves
 * and this player has not been told today. The conditional upsert makes it
 * at most once per UTC day across every API instance.
 *
 * @param ctx - Shared services.
 * @param userId - The player.
 * @returns The items announced (empty when nothing was sent).
 */
export async function checkWishlistAlert(
  ctx: AppContext,
  userId: string,
): Promise<{ itemId: string; title: string }[]> {
  const now = ctx.now();
  const day = dayKey(now);
  const settings = await settingsOf(ctx.db, userId);
  if (!settings.alerts || settings.lastAlertDay === day) return [];
  const entries = await wishlistEntries(ctx, userId);
  const hits = entries
    .filter((e) => e.inStoreToday && !e.owned)
    .map((e) => ({ itemId: e.itemId, title: e.title }));
  if (hits.length === 0) return [];
  const claimed = await ctx.db
    .insert(wishlistSettings)
    .values({ userId, lastAlertDay: day, updatedAt: now })
    .onConflictDoUpdate({
      target: wishlistSettings.userId,
      set: { lastAlertDay: day },
      setWhere: sql`${wishlistSettings.lastAlertDay} is distinct from ${day} and ${wishlistSettings.alerts}`,
    })
    .returning({ userId: wishlistSettings.userId });
  if (claimed.length === 0) return [];
  await ctx.notifier.notifyUser(userId, { type: 'wishlist_in_store', day, items: hits });
  return hits;
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const ItemBody = z.object({ itemId: z.string().min(3).max(64) }).strict();
const ItemParams = z.object({ itemId: z.string().min(3).max(64) });
const OrderBody = z.object({ itemIds: z.array(z.string().min(3).max(64)).max(WISHLIST_LIMIT) }).strict();
const SettingsBody = z
  .object({ visibility: z.enum(['friends', 'nobody']).optional(), alerts: z.boolean().optional() })
  .strict();
const UserParams = z.object({ userId: z.string().uuid() });

async function view(ctx: AppContext, userId: string): Promise<WishlistView> {
  const [entries, settings] = await Promise.all([wishlistEntries(ctx, userId), settingsOf(ctx.db, userId)]);
  return { entries, visibility: settings.visibility, alerts: settings.alerts, limit: WISHLIST_LIMIT };
}

/**
 * Registers the wish list routes:
 *
 * - `GET /wishlist` — the caller's list, privacy and alert settings.
 * - `POST /wishlist` `{ itemId }` — add (idempotent; 409 `wishlist_full`, `already_owned`).
 * - `DELETE /wishlist/:itemId` — remove.
 * - `PUT /wishlist/order` `{ itemIds }` — the whole list in its new order.
 * - `PATCH /wishlist/settings` `{ visibility?, alerts? }`.
 * - `GET /players/:userId/wishlist` — a friend's list, if they share it.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerWishlistRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/wishlist', async (req) => {
    const auth = await requireUser(ctx, req);
    const result = await view(ctx, auth.userId);
    await checkWishlistAlert(ctx, auth.userId).catch((err: unknown) =>
      req.log.warn({ err }, 'wish list alert'),
    );
    return result;
  });

  app.post('/wishlist', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { itemId } = parse(ItemBody, req.body);
    if (!isWishable(ctx, itemId))
      throw new ApiError(404, 'offer_not_available', 'Only things sold in the store can go on a wish list');
    await ctx.db.transaction(async (tx) => {
      // Serialises adds per player so two at once cannot both squeeze under the cap.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wishlist:${auth.userId}`}))`);
      const rows = await tx
        .select({ itemId: wishlistItems.itemId, position: wishlistItems.position })
        .from(wishlistItems)
        .where(eq(wishlistItems.userId, auth.userId));
      if (rows.some((r) => r.itemId === itemId)) return;
      if (rows.length >= WISHLIST_LIMIT)
        throw conflict('wishlist_full', `Your wish list holds ${WISHLIST_LIMIT} items. Remove one first.`);
      const owned = await ownedSet(tx, auth.userId);
      if (coveredItems(itemId).every((id) => owned.has(id)))
        throw conflict('already_owned', 'You already own this');
      await tx.insert(wishlistItems).values({
        userId: auth.userId,
        itemId,
        position: rows.reduce((m, r) => Math.max(m, r.position + 1), 0),
        createdAt: ctx.now(),
      });
    });
    return view(ctx, auth.userId);
  });

  app.delete('/wishlist/:itemId', async (req) => {
    const auth = await requireUser(ctx, req);
    const { itemId } = parse(ItemParams, req.params);
    await removeFromWishlist(ctx.db, auth.userId, [itemId]);
    return view(ctx, auth.userId);
  });

  app.put('/wishlist/order', async (req) => {
    const auth = await requireUser(ctx, req);
    const { itemIds } = parse(OrderBody, req.body);
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wishlist:${auth.userId}`}))`);
      const rows = await tx
        .select({ itemId: wishlistItems.itemId })
        .from(wishlistItems)
        .where(eq(wishlistItems.userId, auth.userId));
      const current = new Set(rows.map((r) => r.itemId));
      if (itemIds.length !== current.size || new Set(itemIds).size !== itemIds.length)
        throw conflict('wishlist_changed', 'Your wish list changed; reload it and try again');
      if (itemIds.some((id) => !current.has(id)))
        throw conflict('wishlist_changed', 'Your wish list changed; reload it and try again');
      for (const [position, itemId] of itemIds.entries()) {
        await tx
          .update(wishlistItems)
          .set({ position })
          .where(and(eq(wishlistItems.userId, auth.userId), eq(wishlistItems.itemId, itemId)));
      }
    });
    return view(ctx, auth.userId);
  });

  app.patch('/wishlist/settings', async (req) => {
    const auth = await requireUser(ctx, req);
    const body = parse(SettingsBody, req.body);
    if (body.visibility === undefined && body.alerts === undefined)
      throw badRequest('nothing_to_change', 'Send visibility, alerts or both');
    const patch = {
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(body.alerts !== undefined ? { alerts: body.alerts } : {}),
      updatedAt: ctx.now(),
    };
    await ctx.db
      .insert(wishlistSettings)
      .values({ userId: auth.userId, ...patch })
      .onConflictDoUpdate({ target: wishlistSettings.userId, set: patch });
    return view(ctx, auth.userId);
  });

  app.get(
    '/players/:userId/wishlist',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const { userId } = parse(UserParams, req.params);
      if (userId === auth.userId) return view(ctx, userId);
      const [pair] = await ctx.db
        .select({ status: friendships.status })
        .from(friendships)
        .where(
          sql`(${friendships.userId} = ${auth.userId} and ${friendships.friendId} = ${userId})
            or (${friendships.userId} = ${userId} and ${friendships.friendId} = ${auth.userId})`,
        );
      const settings = await settingsOf(ctx.db, userId);
      // SECURITY: not friends, blocked and hidden all answer alike, so the
      // response never reveals a block or whether the account exists.
      if (pair?.status !== 'accepted' || settings.visibility !== 'friends')
        throw new ApiError(403, 'wishlist_hidden', "This player's wish list is private");
      const entries = (await wishlistEntries(ctx, userId)).filter((e) => !e.owned);
      return { userId, entries, limit: WISHLIST_LIMIT };
    },
  );
}
