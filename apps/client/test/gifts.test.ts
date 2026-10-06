/**
 * Gifts and wish lists between the API and the UI: mapping each answer onto
 * the UI's types, refusals into player text and realtime events into toasts.
 */
import { describe, expect, it } from 'vitest';
import type { CosmeticItem } from '@tumble/ui';
import { ApiError } from '../src/game/api.ts';
import {
  giftErrorText,
  giftEventToast,
  toGiftPicker,
  toGifts,
  toWishlist,
  type ApiGift,
  type ItemResolver,
} from '../src/game/online/gifts.ts';

const hat: CosmeticItem = {
  id: 'headwear.party',
  name: 'Party Hat',
  slot: 'headwear',
  rarity: 'epic',
  icon: 'H',
  art: ['#fff', '#000'],
  owned: false,
};
const resolve: ItemResolver = (id) => (id === hat.id ? hat : null);
const pal = { userId: 'u1', name: 'Bean', tag: '0420' };

function apiGift(over: Partial<ApiGift> = {}): ApiGift {
  return {
    giftId: 'g1',
    offerId: hat.id,
    title: 'Party Hat',
    items: [
      { id: hat.id, name: 'Party Hat', slot: 'headwear', rarity: 'epic' },
      { id: 'gone.item', name: 'Gone', slot: null, rarity: null },
    ],
    price: { currency: 'gems', amount: 1200 },
    message: { text: 'hi' },
    status: 'pending',
    refunded: false,
    autoAccepted: false,
    note: null,
    sentAt: '2026-10-04T12:00:00.000Z',
    opensAutomaticallyAt: '2026-11-03T12:00:00.000Z',
    resolvedAt: null,
    from: pal,
    to: null,
    ...over,
  };
}

describe('gift mapping', () => {
  it('maps the inbox, skipping items this build does not know', () => {
    const data = toGifts(
      {
        received: [apiGift()],
        sent: [apiGift({ giftId: 'g2', price: { currency: 'gumballs', amount: 500 } })],
        unopened: 1,
        limits: { daily: 5, sentToday: 2, resetsAt: '2026-10-05T00:00:00.000Z', inbox: 30 },
        policy: { minFriendDays: 3, minAccountDays: 7, autoAcceptDays: 30, messageMax: 80 },
      },
      resolve,
    );
    expect(data.status).toBe('ready');
    expect(data.received[0]).toMatchObject({
      giftId: 'g1',
      items: [hat],
      price: { currency: 'gems', amount: 1200 },
      sentAt: Date.parse('2026-10-04T12:00:00.000Z'),
      from: pal,
      to: null,
    });
    expect(data.sent[0]!.price).toEqual({ currency: 'gumballs', amount: 500 });
    expect(data.limits).toEqual({ daily: 5, sentToday: 2, resetsAt: Date.parse('2026-10-05T00:00:00.000Z') });
  });

  it('maps the picker and only preselects an eligible friend', () => {
    const api = {
      offerId: hat.id,
      title: 'Party Hat',
      sender: null,
      friends: [
        {
          userId: 'u1',
          name: 'Bean',
          tag: '0420',
          eligible: true,
          price: { currency: 'gems', amount: 1200 },
        },
        {
          userId: 'u2',
          name: 'Owner',
          tag: '0001',
          eligible: false,
          price: null,
          reason: 'gift_friendship_too_new',
          message: 'Wait a bit',
          retryAt: '2026-10-06T00:00:00.000Z',
        },
      ],
      sentToday: 0,
      dailyLimit: 5,
    };
    const p = toGiftPicker(api, resolve, hat.id, 'u1', 80);
    expect(p).toMatchObject({ status: 'ready', item: hat, recipientId: 'u1', messageMax: 80, sender: null });
    expect(p.friends[1]).toEqual({
      userId: 'u2',
      name: 'Owner',
      tag: '0001',
      eligible: false,
      price: null,
      message: 'Wait a bit',
      retryAt: Date.parse('2026-10-06T00:00:00.000Z'),
    });
    expect(toGiftPicker(api, resolve, hat.id, 'u2', 80).recipientId).toBeNull();
    const blocked = toGiftPicker(
      { ...api, sender: { reason: 'gift_account_required', message: 'Link an account' } },
      resolve,
      hat.id,
      null,
      80,
    );
    expect(blocked.sender).toEqual({ message: 'Link an account' });
  });

  it('maps the wish list with each entry’s hero item', () => {
    const w = toWishlist(
      {
        entries: [
          {
            itemId: 'bundle:x',
            title: 'X Set',
            kind: 'bundle',
            items: [hat.id, 'b'],
            price: { currency: 'gumballs', amount: 10 },
            inStoreToday: true,
            owned: false,
          },
        ],
        visibility: 'nobody',
        alerts: false,
        limit: 50,
      },
      resolve,
    );
    expect(w).toEqual({
      status: 'ready',
      entries: [
        {
          itemId: 'bundle:x',
          title: 'X Set',
          kind: 'bundle',
          item: hat,
          price: { currency: 'gumballs', amount: 10 },
          inStoreToday: true,
          owned: false,
        },
      ],
      visibility: 'nobody',
      alerts: false,
      limit: 50,
    });
  });
});

describe('gift text', () => {
  it('words transport, kill-switch and policy refusals', () => {
    expect(giftErrorText(new ApiError(0, 'network', 'x'))).toContain('Nothing was charged');
    expect(giftErrorText(new ApiError(503, 'feature_disabled', 'x'))).toContain('store is closed');
    expect(giftErrorText(new ApiError(503, 'maintenance', 'Back soon.'))).toBe(
      'Back soon. Gifts will be back after maintenance.',
    );
    expect(giftErrorText(new ApiError(402, 'insufficient_funds', 'x'))).toContain("don't have enough");
    expect(giftErrorText(new ApiError(409, 'gift_already_owned', 'They already own this.'))).toBe(
      'They already own this.',
    );
    expect(giftErrorText(new Error('boom'))).toBe('boom');
  });

  it('toasts what the other side did, not the player’s own actions', () => {
    const base = { giftId: 'g1', other: pal, title: 'Party Hat' };
    expect(giftEventToast({ ...base, status: 'received', role: 'recipient' }, 'Bean')).toMatchObject({
      title: 'Bean sent you a gift!',
    });
    expect(giftEventToast({ ...base, status: 'opened', role: 'sender' }, 'Bean')?.title).toBe(
      'Bean opened your gift!',
    );
    expect(giftEventToast({ ...base, status: 'declined', role: 'sender' }, 'Bean')?.body).toContain(
      'came back',
    );
    expect(giftEventToast({ ...base, status: 'returned', role: 'sender' }, 'Bean')).not.toBeNull();
    expect(giftEventToast({ ...base, status: 'cancelled', role: 'sender' }, 'Bean')).toBeNull();
    expect(giftEventToast({ ...base, status: 'opened', role: 'recipient' }, 'Bean')).toBeNull();
    expect(
      giftEventToast({ ...base, status: 'opened', role: 'recipient', autoAccepted: true }, 'Bean')?.title,
    ).toBe('A gift opened itself');
    expect(giftEventToast({ ...base, status: 'cancelled', role: 'recipient' }, 'Tumbler 123')?.title).toBe(
      'Tumbler 123 took back a gift',
    );
  });
});
