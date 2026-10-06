/**
 * The report queue: filter, page, read the evidence, select reports and
 * decide on them in bulk (dismiss, resolve, warn, mute, ban).
 */
import { useState } from 'react';
import { Badge, Pager, PlayerLink, StateBlock, useConsole, useLoad } from '../components.tsx';
import {
  ACTION_META,
  BAN_DURATIONS,
  MUTE_DURATIONS,
  personLabel,
  query,
  REASON_LABELS,
  relativeTime,
  reportActionBody,
  SCOPE_LABELS,
  shortTime,
} from '../format.ts';
import type { ReportAction, ReportPage, ReportRow } from '../types.ts';

const PAGE = 50;

/** Filters of the queue. */
export interface ReportFilters {
  status: string;
  reason: string;
  order: 'oldest' | 'newest';
  targetUserId: string;
}

/** How each evidence channel is labelled (voice lines are metadata: nothing is recorded). */
const EVIDENCE_CHANNEL: Record<string, string> = {
  global: 'global',
  whisper: 'whisper to reporter',
  club: 'club chat',
  voice: 'voice room (no recording)',
};

/**
 * One report row: who, what, evidence, and its selection box.
 *
 * @param props.report - The report.
 * @param props.selected - Whether it is ticked.
 * @param props.onToggle - Ticks or unticks it.
 * @param props.now - Clock reading (ms).
 */
export function ReportRowView(props: {
  report: ReportRow;
  selected: boolean;
  onToggle(): void;
  now: number;
}) {
  const r = props.report;
  return (
    <tr className={props.selected ? 'is-selected' : undefined}>
      <td className="adm-col-check">
        <input
          type="checkbox"
          checked={props.selected}
          onChange={props.onToggle}
          aria-label={`Select report against ${personLabel(r.target)}`}
        />
      </td>
      <td>
        <span title={shortTime(r.createdAt)}>{relativeTime(r.createdAt, props.now)}</span>
        {r.status !== 'open' && (
          <div>
            <Badge>{r.status}</Badge>
          </div>
        )}
      </td>
      <td>
        <Badge tone={r.reason === 'cheating' || r.reason === 'harassment' ? 'bad' : 'warn'}>
          {REASON_LABELS[r.reason] ?? r.reason}
        </Badge>
      </td>
      <td>
        <PlayerLink id={r.target.id} label={personLabel(r.target)} />
        <div className="adm-sub">
          {r.target.openReports > 1 && <Badge tone="warn">{r.target.openReports} open</Badge>}
          {r.target.activeSanctions.map((s) => (
            <Badge
              key={s.id}
              tone="bad"
              title={s.expiresAt ? `until ${shortTime(s.expiresAt)}` : 'permanent'}
            >
              {SCOPE_LABELS[s.scope] ?? s.scope}
            </Badge>
          ))}
        </div>
      </td>
      <td>
        <PlayerLink id={r.reporter.id} label={personLabel(r.reporter)} />
      </td>
      <td className="adm-mono">{r.matchId ?? '—'}</td>
      <td className="adm-col-wide">
        {r.details ? <p className="adm-quote">{r.details}</p> : <span className="adm-muted">No details</span>}
        {r.evidence && r.evidence.length > 0 && (
          <details className="adm-evidence">
            <summary>
              {r.evidence.some((l) => l.channel === 'voice') ? 'Evidence' : 'Chat evidence'} (
              {r.evidence.length})
            </summary>
            <ol>
              {r.evidence.map((l, i) => (
                <li key={i}>
                  <span className="adm-muted">
                    {shortTime(new Date(l.at).toISOString())} · {EVIDENCE_CHANNEL[l.channel] ?? l.channel}
                  </span>{' '}
                  {l.text}
                </li>
              ))}
            </ol>
          </details>
        )}
      </td>
    </tr>
  );
}

/**
 * The bar of bulk decisions for the selected reports.
 *
 * @param props.count - Selected reports.
 * @param props.onAction - Starts a decision.
 * @param props.onClear - Clears the selection.
 */
export function BulkBar(props: { count: number; onAction(a: ReportAction): void; onClear(): void }) {
  if (props.count === 0) return null;
  return (
    <div className="adm-bulk" role="toolbar" aria-label="Actions for selected reports">
      <strong>{props.count} selected</strong>
      {(Object.keys(ACTION_META) as ReportAction[]).map((a) => (
        <button
          key={a}
          type="button"
          className={`adm-btn ${ACTION_META[a].danger ? 'adm-btn--danger' : ''}`}
          onClick={() => props.onAction(a)}
        >
          {ACTION_META[a].label}
        </button>
      ))}
      <button type="button" className="adm-btn adm-btn--ghost" onClick={props.onClear}>
        Clear
      </button>
    </div>
  );
}

