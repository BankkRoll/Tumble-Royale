/**
 * Store prices at purchase time and the Gem checkout gate: a confirmation
 * shown before the shelves rotated never charges the new price (online the
 * API refuses, offline the profile does), a double tap on a Gem pack starts
 * one checkout, and older pages of history merge without repeats.
 */
import { COSMETICS, getCosmetic } from '@tumble/content/cosmetics';
import { storePriceOnShelf, storeShelfAt } from '@tumble/content/progression';
import { ui, type GiftsData, type PurchaseHistoryData } from '@tumble/ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/game/api.ts';
import { CHECKOUT_REDIRECT_HOLD_MS, GemCheckoutGate } from '../src/game/online/gemCheckout.ts';
import { appendGiftPage, giftErrorText, type ApiGift } from '../src/game/online/gifts.ts';
import { changedPrice, priceChangedText, quoteHolds } from '../src/game/online/priceCheck.ts';
import { appendPurchasePage, type ApiPurchaseHistory } from '../src/game/online/purchaseHistory.ts';
import { ProfileStore } from '../src/game/profile.ts';

class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const storage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };
const colors = { primary: '#ff6fb5', secondary: '#ffd23f', tertiary: '#7c5cff', pattern: 'plain' as const };

describe('price_changed', () => {
  it('reads the new quote from the refusal and explains it', () => {
    const err = new ApiError(409, 'price_changed', 'The price changed', {
      price: { currency: 'gems', amount: 400 },
    });
    expect(changedPrice(err)).toEqual({ currency: 'gems', amount: 400 });
    expect(priceChangedText({ currency: 'gems', amount: 400 })).toMatch(/400 Gems.*Nothing was charged/);
    expect(giftErrorText(err)).toMatch(/400 Gems/);
    expect(changedPrice(new ApiError(409, 'already_owned', 'x'))).toBeNull();
    expect(changedPrice(new ApiError(409, 'price_changed', 'x', { price: 'nope' }))).toBeNull();
  });

  it('holds when nothing was quoted or the quote matches', () => {
    expect(quoteHolds(undefined, { currency: 'gumballs', amount: 5 })).toBe(true);
    expect(quoteHolds({ currency: 'gumballs', amount: 5 }, { currency: 'gumballs', amount: 5 })).toBe(true);
    expect(quoteHolds({ currency: 'gumballs', amount: 5 }, { currency: 'gumballs', amount: 6 })).toBe(false);
    expect(quoteHolds({ currency: 'gems', amount: 5 }, { currency: 'gumballs', amount: 5 })).toBe(false);
  });
});

describe('offline purchase at a stale price', () => {
  beforeEach(() => storage.clear());

  it('charges nothing and reports the shelf price when the quote moved', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const p = new ProfileStore(false, () => now);
    p.create('Sprinkles', colors);
    const shelf = storeShelfAt(new Date(now), COSMETICS);
    const offer = shelf.daily[0]!;
    const price = storePriceOnShelf(shelf, getCosmetic(offer.offerId)!)!;
    const stale = p.purchase(offer.offerId, { currency: price.currency, amount: price.amount + 1 });
    expect(stale).toEqual({ error: 'price', price });
    expect(p.owns(offer.offerId)).toBe(false);
  });
});

