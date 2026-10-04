/**
 * The refund queue: Gem pack refund requests awaiting a decision (and every
 * refund for history), one refund's purchase, player and ledger trail, and
 * the approve / deny decisions. Approving needs the admin role because it
 * sends real money back; the server enforces that whatever the console shows.
 */
import { useState, type ReactNode } from 'react';
import type { AdminApi } from '../api.ts';
import {
  Badge,
  Pager,
  PlayerLink,
  StateBlock,
  useConsole,
  useLoad,
  type ActionRequest,
} from '../components.tsx';
import {
  isAdmin,
  personLabel,
  query,
  REFUND_STATUS,
  refundAmount,
  relativeTime,
  shortTime,
} from '../format.ts';
import type { RefundDetail, RefundPage, RefundRow, StaffRole } from '../types.ts';

const PAGE = 50;

const STATUS_FILTERS: [string, string][] = [
  ['open', 'awaiting decision'],
  ['processing', 'sent to Stripe'],
  ['manual', 'refund by hand'],
  ['failed', 'failed'],
  ['refunded', 'refunded'],
  ['denied', 'denied'],
  ['all', 'all'],
];

/** Approve / deny for one request, as confirm-dialog requests. */
export interface RefundActions {
  approve: ActionRequest;
  deny: ActionRequest;
}

/**
 * The decisions offered for a real-money request.
 *
 * @param api - Console API client.
 * @param detail - The refund being decided.
 * @param onDone - Reloads the view after a decision.
 * @returns Dialog requests for approve and deny.
 */
export function refundActions(api: AdminApi, detail: RefundDetail, onDone: () => void): RefundActions {
  const id = detail.refund.id;
  const amount = refundAmount(detail.refund.currency, detail.refund.amount);
  const viaStripe = detail.provider === 'stripe' && Boolean(detail.purchase?.paymentIntent);
  return {
    approve: {
      title: `Approve refund of ${amount}`,
      body: viaStripe
        ? `Stripe refunds ${amount} to the player's card now. When Stripe confirms, the pack's Gems are taken back; any already spent become Gem debt and cosmetics are kept.`
        : `No Stripe key is configured, so the request is marked for manual processing: refund ${amount} by hand in the payment dashboard. Gems move when Stripe reports the refund.`,
      confirmLabel: viaStripe ? 'Refund through Stripe' : 'Mark for manual refund',
      danger: true,
      reason: 'optional',
      run: async (note) => {
        await api.request('POST', `/internal/refunds/${id}/approve`, note ? { note } : {});
        onDone();
      },
      done: viaStripe ? 'Refund sent to Stripe' : 'Marked for manual refund',
    },
    deny: {
      title: 'Deny refund request',
      body: 'The player sees your reason. Nothing moves; the request cannot be filed again.',
      confirmLabel: 'Deny',
      run: async (reason) => {
        await api.request('POST', `/internal/refunds/${id}/deny`, { reason });
        onDone();
      },
      done: 'Request denied',
    },
  };
}

/** True while staff can still decide on a refund. */
export function isDecidable(r: Pick<RefundRow, 'kind' | 'status'>): boolean {
  return r.kind === 'real_money' && (r.status === 'pending' || r.status === 'failed');
}

/**
 * One queue row.
 *
 * @param props.refund - The refund.
 * @param props.now - Clock reading (ms).
 */
export function RefundRowView(props: { refund: RefundRow; now: number }) {
  const r = props.refund;
  const status = REFUND_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  return (
    <tr>
      <td>
        <a className="adm-link" href={`#/refunds/${encodeURIComponent(r.id)}`}>
          <span title={shortTime(r.createdAt)}>{relativeTime(r.createdAt, props.now)}</span>
        </a>
      </td>
      <td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td>{r.kind === 'real_money' ? 'Gem pack (money)' : 'Store (self-service)'}</td>
      <td>
        <PlayerLink
          id={r.userId}
          label={personLabel({ id: r.userId, displayName: r.displayName, tag: r.tag })}
        />
      </td>
      <td className="adm-mono">{r.offerId}</td>
      <td>{refundAmount(r.currency, r.amount)}</td>
      <td className="adm-col-wide">
        {r.playerReason ? (
          <p className="adm-quote">{r.playerReason}</p>
        ) : (
          <span className="adm-muted">—</span>
        )}
        {r.lastError && (
          <p className="adm-inline-error" role="note">
            {r.lastError}
          </p>
        )}
      </td>
    </tr>
  );
}

