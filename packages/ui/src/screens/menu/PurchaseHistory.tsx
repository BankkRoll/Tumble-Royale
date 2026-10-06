/**
 * Store → Purchases: the online account's purchase history with refunds.
 *
 * - Store items and bundles bought with Gumballs or Gems can be refunded by
 *   the player inside the window; a confirm dialog states exactly which items
 *   leave the locker and what comes back before anything is sent.
 * - Gem packs (real money) get a "Request a refund" form; staff review it and
 *   the entry shows where the request stands.
 * - Everything else shows why it cannot be refunded, in the server's words.
 *
 * The server decides eligibility; this only presents it.
 */
import { useEffect, useState, type JSX } from 'react';
import { Button } from '../../components/controls.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { PurchaseHistoryData, PurchaseHistoryEntry, RefundState } from '../../store/types.ts';

const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  gumballs: 'Gumballs',
  gems: 'Gems',
  crown_shards: 'Crown Shards',
};

/** Dialog id prefix of the self-service refund confirmation. */
export const REFUND_DIALOG_PREFIX = 'refund:';

/**
 * A price for people: money as dollars, currencies with their name.
 *
 * @param price - Currency and amount (minor units for money).
 * @returns e.g. `$9.99` or `1,200 Gems`.
 */
export function formatPaid(price: PurchaseHistoryEntry['price']): string {
  if (price.currency === 'usd') return `$${(price.amount / 100).toFixed(2)}`;
  return `${formatNumber(price.amount)} ${CURRENCY_NAMES[price.currency] ?? price.currency}`;
}

/**
 * What the player sees about an existing refund.
 *
 * @param refund - The purchase's refund.
 * @returns A short status line, and whether it is still in progress.
 */
export function refundStatusText(refund: NonNullable<PurchaseHistoryEntry['refund']>): {
  text: string;
  tone: 'mint' | 'lemon' | 'muted';
} {
  const lines: Record<RefundState, { text: string; tone: 'mint' | 'lemon' | 'muted' }> = {
    completed: { text: 'Refunded', tone: 'mint' },
    pending: { text: 'Refund requested: waiting for review', tone: 'lemon' },
    processing: { text: 'Refund approved: on its way to your payment method', tone: 'lemon' },
    manual: { text: 'Refund approved: on its way to your payment method', tone: 'lemon' },
    refunded: { text: 'Refunded to your payment method', tone: 'mint' },
    partially_refunded: { text: 'Partly refunded to your payment method', tone: 'mint' },
    denied: {
      text: refund.decisionReason ? `Refund declined: ${refund.decisionReason}` : 'Refund declined',
      tone: 'muted',
    },
    failed: { text: 'The refund hit a snag; our team is looking into it', tone: 'lemon' },
  };
  return lines[refund.status];
}

/**
 * The confirmation for a self-service refund: what leaves the locker and
 * what comes back.
 *
 * @param entry - The purchase.
 * @param history - For the refunds left this year.
 * @returns Dialog body text.
 */
export function refundConfirmText(entry: PurchaseHistoryEntry, history: PurchaseHistoryData): string {
  const names = entry.items.map((i) => i.name);
  const what =
    names.length === 0
      ? 'This purchase'
      : names.length === 1
        ? `${names[0]}`
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const left = Math.max(0, history.selfRefunds.limit - history.selfRefunds.used - 1);
  return (
    `${what} will leave your locker (any outfit wearing ${names.length > 1 ? 'them' : 'it'} switches back to ` +
    `the default), and you get ${formatPaid(entry.price)} back. ` +
    `After this you have ${left} of ${history.selfRefunds.limit} store refunds left for the next ` +
    `${history.selfRefunds.windowDays} days. This can't be undone.`
  );
}

/**
 * Turns a confirmed refund dialog into the `refundPurchase` intent; nothing
 * is sent on Cancel or Escape.
 *
 * @returns Unsubscribe.
 */
export function bindRefundConfirm(): () => void {
  return uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (!dialogId.startsWith(REFUND_DIALOG_PREFIX) || buttonId !== 'confirm') return;
    uiEvents.emit('refundPurchase', { purchaseId: dialogId.slice(REFUND_DIALOG_PREFIX.length) });
  });
}

/**
 * Opens the self-service refund confirmation.
 *
 * @param entry - The purchase.
 * @param history - For the refunds left this year.
 */
export function confirmRefund(entry: PurchaseHistoryEntry, history: PurchaseHistoryData): void {
  ui.getState().showDialog({
    id: `${REFUND_DIALOG_PREFIX}${entry.purchaseId}`,
    kind: 'confirm',
    title: `Refund ${entry.title}?`,
    body: refundConfirmText(entry, history),
    buttons: [
      { id: 'cancel', label: 'Keep it', variant: 'secondary', autofocus: true },
      { id: 'confirm', label: 'Refund', variant: 'danger' },
    ],
  });
}

