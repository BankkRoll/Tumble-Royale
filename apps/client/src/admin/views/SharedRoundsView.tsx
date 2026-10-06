/**
 * Shared custom rounds: the list (reported first on request), one round's
 * details with its JSON and reports, and the takedown, dismiss and restore
 * actions (each asks for a reason, which lands in the audit log).
 */
import { useState } from 'react';
import { isAdmin, query, relativeTime, shortTime } from '../format.ts';
import { Badge, Pager, PlayerLink, StateBlock, useConsole, useLoad } from '../components.tsx';
import type { SharedRoundDetail, SharedRoundRow } from '../types.ts';

const PAGE = 50;

const STATUS_TONE: Record<SharedRoundRow['status'], 'good' | 'neutral' | 'bad'> = {
  published: 'good',
  unpublished: 'neutral',
  taken_down: 'bad',
};

const STATUS_LABEL: Record<SharedRoundRow['status'], string> = {
  published: 'shared',
  unpublished: 'hidden by owner',
  taken_down: 'taken down',
};

/**
 * Size of a round for the table.
 *
 * @param round - The round's JSON definition.
 * @returns E.g. `"42 parts · 6 obstacles · 3 triggers"`.
 */
export function roundContents(round: unknown): string {
  const r = (round ?? {}) as { geometry?: unknown[]; obstacles?: unknown[]; triggers?: unknown[] };
  return `${r.geometry?.length ?? 0} parts · ${r.obstacles?.length ?? 0} obstacles · ${r.triggers?.length ?? 0} triggers`;
}

