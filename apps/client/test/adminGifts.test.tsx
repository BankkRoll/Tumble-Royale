/**
 * Gifts on the console's player page: statuses, which gifts can still be
 * reversed, the request a reversal sends, and the table for admins and
 * moderators.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, tabSessionStore } from '../src/admin/api.ts';
import type { AdminGift } from '../src/admin/types.ts';
import { GIFT_STATUS, giftReverseAction, GiftTable, isReversible } from '../src/admin/views/GiftsCard.tsx';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

function gift(over: Partial<AdminGift> = {}): AdminGift {
  return {
    giftId: 'g-1',
    offerId: 'headwear.party',
    title: 'Party Hat',
    items: [{ id: 'headwear.party', name: 'Party Hat', slot: 'headwear', rarity: 'epic' }],
    price: { currency: 'gems', amount: 1200 },
    message: { text: 'enjoy' },
    status: 'opened',
    refunded: false,
    autoAccepted: false,
    note: null,
    sentAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    opensAutomaticallyAt: new Date(NOW + 30 * 86_400_000).toISOString(),
    resolvedAt: null,
    from: { userId: 'u-1', name: 'Bouncy', tag: '0042' },
    to: { userId: 'u-2', name: 'Bean', tag: '0420' },
    ledger: [
      {
        userId: 'u-1',
        currency: 'gems',
        delta: -1200,
        reason: 'gift',
        ref: 'gift:g-1',
        createdAt: new Date(NOW).toISOString(),
      },
    ],
    ...over,
  };
}

describe('console gifts', () => {
  it('names every status and only reverses what is still in play', () => {
    expect(GIFT_STATUS.pending.label).toBe('unopened');
    expect(GIFT_STATUS.reversed.tone).toBe('bad');
    expect(isReversible({ status: 'pending' })).toBe(true);
    expect(isReversible({ status: 'opened' })).toBe(true);
    for (const status of ['declined', 'cancelled', 'returned', 'reversed'] as const)
      expect(isReversible({ status })).toBe(false);
  });

  it('sends the reversal with the reason and reloads', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const store = tabSessionStore(undefined, () => NOW);
    store.set({
      token: 'tra_x',
      expiresAt: new Date(NOW + 60_000).toISOString(),
      actor: { userId: 's', label: 'A#1', role: 'admin' },
    });
    const api = new AdminApi('https://api.test', store, fetchFn as unknown as typeof fetch);
    const reload = vi.fn();
    const action = giftReverseAction(api, gift(), reload);
    expect(String(action.body)).toContain('Refunds 1,200 Gems to Bouncy#0042');
    expect(String(action.body)).toContain('takes Party Hat back');
    expect(action.danger).toBe(true);
    await action.run('stolen card', null);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.test/internal/gifts/g-1/reverse',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'stolen card' }) }),
    );
    expect(reload).toHaveBeenCalledOnce();
    const pending = giftReverseAction(api, gift({ status: 'pending', from: null }), reload);
    expect(String(pending.body)).toContain('the (deleted) sender');
    expect(String(pending.body)).toContain('can no longer open it');
  });

  it('shows the other party, note, status and ledger, with Reverse for admins only', () => {
    const rows = [gift(), gift({ giftId: 'g-2', status: 'declined', refunded: true, to: null })];
    const admin = renderToStaticMarkup(
      <GiftTable gifts={rows} direction="sent" role="admin" now={NOW} onReverse={vi.fn()} />,
    );
    expect(admin).toContain('href="#/players/u-2"');
    expect(admin).toContain('Bean#0420');
    expect(admin).toContain('deleted account');
    expect(admin).toContain('enjoy');
    expect(admin).toContain('1,200 Gems');
    expect(admin).toContain('gift -1200 gems');
    expect(admin).toContain('sender refunded');
    expect(admin.match(/Reverse…/g)).toHaveLength(1);
    const mod = renderToStaticMarkup(
      <GiftTable gifts={rows} direction="received" role="moderator" now={NOW} onReverse={vi.fn()} />,
    );
    expect(mod).toContain('Bouncy#0042');
    expect(mod).not.toContain('Reverse…');
    expect(
      renderToStaticMarkup(
        <GiftTable gifts={[]} direction="sent" role="admin" now={NOW} onReverse={vi.fn()} />,
      ),
    ).toContain('None.');
  });
});