function RequestForm(props: { entry: PurchaseHistoryEntry; busy: boolean; onDone(): void }): JSX.Element {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 3;
  const id = `refund-reason-${props.entry.purchaseId}`;
  return (
    <form
      className="tr-col"
      style={{ gap: '0.4em' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || props.busy) return;
        uiEvents.emit('refundPurchase', { purchaseId: props.entry.purchaseId, reason: reason.trim() });
        props.onDone();
      }}
    >
      <label htmlFor={id} className="tr-small">
        Tell us what went wrong. Our team reviews every request; if it's approved, the money goes back to your
        payment method and the pack's Gems are removed (Gems you already spent become a balance to repay).
      </label>
      <textarea
        id={id}
        className="tr-input"
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="tr-row" style={{ gap: '0.4em' }}>
        <Button size="sm" variant="secondary" type="button" onClick={props.onDone}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={!ok || props.busy}>
          Send request
        </Button>
      </div>
    </form>
  );
}

/**
 * One purchase row.
 *
 * @param props.entry - The purchase.
 * @param props.history - The whole history (limits, busy state).
 */
export function PurchaseRow(props: {
  entry: PurchaseHistoryEntry;
  history: PurchaseHistoryData;
}): JSX.Element {
  const { entry, history } = props;
  const [asking, setAsking] = useState(false);
  const busy = history.busyId === entry.purchaseId;
  const e = entry.eligibility;
  const status = entry.refund ? refundStatusText(entry.refund) : null;
  return (
    <li className="tr-panel tr-col" style={{ gap: '0.3em' }} data-testid="purchase-row">
      <div className="tr-row" style={{ gap: '0.5em', alignItems: 'baseline' }}>
        <strong className="tr-grow">{entry.title}</strong>
        <span className="tr-small">{formatPaid(entry.price)}</span>
      </div>
      <div className="tr-small tr-muted">
        {new Date(entry.purchasedAt).toLocaleDateString()}
        {entry.gems ? ` · ${formatNumber(entry.gems)} Gems` : ''}
        {entry.items.length > 1 ? ` · ${entry.items.map((i) => i.name).join(', ')}` : ''}
      </div>
      {status && (
        <span className={`tr-chip${status.tone === 'muted' ? '' : ` tr-chip--${status.tone}`}`} role="status">
          {status.text}
        </span>
      )}
      {!status && e.eligible && e.kind === 'self_service' && (
        <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirmRefund(entry, history)}>
            {busy ? 'Refunding…' : 'Refund'}
          </Button>
          <span className="tr-small tr-muted">Until {new Date(e.until).toLocaleDateString()}</span>
        </div>
      )}
      {!status &&
        e.eligible &&
        e.kind === 'real_money' &&
        (asking ? (
          <RequestForm entry={entry} busy={busy} onDone={() => setAsking(false)} />
        ) : (
          <div className="tr-row" style={{ gap: '0.5em', alignItems: 'center' }}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
              {busy ? 'Sending…' : 'Request a refund'}
            </Button>
            <span className="tr-small tr-muted">Until {new Date(e.until).toLocaleDateString()}</span>
          </div>
        ))}
      {!status && !e.eligible && (
        <p className="tr-small tr-muted" style={{ margin: 0 }} data-reason={e.reason}>
          {e.message}
          {e.retryAt ? ` Your next refund frees up on ${new Date(e.retryAt).toLocaleDateString()}.` : ''}
        </p>
      )}
    </li>
  );
}

/** The Purchases section of the Store. Asks for fresh history whenever it opens. */
export function PurchaseHistorySection(): JSX.Element {
  const history = useUI((s) => s.purchaseHistory);
  useEffect(() => {
    uiEvents.emit('requestPurchaseHistory');
    return bindRefundConfirm();
  }, []);

  return (
    <section className="tr-col tr-store-section" aria-label="Purchases" data-testid="store-purchases">
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Purchases</h2>
        {history?.status === 'ready' && (
          <span className="tr-chip">
            {Math.max(0, history.selfRefunds.limit - history.selfRefunds.used)} of {history.selfRefunds.limit}{' '}
            refunds left
          </span>
        )}
      </div>
      {history && (
        <p className="tr-small tr-muted" style={{ margin: 0 }}>
          Store items and bundles can be refunded within {history.policy.selfServiceWindowDays} days,{' '}
          {history.selfRefunds.limit} times a year. Gem packs can be sent for review within{' '}
          {history.policy.realMoneyWindowDays} days. Season Pass and Crown Shard purchases can't be refunded.
        </p>
      )}
      {!history || (history.status === 'loading' && history.entries.length === 0) ? (
        <div className="tr-empty">
          <span className="tr-gumball-spinner" />
          <p>Finding your receipts…</p>
        </div>
      ) : history.status === 'error' && history.entries.length === 0 ? (
        <div className="tr-empty" role="alert">
          <p>{history.error ?? "Couldn't load your purchases."}</p>
          <Button size="sm" onClick={() => uiEvents.emit('requestPurchaseHistory')}>
            Try again
          </Button>
        </div>
      ) : history.entries.length === 0 ? (
        <div className="tr-empty">
          <p>No purchases yet.</p>
        </div>
      ) : (
        <>
          <ul className="tr-col" style={{ gap: '0.5em', listStyle: 'none', padding: 0, margin: 0 }}>
            {history.entries.map((e) => (
              <PurchaseRow key={e.purchaseId} entry={e} history={history} />
            ))}
          </ul>
          {history.nextCursor && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="purchases-more"
              disabled={history.loadingMore === true}
              onClick={() => uiEvents.emit('loadMorePurchases')}
            >
              {history.loadingMore ? (
                <span className="tr-gumball-spinner tr-gumball-spinner--sm" />
              ) : (
                'Show older'
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