/** Sentence describing what a bulk decision will do. */
export function describeAction(action: ReportAction, reports: number, players: number): string {
  const r = `${reports} report${reports === 1 ? '' : 's'}`;
  const p = `${players} player${players === 1 ? '' : 's'}`;
  switch (action) {
    case 'dismiss':
      return `Close ${r} as unfounded. Nobody is sanctioned.`;
    case 'resolve':
      return `Close ${r} as handled elsewhere. Nobody is sanctioned.`;
    case 'warn':
      return `Record a warning on ${p} and notify them, then close ${r}.`;
    case 'mute':
      return `Turn off chat for ${p} (global, party and whispers), then close ${r}.`;
    case 'voice_mute':
      return `Turn off voice chat for ${p} and drop them from every voice room at once, then close ${r}.`;
    case 'ban':
      return `Suspend ${p}: they are signed out of everything at once. Closes every open report against them.`;
  }
}

/** The report queue view. */
export function ReportsView() {
  const { api, confirm, now } = useConsole();
  const [filters, setFilters] = useState<ReportFilters>({
    status: 'open',
    reason: '',
    order: 'oldest',
    targetUserId: '',
  });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const url = `/internal/reports${query({
    status: filters.status,
    reason: filters.reason,
    order: filters.order,
    targetUserId: filters.targetUserId.trim() || undefined,
    limit: PAGE,
    offset,
  })}`;
  const state = useLoad(url, () => api.request<ReportPage>('GET', url));
  const rows = state.data?.reports ?? [];

  const setFilter = <K extends keyof ReportFilters>(k: K, v: ReportFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
    setSelected(new Set());
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const act = (action: ReportAction) => {
    const ids = [...selected];
    const players = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.target.id)).size;
    confirm({
      title: `${ACTION_META[action].verb} — ${ids.length} report${ids.length === 1 ? '' : 's'}`,
      body: describeAction(action, ids.length, players),
      confirmLabel: ACTION_META[action].verb,
      danger: ACTION_META[action].danger,
      ...(action === 'mute' || action === 'voice_mute'
        ? { durations: MUTE_DURATIONS }
        : action === 'ban'
          ? { durations: BAN_DURATIONS }
          : {}),
      run: async (reason, hours) => {
        await api.request('POST', '/internal/reports/action', reportActionBody(ids, action, reason, hours));
        setSelected(new Set());
        state.reload();
      },
      done: `${ACTION_META[action].verb}: done`,
    });
  };

  return (
    <section aria-labelledby="reports-title">
      <header className="adm-view-head">
        <h1 id="reports-title">Reports</h1>
        <button type="button" className="adm-btn" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>
      <form className="adm-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter reports">
        <label className="adm-field">
          <span>Status</span>
          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            {['open', 'actioned', 'dismissed', 'resolved', 'all'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-field">
          <span>Reason</span>
          <select value={filters.reason} onChange={(e) => setFilter('reason', e.target.value)}>
            <option value="">any</option>
            {Object.entries(REASON_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-field">
          <span>Order</span>
          <select
            value={filters.order}
            onChange={(e) => setFilter('order', e.target.value as 'oldest' | 'newest')}
          >
            <option value="oldest">oldest first</option>
            <option value="newest">newest first</option>
          </select>
        </label>
        <label className="adm-field adm-field--grow">
          <span>Reported player id</span>
          <input
            value={filters.targetUserId}
            placeholder="any"
            spellCheck={false}
            onChange={(e) => setFilter('targetUserId', e.target.value)}
          />
        </label>
      </form>
      <BulkBar count={selected.size} onAction={act} onClear={() => setSelected(new Set())} />
      <StateBlock
        state={state}
        empty="No reports match. The queue is clear."
        isEmpty={(d) => d.reports.length === 0}
      >
        {(page) => (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th className="adm-col-check">
                      <input
                        type="checkbox"
                        aria-label="Select every report on this page"
                        checked={allOnPage}
                        onChange={() =>
                          setSelected(
                            allOnPage ? new Set() : new Set([...selected, ...rows.map((r) => r.id)]),
                          )
                        }
                      />
                    </th>
                    <th>Filed</th>
                    <th>Reason</th>
                    <th>Reported player</th>
                    <th>Reporter</th>
                    <th>Match</th>
                    <th>Details and evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {page.reports.map((r) => (
                    <ReportRowView
                      key={r.id}
                      report={r}
                      selected={selected.has(r.id)}
                      onToggle={() => toggle(r.id)}
                      now={now()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              offset={page.offset}
              limit={page.limit}
              count={page.reports.length}
              total={page.total}
              onPage={(o) => {
                setOffset(o);
                setSelected(new Set());
              }}
            />
          </>
        )}
      </StateBlock>
    </section>
  );
}
