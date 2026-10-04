/**
 * The console's refund queue: routes, amounts, the approve / deny requests it
 * sends, role gating of approval and the rendered rows and detail.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, tabSessionStore } from '../src/admin/api.ts';
import { parseRoute, refundAmount, REFUND_STATUS, routeHash } from '../src/admin/format.ts';
import type { RefundDetail, RefundRow } from '../src/admin/types.ts';
import {
  isDecidable,
  RefundDetailView,
  refundActions,
  RefundRowView,
} from '../src/admin/views/RefundsView.tsx';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const row: RefundRow = {
  id: 'rf-1',
  userId: 'u-1',
  purchaseId: 'p-1',
  kind: 'real_money',
  status: 'pending',
  currency: 'usd',
  amount: 999,
  items: [],
  playerReason: 'Bought the wrong pack',
  decisionReason: null,
  decidedBy: null,
  decidedAt: null,
  lastError: null,
  createdAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  offerId: 'gems.1100',
  purchasedAt: new Date(NOW - 86_400_000).toISOString(),
  displayName: 'Bouncy',
  tag: '0042',
};

function detail(over: Partial<RefundDetail> = {}): RefundDetail {
  return {
    refund: {
      id: row.id,
      userId: row.userId,
      purchaseId: row.purchaseId,
      kind: row.kind,
      status: row.status,
      currency: row.currency,
      amount: row.amount,
      items: [],
      playerReason: row.playerReason,
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
      lastError: null,
      createdAt: row.createdAt,
      providerRefundId: null,
      attempts: 0,
    },
    purchase: {
      id: 'p-1',
      kind: 'gem_pack',
      offerId: 'gems.1100',
      currency: 'usd',
      price: 999,
      status: 'completed',
      provider: 'stripe',
      paymentIntent: 'pi_1',
      createdAt: row.purchasedAt!,
      completedAt: row.purchasedAt,
    },
    player: {
      id: 'u-1',
      isGuest: false,
      createdAt: row.purchasedAt!,
      gumballs: 0,
      gems: 1100,
      gemDebt: 25,
      displayName: 'Bouncy',
      tag: '0042',
      purchases: 2,
    },
    history: [
      {
        id: 'rf-1',
        purchaseId: 'p-1',
        kind: 'real_money',
        status: 'pending',
        currency: 'usd',
        amount: 999,
        createdAt: row.createdAt,
      },
    ],
    ledger: [
      {
        currency: 'gems',
        delta: 1100,
        balanceAfter: 1100,
        reason: 'gem_pack',
        ref: 'p-1',
        createdAt: row.purchasedAt!,
      },
    ],
    provider: 'stripe',
    ...over,
  };
}

describe('refund helpers', () => {
  it('round-trips the queue and detail routes', () => {
    expect(parseRoute('#/refunds')).toEqual({ view: 'refunds' });
    expect(parseRoute('#/refunds/rf-1')).toEqual({ view: 'refunds', id: 'rf-1' });
    expect(routeHash({ view: 'refunds', id: 'a/b' })).toBe('#/refunds/a%2Fb');
    expect(routeHash({ view: 'refunds' })).toBe('#/refunds');
  });

  it('formats money and currencies', () => {
    expect(refundAmount('usd', 999)).toBe('$9.99');
    expect(refundAmount('gems', 1200)).toBe('1,200 Gems');
    expect(refundAmount('gumballs', 50)).toBe('50 Gumballs');
    expect(REFUND_STATUS.failed.tone).toBe('bad');
  });

  it('only offers decisions on open money requests', () => {
    expect(isDecidable(row)).toBe(true);
    expect(isDecidable({ ...row, status: 'failed' })).toBe(true);
    expect(isDecidable({ ...row, status: 'processing' })).toBe(false);
    expect(isDecidable({ ...row, kind: 'self_service', status: 'completed' })).toBe(false);
  });

  it('sends approve and deny to the right routes and reloads', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const store = tabSessionStore(undefined, () => NOW);
    store.set({
      token: 'tra_x',
      expiresAt: new Date(NOW + 60_000).toISOString(),
      actor: { userId: 's', label: 'A#1', role: 'admin' },
    });
    const api = new AdminApi('https://api.test', store, fetchFn as unknown as typeof fetch);
    const reload = vi.fn();
    const a = refundActions(api, detail(), reload);
    expect(a.approve.confirmLabel).toBe('Refund through Stripe');
    expect(a.approve.reason).toBe('optional');
    await a.approve.run('wrong pack', null);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.test/internal/refunds/rf-1/approve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'wrong pack' }) }),
    );
    await a.approve.run('', null);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.test/internal/refunds/rf-1/approve',
      expect.objectContaining({ body: '{}' }),
    );
    await a.deny.run('Gems spent', null);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.test/internal/refunds/rf-1/deny',
      expect.objectContaining({ body: JSON.stringify({ reason: 'Gems spent' }) }),
    );
    expect(reload).toHaveBeenCalledTimes(3);
    const manual = refundActions(api, detail({ provider: 'fake' }), reload);
    expect(manual.approve.confirmLabel).toBe('Mark for manual refund');
    expect(String(manual.approve.body)).toContain('by hand');
  });
});

describe('refund views', () => {
  it('renders a queue row with the player, amount, reason and a link to the detail', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RefundRowView refund={{ ...row, lastError: 'Stripe said no' }} now={NOW} />
        </tbody>
      </table>,
    );
    expect(html).toContain('href="#/refunds/rf-1"');
    expect(html).toContain('Bouncy#0042');
    expect(html).toContain('$9.99');
    expect(html).toContain('Bought the wrong pack');
    expect(html).toContain('awaiting decision');
    expect(html).toContain('Stripe said no');
    expect(html).toContain('3 h ago');
  });

  it('lets admins approve, keeps approval from moderators, and lets both deny', () => {
    const d = detail();
    const actions = refundActions(new AdminApi('https://api.test', tabSessionStore(undefined)), d, vi.fn());
    const admin = renderToStaticMarkup(
      <RefundDetailView detail={d} role="admin" now={NOW} actions={actions} onAction={vi.fn()} />,
    );
    expect(admin).toContain('Approve…');
    expect(admin).toContain('Deny…');
    expect(admin).toContain('pi_1');
    expect(admin).toContain('gem_pack');
    expect(admin).toContain('Gem debt');
    const mod = renderToStaticMarkup(
      <RefundDetailView detail={d} role="moderator" now={NOW} actions={actions} onAction={vi.fn()} />,
    );
    expect(mod).not.toContain('Approve…');
    expect(mod).toContain('Only admins can approve money refunds.');
    expect(mod).toContain('Deny…');
  });

  it('offers a retry after a failure and nothing once decided', () => {
    const actions = refundActions(
      new AdminApi('https://api.test', tabSessionStore(undefined)),
      detail(),
      vi.fn(),
    );
    const failed = detail();
    failed.refund = { ...failed.refund, status: 'failed', lastError: 'card expired' };
    const html = renderToStaticMarkup(
      <RefundDetailView detail={failed} role="admin" now={NOW} actions={actions} onAction={vi.fn()} />,
    );
    expect(html).toContain('Retry approval…');
    expect(html).toContain('card expired');
    const done = detail();
    done.refund = { ...done.refund, status: 'refunded', decidedBy: 'Boss#0001', decidedAt: row.createdAt };
    const closed = renderToStaticMarkup(
      <RefundDetailView detail={done} role="admin" now={NOW} actions={actions} onAction={vi.fn()} />,
    );
    expect(closed).not.toContain('Approve…');
    expect(closed).not.toContain('Deny…');
    expect(closed).toContain('Boss#0001');
  });
});
