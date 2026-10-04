/**
 * Store → Purchases: loading, error and empty states, what each purchase
 * offers (refund, request, status, refusal reason), the confirmation text
 * and the intents a confirmed refund sends.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindRefundConfirm,
  confirmRefund,
  formatPaid,
  PurchaseHistorySection,
  PurchaseRow,
  refundConfirmText,
  refundStatusText,
} from '../src/screens/menu/PurchaseHistory.tsx';
import { StoreTab } from '../src/screens/menu/StoreTab.tsx';
import { accountUi } from '../src/store/account.ts';
import { uiEvents } from '../src/store/events.ts';
import { ui } from '../src/store/uiStore.ts';
import type { PurchaseHistoryData, PurchaseHistoryEntry, StoreData } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(accountUi as unknown as { getInitialState: () => unknown }).getInitialState = accountUi.getState;

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const DAY = 86_400_000;

function entry(over: Partial<PurchaseHistoryEntry> = {}): PurchaseHistoryEntry {
  return {
    purchaseId: 'p1',
    kind: 'cosmetic',
    title: 'Party Hat',
    items: [{ id: 'headwear.party', name: 'Party Hat' }],
    price: { currency: 'gems', amount: 1200 },
    purchasedAt: NOW - DAY,
    refund: null,
    eligibility: { eligible: true, kind: 'self_service', until: NOW + 6 * DAY },
    ...over,
  };
}

function history(
  entries: PurchaseHistoryEntry[],
  over: Partial<PurchaseHistoryData> = {},
): PurchaseHistoryData {
  return {
    status: 'ready',
    entries,
    selfRefunds: { used: 1, limit: 3, windowDays: 365, nextAvailableAt: null },
    policy: { selfServiceWindowDays: 7, realMoneyWindowDays: 14 },
    ...over,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const row = (e: PurchaseHistoryEntry, h = history([e])) =>
  text(renderToStaticMarkup(<PurchaseRow entry={e} history={h} />));

beforeEach(() => {
  ui.getState().setPurchaseHistory(null);
});
afterEach(() => {
  ui.getState().setPurchaseHistory(null);
  ui.getState().closeDialog();
});

describe('purchase rows', () => {
  it('offers a refund with its deadline for an eligible store purchase', () => {
    const t = row(entry());
    expect(t).toContain('Party Hat');
    expect(t).toContain('1,200 Gems');
    expect(t).toContain('Refund');
    expect(t).toContain('Until');
  });

  it('shows "Refunding…" while that purchase is being sent', () => {
    const e = entry();
    expect(row(e, history([e], { busyId: 'p1' }))).toContain('Refunding…');
  });

  it('offers a request for a Gem pack, priced in money', () => {
    const t = row(
      entry({
        kind: 'gem_pack',
        title: 'Pouch of Gems',
        items: [],
        gems: 1100,
        price: { currency: 'usd', amount: 999 },
        eligibility: { eligible: true, kind: 'real_money', until: NOW + 13 * DAY },
      }),
    );
    expect(t).toContain('$9.99');
    expect(t).toContain('1,100 Gems');
    expect(t).toContain('Request a refund');
    expect(t).not.toMatch(/\bRefund\b(?! )/);
  });

  it('explains why a purchase cannot be refunded, with the date the limit frees up', () => {
    const t = row(
      entry({
        eligibility: {
          eligible: false,
          reason: 'refund_limit_reached',
          message: 'You’ve used all 3 store refunds for the year.',
          retryAt: NOW + 30 * DAY,
        },
      }),
    );
    expect(t).toContain('You’ve used all 3 store refunds for the year.');
    expect(t).toContain('Your next refund frees up on');
    expect(t).not.toContain('Request a refund');
    const html = renderToStaticMarkup(
      <PurchaseRow
        entry={entry({
          kind: 'pass_premium',
          eligibility: {
            eligible: false,
            reason: 'refund_not_refundable',
            message: 'Season Pass upgrades …',
          },
        })}
        history={history([])}
      />,
    );
    expect(html).toContain('data-reason="refund_not_refundable"');
    expect(html).not.toContain('<button');
  });

  it('states where a refund stands, including a denial reason', () => {
    const pending = entry({
      refund: { kind: 'real_money', status: 'pending', decisionReason: null },
      eligibility: { eligible: false, reason: 'refund_already_requested', message: 'You already asked' },
    });
    expect(row(pending)).toContain('waiting for review');
    expect(row(pending)).not.toContain('You already asked');
    expect(
      refundStatusText({ kind: 'real_money', status: 'denied', decisionReason: 'Gems were spent' }).text,
    ).toBe('Refund declined: Gems were spent');
    expect(refundStatusText({ kind: 'self_service', status: 'completed', decisionReason: null })).toEqual({
      text: 'Refunded',
      tone: 'mint',
    });
    expect(refundStatusText({ kind: 'real_money', status: 'processing', decisionReason: null }).tone).toBe(
      'lemon',
    );
  });
});

describe('refund confirmation', () => {
  it('names what leaves the locker, what comes back and the refunds left', () => {
    const bundle = entry({
      title: 'Space Set',
      items: [
        { id: 'a', name: 'Helmet' },
        { id: 'b', name: 'Jetpack' },
        { id: 'c', name: 'Boots' },
      ],
      price: { currency: 'gumballs', amount: 2500 },
    });
    const body = refundConfirmText(bundle, history([bundle]));
    expect(body).toContain('Helmet, Jetpack and Boots will leave your locker');
    expect(body).toContain('switches back to the default');
    expect(body).toContain('you get 2,500 Gumballs back');
    expect(body).toContain('1 of 3 store refunds left');
    expect(body).toContain("can't be undone");
    expect(formatPaid({ currency: 'crown_shards', amount: 30 })).toBe('30 Crown Shards');
  });

  it('opens a confirm dialog whose safe button is focused, and refunds only on Refund', () => {
    const e = entry();
    confirmRefund(e, history([e]));
    const dialog = ui.getState().dialog!;
    expect(dialog).toMatchObject({ id: 'refund:p1', kind: 'confirm', title: 'Refund Party Hat?' });
    expect(dialog.buttons).toEqual([
      expect.objectContaining({ id: 'cancel', autofocus: true }),
      expect.objectContaining({ id: 'confirm', variant: 'danger' }),
    ]);
    const sent = vi.fn();
    const offSent = uiEvents.on('refundPurchase', sent);
    const off = bindRefundConfirm();
    try {
      uiEvents.emit('dialogResult', { dialogId: 'refund:p1', buttonId: 'cancel' });
      uiEvents.emit('dialogResult', { dialogId: 'purchase:x', buttonId: 'confirm' });
      expect(sent).not.toHaveBeenCalled();
      uiEvents.emit('dialogResult', { dialogId: 'refund:p1', buttonId: 'confirm' });
      expect(sent).toHaveBeenCalledWith({ purchaseId: 'p1' });
    } finally {
      off();
      offSent();
    }
  });
});

describe('purchases section', () => {
  it('shows loading, error with retry, and empty states', () => {
    expect(text(renderToStaticMarkup(<PurchaseHistorySection />))).toContain('Finding your receipts');
    ui.getState().setPurchaseHistory(history([], { status: 'error', error: 'The server is unreachable.' }));
    const err = renderToStaticMarkup(<PurchaseHistorySection />);
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain('The server is unreachable.');
    expect(text(err)).toContain('Try again');
    ui.getState().setPurchaseHistory(history([]));
    const empty = text(renderToStaticMarkup(<PurchaseHistorySection />));
    expect(empty).toContain('No purchases yet.');
    expect(empty).toContain('2 of 3 refunds left');
    expect(empty).toContain('within 7 days');
    expect(empty).toContain('Season Pass and Crown Shard purchases can');
  });

  it('is a Store section for online accounts only', () => {
    const store: StoreData = { featured: [], daily: [], rotationEndsAt: NOW + 3600e3 };
    ui.getState().setStoreData(store);
    accountUi.setState({ session: 'local' });
    expect(renderToStaticMarkup(<StoreTab />)).not.toContain('data-section="purchases"');
    accountUi.setState({ session: 'online' });
    ui.getState().setPurchaseHistory(history([entry()]));
    ui.setState({ storeSection: 'purchases' });
    const html = renderToStaticMarkup(<StoreTab />);
    expect(html).toContain('data-section="purchases"');
    expect(html).toContain('data-testid="store-purchases"');
    expect(html).toContain('data-testid="purchase-row"');
    accountUi.setState({ session: 'local' });
    ui.setState({ storeSection: null });
  });
});
