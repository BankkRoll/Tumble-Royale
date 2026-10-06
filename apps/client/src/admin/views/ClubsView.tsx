/**
 * Clubs: search and the reported-first list, and the page of one club with
 * its roster, chat evidence, reports and audit trail, plus the moderation
 * actions (rename, reset to a safe name, clear the description, reset the
 * emblem, disband). Every action asks for a reason, which the audit log keeps.
 */
import { useState, type FormEvent } from 'react';
import { Badge, PlayerLink, StateBlock, useConsole, useLoad, type ActionRequest } from '../components.tsx';
import { query, relativeTime, shortTime } from '../format.ts';
import type { ClubDetail, ClubListRow } from '../types.ts';

/** Human names for club report reasons. */
export const CLUB_REASON_LABELS: Record<string, string> = {
  name: 'Name or tag',
  description: 'Description',
  emblem: 'Emblem',
  chat: 'Club chat',
  other: 'Other',
};

/** The club list, or one club's page. */
export function ClubsView(props: { id?: string | undefined; q?: string | undefined }) {
  return props.id ? <ClubPage id={props.id} /> : <ClubList q={props.q ?? ''} />;
}

function ClubLink(props: { id: string; label: string }) {
  return (
    <a className="adm-link" href={`#/clubs/${encodeURIComponent(props.id)}`}>
      {props.label}
    </a>
  );
}

