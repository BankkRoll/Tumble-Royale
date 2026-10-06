/**
 * Gifts on the player page: everything the player sent and received, with
 * the other party, the price, the note, how it ended and its ledger rows.
 * Admins can reverse an unopened or opened gift (the sender is refunded and
 * an opened gift's items leave the recipient's locker); moderators see the
 * same list without the button, and the server enforces the role regardless.
 */
import { useState } from 'react';
import { Badge, PlayerLink, StateBlock, useConsole, useLoad, type ActionRequest } from '../components.tsx';
import { isAdmin, refundAmount, relativeTime, shortTime } from '../format.ts';
import type { AdminApi } from '../api.ts';
import type { AdminGift, GiftStatus, PlayerGifts, StaffRole } from '../types.ts';

/** Human names and badge tones for gift statuses. */
export const GIFT_STATUS: Record<
  GiftStatus,
  { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }
> = {
  pending: { label: 'unopened', tone: 'warn' },
  opened: { label: 'opened', tone: 'good' },
  declined: { label: 'declined', tone: 'neutral' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
  returned: { label: 'returned', tone: 'neutral' },
  reversed: { label: 'reversed by staff', tone: 'bad' },
};

/** True while a reversal still has something to undo. */
export function isReversible(g: Pick<AdminGift, 'status'>): boolean {
  return g.status === 'pending' || g.status === 'opened';
}

/**
 * The reversal dialog for one gift.
 *
 * @param api - Console API.
 * @param g - The gift.
 * @param onDone - Reloads the page afterwards.
 */
export function giftReverseAction(api: AdminApi, g: AdminGift, onDone: () => void): ActionRequest {
  const price = refundAmount(g.price.currency, g.price.amount);
  const sender = g.from ? `${g.from.name}#${g.from.tag}` : 'the (deleted) sender';
  return {
    title: `Reverse gift: ${g.title}`,
    body:
      g.status === 'opened'
        ? `Refunds ${price} to ${sender} and takes ${g.items.map((i) => i.name).join(', ')} back from the recipient, off every loadout that wears it. Items they have since earned another way stay.`
        : `Refunds ${price} to ${sender}; the recipient can no longer open it.`,
    confirmLabel: 'Reverse gift',
    danger: true,
    run: async (reason) => {
      await api.request('POST', `/internal/gifts/${encodeURIComponent(g.giftId)}/reverse`, { reason });
      onDone();
    },
    done: 'Gift reversed',
  };
}

/**
 * One direction of a player's gifts.
 *
 * @param props.gifts - The gifts.
 * @param props.direction - Whose side the table shows the other party for.
 * @param props.role - The viewer's role (reversal is admin-only).
 * @param props.now - Clock for relative times.
 * @param props.onReverse - Opens the reversal dialog.
 */
export function GiftTable(props: {
  gifts: AdminGift[];
  direction: 'sent' | 'received';
  role: StaffRole;
  now: number;
  onReverse: (g: AdminGift) => void;
}) {
  const admin = isAdmin(props.role);
  if (props.gifts.length === 0) return <p className="adm-muted">None.</p>;
  return (
    <div className="adm-table-wrap adm-table-wrap--short">
      <table className="adm-table">
        <thead>
          <tr>
            <th>Sent</th>
            <th>{props.direction === 'sent' ? 'To' : 'From'}</th>
            <th>Gift</th>
            <th>Price</th>
            <th>Status</th>
            <th>Ledger</th>
            {admin && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {props.gifts.map((g) => {
            const other = props.direction === 'sent' ? g.to : g.from;
            const status = GIFT_STATUS[g.status];
            return (
              <tr key={g.giftId} data-testid="admin-gift">
                <td title={shortTime(g.sentAt)}>{relativeTime(g.sentAt, props.now)}</td>
                <td>
                  {other ? (
                    <PlayerLink id={other.userId} label={`${other.name}#${other.tag}`} />
                  ) : (
                    <span className="adm-muted">deleted account</span>
                  )}
                </td>
                <td>
                  {g.title}
                  {g.message && <div className="adm-sub">“{g.message.text}”</div>}
                  <div className="adm-sub adm-mono">{g.giftId}</div>
                </td>
                <td>{refundAmount(g.price.currency, g.price.amount)}</td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {g.autoAccepted && <div className="adm-sub">auto-accepted</div>}
                  {g.note && <div className="adm-sub">{g.note.replace('_', ' ')}</div>}
                  {g.refunded && <div className="adm-sub">sender refunded</div>}
                </td>
                <td className="adm-mono adm-sub">
                  {g.ledger.map((l) => (
                    <div key={`${l.reason}:${l.userId}`}>
                      {l.reason} {l.delta > 0 ? '+' : ''}
                      {l.delta} {l.currency}
                    </div>
                  ))}
                </td>
                {admin && (
                  <td>
                    {isReversible(g) && (
                      <button
                        type="button"
                        className="adm-btn adm-btn--small adm-btn--danger"
                        onClick={() => props.onReverse(g)}
                      >
                        Reverse…
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Gifts card on a player's page.
 *
 * @param props.id - Account id.
 */
export function PlayerGiftsCard(props: { id: string }) {
  const { api, actor, confirm, now } = useConsole();
  const url = `/internal/users/${encodeURIComponent(props.id)}/gifts`;
  const state = useLoad(url, () => api.request<PlayerGifts>('GET', url));
  const [tab, setTab] = useState<'received' | 'sent'>('received');
  return (
    <section className="adm-card adm-card--wide" aria-label="Gifts">
      <header>
        <h2>Gifts</h2>
        <div className="adm-actions" role="tablist" aria-label="Gift direction">
          {(['received', 'sent'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`adm-btn adm-btn--small${tab === t ? ' adm-btn--primary' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'received' ? 'Received' : 'Sent'}
              {state.data ? ` (${state.data[t].length})` : ''}
            </button>
          ))}
        </div>
      </header>
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {(d) => (
          <GiftTable
            gifts={d[tab]}
            direction={tab}
            role={actor.role}
            now={now()}
            onReverse={(g) => confirm(giftReverseAction(api, g, state.reload))}
          />
        )}
      </StateBlock>
    </section>
  );
}
