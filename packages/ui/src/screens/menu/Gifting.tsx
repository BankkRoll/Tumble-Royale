/**
 * Gifts and wish lists in the menu.
 *
 * - {@link WishlistButton} / {@link GiftButton}: the star and the Gift button
 *   on a store item's detail.
 * - {@link GiftSheet}: the friend picker (every friend, with the reason a
 *   gift to them is not possible right now), an optional note, and a confirm
 *   dialog naming the price before anything is sent.
 * - {@link GiftsSection}: Profile → Gifts, the inbox (open with the capsule
 *   reveal, or decline so the sender gets their currency back) and what the
 *   player sent (with cancel while unopened).
 * - {@link WishlistSection}: Profile → Wish list, with reordering, privacy
 *   and the store alert switch; {@link FriendWishlistPanel} shows a friend's
 *   list on their profile card with a Gift button per entry.
 *
 * Streamer Mode masks every other player's name here, friends included,
 * because gift notices are exactly the kind of thing that ends up on stream.
 * The server decides every rule; this only presents its answers.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Price } from '../../components/bits.tsx';
import { Button, Segmented, Toggle } from '../../components/controls.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { ItemPreview } from '../../components/ItemPreview.tsx';
import { maskedName } from '../../names.ts';
import { useAccountUI } from '../../store/account.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type {
  CosmeticItem,
  Currency,
  GiftEntry,
  GiftParty,
  GiftPickerData,
  GiftsData,
  WishlistEntryView,
} from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';

const CURRENCY_NAMES: Readonly<Record<Currency, string>> = { gumballs: 'Gumballs', gems: 'Gems' };

/** Dialog id prefixes, echoed back in `dialogResult`. */
export const GIFT_DIALOG = {
  send: 'gift-send:',
  decline: 'gift-decline:',
  cancel: 'gift-cancel:',
} as const;

/**
 * A price for people.
 *
 * @param price - Currency and amount.
 * @example formatGiftPrice({ currency: 'gems', amount: 1200 }); // '1,200 Gems'
 */
export function formatGiftPrice(price: { currency: Currency; amount: number }): string {
  return `${formatNumber(price.amount)} ${CURRENCY_NAMES[price.currency]}`;
}

/**
 * The name to show for the other party of a gift: "a deleted account" once
 * it is gone, a stable "Tumbler N" under Streamer Mode.
 *
 * @param p - The party, or null when their account was deleted.
 * @param streamer - Settings → Streamer mode.
 */
export function giftPartyName(p: GiftParty | null, streamer: boolean): string {
  if (!p) return 'a deleted account';
  return streamer ? maskedName(p.userId) : `${p.name}#${p.tag}`;
}

/**
 * One line on where a gift stands, from the viewer's side.
 *
 * @param g - The gift.
 * @param role - Whether the viewer sent or received it.
 * @returns Text and chip tone.
 */
export function giftStatusLine(
  g: GiftEntry,
  role: 'sender' | 'recipient',
): { text: string; tone: 'mint' | 'lemon' | 'muted' } {
  const back = g.refunded ? `, your ${CURRENCY_NAMES[g.price.currency]} came back` : '';
  if (role === 'recipient') {
    switch (g.status) {
      case 'pending':
        return { text: 'Waiting for you', tone: 'lemon' };
      case 'opened':
        return { text: g.autoAccepted ? 'Opened for you automatically' : 'Opened', tone: 'mint' };
      case 'declined':
        return { text: 'You declined it', tone: 'muted' };
      case 'cancelled':
        return { text: 'The sender took it back', tone: 'muted' };
      case 'returned':
        return {
          text: g.note === 'recipient_owns' ? 'You already had it, so it went back' : 'Sent back',
          tone: 'muted',
        };
      case 'reversed':
        return { text: 'Withdrawn by our team', tone: 'muted' };
    }
  }
  switch (g.status) {
    case 'pending':
      return { text: 'Not opened yet', tone: 'lemon' };
    case 'opened':
      return { text: g.autoAccepted ? 'Opened (automatically)' : 'Opened!', tone: 'mint' };
    case 'declined':
      return { text: `Declined${back}`, tone: 'muted' };
    case 'cancelled':
      return { text: `Cancelled${back}`, tone: 'muted' };
    case 'returned':
      return {
        text:
          g.note === 'recipient_owns'
            ? `They already had it${back}`
            : g.note === 'recipient_deleted'
              ? `Their account was deleted${back}`
              : `Sent back${back}`,
        tone: 'muted',
      };
    case 'reversed':
      return { text: `Reversed by our team${back}`, tone: 'muted' };
  }
}