function ClubList(props: { q: string }) {
  const { api, go, now } = useConsole();
  const [text, setText] = useState(props.q);
  const [status, setStatus] = useState<'live' | 'disbanded' | 'all'>('live');
  const url = `/internal/clubs${query({ q: props.q.trim(), status, reported: '1' })}`;
  const state = useLoad(url, () => api.request<{ clubs: ClubListRow[] }>('GET', url));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(`#/clubs${query({ q: text.trim() })}`);
  };
  return (
    <section aria-labelledby="clubs-title">
      <header className="adm-view-head">
        <h1 id="clubs-title">Clubs</h1>
        <button type="button" className="adm-btn" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>
      <form className="adm-filters" role="search" onSubmit={submit}>
        <label className="adm-field adm-field--grow">
          <span>Club name, tag or id</span>
          <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </label>
        <label className="adm-field">
          <span>State</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="live">live</option>
            <option value="disbanded">disbanded</option>
            <option value="all">all</option>
          </select>
        </label>
        <button type="submit" className="adm-btn adm-btn--primary">
          Search
        </button>
      </form>
      <StateBlock state={state} empty="No clubs match." isEmpty={(d) => d.clubs.length === 0}>
        {(d) => (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Members</th>
                  <th>Join</th>
                  <th>Last activity</th>
                  <th>Open reports</th>
                </tr>
              </thead>
              <tbody>
                {d.clubs.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <ClubLink id={c.id} label={`${c.name} [${c.tag}]`} />
                      {c.disbandedAt && <Badge>disbanded</Badge>}
                    </td>
                    <td>
                      {c.memberCount}/{c.maxMembers}
                    </td>
                    <td>{c.joinMode}</td>
                    <td title={shortTime(c.lastActivityAt)}>{relativeTime(c.lastActivityAt, now())}</td>
                    <td>{c.openReports > 0 ? <Badge tone="warn">{c.openReports}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StateBlock>
    </section>
  );
}

/**
 * The moderation actions offered for one club.
 *
 * @param label - `Name [TAG]` for the dialog text.
 * @param id - Club id.
 * @param send - Performs a request.
 * @param reload - Refreshes the page afterwards.
 * @param rename - Name and tag typed into the rename form.
 * @returns One {@link ActionRequest} per button.
 */
export function clubActions(
  label: string,
  id: string,
  send: (method: 'POST', path: string, body: unknown) => Promise<unknown>,
  reload: () => void,
  rename: { name: string; tag: string },
): Record<'rename' | 'resetName' | 'clearDescription' | 'resetEmblem' | 'disband', ActionRequest> {
  const post = (path: string, body: Record<string, unknown>) => async (reason: string) => {
    await send('POST', `/internal/clubs/${id}/${path}`, { ...body, reason });
    reload();
  };
  return {
    rename: {
      title: `Rename ${label}`,
      body: `New name: ${rename.name}${rename.tag ? ` [${rename.tag.toUpperCase()}]` : ''}. Members see it at once.`,
      confirmLabel: 'Rename',
      run: post('rename', { name: rename.name, ...(rename.tag ? { tag: rename.tag } : {}) }),
      done: 'Club renamed',
    },
    resetName: {
      title: `Reset ${label}'s name`,
      body: 'Replaces the name and tag with a generated, neutral pair. The old ones stay in the audit log.',
      confirmLabel: 'Reset name',
      danger: true,
      run: post('reset-name', {}),
      done: 'Name reset',
    },
    clearDescription: {
      title: `Clear ${label}'s description`,
      body: 'Removes the description. Officers can write a new one.',
      confirmLabel: 'Clear',
      run: post('clear-description', {}),
      done: 'Description cleared',
    },
    resetEmblem: {
      title: `Reset ${label}'s emblem`,
      body: 'Puts the default emblem back.',
      confirmLabel: 'Reset emblem',
      run: post('reset-emblem', {}),
      done: 'Emblem reset',
    },
    disband: {
      title: `Disband ${label}`,
      body: 'Removes every member and frees the name. The chat and reports stay here for the record.',
      confirmLabel: 'Disband',
      danger: true,
      run: post('disband', {}),
      done: 'Club disbanded',
    },
  };
}

function ClubPage(props: { id: string }) {
  const { api, confirm, now } = useConsole();
  const url = `/internal/clubs/${encodeURIComponent(props.id)}`;
  const state = useLoad(url, () => api.request<ClubDetail>('GET', url));
  const [rename, setRename] = useState({ name: '', tag: '' });
  const send = (method: 'POST', path: string, body: unknown) => api.request(method, path, body);
  const decide = (reportId: string, action: 'resolve' | 'dismiss') =>
    confirm({
      title: action === 'resolve' ? 'Resolve this report' : 'Dismiss this report',
      body: 'Closes the report; the reason goes in the audit log.',
      confirmLabel: action === 'resolve' ? 'Resolve' : 'Dismiss',
      run: async (reason) => {
        await api.request('POST', '/internal/club-reports/action', { reportIds: [reportId], action, reason });
        state.reload();
      },
      done: 'Report closed',
    });
  return (
    <section aria-labelledby="club-title">
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {(d) => {
          const c = d.club;
          const label = `${c.name} [${c.tag}]`;
          const actions = clubActions(label, c.id, send, state.reload, rename);
          const live = !c.disbandedAt;
          return (
            <>
              <header className="adm-view-head">
                <div>
                  <h1 id="club-title">{label}</h1>
                  <div className="adm-sub adm-mono">{c.id}</div>
                </div>
                {live && (
                  <div className="adm-actions" role="toolbar" aria-label="Club actions">
                    <button type="button" className="adm-btn" onClick={() => confirm(actions.resetName)}>
                      Reset name
                    </button>
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => confirm(actions.clearDescription)}
                    >
                      Clear description
                    </button>
                    <button type="button" className="adm-btn" onClick={() => confirm(actions.resetEmblem)}>
                      Reset emblem
                    </button>
                    <button
                      type="button"
                      className="adm-btn adm-btn--danger"
                      onClick={() => confirm(actions.disband)}
                    >
                      Disband…
                    </button>
                  </div>
                )}
              </header>
              <div className="adm-grid">
                <section className="adm-card">
                  <header>
                    <h2>Club</h2>
                  </header>
                  <dl className="adm-facts">
                    <div>
                      <dt>Description</dt>
                      <dd>{c.description || '—'}</dd>
                    </div>
                    <div>
                      <dt>Join mode</dt>
                      <dd>{c.joinMode}</dd>
                    </div>
                    <div>
                      <dt>Members</dt>
                      <dd>
                        {c.memberCount}/{c.maxMembers}
                      </dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd title={shortTime(c.createdAt)}>{relativeTime(c.createdAt, now())}</dd>
                    </div>
                    <div>
                      <dt>State</dt>
                      <dd>
                        {live ? (
                          <Badge tone="good">live</Badge>
                        ) : (
                          <>
                            <Badge>disbanded</Badge> {c.disbandReason}
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {live && (
                    <form
                      className="adm-filters"
                      aria-label="Rename club"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (rename.name.trim()) confirm(actions.rename);
                      }}
                    >
                      <label className="adm-field adm-field--grow">
                        <span>New name</span>
                        <input
                          value={rename.name}
                          maxLength={24}
                          onChange={(e) => setRename({ ...rename, name: e.target.value })}
                        />
                      </label>
                      <label className="adm-field">
                        <span>New tag (optional)</span>
                        <input
                          value={rename.tag}
                          maxLength={5}
                          onChange={(e) => setRename({ ...rename, tag: e.target.value })}
                        />
                      </label>
                      <button type="submit" className="adm-btn" disabled={!rename.name.trim()}>
                        Rename…
                      </button>
                    </form>
                  )}
                </section>
                <section className="adm-card">
                  <header>
                    <h2>Members ({d.members.length})</h2>
                  </header>
                  {d.members.length === 0 ? (
                    <p className="adm-muted">No members.</p>
                  ) : (
                    <ul className="adm-list">
                      {d.members.map((m) => (
                        <li key={m.userId}>
                          <PlayerLink id={m.userId} label={`${m.displayName}#${m.tag}`} />{' '}
                          <Badge>{m.role}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="adm-card adm-card--wide">
                  <header>
                    <h2>Reports ({d.reports.length})</h2>
                  </header>
                  {d.reports.length === 0 ? (
                    <p className="adm-muted">No reports.</p>
                  ) : (
                    <ul className="adm-list">
                      {d.reports.map((r) => (
                        <li key={r.id}>
                          <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status}</Badge>{' '}
                          <strong>{CLUB_REASON_LABELS[r.reason] ?? r.reason}</strong> by{' '}
                          <PlayerLink
                            id={r.reporterId}
                            label={
                              r.reporterName ? `${r.reporterName}#${r.reporterTag}` : r.reporterId.slice(0, 8)
                            }
                          />{' '}
                          <span className="adm-muted">{relativeTime(r.createdAt, now())}</span>
                          {r.details && <div>“{r.details}”</div>}
                          <div className="adm-sub">
                            When reported: {r.snapshot.name} [{r.snapshot.tag}] —{' '}
                            {r.snapshot.description || 'no description'}
                          </div>
                          {r.evidence && (
                            <ol className="adm-evidence" aria-label="Chat when reported">
                              {r.evidence.map((l) => (
                                <li key={l.id}>
                                  <strong>{l.from.name}</strong>: {l.text}
                                </li>
                              ))}
                            </ol>
                          )}
                          {r.status === 'open' && (
                            <div className="adm-actions">
                              <button
                                type="button"
                                className="adm-btn adm-btn--small"
                                onClick={() => decide(r.id, 'resolve')}
                              >
                                Resolve
                              </button>
                              <button
                                type="button"
                                className="adm-btn adm-btn--small"
                                onClick={() => decide(r.id, 'dismiss')}
                              >
                                Dismiss
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="adm-card adm-card--wide">
                  <header>
                    <h2>Recent chat ({d.chat.length})</h2>
                  </header>
                  {d.chat.length === 0 ? (
                    <p className="adm-muted">No chat kept (lines older than 30 days are deleted).</p>
                  ) : (
                    <ol className="adm-evidence" aria-label="Club chat">
                      {d.chat.map((l) => (
                        <li key={l.id}>
                          <span className="adm-muted">{shortTime(new Date(l.at).toISOString())}</span>{' '}
                          <PlayerLink id={l.from.userId} label={`${l.from.name}#${l.from.tag}`} />: {l.text}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <section className="adm-card adm-card--wide">
                  <header>
                    <h2>Audit</h2>
                  </header>
                  {d.audit.length === 0 ? (
                    <p className="adm-muted">No console actions yet.</p>
                  ) : (
                    <ul className="adm-list">
                      {d.audit.map((a) => (
                        <li key={a.id}>
                          {shortTime(a.createdAt)} <strong>{a.action}</strong> by {a.actorLabel}
                          {a.reason ? ` — ${a.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </>
          );
        }}
      </StateBlock>
    </section>
  );
}
