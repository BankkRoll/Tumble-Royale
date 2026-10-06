/**
 * Gifts and wish lists between the API and the UI: maps `GET /gifts`,
 * `GET /gifts/eligibility` and the wish list answers onto the UI's types,
 * and turns refusals and realtime gift events into player-facing text. Free
 * of DOM and network so it is unit-tested on its own; cosmetics are resolved
 * through a function the caller passes in.
 */
import type {
  CosmeticItem,
  Currency,
  GiftEntry,
  GiftPickerData,
  GiftsData,
  GiftState,
  WishlistData,
  WishlistEntryView,
} from '@tumble/ui';
import { ApiError } from '../api.ts';

/** Resolves a cosmetic id to the UI's item (null when unknown to this build). */
export type ItemResolver = (id: string) => CosmeticItem | null;

/** A gift's party, as the API sends it. */
interface ApiParty {
  userId: string;
  name: string;
  tag: string;
}

/** One gift, as the API sends it. */
export interface ApiGift {
  giftId: string;
  offerId: string;
  title: string;
  items: { id: string; name: string; slot: string | null; rarity: string | null }[];
  price: { currency: string; amount: number };
  message: { text: string; masked?: string } | null;
  status: GiftState;
  refunded: boolean;
  autoAccepted: boolean;
  note: GiftEntry['note'];
  sentAt: string;
  opensAutomaticallyAt: string;
  resolvedAt: string | null;
  from: ApiParty | null;
  to: ApiParty | null;
}

/** `GET /gifts`. */
export interface ApiGiftInbox {
  received: ApiGift[];
  sent: ApiGift[];
  unopened: number;
  limits: { daily: number; sentToday: number; resetsAt: string; inbox: number };
  policy: GiftsData['policy'];
}

/** `GET /gifts/eligibility`. */
export interface ApiGiftPicker {
  offerId: string;
  title: string;
  sender: { reason: string; message: string; retryAt?: string } | null;
  friends: {
    userId: string;
    name: string;
    tag: string;
    eligible: boolean;
    price: { currency: string; amount: number } | null;
    reason?: string;
    message?: string;
    retryAt?: string;
  }[];
  sentToday: number;
  dailyLimit: number;
}

/** `POST /gifts` and the gift actions. */
export interface ApiGiftResult {
  gift: ApiGift;
  granted?: string[];
  replayed: boolean;
}

/** A wish list entry, as the API sends it. */
export interface ApiWishlistEntry {
  itemId: string;
  title: string;
  kind: 'item' | 'bundle';
  items: string[];
  price: { currency: string; amount: number } | null;
  inStoreToday: boolean;
  owned: boolean;
}

/** `GET /wishlist` and every wish list change. */
export interface ApiWishlist {
  entries: ApiWishlistEntry[];
  visibility: 'friends' | 'nobody';
  alerts: boolean;
  limit: number;
}

const currency = (c: string): Currency => (c === 'gems' ? 'gems' : 'gumballs');

function giftEntry(g: ApiGift, resolve: ItemResolver): GiftEntry {
  return {
    giftId: g.giftId,
    offerId: g.offerId,
    title: g.title,
    items: g.items.flatMap((i) => {
      const item = resolve(i.id);
      return item ? [item] : [];
    }),
    price: { currency: currency(g.price.currency), amount: g.price.amount },
    message: g.message,
    status: g.status,
    refunded: g.refunded,
    autoAccepted: g.autoAccepted,
    note: g.note,
    sentAt: Date.parse(g.sentAt),
    opensAutomaticallyAt: Date.parse(g.opensAutomaticallyAt),
    from: g.from,
    to: g.to,
  };
}

/**
 * Maps `GET /gifts` onto Profile → Gifts.
 *
 * @param inbox - The API's answer.
 * @param resolve - Cosmetic lookup.
 */
export function toGifts(inbox: ApiGiftInbox, resolve: ItemResolver): GiftsData {
  return {
    status: 'ready',
    received: inbox.received.map((g) => giftEntry(g, resolve)),
    sent: inbox.sent.map((g) => giftEntry(g, resolve)),
    unopened: inbox.unopened,
    limits: {
      daily: inbox.limits.daily,
      sentToday: inbox.limits.sentToday,
      resetsAt: Date.parse(inbox.limits.resetsAt),
    },
    policy: inbox.policy,
  };
}

/**
 * Maps `GET /gifts/eligibility` onto the gift sheet.
 *
 * @param p - The API's answer.
 * @param resolve - Cosmetic lookup (the hero item preview).
 * @param heroId - Item to preview (a bundle's first item).
 * @param recipientId - Friend to preselect.
 * @param messageMax - Longest note.
 */
