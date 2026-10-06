/**
 * The Store keeps prices honest across a rotation, the Gem packs take one
 * checkout at a time, and long histories page: a confirmation carries the
 * price it showed, an expired shelf asks for new ones instead of sitting at
 * 0:00, pack buttons wait while a checkout is created, and Purchases and Gifts
 * offer older pages.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrencyPanel } from '../src/screens/menu/CurrencyPanel.tsx';
import { GiftsSection } from '../src/screens/menu/Gifting.tsx';
import { PurchaseHistorySection } from '../src/screens/menu/PurchaseHistory.tsx';
import {
  bindPurchaseConfirm,
  countdown,
  quotePurchase,
  shouldRefreshStore,
  storeExpiresAt,
  StoreTab,
} from '../src/screens/menu/StoreTab.tsx';
import { uiEvents } from '../src/store/events.ts';
import type { GiftsData, PurchaseHistoryData, StoreData } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function store(extra: Partial<StoreData> = {}): StoreData {
  return { featured: [], daily: [], rotationEndsAt: Date.now() + 3600e3, ...extra };
}

describe('shelf rotation', () => {
  it('says "Restocking…" instead of a stuck 0:00 once a shelf has run out', () => {
    expect(countdown('New picks in', 1_000, 1_000)).toBe('Restocking…');
    expect(countdown('New picks in', 61_000, 1_000)).toBe('New picks in 1:00');
    ui.getState().setStoreData(store({ rotationEndsAt: Date.now() - 1000 }));
    ui.setState({ storeSection: 'today' });
    expect(text(renderToStaticMarkup(<StoreTab />))).toContain('Restocking…');
  });

  it('asks for new shelves once per rotation, when the first shelf runs out', () => {
    const s = store({
      rotationEndsAt: 5_000,
      weeklyEndsAt: 3_000,
      shardShop: { offers: [], rotationEndsAt: 9_000, shardsPerCrown: 60 },
    });
    expect(storeExpiresAt(s)).toBe(3_000);
    expect(storeExpiresAt(null)).toBe(Infinity);
    expect(shouldRefreshStore(3_000, 2_999, null)).toBe(false);
    expect(shouldRefreshStore(3_000, 3_000, null)).toBe(true);
    expect(shouldRefreshStore(3_000, 4_000, 3_000)).toBe(false);
    expect(shouldRefreshStore(Infinity, 4_000, null)).toBe(false);
  });
});

describe('purchase confirmation', () => {
  let off: () => void;
  const seen: unknown[] = [];
  let stop: () => void;
  beforeEach(() => {
    seen.length = 0;
    off = bindPurchaseConfirm();
    stop = uiEvents.on('purchase', (p) => void seen.push(p));
  });
  afterEach(() => {
    off();
    stop();
  });

  it('sends the price the dialog showed with the purchase', () => {
    quotePurchase('hat.top', { currency: 'gems', amount: 400 });
    uiEvents.emit('dialogResult', { dialogId: 'purchase:hat.top', buttonId: 'confirm' });
    expect(seen).toEqual([{ offerId: 'hat.top', expectedPrice: { currency: 'gems', amount: 400 } }]);
  });

  it('forgets the quote when the dialog is dismissed', () => {
    quotePurchase('hat.top', { currency: 'gems', amount: 400 });
    uiEvents.emit('dialogResult', { dialogId: 'purchase:hat.top', buttonId: 'cancel' });
    uiEvents.emit('dialogResult', { dialogId: 'purchase:hat.top', buttonId: 'confirm' });
    expect(seen).toEqual([{ offerId: 'hat.top' }]);
  });
});

describe('Gem pack double tap', () => {
  it('disables every pack while one checkout is being created and marks the pending one', () => {
    ui.getState().setStoreData(
      store({
        gemCheckout: 'enabled',
        gemCheckoutPending: 'gems.1100',
        gemPacks: [
          { id: 'gems.500', name: 'Handful', gems: 500, price: '$4.99' },
          { id: 'gems.1100', name: 'Pouch', gems: 1100, price: '$9.99' },
        ],
      }),
    );
    ui.getState().setCurrencyPanel('gems');
    const html = renderToStaticMarkup(<CurrencyPanel />);
    const buttons = html.match(/<button[^>]*tr-gem-pack[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toContain('disabled');
    expect(html).toMatch(/data-testid="gem-pack-gems.1100"[^>]*aria-busy="true"/);
    expect(html).toContain('aria-label="Opening checkout"');
  });

  it('enables the packs again when nothing is pending', () => {
    ui.getState().setStoreData(
      store({
        gemCheckout: 'enabled',
        gemCheckoutPending: null,
        gemPacks: [{ id: 'gems.500', name: 'Handful', gems: 500, price: '$4.99' }],
      }),
    );
    ui.getState().setCurrencyPanel('gems');
    const button = renderToStaticMarkup(<CurrencyPanel />).match(/<button[^>]*tr-gem-pack[^>]*>/)![0];
    expect(button).not.toContain('disabled');
  });
});

describe('older pages', () => {
  const history = (extra: Partial<PurchaseHistoryData>): PurchaseHistoryData => ({
    status: 'ready',
    entries: [
      {
        purchaseId: 'p1',
        kind: 'cosmetic',
        title: 'Top Hat',
        items: [],
        price: { currency: 'gumballs', amount: 100 },
        purchasedAt: Date.now(),
        refund: null,
        eligibility: { eligible: false, reason: 'refund_window_expired', message: 'Too late.' },
      },
    ],
    selfRefunds: { used: 0, limit: 3, windowDays: 365, nextAvailableAt: null },
    policy: { selfServiceWindowDays: 7, realMoneyWindowDays: 14 },
    ...extra,
  });

  it('offers older purchases only while there are more', () => {
    ui.getState().setPurchaseHistory(history({ nextCursor: 'abc' }));
    expect(renderToStaticMarkup(<PurchaseHistorySection />)).toContain('data-testid="purchases-more"');
    ui.getState().setPurchaseHistory(history({ nextCursor: 'abc', loadingMore: true }));
    expect(renderToStaticMarkup(<PurchaseHistorySection />)).toMatch(
      /purchases-more"[^>]*disabled|disabled[^>]*purchases-more"/,
    );
    ui.getState().setPurchaseHistory(history({ nextCursor: null }));
    expect(renderToStaticMarkup(<PurchaseHistorySection />)).not.toContain('purchases-more');
  });

  it('offers older gifts for the open list', () => {
    const gifts: GiftsData = {
      status: 'ready',
      received: [],
      sent: [],
      unopened: 0,
      limits: { daily: 5, sentToday: 0, resetsAt: 0 },
      policy: { minFriendDays: 3, minAccountDays: 7, autoAcceptDays: 30, messageMax: 80 },
      nextCursor: { received: 'r1', sent: null },
    };
    ui.getState().setGifts(gifts);
    expect(renderToStaticMarkup(<GiftsSection />)).toContain('data-testid="gifts-more"');
    ui.getState().setGifts({ ...gifts, nextCursor: { received: null, sent: 's1' } });
    expect(renderToStaticMarkup(<GiftsSection />)).not.toContain('gifts-more');
  });
});
