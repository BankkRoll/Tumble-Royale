/**
 * Purchase history and refunds between the API and the UI: maps
 * `GET /purchases` onto the Store's Purchases section and turns refund
 * answers and refusals into player-facing text. Kept free of DOM and network
 * so it is unit-tested on its own.
 */
import type { PurchaseHistoryData, PurchaseHistoryEntry } from '@tumble/ui';
import { ApiError } from '../api.ts';

/** `GET /purchases`, as the API sends it. */
export interface ApiPurchaseHistory {
  purchases: {
    purchaseId: string;
    kind: string;
    offerId: string;
    title: string;
    items: { id: string; name: string; slot: string | null }[];
    gems?: number;
    price: { currency: string; amount: number };
    status: string;
    purchasedAt: string;
    refund: {
      refundId: string;
      kind: 'self_service' | 'real_money';
      status: NonNullable<PurchaseHistoryEntry['refund']>['status'];
      requestedAt: string;
      decisionReason: string | null;
    } | null;
    eligibility:
      | { eligible: true; kind: 'self_service' | 'real_money'; until: string }
      | {
          eligible: false;
          reason: Extract<PurchaseHistoryEntry['eligibility'], { eligible: false }>['reason'];
          message: string;
          retryAt?: string;
        };
  }[];
  selfRefunds: { used: number; limit: number; windowDays: number; nextAvailableAt: string | null };
  policy: { selfServiceWindowDays: number; realMoneyWindowDays: number };
  /** Cursor for the next older page (absent from older APIs). */
  nextCursor?: string | null;
}

/** `POST /purchases/:purchaseId/refund`. */
export interface ApiRefundResult {
  refundId: string;
  purchaseId: string;
  kind: 'self_service' | 'real_money';
  status: string;
  credit: { currency: string; amount: number };
  items: string[];
  loadoutsChanged: number[];
  replayed: boolean;
}

/**
 * Maps the API's history onto the UI's.
 *
 * @param h - `GET /purchases` response.
 * @returns Ready-to-show history.
 */
export function toPurchaseHistory(h: ApiPurchaseHistory): PurchaseHistoryData {
  return {
    status: 'ready',
    entries: h.purchases.map((p) => ({
      purchaseId: p.purchaseId,
      kind: p.kind,
      title: p.title,
      items: p.items.map((i) => ({ id: i.id, name: i.name })),
      ...(p.gems !== undefined ? { gems: p.gems } : {}),
      price: p.price,
      purchasedAt: Date.parse(p.purchasedAt),
      refund: p.refund
        ? { kind: p.refund.kind, status: p.refund.status, decisionReason: p.refund.decisionReason }
        : null,
      eligibility: p.eligibility.eligible
        ? { eligible: true, kind: p.eligibility.kind, until: Date.parse(p.eligibility.until) }
        : {
            eligible: false,
            reason: p.eligibility.reason,
            message: p.eligibility.message,
            ...(p.eligibility.retryAt ? { retryAt: Date.parse(p.eligibility.retryAt) } : {}),
          },
    })),
    selfRefunds: {
      ...h.selfRefunds,
      nextAvailableAt: h.selfRefunds.nextAvailableAt ? Date.parse(h.selfRefunds.nextAvailableAt) : null,
    },
    policy: h.policy,
    nextCursor: h.nextCursor ?? null,
  };
}

/**
 * Appends an older page of history, skipping purchases already shown.
 *
 * @param shown - What is shown.
 * @param older - The next page from `GET /purchases?before=`.
 */
export function appendPurchasePage(
  shown: PurchaseHistoryData,
  older: ApiPurchaseHistory,
): PurchaseHistoryData {
  const page = toPurchaseHistory(older);
  const ids = new Set(shown.entries.map((e) => e.purchaseId));
  return {
    ...shown,
    status: 'ready',
    entries: [...shown.entries, ...page.entries.filter((e) => !ids.has(e.purchaseId))],
    nextCursor: page.nextCursor ?? null,
    loadingMore: false,
  };
}

/**
 * Player-facing text for a refund the API refused.
 *
 * The policy refusals (`refund_*`) already carry the server's explanation,
 * so only transport and kill-switch failures get their own wording.
 *
 * @param err - The thrown value.
 * @returns Dialog body.
 */
export function refundErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'The server could not be reached. Nothing was refunded; try again.';
    if (err.code === 'feature_disabled')
      return 'The store is closed for a moment, and refunds with it. Nothing changed; try again soon!';
    if (err.code === 'maintenance') return `${err.message} Refunds will be back after maintenance.`;
    if (err.code === 'rate_limited' || err.status === 429)
      return 'Too many tries. Wait a minute and try again.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * The toast after a successful refund or request.
 *
 * @param r - The API's answer.
 * @param credit - Display text of what came back (`1,200 Gems`).
 * @returns Title and body.
 */
export function refundToast(r: ApiRefundResult, credit: string): { title: string; body: string } {
  if (r.kind === 'real_money')
    return {
      title: 'Refund requested',
      body: 'Our team will review it; you’ll see the decision under Store → Purchases.',
    };
  return {
    title: `Refunded: ${credit} back`,
    body:
      r.loadoutsChanged.length > 0
        ? 'The item left your locker, and outfits wearing it switched back to the default.'
        : 'The item left your locker.',
  };
}