describe('older pages', () => {
  const entry = (purchaseId: string): ApiPurchaseHistory['purchases'][number] => ({
    purchaseId,
    kind: 'cosmetic',
    offerId: 'hat',
    title: 'Hat',
    items: [],
    price: { currency: 'gumballs', amount: 1 },
    status: 'completed',
    purchasedAt: '2026-10-01T00:00:00.000Z',
    refund: null,
    eligibility: { eligible: false, reason: 'refund_window_expired', message: 'x' },
  });
  const history = (ids: string[], nextCursor: string | null): ApiPurchaseHistory => ({
    purchases: ids.map(entry),
    nextCursor,
    selfRefunds: { used: 0, limit: 3, windowDays: 365, nextAvailableAt: null },
    policy: { selfServiceWindowDays: 7, realMoneyWindowDays: 14 },
  });

  it('appends purchases once and moves the cursor on', () => {
    const shown: PurchaseHistoryData = {
      status: 'ready',
      entries: [],
      selfRefunds: { used: 0, limit: 3, windowDays: 365, nextAvailableAt: null },
      policy: { selfServiceWindowDays: 7, realMoneyWindowDays: 14 },
      nextCursor: 'c1',
      loadingMore: true,
    };
    const first = appendPurchasePage(shown, history(['a', 'b'], 'c2'));
    const second = appendPurchasePage(first, history(['b', 'c'], null));
    expect(second.entries.map((e) => e.purchaseId)).toEqual(['a', 'b', 'c']);
    expect(second).toMatchObject({ nextCursor: null, loadingMore: false });
  });

  it('appends gifts to the asked list only, skipping ones already shown', () => {
    const gift = (giftId: string): ApiGift =>
      ({
        giftId,
        offerId: 'hat',
        title: 'Hat',
        items: [],
        price: { currency: 'gumballs', amount: 1 },
        message: null,
        status: 'opened',
        refunded: false,
        autoAccepted: false,
        note: null,
        sentAt: '2026-10-01T00:00:00.000Z',
        opensAutomaticallyAt: '2026-10-31T00:00:00.000Z',
        resolvedAt: null,
        from: null,
        to: null,
      }) as unknown as ApiGift;
    const data = {
      status: 'ready',
      received: [],
      sent: [{ giftId: 'x' }],
      unopened: 0,
      limits: { daily: 5, sentToday: 0, resetsAt: 0 },
      policy: { minFriendDays: 3, minAccountDays: 7, autoAcceptDays: 30, messageMax: 80 },
      nextCursor: { received: 'r1', sent: 's1' },
      loadingMore: 'sent',
    } as unknown as GiftsData;
    const next = appendGiftPage(
      data,
      'sent',
      { gifts: [gift('x'), gift('y')], nextCursor: null },
      () => null,
    );
    expect(next.sent.map((g) => g.giftId)).toEqual(['x', 'y']);
    expect(next.nextCursor).toEqual({ received: 'r1', sent: null });
    expect(next.loadingMore).toBeNull();
  });
});

describe('Gem checkout gate', () => {
  beforeEach(() => {
    ui.getState().setStoreData({ featured: [], daily: [], rotationEndsAt: 0, gemCheckout: 'enabled' });
  });

  it('starts one checkout for a double tap and shows which pack is pending', async () => {
    const gate = new GemCheckoutGate();
    let finish!: () => void;
    let calls = 0;
    const task = () =>
      new Promise<'done'>((resolve) => {
        calls++;
        finish = () => resolve('done');
      });
    const first = gate.run('gems.1100', task);
    expect(ui.getState().store?.gemCheckoutPending).toBe('gems.1100');
    expect(await gate.run('gems.1100', task)).toBe(false);
    expect(await gate.run('gems.500', task)).toBe(false);
    expect(calls).toBe(1);
    finish();
    expect(await first).toBe(true);
    expect(ui.getState().store?.gemCheckoutPending).toBeNull();
    expect(gate.pending).toBe(false);
  });

  it('stays closed while the page hands over to the checkout, then reopens', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const gate = new GemCheckoutGate((fn, ms) => timers.push({ fn, ms }));
    await gate.run('gems.1100', async () => 'redirected');
    expect(gate.pending).toBe(true);
    expect(ui.getState().store?.gemCheckoutPending).toBe('gems.1100');
    expect(timers.map((t) => t.ms)).toEqual([CHECKOUT_REDIRECT_HOLD_MS]);
    timers[0]!.fn();
    expect(gate.pending).toBe(false);
  });

  it('reopens after a failed checkout', async () => {
    const gate = new GemCheckoutGate();
    await expect(gate.run('gems.1100', () => Promise.reject(new Error('network')))).rejects.toThrow(
      'network',
    );
    expect(gate.pending).toBe(false);
    expect(ui.getState().store?.gemCheckoutPending).toBeNull();
  });
});
