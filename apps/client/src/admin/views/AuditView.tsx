/**
 * The audit log: every admin action from the console and the CLI, newest
 * first, filtered by kind or target and paged with "Load more".
 */
import { useEffect, useState } from 'react';
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

/** The audit log view. */
export function AuditView(props: { target?: string | undefined }) {
  const { api } = useConsole();
  const [kind, setKind] = useState('');
  const [target, setTarget] = useState(props.target ?? '');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const base = { action: kind, targetId: target.trim() || undefined, limit: 50 };

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .request<AuditPage>(
        'GET',
        `/internal/audit${query({ action: kind, targetId: target.trim() || undefined, limit: 50 })}`,
      )
      .then(
        (p) => {
          if (!live) return;
          setEntries(p.entries);
          setNext(p.nextBefore);
          setLoading(false);
        },
        (err: unknown) => {
          if (!live) return;
          setError(errorMessage(err));
          setLoading(false);
        },
      );
    return () => {
      live = false;
    };
  }, [api, kind, target, tick]);

  const more = async () => {
    if (next === null) return;
    setLoading(true);
    try {
      const p = await api.request<AuditPage>('GET', `/internal/audit${query({ ...base, before: next })}`);
      setEntries((e) => [...e, ...p.entries]);
      setNext(p.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    }
    setLoading(false);
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