/** One round: details, reports, JSON and actions. */
export function SharedRoundDetailView(props: { code: string; onChanged(): void }) {
  const { api, confirm, actor, now } = useConsole();
  const url = `/internal/custom-rounds/${encodeURIComponent(props.code)}`;
  const state = useLoad(url, () => api.request<SharedRoundDetail>('GET', url));
  const act = (path: string, title: string, body: string, label: string, done: string) =>
    confirm({
      title,
      body,
      confirmLabel: label,
      danger: path === 'takedown',
      run: async (reason) => {
        await api.request('POST', `${url}/${path}`, { reason });
        state.reload();
        props.onChanged();
      },
      done,
    });
  return (
    <StateBlock state={state} empty="Not found." isEmpty={() => false}>
      {(d) => (
        <article className="adm-card" aria-label={`Round ${d.round.code}`}>
          <header className="adm-view-head">
            <h2>
              {d.round.name} <code>{d.round.code}</code>
            </h2>
            <Badge tone={STATUS_TONE[d.round.status]}>{STATUS_LABEL[d.round.status]}</Badge>
          </header>
          <dl className="adm-dl">
            <dt>Author</dt>
            <dd>
              <PlayerLink id={d.round.ownerId} label={d.round.author ?? d.round.ownerId.slice(0, 8)} />
            </dd>
            <dt>Type</dt>
            <dd>{d.round.type}</dd>
            <dt>Description</dt>
            <dd>{d.round.description || '—'}</dd>
            <dt>Contents</dt>
            <dd>{roundContents(d.round.definition)}</dd>
            <dt>Updated</dt>
            <dd title={shortTime(d.round.updatedAt)}>{relativeTime(d.round.updatedAt, now())}</dd>
            {d.round.status === 'taken_down' ? (
              <>
                <dt>Taken down</dt>
                <dd>
                  {d.round.takedownReason} ({d.round.takenDownBy}, {shortTime(d.round.takenDownAt)})
                </dd>
              </>
            ) : null}
          </dl>
          <div className="adm-actions">
            {d.round.status !== 'taken_down' ? (
              <button
                type="button"
                className="adm-btn adm-btn--danger"
                onClick={() =>
                  act(
                    'takedown',
                    `Take down ${d.round.name}`,
                    'The code stops working in the editor, lobbies and new shows at once, and its open reports close.',
                    'Take down',
                    'Taken down',
                  )
                }
              >
                Take down
              </button>
            ) : isAdmin(actor.role) ? (
              <button
                type="button"
                className="adm-btn"
                onClick={() =>
                  act(
                    'restore',
                    `Restore ${d.round.name}`,
                    'The code works again everywhere.',
                    'Restore',
                    'Restored',
                  )
                }
              >
                Restore
              </button>
            ) : null}
            {d.reports.some((r) => r.status === 'open') ? (
              <button
                type="button"
                className="adm-btn"
                onClick={() =>
                  act(
                    'dismiss-reports',
                    'Dismiss open reports',
                    'The round stays up; its open reports close as dismissed.',
                    'Dismiss',
                    'Dismissed',
                  )
                }
              >
                Dismiss reports
              </button>
            ) : null}
          </div>
          <h3>Reports ({d.reports.length})</h3>
          {d.reports.length === 0 ? (
            <p className="adm-muted">No reports.</p>
          ) : (
            <ul className="adm-list">
              {d.reports.map((r) => (
                <li key={r.id}>
                  <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status}</Badge>{' '}
                  <strong>{r.reason}</strong>
                  {r.details ? `: ${r.details}` : ''} ·{' '}
                  <PlayerLink id={r.reporter.id} label={r.reporter.name ?? r.reporter.id.slice(0, 8)} /> ·{' '}
                  <span title={shortTime(r.createdAt)}>{relativeTime(r.createdAt, now())}</span>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Round JSON</summary>
            <pre className="adm-json">{JSON.stringify(d.round.definition, null, 2)}</pre>
          </details>
        </article>
      )}
    </StateBlock>
  );
}

/** The shared rounds list. */
export function SharedRoundsView(props: { code?: string | undefined }) {
  const { api, now } = useConsole();
  const [status, setStatus] = useState<'all' | SharedRoundRow['status']>('all');
  const [reported, setReported] = useState<'0' | '1'>('1');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const url = `/internal/custom-rounds${query({ status, reported, q: q.trim() || undefined, limit: PAGE, offset })}`;
  const state = useLoad(url, () =>
    api.request<{ rounds: SharedRoundRow[]; offset: number; limit: number }>('GET', url),
  );
  return (
    <section aria-labelledby="rounds-title">
      <header className="adm-view-head">
        <h1 id="rounds-title">Shared rounds</h1>
        <button type="button" className="adm-btn" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>
      {props.code ? <SharedRoundDetailView code={props.code} onChanged={state.reload} /> : null}
      <form className="adm-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter shared rounds">
        <label className="adm-field">
          <span>Show</span>
          <select
            value={reported}
            onChange={(e) => {
              setReported(e.target.value as '0' | '1');
              setOffset(0);
            }}
          >
            <option value="1">with open reports</option>
            <option value="0">all</option>
          </select>
        </label>
        <label className="adm-field">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setOffset(0);
            }}
          >
            <option value="all">any</option>
            <option value="published">shared</option>
            <option value="unpublished">hidden by owner</option>
            <option value="taken_down">taken down</option>
          </select>
        </label>
        <label className="adm-field">
          <span>Name or code</span>
          <input
            value={q}
            maxLength={64}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </label>
      </form>
      <StateBlock state={state} empty="No shared rounds match." isEmpty={(d) => d.rounds.length === 0}>
        {(d) => (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Code</th>
                    <th>Author</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Open reports</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rounds.map((r) => (
                    <tr key={r.code}>
                      <td>
                        <a href={`#/rounds/${r.code}`}>{r.name}</a>
                      </td>
                      <td>
                        <code>{r.code}</code>
                      </td>
                      <td>{r.author ?? '—'}</td>
                      <td>{r.type}</td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      </td>
                      <td>{r.openReports > 0 ? <Badge tone="warn">{r.openReports}</Badge> : 0}</td>
                      <td title={shortTime(r.updatedAt)}>{relativeTime(r.updatedAt, now())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={d.offset} limit={d.limit} count={d.rounds.length} onPage={setOffset} />
          </>
        )}
      </StateBlock>
    </section>
  );
}