export function toGiftPicker(
  p: ApiGiftPicker,
  resolve: ItemResolver,
  heroId: string,
  recipientId: string | null,
  messageMax: number,
): GiftPickerData {
  return {
    offerId: p.offerId,
    title: p.title,
    item: resolve(heroId),
    status: 'ready',
    sender: p.sender
      ? { message: p.sender.message, ...(p.sender.retryAt ? { retryAt: Date.parse(p.sender.retryAt) } : {}) }
      : null,
    friends: p.friends.map((f) => ({
      userId: f.userId,
      name: f.name,
      tag: f.tag,
      eligible: f.eligible,
      price: f.price ? { currency: currency(f.price.currency), amount: f.price.amount } : null,
      ...(f.message ? { message: f.message } : {}),
      ...(f.retryAt ? { retryAt: Date.parse(f.retryAt) } : {}),
    })),
    sentToday: p.sentToday,
    dailyLimit: p.dailyLimit,
    messageMax,
    recipientId:
      recipientId && p.friends.some((f) => f.userId === recipientId && f.eligible) ? recipientId : null,
  };
}

/**
 * Maps wish list entries for the UI.
 *
 * @param entries - The API's entries.
 * @param resolve - Cosmetic lookup.
 */
export function toWishlistEntries(entries: ApiWishlistEntry[], resolve: ItemResolver): WishlistEntryView[] {
  return entries.map((e) => ({
    itemId: e.itemId,
    title: e.title,
    kind: e.kind,
    item: e.items[0] ? resolve(e.items[0]) : null,
    price: e.price ? { currency: currency(e.price.currency), amount: e.price.amount } : null,
    inStoreToday: e.inStoreToday,
    owned: e.owned,
  }));
}

/**
 * Maps `GET /wishlist` onto Profile → Wish list.
 *
 * @param w - The API's answer.
 * @param resolve - Cosmetic lookup.
 */
export function toWishlist(w: ApiWishlist, resolve: ItemResolver): WishlistData {
  return {
    status: 'ready',
    entries: toWishlistEntries(w.entries, resolve),
    visibility: w.visibility,
    alerts: w.alerts,
    limit: w.limit,
  };
}

/**
 * Player-facing text for a gift request the API refused. Policy refusals
 * (`gift_*`) carry the server's own explanation.
 *
 * @param err - The thrown value.
 */
export function giftErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'The server could not be reached. Nothing was charged; try again.';
    if (err.code === 'feature_disabled')
      return 'The store is closed for a moment, and gifting with it. Nothing changed; try again soon!';
    if (err.code === 'maintenance') return `${err.message} Gifts will be back after maintenance.`;
    if (err.code === 'insufficient_funds') return "You don't have enough for this gift right now.";
    if (err.code === 'rate_limited' || err.status === 429)
      return err.message || 'Too many tries. Wait a minute.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** A realtime `gift` event. */
export interface GiftEvent {
  giftId: string;
  status: 'received' | Exclude<GiftState, 'pending'>;
  role: 'sender' | 'recipient';
  other: ApiParty | null;
  title: string;
  autoAccepted?: boolean;
}

/**
 * The toast for a realtime gift event, or null when it needs none (the
 * player's own actions are confirmed where they were taken).
 *
 * @param e - The event.
 * @param name - The other party's display name (already streamer-safe).
 */
export function giftEventToast(e: GiftEvent, name: string): { title: string; body?: string } | null {
  if (e.role === 'recipient') {
    if (e.status === 'received')
      return { title: `${name} sent you a gift!`, body: 'Open it from Profile → Gifts.' };
    if (e.status === 'opened' && e.autoAccepted)
      return { title: 'A gift opened itself', body: `${e.title} is in your locker.` };
    if (e.status === 'cancelled') return { title: `${name} took back a gift` };
    if (e.status === 'reversed')
      return { title: 'A gift was withdrawn', body: `${e.title} left your locker.` };
    return null;
  }
  switch (e.status) {
    case 'opened':
      return { title: `${name} opened your gift!`, body: e.title };
    case 'declined':
      return { title: `${name} declined your gift`, body: 'Your currency came back.' };
    case 'returned':
      return { title: 'A gift came back to you', body: `${e.title}: your currency came back.` };
    case 'reversed':
      return { title: 'A gift was reversed', body: `${e.title}: your currency came back.` };
    default:
      return null;
  }
}
