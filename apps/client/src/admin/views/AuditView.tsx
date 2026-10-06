/**
 * The audit log: every admin action from the console and the CLI, newest
 * first, filtered by kind or target and paged with "Load more".
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { Badge, errorMessage, useConsole } from '../components.tsx';
import { query, shortTime } from '../format.ts';
import type { AuditEntry, AuditPage } from '../types.ts';

const KINDS: [string, string][] = [
  ['', 'everything'],
  ['player.', 'players'],
  ['report.', 'reports'],
  ['flag.', 'flags'],
  ['playlist.', 'playlists'],
  ['maintenance.', 'maintenance'],
  ['news.', 'news'],
  ['staff.', 'staff'],
  ['refund.', 'refunds'],
  ['gift.', 'gifts'],
  ['session.', 'sign-ins'],
];

/**
 * One audit row.
 *
 * @param props.entry - The entry.
 */
export function AuditRow(props: { entry: AuditEntry }) {
  const e = props.entry;
  const target =
    e.targetType === 'user' && e.targetId ? (
      <a className="adm-link adm-mono" href={`#/players/${encodeURIComponent(e.targetId)}`}>
        {e.targetId.slice(0, 8)}…
      </a>
    ) : e.targetId ? (
      <span className="adm-mono">
        {e.targetType}:{e.targetId.length > 24 ? `${e.targetId.slice(0, 8)}…` : e.targetId}
      </span>
    ) : (
      (e.targetType ?? '—')
    );
  return (
    <tr>
      <td>{shortTime(e.createdAt)}</td>
      <td>
        {e.actorLabel} <Badge>{e.actorRole}</Badge>
      </td>
      <td className="adm-mono">{e.action}</td>
      <td>{target}</td>
      <td className="adm-col-wide">
        {e.reason ?? <span className="adm-muted">—</span>}
        {e.details && Object.keys(e.details).length > 0 && (
          <details>
            <summary>Details</summary>
            <pre className="adm-pre">{JSON.stringify(e.details, null, 2)}</pre>
          </details>
        )}
      </td>
    </tr>
  );
}

/** The audit list for one filter. */
export interface AuditState {
  /** The filter the rows belong to. */
  key: string;
  entries: AuditEntry[];
  next: number | null;
  loading: boolean;
  error: string | null;
}

/** What happens to the audit list; every answer names the filter it was asked for. */
export type AuditAction =
  | { type: 'load'; key: string }
  | { type: 'loaded'; key: string; page: AuditPage }
  | { type: 'more'; key: string }
  | { type: 'appended'; key: string; before: number; page: AuditPage }
  | { type: 'failed'; key: string; error: string };

/** The audit list before anything loaded. */
export const AUDIT_INITIAL: AuditState = { key: '', entries: [], next: null, loading: true, error: null };

/**
 * The audit list's state machine. A new filter clears the rows at once (no
 * old rows under the new filter, no Load more for the old cursor), and an
 * answer for another filter, or a page for a cursor already passed, is
 * dropped.
 *
 * @param s - Current state.
 * @param a - What happened.
 * @returns Next state.
 */
export function auditReducer(s: AuditState, a: AuditAction): AuditState {
  if (a.type === 'load')
    return a.key === s.key
      ? { ...s, loading: true, error: null }
      : { key: a.key, entries: [], next: null, loading: true, error: null };
  if (a.key !== s.key) return s;
  switch (a.type) {
    case 'loaded':
      return { ...s, entries: a.page.entries, next: a.page.nextBefore, loading: false };
    case 'more':
      return { ...s, loading: true, error: null };
    case 'appended':
      if (a.before !== s.next) return { ...s, loading: false };
      return { ...s, entries: [...s.entries, ...a.page.entries], next: a.page.nextBefore, loading: false };
    case 'failed':
      return { ...s, error: a.error, loading: false };
  }
}

/** The audit log view. */
export function AuditView(props: { target?: string | undefined }) {
  const { api } = useConsole();
  const [kind, setKind] = useState('');
  const [target, setTarget] = useState(props.target ?? '');
  const [tick, setTick] = useState(0);
  const base = { action: kind, targetId: target.trim() || undefined, limit: 50 };
  const key = query(base);
  const [state, dispatch] = useReducer(auditReducer, AUDIT_INITIAL);
  const { entries, next, loading, error } = state;
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    dispatch({ type: 'load', key });
    api.request<AuditPage>('GET', `/internal/audit${key}`).then(
      (page) => !ctl.signal.aborted && dispatch({ type: 'loaded', key, page }),
      (err: unknown) => !ctl.signal.aborted && dispatch({ type: 'failed', key, error: errorMessage(err) }),
    );
    return () => ctl.abort();
  }, [api, key, tick]);

  const more = async () => {
    if (next === null || loading) return;
    const before = next;
    dispatch({ type: 'more', key });
    try {
      const page = await api.request<AuditPage>('GET', `/internal/audit${query({ ...base, before })}`);
      dispatch({ type: 'appended', key, before, page });
    } catch (err) {
      dispatch({ type: 'failed', key, error: errorMessage(err) });
    }
  };

  return (
    <section aria-labelledby="audit-title">
      <header className="adm-view-head">
        <h1 id="audit-title">Audit log</h1>
        <button type="button" className="adm-btn" onClick={() => setTick((t) => t + 1)} disabled={loading}>
          Refresh
        </button>
      </header>
      <form className="adm-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter the audit log">
        <label className="adm-field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-field adm-field--grow">
          <span>Target id</span>
          <input
            value={target}
            spellCheck={false}
            placeholder="any"
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
      </form>
      {error && (
        <p className="adm-inline-error" role="alert">
          {error}
        </p>
      )}
      {entries.length === 0 ? (
        <div className="adm-state" role="status">
          {loading ? 'Loading…' : 'No admin actions match.'}
        </div>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <AuditRow key={e.id} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && (
        <div className="adm-pager">
          <button type="button" className="adm-btn" onClick={() => void more()} disabled={loading}>
            Load more
          </button>
        </div>
      )}
    </section>
  );
}