/**
 * The confirmation before a gift is sent: what, to whom, for how much.
 *
 * @param picker - The open gift sheet.
 * @param recipient - The chosen friend's display name (already streamer-safe).
 * @param price - What it costs.
 */
export function giftConfirmText(
  picker: Pick<GiftPickerData, 'title'>,
  recipient: string,
  price: { currency: Currency; amount: number },
): string {
  return (
    `Send ${picker.title} to ${recipient} for ${formatGiftPrice(price)}? ` +
    `They can open it or decline it (then your ${CURRENCY_NAMES[price.currency]} come back), ` +
    `and you can cancel it until they open it. Once opened, a gift can't be refunded.`
  );
}

function useStreamer(): boolean {
  return useUI((s) => s.settings.gameplay.streamerMode);
}

function useOnlineAccount(): boolean {
  return useAccountUI((a) => a.session === 'online');
}

/** Message text honouring Settings → Chat filter. */
function noteText(m: NonNullable<GiftEntry['message']>, filterOn: boolean): string {
  return filterOn && m.masked ? m.masked : m.text;
}

// -----------------------------------------------------------------------------
// Store buttons
// -----------------------------------------------------------------------------

/**
 * Star toggle putting a store item (or `bundle:<id>`) on the wish list.
 * Hidden until the wish list has loaded (offline play has none).
 *
 * @param props.itemId - Offer id.
 */
export function WishlistButton({ itemId }: { itemId: string }): JSX.Element | null {
  const wishlist = useUI((s) => s.wishlist);
  if (!wishlist || wishlist.status === 'error') return null;
  const on = wishlist.entries.some((e) => e.itemId === itemId);
  const full = !on && wishlist.entries.length >= wishlist.limit;
  return (
    <Button
      size="sm"
      variant={on ? 'mint' : 'secondary'}
      aria-pressed={on}
      disabled={full}
      title={full ? `Your wish list is full (${wishlist.limit})` : undefined}
      data-testid="wishlist-toggle"
      onClick={() => uiEvents.emit('wishlistToggle', { itemId, on: !on })}
    >
      <Icon name="star" size="1em" /> {on ? 'On wish list' : 'Wish list'}
    </Button>
  );
}

/**
 * Opens the gift sheet for an offer (online accounts only).
 *
 * @param props.offerId - Cosmetic id or `bundle:<id>`.
 * @param props.recipientId - Friend to preselect.
 */
export function GiftButton({
  offerId,
  recipientId,
}: {
  offerId: string;
  recipientId?: string;
}): JSX.Element | null {
  const online = useOnlineAccount();
  if (!online) return null;
  return (
    <Button
      size="sm"
      variant="premium"
      data-testid="gift-button"
      onClick={() => uiEvents.emit('openGiftPicker', { offerId, ...(recipientId ? { recipientId } : {}) })}
    >
      <Icon name="gift" size="1em" /> Gift
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Gift sheet
// -----------------------------------------------------------------------------

/** Messages typed in the sheet, waiting for their confirm dialog. */
const pendingNotes = new Map<string, string>();

/**
 * Turns a confirmed send dialog into the `sendGift` intent; Cancel or Escape
 * sends nothing.
 *
 * @returns Unsubscribe.
 */
export function bindGiftConfirm(): () => void {
  return uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    const note = pendingNotes.get(dialogId);
    pendingNotes.delete(dialogId);
    if (buttonId !== 'confirm') return;
    if (dialogId.startsWith(GIFT_DIALOG.send)) {
      const [offerId, recipientId] = dialogId.slice(GIFT_DIALOG.send.length).split('|') as [string, string];
      uiEvents.emit('sendGift', { offerId, recipientId, ...(note ? { message: note } : {}) });
    } else if (dialogId.startsWith(GIFT_DIALOG.decline)) {
      uiEvents.emit('giftAction', { giftId: dialogId.slice(GIFT_DIALOG.decline.length), action: 'decline' });
    } else if (dialogId.startsWith(GIFT_DIALOG.cancel)) {
      uiEvents.emit('giftAction', { giftId: dialogId.slice(GIFT_DIALOG.cancel.length), action: 'cancel' });
    }
  });
}

