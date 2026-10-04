/**
 * Purchase history mapping and refund messages between the API and the
 * Store's Purchases section.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/game/api.ts';
import {
  refundErrorText,
  refundToast,
  toPurchaseHistory,
  type ApiPurchaseHistory,
  type ApiRefundResult,
} from '../src/game/online/purchaseHistory.ts';

const api: ApiPurchaseHistory = {
  purchases: [
    {
      purchaseId: 'p1',
      kind: 'cosmetic',
      offerId: 'bundle:space',
      title: 'Space Set',
      items: [{ id: 'a', name: 'Helmet', slot: 'headwear' }],
      price: { currency: 'gems', amount: 1200 },
      status: 'completed',
      purchasedAt: '2026-10-03T12:00:00.000Z',
      refund: null,
      eligibility: { eligible: true, kind: 'self_service', until: '2026-10-10T12:00:00.000Z' },
    },
    {
      purchaseId: 'p2',
      kind: 'gem_pack',
      offerId: 'gems.1100',
      title: 'Pouch of Gems',
      items: [],
      gems: 1100,
      price: { currency: 'usd', amount: 999 },
      status: 'completed',
      purchasedAt: '2026-10-01T12:00:00.000Z',
      refund: {
        refundId: 'r2',
        kind: 'real_money',
        status: 'denied',
        requestedAt: '2026-10-02T12:00:00.000Z',
        decisionReason: 'Gems spent',
      },
      eligibility: {
        eligible: false,
        reason: 'refund_limit_reached',
        message: 'All used',
        retryAt: '2027-01-01T00:00:00.000Z',
      },
    },
  ],
  selfRefunds: { used: 3, limit: 3, windowDays: 365, nextAvailableAt: '2027-01-01T00:00:00.000Z' },
  policy: { selfServiceWindowDays: 7, realMoneyWindowDays: 14 },
};

describe('purchase history', () => {
  it('maps the API history onto the UI with epoch times', () => {
    const h = toPurchaseHistory(api);
    expect(h.status).toBe('ready');
    expect(h.entries[0]).toEqual({
      purchaseId: 'p1',
      kind: 'cosmetic',
      title: 'Space Set',
      items: [{ id: 'a', name: 'Helmet' }],
      price: { currency: 'gems', amount: 1200 },
      purchasedAt: Date.parse('2026-10-03T12:00:00.000Z'),
      refund: null,
      eligibility: { eligible: true, kind: 'self_service', until: Date.parse('2026-10-10T12:00:00.000Z') },
    });
    expect(h.entries[1]).toMatchObject({
      gems: 1100,
      refund: { status: 'denied', decisionReason: 'Gems spent' },
      eligibility: {
        eligible: false,
        reason: 'refund_limit_reached',
        retryAt: Date.parse('2027-01-01T00:00:00.000Z'),
      },
    });
    expect(h.selfRefunds.nextAvailableAt).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('explains refusals in the server’s words and transport failures in its own', () => {
    expect(refundErrorText(new ApiError(409, 'refund_window_expired', 'Only within 7 days.'))).toBe(
      'Only within 7 days.',
    );
    expect(refundErrorText(new ApiError(0, 'network', 'x'))).toContain('Nothing was refunded');
    expect(refundErrorText(new ApiError(503, 'feature_disabled', 'x'))).toContain('store is closed');
    expect(refundErrorText(new ApiError(503, 'maintenance', 'Mopping the floors.'))).toBe(
      'Mopping the floors. Refunds will be back after maintenance.',
    );
    expect(refundErrorText(new ApiError(429, 'rate_limited', 'x'))).toContain('Too many tries');
  });

  it('confirms a refund or a request', () => {
    const base: ApiRefundResult = {
      refundId: 'r',
      purchaseId: 'p',
      kind: 'self_service',
      status: 'completed',
      credit: { currency: 'gems', amount: 1200 },
      items: ['a'],
      loadoutsChanged: [0],
      replayed: false,
    };
    expect(refundToast(base, '1,200 Gems')).toEqual({
      title: 'Refunded: 1,200 Gems back',
      body: expect.stringContaining('switched back to the default'),
    });
    expect(refundToast({ ...base, loadoutsChanged: [] }, '5 Gumballs').body).toBe(
      'The item left your locker.',
    );
    expect(refundToast({ ...base, kind: 'real_money', status: 'pending' }, '$9.99').title).toBe(
      'Refund requested',
    );
  });
});