function Facts(props: { rows: [string, ReactNode][] }) {
  return (
    <dl className="adm-facts">
      {props.rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One refund: decision buttons, the purchase, the player and the ledger trail.
 *
 * @param props.detail - Loaded refund.
 * @param props.role - The viewer's role (approve is admin-only).
 * @param props.now - Clock reading (ms).
 * @param props.onAction - Opens a decision dialog.
 * @param props.actions - The decisions for this refund.
 */
export function RefundDetailView(props: {
  detail: RefundDetail;
  role: StaffRole;
  now: number;
  actions: RefundActions;
  onAction(action: ActionRequest): void;
}) {
  const { refund: r, purchase, player, history, ledger } = props.detail;
  const status = REFUND_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  const decidable = isDecidable(r);
  const name = player
    ? personLabel({ id: player.id, displayName: player.displayName, tag: player.tag })
    : r.userId;
  return (
    <article aria-labelledby="refund-title">
      <header className="adm-view-head">
        <h1 id="refund-title">
          Refund {refundAmount(r.currency, r.amount)} <Badge tone={status.tone}>{status.label}</Badge>
        </h1>
        {decidable && (
          <div className="adm-actions">
            {isAdmin(props.role) ? (
              <button
                type="button"
                className="adm-btn adm-btn--primary"
                onClick={() => props.onAction(props.actions.approve)}
              >
                {r.status === 'failed' ? 'Retry approval…' : 'Approve…'}
              </button>
            ) : (
              <span className="adm-muted">Only admins can approve money refunds.</span>
            )}
            <button
              type="button"
              className="adm-btn adm-btn--danger"
              onClick={() => props.onAction(props.actions.deny)}
            >
              Deny…
            </button>
          </div>
        )}
      </header>
      {r.lastError && (
        <p className="adm-inline-error" role="alert">
          {r.lastError}
        </p>
      )}
      <div className="adm-grid">
        <section className="adm-card">
          <header>
            <h2>Request</h2>
          </header>
          <Facts
            rows={[
              ['Kind', r.kind === 'real_money' ? 'Gem pack refund request' : 'Self-service store refund'],
              ['Filed', <span title={shortTime(r.createdAt)}>{relativeTime(r.createdAt, props.now)}</span>],
              ['Player said', r.playerReason ?? '—'],
              ['Decided by', r.decidedBy ? `${r.decidedBy}, ${shortTime(r.decidedAt)}` : '—'],
              ['Staff note', r.decisionReason ?? '—'],
              ['Stripe refund', r.providerRefundId ?? '—'],
              ['Items removed', r.items.length ? r.items.join(', ') : '—'],
            ]}
          />
        </section>
        <section className="adm-card">
          <header>
            <h2>Purchase</h2>
          </header>
          {purchase ? (
            <Facts
              rows={[
                ['Offer', <span className="adm-mono">{purchase.offerId}</span>],
                ['Paid', refundAmount(purchase.currency, purchase.price)],
                ['Status', purchase.status],
                ['When', shortTime(purchase.completedAt ?? purchase.createdAt)],
                ['Provider', purchase.provider ?? '—'],
                ['PaymentIntent', <span className="adm-mono">{purchase.paymentIntent ?? '—'}</span>],
              ]}
            />
          ) : (
            <p className="adm-muted">The purchase is gone (account deleted).</p>
          )}
        </section>
        <section className="adm-card">
          <header>
            <h2>Player</h2>
          </header>
          {player ? (
            <Facts
              rows={[
                ['Name', <PlayerLink id={player.id} label={name} />],
                ['Account', player.isGuest ? 'guest' : 'full account'],
                ['Gems', String(player.gems)],
                ['Gem debt', player.gemDebt > 0 ? <Badge tone="bad">{player.gemDebt}</Badge> : '0'],
                ['Purchases', String(player.purchases)],
                ['Refunds', String(history.length)],
              ]}
            />
          ) : (
            <p className="adm-muted">Account deleted.</p>
          )}
        </section>
        <section className="adm-card adm-card--wide">
          <header>
            <h2>Refund history</h2>
          </header>
          <ul className="adm-list">
            {history.map((h) => (
              <li key={h.id}>
                <a className="adm-link" href={`#/refunds/${encodeURIComponent(h.id)}`}>
                  {shortTime(h.createdAt)}
                </a>{' '}
                {h.kind === 'real_money' ? 'money' : 'store'} · {refundAmount(h.currency, h.amount)} ·{' '}
                {REFUND_STATUS[h.status]?.label ?? h.status}
              </li>
            ))}
          </ul>
        </section>
        <section className="adm-card adm-card--wide">
          <header>
            <h2>Ledger for this purchase</h2>
          </header>
          {ledger.length === 0 ? (
            <p className="adm-muted">No currency moved for this purchase.</p>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Account</th>
                  <th>Change</th>
                  <th>Balance after</th>
                  <th>Reason</th>
                  <th>Ref</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l, i) => (
                  <tr key={i}>
                    <td>{shortTime(l.createdAt)}</td>
                    <td>{l.currency}</td>
                    <td>{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                    <td>{l.balanceAfter}</td>
                    <td className="adm-mono">{l.reason}</td>
                    <td className="adm-mono">{l.ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </article>
  );
}

function RefundPageView(props: { id: string }) {
  const { api, actor, confirm, now } = useConsole();
  const url = `/internal/refunds/${encodeURIComponent(props.id)}`;
  const state = useLoad(url, () => api.request<RefundDetail>('GET', url));
  return (
    <section>
      <p>
        <a className="adm-link" href="#/refunds">
          Back to the queue
        </a>
      </p>
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {(d) => (
          <RefundDetailView
            detail={d}
            role={actor.role}
            now={now()}
            actions={refundActions(api, d, state.reload)}
            onAction={confirm}
          />
        )}
      </StateBlock>
    </section>
  );
}

/**
 * The refund queue, or one refund when `id` is set.
 *
 * @param props.id - Refund id from the route.
 */
export function RefundsView(props: { id?: string | undefined }) {
  const { api, now } = useConsole();
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const url = `/internal/refunds${query({ status, kind, limit: PAGE, offset })}`;
  const state = useLoad(props.id ? null : url, () => api.request<RefundPage>('GET', url));
  if (props.id) return <RefundPageView id={props.id} />;
  return (
    <section aria-labelledby="refunds-title">
      <header className="adm-view-head">
        <h1 id="refunds-title">Refunds</h1>
        <button type="button" className="adm-btn" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>
      <form className="adm-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter refunds">
        <label className="adm-field">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {STATUS_FILTERS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-field">
          <span>Kind</span>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">any</option>
            <option value="real_money">Gem pack (money)</option>
            <option value="self_service">Store (self-service)</option>
          </select>
        </label>
      </form>
      <StateBlock
        state={state}
        empty="No refunds match. Nothing is waiting for a decision."
        isEmpty={(d) => d.refunds.length === 0}
      >
        {(page) => (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Filed</th>
                    <th>Status</th>
                    <th>Kind</th>
                    <th>Player</th>
                    <th>Offer</th>
                    <th>Amount</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {page.refunds.map((r) => (
                    <RefundRowView key={r.id} refund={r} now={now()} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              offset={page.offset}
              limit={page.limit}
              count={page.refunds.length}
              total={page.total}
              onPage={setOffset}
            />
          </>
        )}
      </StateBlock>
    </section>
  );
}