/** The gift sheet, open while `giftPicker` is set. */
export function GiftSheet(): JSX.Element | null {
  const picker = useUI((s) => s.giftPicker);
  const streamer = useStreamer();
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => bindGiftConfirm(), []);
  useEffect(() => {
    setChosen(picker?.recipientId ?? null);
    setNote('');
  }, [picker?.offerId, picker?.recipientId]);
  if (!picker) return null;

  const close = (): void => {
    playCue('ui.back');
    ui.getState().setGiftPicker(null);
  };
  const eligible = picker.friends.filter((f) => f.eligible);
  const pick = picker.friends.find((f) => f.userId === chosen && f.eligible) ?? null;
  const name = (f: { userId: string; name: string; tag: string }) => giftPartyName(f, streamer);
  const send = (): void => {
    if (!pick?.price) return;
    const id = `${GIFT_DIALOG.send}${picker.offerId}|${pick.userId}`;
    if (note.trim()) pendingNotes.set(id, note.trim());
    ui.getState().showDialog({
      id,
      kind: 'purchase',
      title: 'Send this gift?',
      body: giftConfirmText(picker, name(pick), pick.price),
      ...(picker.item ? { icon: picker.item.icon } : {}),
    });
  };
  const busy = picker.status === 'sending';
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="15"
      role="dialog"
      aria-modal="true"
      aria-label={`Gift ${picker.title}`}
      data-testid="gift-sheet"
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-gift-sheet tr-col tr-enter-pop">
        <div className="tr-row" style={{ gap: '0.6em', alignItems: 'center' }}>
          {picker.item && (
            <span className={`tr-gift-art tr-item--${picker.item.rarity}`}>
              <ItemPreview item={picker.item} flat />
            </span>
          )}
          <div className="tr-col tr-grow" style={{ minWidth: 0, gap: '0.1em' }}>
            <b className="tr-title tr-h3 tr-ellipsis">Gift {picker.title}</b>
            <span className="tr-small tr-muted">
              {picker.sentToday} of {picker.dailyLimit} gifts sent today
            </span>
          </div>
        </div>
        {picker.status === 'loading' ? (
          <div className="tr-empty">
            <span className="tr-gumball-spinner" />
            <p>Finding your friends…</p>
          </div>
        ) : picker.status === 'error' ? (
          <p className="tr-small" role="alert">
            {picker.error ?? "Couldn't load your friends."}
          </p>
        ) : picker.sender ? (
          <p className="tr-small" role="note" data-testid="gift-sender-blocked">
            {picker.sender.message}
          </p>
        ) : picker.friends.length === 0 ? (
          <p className="tr-small tr-muted">Add some friends first: gifts are for friends.</p>
        ) : (
          <>
            <ul className="tr-gift-friends tr-scroll" role="radiogroup" aria-label="Pick a friend">
              {picker.friends.map((f) => (
                <li key={f.userId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={chosen === f.userId}
                    aria-disabled={!f.eligible}
                    disabled={!f.eligible || busy}
                    className={`tr-gift-friend${chosen === f.userId ? ' is-selected' : ''}`}
                    data-nav=""
                    data-testid="gift-friend"
                    onClick={() => {
                      playCue('ui.click');
                      setChosen(f.userId);
                    }}
                  >
                    <b className="tr-ellipsis">{name(f)}</b>
                    {f.eligible && f.price ? (
                      <Price currency={f.price.currency} amount={f.price.amount} />
                    ) : (
                      <span className="tr-small tr-muted" data-testid="gift-friend-reason">
                        {f.message}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {eligible.length > 0 && (
              <label className="tr-col tr-small" style={{ gap: '0.25em' }}>
                Add a note (optional)
                <input
                  className="tr-input"
                  value={note}
                  maxLength={picker.messageMax}
                  disabled={busy}
                  data-nav=""
                  onChange={(e) => setNote(e.target.value)}
                  aria-describedby="gift-note-count"
                />
                <span id="gift-note-count" className="tr-muted">
                  {note.length}/{picker.messageMax} · notes use the chat filter
                </span>
              </label>
            )}
          </>
        )}
        <div className="tr-row" style={{ gap: '0.5em', justifyContent: 'flex-end' }}>
          <Button variant="secondary" data-nav-back="" cue="ui.back" hint="Esc" onClick={close}>
            Close
          </Button>
          <Button
            variant="go"
            disabled={!pick || busy || !!picker.sender}
            data-testid="gift-send"
            autoFocusNav={!!pick}
            onClick={send}
          >
            {busy ? 'Sending…' : pick?.price ? `Send for ${formatGiftPrice(pick.price)}` : 'Send gift'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Profile → Gifts
// -----------------------------------------------------------------------------

/** Items shown as capsules that pop open (the end-of-show unlock reveal). */
export function GiftReveal({ items, onDone }: { items: CosmeticItem[]; onDone: () => void }): JSX.Element {
  const reduce = useUI((s) => s.settings.accessibility.reduceMotion);
  const [open, setOpen] = useState(reduce);
  useEffect(() => {
    if (reduce) return;
    playCue('ui.reward');
    const id = window.setTimeout(() => {
      setOpen(true);
      const top = items.reduce<CosmeticItem | null>((best, i) => best ?? i, null);
      if (top) playCue(`ui.rarity.${top.rarity}`);
    }, 600);
    return () => window.clearTimeout(id);
  }, [items, reduce]);
  return (
    <div className="tr-panel tr-rewards-unlocks tr-enter" data-testid="gift-reveal" role="status">
      <span className="tr-label">From your gift!</span>
      <div className="tr-row tr-wrap">
        {items.map((u) => (
          <div
            key={u.id}
            className={`tr-capsule tr-capsule--${u.rarity}${open ? ' is-open' : ''}`}
            style={{ ['--art-a' as string]: u.art[0], ['--art-b' as string]: u.art[1] }}
          >
            {open ? (
              <>
                <span className="tr-capsule-burst" aria-hidden />
                <ItemPreview item={u} className="tr-capsule-icon" />
                <b className="tr-ellipsis">{u.name}</b>
                <span className={`tr-rarity-band tr-rarity-band--${u.rarity}`}>{rarityLabels[u.rarity]}</span>
              </>
            ) : (
              <span className="tr-capsule-shell tr-loop" aria-label="Wrapped gift" />
            )}
          </div>
        ))}
      </div>
      <Button size="sm" variant="mint" autoFocusNav onClick={onDone}>
        Nice!
      </Button>
    </div>
  );
}

function GiftItems({ g }: { g: GiftEntry }): JSX.Element {
  return (
    <span className="tr-bundle-items">
      {g.items.map((it) => (
        <span key={it.id} className={`tr-bundle-item tr-item--${it.rarity}`} title={it.name}>
          <ItemPreview item={it} flat />
        </span>
      ))}
    </span>
  );
}

/**
 * One received gift.
 *
 * @param props.g - The gift.
 * @param props.gifts - The whole inbox (busy state).
 */
export function ReceivedGiftRow({ g, gifts }: { g: GiftEntry; gifts: GiftsData }): JSX.Element {
  const streamer = useStreamer();
  const filterOn = useUI((s) => s.settings.gameplay.chatFilter);
  const busy = gifts.busyId === g.giftId;
  const status = giftStatusLine(g, 'recipient');
  return (
    <li className="tr-panel tr-col tr-gift-row" style={{ gap: '0.3em' }} data-testid="gift-received">
      <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
        <GiftItems g={g} />
        <div className="tr-col tr-grow" style={{ minWidth: 0 }}>
          <strong className="tr-ellipsis">{g.status === 'pending' ? 'A wrapped gift' : g.title}</strong>
          <span className="tr-small tr-muted">From {giftPartyName(g.from, streamer)}</span>
        </div>
        <span className={`tr-chip${status.tone === 'muted' ? '' : ` tr-chip--${status.tone}`}`}>
          {status.text}
        </span>
      </div>
      {g.message && (
        <blockquote className="tr-gift-note tr-small" data-testid="gift-note">
          “{noteText(g.message, filterOn)}”
        </blockquote>
      )}
      {g.status === 'pending' && (
        <div className="tr-row tr-wrap" style={{ gap: '0.5em', alignItems: 'center' }}>
          <Button
            size="sm"
            variant="go"
            disabled={busy}
            data-testid="gift-open"
            onClick={() => uiEvents.emit('giftAction', { giftId: g.giftId, action: 'open' })}
          >
            {busy ? 'Opening…' : 'Open'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            data-testid="gift-decline"
            onClick={() =>
              ui.getState().showDialog({
                id: `${GIFT_DIALOG.decline}${g.giftId}`,
                kind: 'confirm',
                title: 'Decline this gift?',
                body: `It goes back to ${giftPartyName(g.from, streamer)}${g.from ? ', who gets their currency back' : ''}. This can't be undone.`,
                buttons: [
                  { id: 'cancel', label: 'Keep it', variant: 'secondary', autofocus: true },
                  { id: 'confirm', label: 'Decline', variant: 'danger' },
                ],
              })
            }
          >
            Decline
          </Button>
          <span className="tr-small tr-muted">
            Opens by itself on {new Date(g.opensAutomaticallyAt).toLocaleDateString()}
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * One sent gift.
 *
 * @param props.g - The gift.
 * @param props.gifts - The whole list (busy state).
 */
export function SentGiftRow({ g, gifts }: { g: GiftEntry; gifts: GiftsData }): JSX.Element {
  const streamer = useStreamer();
  const busy = gifts.busyId === g.giftId;
  const status = giftStatusLine(g, 'sender');
  return (
    <li className="tr-panel tr-col tr-gift-row" style={{ gap: '0.3em' }} data-testid="gift-sent">
      <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
        <GiftItems g={g} />
        <div className="tr-col tr-grow" style={{ minWidth: 0 }}>
          <strong className="tr-ellipsis">{g.title}</strong>
          <span className="tr-small tr-muted">
            To {giftPartyName(g.to, streamer)} · {formatGiftPrice(g.price)}
          </span>
        </div>
        <span className={`tr-chip${status.tone === 'muted' ? '' : ` tr-chip--${status.tone}`}`}>
          {status.text}
        </span>
      </div>
      {g.status === 'pending' && (
        <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            data-testid="gift-cancel"
            onClick={() =>
              ui.getState().showDialog({
                id: `${GIFT_DIALOG.cancel}${g.giftId}`,
                kind: 'confirm',
                title: 'Cancel this gift?',
                body: `You get ${formatGiftPrice(g.price)} back and it disappears from their gifts.`,
                buttons: [
                  { id: 'cancel', label: 'Keep it', variant: 'secondary', autofocus: true },
                  { id: 'confirm', label: 'Cancel gift', variant: 'danger' },
                ],
              })
            }
          >
            {busy ? 'Cancelling…' : 'Cancel gift'}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Profile → Gifts. Asks for fresh gifts whenever it opens. */
export function GiftsSection(): JSX.Element {
  const gifts = useUI((s) => s.gifts);
  useEffect(() => {
    uiEvents.emit('requestGifts');
    return bindGiftConfirm();
  }, []);
  const [tab, setTab] = useState<'received' | 'sent'>('received');
  if (!gifts || (gifts.status === 'loading' && gifts.received.length + gifts.sent.length === 0)) {
    return (
      <section className="tr-panel tr-empty" data-testid="gifts-section">
        <span className="tr-gumball-spinner" />
        <p>Checking for gifts…</p>
      </section>
    );
  }
  if (gifts.status === 'error' && gifts.received.length + gifts.sent.length === 0) {
    return (
      <section className="tr-panel tr-empty" role="alert" data-testid="gifts-section">
        <p>{gifts.error ?? "Couldn't load your gifts."}</p>
        <Button size="sm" onClick={() => uiEvents.emit('requestGifts')}>
          Try again
        </Button>
      </section>
    );
  }
  const list = tab === 'received' ? gifts.received : gifts.sent;
  return (
    <section
      className="tr-col tr-gifts"
      aria-label="Gifts"
      data-testid="gifts-section"
      style={{ gap: '0.6em' }}
    >
      {gifts.revealed && (
        <GiftReveal
          items={gifts.revealed.items}
          onDone={() => ui.getState().setGifts({ ...ui.getState().gifts!, revealed: null })}
        />
      )}
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Gifts</h2>
        <span className="tr-chip">
          {gifts.limits.sentToday} of {gifts.limits.daily} sent today
        </span>
      </div>
      <Segmented<'received' | 'sent'>
        label="Gifts"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'received', label: gifts.unopened > 0 ? `Received (${gifts.unopened})` : 'Received' },
          { value: 'sent', label: 'Sent' },
        ]}
      />
      <p className="tr-small tr-muted" style={{ margin: 0 }}>
        Friends of {gifts.policy.minFriendDays}+ days can gift each other store items. Unopened gifts open by
        themselves after {gifts.policy.autoAcceptDays} days; declining or cancelling one gives the sender
        their currency back. Opened gifts can't be refunded.
      </p>
      {list.length === 0 ? (
        <div className="tr-empty">
          <p>
            {tab === 'received'
              ? 'No gifts yet.'
              : "You haven't sent any gifts yet. Look for Gift in the Store."}
          </p>
        </div>
      ) : (
        <ul className="tr-col" style={{ gap: '0.5em', listStyle: 'none', padding: 0, margin: 0 }}>
          {list.map((g) =>
            tab === 'received' ? (
              <ReceivedGiftRow key={g.giftId} g={g} gifts={gifts} />
            ) : (
              <SentGiftRow key={g.giftId} g={g} gifts={gifts} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Wish lists
// -----------------------------------------------------------------------------

function WishlistRow({
  e,
  index,
  count,
  ids,
}: {
  e: WishlistEntryView;
  index: number;
  count: number;
  ids: string[];
}): JSX.Element {
  const move = (dir: -1 | 1): void => {
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(index + dir, 0, moved!);
    uiEvents.emit('wishlistReorder', { itemIds: next });
  };
  return (
    <li
      className="tr-panel tr-row tr-wishlist-row"
      style={{ gap: '0.5em', alignItems: 'center' }}
      data-testid="wishlist-entry"
    >
      {e.item && (
        <span className={`tr-bundle-item tr-item--${e.item.rarity}`}>
          <ItemPreview item={e.item} flat />
        </span>
      )}
      <div className="tr-col tr-grow" style={{ minWidth: 0, gap: '0.1em' }}>
        <strong className="tr-ellipsis">
          {e.title}
          {e.kind === 'bundle' ? ' (bundle)' : ''}
        </strong>
        <span className="tr-row tr-wrap" style={{ gap: '0.35em' }}>
          {e.owned ? (
            <span className="tr-chip tr-chip--mint">Owned</span>
          ) : e.price ? (
            <Price currency={e.price.currency} amount={e.price.amount} />
          ) : null}
          {e.inStoreToday && !e.owned && <span className="tr-chip tr-chip--lemon">In the store today</span>}
        </span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Move ${e.title} up`}
        disabled={index === 0}
        onClick={() => move(-1)}
      >
        <Icon name="chevron-left" size="1em" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Move ${e.title} down`}
        disabled={index === count - 1}
        onClick={() => move(1)}
      >
        <Icon name="chevron-right" size="1em" />
      </Button>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Remove ${e.title} from your wish list`}
        onClick={() => uiEvents.emit('wishlistToggle', { itemId: e.itemId, on: false })}
      >
        <Icon name="close" size="1em" />
      </Button>
    </li>
  );
}

/** Profile → Wish list. */
export function WishlistSection(): JSX.Element {
  const wishlist = useUI((s) => s.wishlist);
  useEffect(() => uiEvents.emit('requestWishlist'), []);
  if (!wishlist || (wishlist.status === 'loading' && wishlist.entries.length === 0)) {
    return (
      <section className="tr-panel tr-empty" data-testid="wishlist-section">
        <span className="tr-gumball-spinner" />
        <p>Unrolling your wish list…</p>
      </section>
    );
  }
  const ids = wishlist.entries.map((e) => e.itemId);
  return (
    <section
      className="tr-col"
      aria-label="Wish list"
      data-testid="wishlist-section"
      style={{ gap: '0.6em' }}
    >
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Wish list</h2>
        <span className="tr-chip">
          {wishlist.entries.length}/{wishlist.limit}
        </span>
      </div>
      {wishlist.status === 'error' && (
        <p className="tr-small" role="alert">
          {wishlist.error ?? "Couldn't update your wish list."}
        </p>
      )}
      <div className="tr-panel tr-col" style={{ gap: '0.5em' }}>
        <div className="tr-row tr-wrap" style={{ gap: '0.5em', alignItems: 'center' }}>
          <span className="tr-small tr-grow">Who can see it</span>
          <Segmented<'friends' | 'nobody'>
            label="Who can see your wish list"
            value={wishlist.visibility}
            onChange={(visibility) => uiEvents.emit('wishlistSettings', { visibility })}
            options={[
              { value: 'friends', label: 'Friends' },
              { value: 'nobody', label: 'Only me' },
            ]}
          />
        </div>
        <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
          <span className="tr-small tr-grow">Tell me when something on it is in the store</span>
          <Toggle
            checked={wishlist.alerts}
            label="Wish list store alerts"
            onChange={(alerts) => uiEvents.emit('wishlistSettings', { alerts })}
          />
        </div>
      </div>
      {wishlist.entries.length === 0 ? (
        <div className="tr-empty">
          <p>Nothing here yet. Press Wish list on any Store item to add it.</p>
          <Button size="sm" variant="premium" onClick={() => ui.getState().openStore('catalog')}>
            Browse the Store
          </Button>
        </div>
      ) : (
        <ol className="tr-col" style={{ gap: '0.4em', listStyle: 'none', padding: 0, margin: 0 }}>
          {wishlist.entries.map((e, i) => (
            <WishlistRow key={e.itemId} e={e} index={i} count={ids.length} ids={ids} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * A friend's wish list on their profile card, with a Gift button per entry.
 * Loads on demand so opening a card never fetches more than it shows.
 *
 * @param props.userId - The friend.
 */
export function FriendWishlistPanel({ userId }: { userId: string }): JSX.Element | null {
  const data = useUI((s) => (s.friendWishlist?.userId === userId ? s.friendWishlist : null));
  const online = useOnlineAccount();
  const asked = useRef(false);
  useEffect(() => {
    asked.current = false;
  }, [userId]);
  if (!online) return null;
  if (!data) {
    return (
      <Button
        size="sm"
        variant="secondary"
        data-testid="friend-wishlist-open"
        onClick={() => {
          if (asked.current) return;
          asked.current = true;
          uiEvents.emit('requestFriendWishlist', { userId });
        }}
      >
        <Icon name="star" size="1em" /> Wish list
      </Button>
    );
  }
  return (
    <div className="tr-panel tr-col" style={{ gap: '0.4em' }} data-testid="friend-wishlist">
      <span className="tr-label">Wish list</span>
      {data.status === 'loading' ? (
        <span className="tr-small tr-muted">Loading…</span>
      ) : data.status === 'hidden' ? (
        <span className="tr-small tr-muted">This wish list is private.</span>
      ) : data.status === 'error' ? (
        <span className="tr-small" role="alert">
          Couldn't load the wish list.
        </span>
      ) : data.entries.length === 0 ? (
        <span className="tr-small tr-muted">Nothing on it right now.</span>
      ) : (
        <ul className="tr-col" style={{ gap: '0.3em', listStyle: 'none', padding: 0, margin: 0 }}>
          {data.entries.map((e) => (
            <li key={e.itemId} className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
              {e.item && (
                <span className={`tr-bundle-item tr-item--${e.item.rarity}`}>
                  <ItemPreview item={e.item} flat />
                </span>
              )}
              <span className="tr-grow tr-ellipsis">{e.title}</span>
              {e.inStoreToday && <span className="tr-chip tr-chip--lemon">Today</span>}
              <GiftButton offerId={e.itemId} recipientId={userId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
