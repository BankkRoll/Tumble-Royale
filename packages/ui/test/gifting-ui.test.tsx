/**
 * Gifts and wish lists in the menu: inbox states (loading, error, empty,
 * pending with note, every settled status from both sides), the reveal, the
 * gift sheet (eligible and refused friends, sender refusals, the confirm
 * dialog with the price), Streamer Mode masking, the wish list section and
 * its controls, the store buttons, the Profile sections and the menu badge,
 * and the intents each confirmed dialog sends.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindGiftConfirm,
  formatGiftPrice,
  FriendWishlistPanel,
  GiftButton,
  giftConfirmText,
  giftPartyName,
  GiftReveal,
  GiftSheet,
  GiftsSection,
  giftStatusLine,
  ReceivedGiftRow,
  SentGiftRow,
  WishlistButton,
  WishlistSection,
} from '../src/screens/menu/Gifting.tsx';
import { ItemDetail } from '../src/screens/menu/DressingRoom.tsx';
import { MainMenu } from '../src/screens/menu/MainMenu.tsx';
import { ProfileTab } from '../src/screens/menu/ProfileTab.tsx';
import { maskedName } from '../src/names.ts';
import { accountUi } from '../src/store/account.ts';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { uiEvents } from '../src/store/events.ts';
import { ui } from '../src/store/uiStore.ts';
import type {
  CosmeticItem,
  GiftEntry,
  GiftPickerData,
  GiftsData,
  ProfileData,
  WishlistData,
} from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(accountUi as unknown as { getInitialState: () => unknown }).getInitialState = accountUi.getState;

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const DAY = 86_400_000;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const hat: CosmeticItem = {
  id: 'headwear.party',
  name: 'Party Hat',
  slot: 'headwear',
  rarity: 'epic',
  icon: 'H',
  art: ['#ffd6f2', '#ffd23f'],
  owned: false,
};
const pal = { userId: '11111111-1111-4111-8111-111111111111', name: 'Bean', tag: '0420' };
const me = { userId: '22222222-2222-4222-8222-222222222222', name: 'Sprinkles', tag: '1234' };

function gift(over: Partial<GiftEntry> = {}): GiftEntry {
  return {
    giftId: 'g1',
    offerId: hat.id,
    title: 'Party Hat',
    items: [hat],
    price: { currency: 'gems', amount: 1200 },
    message: null,
    status: 'pending',
    refunded: false,
    autoAccepted: false,
    note: null,
    sentAt: NOW - DAY,
    opensAutomaticallyAt: NOW + 29 * DAY,
    from: pal,
    to: me,
    ...over,
  };
}

function inbox(over: Partial<GiftsData> = {}): GiftsData {
  return {
    status: 'ready',
    received: [],
    sent: [],
    unopened: 0,
    limits: { daily: 5, sentToday: 1, resetsAt: NOW + DAY },
    policy: { minFriendDays: 3, minAccountDays: 7, autoAcceptDays: 30, messageMax: 80 },
    ...over,
  };
}

function picker(over: Partial<GiftPickerData> = {}): GiftPickerData {
  return {
    offerId: hat.id,
    title: 'Party Hat',
    item: hat,
    status: 'ready',
    sender: null,
    friends: [
      {
        userId: pal.userId,
        name: pal.name,
        tag: pal.tag,
        eligible: true,
        price: { currency: 'gems', amount: 1200 },
      },
      {
        userId: 'f2',
        name: 'Owner',
        tag: '0001',
        eligible: false,
        price: { currency: 'gems', amount: 1200 },
        message: 'They already own this.',
      },
    ],
    sentToday: 1,
    dailyLimit: 5,
    messageMax: 80,
    recipientId: null,
    ...over,
  };
}

function wishlist(over: Partial<WishlistData> = {}): WishlistData {
  return {
    status: 'ready',
    entries: [
      {
        itemId: hat.id,
        title: 'Party Hat',
        kind: 'item',
        item: hat,
        price: { currency: 'gems', amount: 1200 },
        inStoreToday: true,
        owned: false,
      },
      {
        itemId: 'bundle:space',
        title: 'Space Set',
        kind: 'bundle',
        item: hat,
        price: { currency: 'gumballs', amount: 2500 },
        inStoreToday: false,
        owned: false,
      },
    ],
    visibility: 'friends',
    alerts: true,
    limit: 50,
    ...over,
  };
}

function streamer(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: on } } });
}

beforeEach(() => {
  accountUi.setState({ session: 'online' });
  ui.setState({ gifts: null, giftPicker: null, wishlist: null, friendWishlist: null, profileSection: null });
});
afterEach(() => {
  ui.setState({
    settings: DEFAULT_SETTINGS,
    gifts: null,
    giftPicker: null,
    wishlist: null,
    friendWishlist: null,
  });
  ui.getState().closeDialog();
  accountUi.setState({ session: 'local' });
});

describe('gift text', () => {
  it('prices, names and masks', () => {
    expect(formatGiftPrice({ currency: 'gumballs', amount: 2500 })).toBe('2,500 Gumballs');
    expect(giftPartyName(pal, false)).toBe('Bean#0420');
    expect(giftPartyName(pal, true)).toBe(maskedName(pal.userId));
    expect(giftPartyName(null, false)).toBe('a deleted account');
  });

  it('describes every status from both sides, refunds included', () => {
    const line = (o: Partial<GiftEntry>, role: 'sender' | 'recipient') => giftStatusLine(gift(o), role).text;
    expect(line({}, 'recipient')).toBe('Waiting for you');
    expect(line({}, 'sender')).toBe('Not opened yet');
    expect(line({ status: 'opened', autoAccepted: true }, 'recipient')).toContain('automatically');
    expect(line({ status: 'declined', refunded: true }, 'sender')).toBe('Declined, your Gems came back');
    expect(line({ status: 'cancelled', refunded: true }, 'sender')).toBe('Cancelled, your Gems came back');
    expect(line({ status: 'cancelled' }, 'recipient')).toBe('The sender took it back');
    expect(line({ status: 'returned', note: 'recipient_owns', refunded: true }, 'sender')).toBe(
      'They already had it, your Gems came back',
    );
    expect(line({ status: 'returned', note: 'recipient_owns' }, 'recipient')).toContain('already had it');
    expect(line({ status: 'returned', note: 'recipient_deleted', refunded: true }, 'sender')).toContain(
      'account was deleted',
    );
    expect(line({ status: 'reversed', refunded: true }, 'sender')).toContain('Reversed by our team');
    expect(line({ status: 'reversed' }, 'recipient')).toBe('Withdrawn by our team');
    expect(line({ status: 'declined' }, 'sender')).toBe('Declined');
  });

  it('confirms with the price, the way back and the no-refund-after-opening rule', () => {
    const body = giftConfirmText({ title: 'Party Hat' }, 'Bean#0420', { currency: 'gems', amount: 1200 });
    expect(body).toContain('Send Party Hat to Bean#0420 for 1,200 Gems?');
    expect(body).toContain('decline it (then your Gems come back)');
    expect(body).toContain('cancel it until they open it');
    expect(body).toContain("can't be refunded");
  });
});

describe('gifts inbox', () => {
  it('shows loading, error with retry and empty states', () => {
    expect(text(renderToStaticMarkup(<GiftsSection />))).toContain('Checking for gifts');
    ui.getState().setGifts(inbox({ status: 'error', error: 'Server down' }));
    const err = renderToStaticMarkup(<GiftsSection />);
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain('Server down');
    expect(text(err)).toContain('Try again');
    ui.getState().setGifts(inbox());
    const empty = text(renderToStaticMarkup(<GiftsSection />));
    expect(empty).toContain('No gifts yet.');
    expect(empty).toContain('1 of 5 sent today');
    expect(empty).toContain('open by themselves after 30 days');
    expect(empty).toContain('Opened gifts can&#x27;t be refunded');
  });

  it('keeps a pending gift wrapped, with its note, Open, Decline and the auto-open date', () => {
    const g = gift({ message: { text: 'gg you absolute shit', masked: 'gg you absolute ****' } });
    const html = renderToStaticMarkup(
      <ReceivedGiftRow g={g} gifts={inbox({ received: [g], unopened: 1 })} />,
    );
    const t = text(html);
    expect(t).toContain('A wrapped gift');
    expect(t).not.toContain('Party Hat');
    expect(t).toContain('From Bean#0420');
    expect(t).toContain('absolute ****');
    expect(html).toContain('data-testid="gift-open"');
    expect(html).toContain('data-testid="gift-decline"');
    expect(t).toContain('Opens by itself on');
    const s = ui.getState().settings;
    ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, chatFilter: false } } });
    expect(text(renderToStaticMarkup(<ReceivedGiftRow g={g} gifts={inbox()} />))).toContain('absolute shit');
  });

  it('disables a gift while its action is on the way', () => {
    const g = gift();
    const html = renderToStaticMarkup(<ReceivedGiftRow g={g} gifts={inbox({ busyId: 'g1' })} />);
    expect(text(html)).toContain('Opening…');
    expect(html).toMatch(/data-testid="gift-open"[^>]*disabled|disabled[^>]*data-testid="gift-open"/);
  });

  it('masks every other player under Streamer Mode, friends too', () => {
    streamer(true);
    const g = gift();
    const t = text(renderToStaticMarkup(<ReceivedGiftRow g={g} gifts={inbox()} />));
    expect(t).not.toContain('Bean');
    expect(t).toContain(maskedName(pal.userId));
    const sent = text(renderToStaticMarkup(<SentGiftRow g={gift({ to: pal })} gifts={inbox()} />));
    expect(sent).not.toContain('Bean');
  });

  it('lets the sender cancel only while unopened, and shows settled sends', () => {
    const pending = renderToStaticMarkup(<SentGiftRow g={gift({ to: pal })} gifts={inbox()} />);
    expect(pending).toContain('data-testid="gift-cancel"');
    expect(text(pending)).toContain('To Bean#0420 · 1,200 Gems');
    const opened = renderToStaticMarkup(
      <SentGiftRow g={gift({ to: pal, status: 'opened' })} gifts={inbox()} />,
    );
    expect(opened).not.toContain('data-testid="gift-cancel"');
    expect(text(opened)).toContain('Opened!');
  });

  it('counts unopened gifts on the Received tab, the Profile section and the menu tab', () => {
    ui.getState().setGifts(inbox({ received: [gift()], unopened: 2 }));
    expect(text(renderToStaticMarkup(<GiftsSection />))).toContain('Received (2)');
    const profile: ProfileData = {
      id: me.userId,
      name: me.name,
      tag: me.tag,
      level: 3,
      xp: 0,
      xpToNext: 100,
      gumballs: 0,
      gems: 0,
      crowns: 0,
      colors: { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' },
      isGuest: false,
      stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0, wins: 0, roundsPlayed: 0 },
    } as ProfileData;
    ui.getState().setProfile(profile);
    const tab = text(renderToStaticMarkup(<ProfileTab />));
    expect(tab).toContain('Wish list');
    expect(tab).toContain('Gifts (2)');
    ui.setState({ screen: 'menu' });
    expect(renderToStaticMarkup(<MainMenu />)).toMatch(/data-tab="profile"[^]*?tr-tab-badge/);
    accountUi.setState({ session: 'local' });
    expect(text(renderToStaticMarkup(<ProfileTab />))).not.toContain('Gifts');
    ui.getState().setProfile(null);
  });

  it('opens a deep-linked Profile section on Gifts', () => {
    ui.getState().setProfile({
      id: me.userId,
      name: me.name,
      tag: me.tag,
      level: 1,
      xp: 0,
      xpToNext: 1,
      gumballs: 0,
      gems: 0,
      crowns: 0,
      colors: { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' },
      isGuest: false,
      stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0, wins: 0, roundsPlayed: 0 },
    } as ProfileData);
    ui.getState().setGifts(inbox());
    ui.setState({ profileSection: 'gifts' });
    expect(renderToStaticMarkup(<ProfileTab />)).toContain('data-testid="gifts-section"');
    ui.getState().setProfile(null);
  });

  it('reveals opened items as capsules, closed first unless motion is reduced', () => {
    const shell = renderToStaticMarkup(<GiftReveal items={[hat]} onDone={() => undefined} />);
    expect(shell).toContain('tr-capsule-shell');
    const s = ui.getState().settings;
    ui.setState({ settings: { ...s, accessibility: { ...s.accessibility, reduceMotion: true } } });
    const open = text(renderToStaticMarkup(<GiftReveal items={[hat]} onDone={() => undefined} />));
    expect(open).toContain('Party Hat');
    expect(open).toContain('From your gift!');
  });
});

describe('gift sheet', () => {
  it('is closed until the picker opens, and loads friends first', () => {
    expect(renderToStaticMarkup(<GiftSheet />)).toBe('');
    ui.getState().setGiftPicker(picker({ status: 'loading', friends: [] }));
    expect(text(renderToStaticMarkup(<GiftSheet />))).toContain('Finding your friends');
  });

  it('lists eligible friends with the price and refused ones with the reason', () => {
    ui.getState().setGiftPicker(picker());
    const html = renderToStaticMarkup(<GiftSheet />);
    const t = text(html);
    expect(html).toContain('role="radiogroup"');
    expect(t).toContain('Bean#0420');
    expect(t).toContain('They already own this.');
    expect(html.match(/data-testid="gift-friend"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-disabled="true"[^>]*disabled/);
    expect(t).toContain('1 of 5 gifts sent today');
    expect(t).toContain('notes use the chat filter');
    expect(html).toContain('maxLength="80"');
    expect(html).toMatch(/data-testid="gift-send"[^>]*disabled|disabled[^>]*data-testid="gift-send"/);
  });

  it('explains when the player cannot send at all', () => {
    ui.getState().setGiftPicker(
      picker({ sender: { message: 'Link an account (Settings → Account) to send gifts.' } }),
    );
    const html = renderToStaticMarkup(<GiftSheet />);
    expect(html).toContain('data-testid="gift-sender-blocked"');
    expect(text(html)).toContain('Link an account');
    expect(html).not.toContain('data-testid="gift-friend"');
  });

  it('masks friend names in the picker under Streamer Mode', () => {
    streamer(true);
    ui.getState().setGiftPicker(picker());
    const t = text(renderToStaticMarkup(<GiftSheet />));
    expect(t).not.toContain('Bean');
    expect(t).toContain(maskedName(pal.userId));
  });

  it('sends only on a confirmed dialog, with the typed note', () => {
    const sent = vi.fn();
    const acted = vi.fn();
    const offs = [uiEvents.on('sendGift', sent), uiEvents.on('giftAction', acted), bindGiftConfirm()];
    try {
      uiEvents.emit('dialogResult', { dialogId: `gift-send:${hat.id}|${pal.userId}`, buttonId: 'cancel' });
      expect(sent).not.toHaveBeenCalled();
      uiEvents.emit('dialogResult', { dialogId: `gift-send:${hat.id}|${pal.userId}`, buttonId: 'confirm' });
      expect(sent).toHaveBeenCalledWith({ offerId: hat.id, recipientId: pal.userId });
      uiEvents.emit('dialogResult', { dialogId: 'gift-decline:g1', buttonId: 'confirm' });
      uiEvents.emit('dialogResult', { dialogId: 'gift-cancel:g2', buttonId: 'confirm' });
      uiEvents.emit('dialogResult', { dialogId: 'refund:p1', buttonId: 'confirm' });
      expect(acted.mock.calls).toEqual([
        [{ giftId: 'g1', action: 'decline' }],
        [{ giftId: 'g2', action: 'cancel' }],
      ]);
    } finally {
      for (const off of offs) off();
    }
  });

  it('confirms once however many gift views are mounted', () => {
    const sent = vi.fn();
    const offSent = uiEvents.on('sendGift', sent);
    const a = bindGiftConfirm();
    const b = bindGiftConfirm();
    try {
      uiEvents.emit('dialogResult', { dialogId: `gift-send:${hat.id}|${pal.userId}`, buttonId: 'confirm' });
      expect(sent).toHaveBeenCalledTimes(1);
      a();
      a();
      uiEvents.emit('dialogResult', { dialogId: `gift-send:${hat.id}|${pal.userId}`, buttonId: 'confirm' });
      expect(sent).toHaveBeenCalledTimes(2);
      b();
      uiEvents.emit('dialogResult', { dialogId: `gift-send:${hat.id}|${pal.userId}`, buttonId: 'confirm' });
      expect(sent).toHaveBeenCalledTimes(2);
    } finally {
      offSent();
    }
  });
});

describe('wish list', () => {
  it('lists entries with prices, today’s shelf, reorder and remove controls, and the settings', () => {
    ui.getState().setWishlist(wishlist());
    const html = renderToStaticMarkup(<WishlistSection />);
    const t = text(html);
    expect(t).toContain('2/50');
    expect(t).toContain('Party Hat');
    expect(t).toContain('Space Set (bundle)');
    expect(t).toContain('In the store today');
    expect(html).toContain('aria-label="Move Party Hat up"');
    expect(html).toMatch(
      /aria-label="Move Party Hat up"[^>]*disabled|disabled[^>]*aria-label="Move Party Hat up"/,
    );
    expect(html).toContain('aria-label="Remove Space Set from your wish list"');
    expect(html).toContain('aria-label="Who can see your wish list"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it('shows an empty state with a way to the store', () => {
    ui.getState().setWishlist(wishlist({ entries: [] }));
    const t = text(renderToStaticMarkup(<WishlistSection />));
    expect(t).toContain('Nothing here yet');
    expect(t).toContain('Browse the Store');
  });

  it('toggles from store items, refusing to grow past the cap', () => {
    expect(renderToStaticMarkup(<WishlistButton itemId={hat.id} />)).toBe('');
    ui.getState().setWishlist(wishlist());
    expect(renderToStaticMarkup(<WishlistButton itemId={hat.id} />)).toContain('aria-pressed="true"');
    const off = renderToStaticMarkup(<WishlistButton itemId="other" />);
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain('disabled');
    ui.getState().setWishlist(wishlist({ limit: 2 }));
    expect(renderToStaticMarkup(<WishlistButton itemId="other" />)).toContain('disabled');
  });

  it('puts Wish list and Gift on the store item detail for online accounts', () => {
    ui.getState().setWishlist(wishlist({ entries: [] }));
    const detail = renderToStaticMarkup(
      <ItemDetail
        item={hat}
        equipped={false}
        price={{ currency: 'gems', amount: 1200 }}
        onEquip={() => undefined}
        actions={
          <>
            <WishlistButton itemId={hat.id} />
            <GiftButton offerId={hat.id} />
          </>
        }
      />,
    );
    expect(detail).toContain('data-testid="wishlist-toggle"');
    expect(detail).toContain('data-testid="gift-button"');
    accountUi.setState({ session: 'local' });
    expect(renderToStaticMarkup(<GiftButton offerId={hat.id} />)).toBe('');
  });

  it('shows a friend’s list with Gift buttons, or that it is private', () => {
    expect(renderToStaticMarkup(<FriendWishlistPanel userId={pal.userId} />)).toContain(
      'data-testid="friend-wishlist-open"',
    );
    ui.getState().setFriendWishlist({ userId: pal.userId, status: 'ready', entries: wishlist().entries });
    const html = renderToStaticMarkup(<FriendWishlistPanel userId={pal.userId} />);
    expect(html.match(/data-testid="gift-button"/g)).toHaveLength(2);
    expect(text(html)).toContain('Today');
    ui.getState().setFriendWishlist({ userId: pal.userId, status: 'hidden', entries: [] });
    expect(text(renderToStaticMarkup(<FriendWishlistPanel userId={pal.userId} />))).toContain('private');
    expect(renderToStaticMarkup(<FriendWishlistPanel userId="someone-else" />)).toContain(
      'data-testid="friend-wishlist-open"',
    );
  });
});
