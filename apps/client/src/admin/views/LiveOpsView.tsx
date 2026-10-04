/**
 * Live ops for admins: the maintenance window, feature flags, playlist
 * overrides and the most frequent client and server errors.
 */
import { FLAG_KEYS } from '@tumble/shared/liveops';
import { useState } from 'react';
import { Badge, StateBlock, useConsole, useLoad } from '../components.tsx';
import { fromLocalInput, isAdmin, query, relativeTime, shortTime, toLocalInput } from '../format.ts';
import type { ErrorGroup, FlagRow, MaintenanceView, PlaylistRow } from '../types.ts';

/** The `feature_flags` row that stores maintenance; edited through its own panel. */
const MAINTENANCE_KEY = 'maintenance';

/**
 * Every flag worth showing: the ones the code reads (on when never set) plus
 * any other stored keys.
 *
 * @param stored - Rows from `GET /internal/flags`.
 */
export function flagList(stored: readonly FlagRow[]): (FlagRow & { stored: boolean })[] {
  const out = new Map<string, FlagRow & { stored: boolean }>();
  for (const key of FLAG_KEYS)
    out.set(key, { key, enabled: true, rolloutPercent: 100, payload: null, updatedAt: '', stored: false });
  for (const f of stored) if (f.key !== MAINTENANCE_KEY) out.set(f.key, { ...f, stored: true });
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The live-ops view (admins only). */
export function LiveOpsView() {
  const { actor } = useConsole();
  if (!isAdmin(actor.role))
    return (
      <section>
        <h1>Live ops</h1>
        <div className="adm-state">Live ops need the admin role. Ask an admin to grant it.</div>
      </section>
    );
  return (
    <section aria-labelledby="liveops-title">
      <header className="adm-view-head">
        <h1 id="liveops-title">Live ops</h1>
      </header>
      <div className="adm-grid">
        <MaintenancePanel />
        <FlagsPanel />
        <PlaylistsPanel />
        <ErrorsPanel />
      </div>
    </section>
  );
}

function MaintenancePanel() {
  const { api, confirm, now } = useConsole();
  const state = useLoad('/status', () => api.request<{ maintenance: MaintenanceView }>('GET', '/status'));
  const [message, setMessage] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const startsIso = fromLocalInput(starts);
  const endsIso = fromLocalInput(ends);
  const valid = startsIso !== undefined && endsIso !== undefined;
  return (
    <section className="adm-card">
      <header>
        <h2>Maintenance</h2>
      </header>
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {({ maintenance: m }) => (
          <>
            <p>
              <Badge tone={m.phase === 'active' ? 'bad' : m.phase === 'scheduled' ? 'warn' : 'good'}>
                {m.phase}
              </Badge>{' '}
              {m.phase === 'scheduled' && `starts ${relativeTime(m.startsAt, now())}`}
              {m.phase === 'active' &&
                (m.endsAt ? `ends ${relativeTime(m.endsAt, now())}` : 'until turned off')}
            </p>
            {m.enabled && <p className="adm-quote">{m.message}</p>}
            <form
              className="adm-stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                confirm({
                  title: startsIso ? 'Schedule maintenance' : 'Start maintenance now',
                  body: startsIso
                    ? `Players see a countdown until ${shortTime(startsIso)}; then queues close.`
                    : 'Queues close at once. Running shows finish; the menu shows your message.',
                  confirmLabel: startsIso ? 'Schedule' : 'Start now',
                  danger: !startsIso,
                  reason: 'none',
                  run: async () => {
                    await api.request('PUT', '/internal/maintenance', {
                      enabled: true,
                      startsAt: startsIso,
                      endsAt: endsIso,
                      ...(message.trim() ? { message: message.trim() } : {}),
                    });
                    state.reload();
                  },
                  done: 'Maintenance set',
                });
              }}
            >
              <label className="adm-field">
                <span>Message to players</span>
                <input
                  value={message}
                  maxLength={500}
                  placeholder={m.message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className="adm-inline-form">
                <label className="adm-field">
                  <span>Starts (empty = now)</span>
                  <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
                </label>
                <label className="adm-field">
                  <span>Ends (empty = until turned off)</span>
                  <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
                </label>
              </div>
              <div className="adm-actions">
                <button type="submit" className="adm-btn adm-btn--primary" disabled={!valid}>
                  {startsIso ? 'Schedule…' : 'Start now…'}
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  disabled={!m.enabled}
                  onClick={() =>
                    confirm({
                      title: 'End maintenance',
                      body: 'Queues open again at once.',
                      confirmLabel: 'End maintenance',
                      reason: 'none',
                      run: async () => {
                        await api.request('DELETE', '/internal/maintenance');
                        state.reload();
                      },
                      done: 'Maintenance ended',
                    })
                  }
                >
                  End now…
                </button>
              </div>
            </form>
          </>
        )}
      </StateBlock>
    </section>
  );
}

function FlagsPanel() {
  const { api, confirm } = useConsole();
  const state = useLoad('/internal/flags', () => api.request<{ flags: FlagRow[] }>('GET', '/internal/flags'));
  return (
    <section className="adm-card">
      <header>
        <h2>Feature flags</h2>
      </header>
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {(d) => (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Flag</th>
                  <th>State</th>
                  <th>Rollout</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {flagList(d.flags).map((f) => (
                  <tr key={f.key}>
                    <td className="adm-mono">{f.key}</td>
                    <td>
                      <Badge tone={f.enabled ? 'good' : 'bad'}>{f.enabled ? 'on' : 'off'}</Badge>
                      {!f.stored && <span className="adm-muted"> (default)</span>}
                    </td>
                    <td>{f.rolloutPercent}%</td>
                    <td>
                      <button
                        type="button"
                        className={`adm-btn adm-btn--small ${f.enabled ? 'adm-btn--danger' : ''}`}
                        aria-label={`Turn ${f.key} ${f.enabled ? 'off' : 'on'}`}
                        onClick={() =>
                          confirm({
                            title: `Turn ${f.key} ${f.enabled ? 'off' : 'on'}`,
                            body: 'Every server and client picks this up within a minute or so.',
                            confirmLabel: f.enabled ? 'Turn off' : 'Turn on',
                            danger: f.enabled,
                            reason: 'none',
                            run: async () => {
                              await api.request('PUT', `/internal/flags/${encodeURIComponent(f.key)}`, {
                                enabled: !f.enabled,
                                rolloutPercent: f.rolloutPercent,
                                ...(f.payload !== null && f.payload !== undefined
                                  ? { payload: f.payload }
                                  : {}),
                              });
                              state.reload();
                            },
                            done: `${f.key} ${f.enabled ? 'off' : 'on'}`,
                          })
                        }
                      >
                        {f.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                    </td>
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

function PlaylistsPanel() {
  const { api, confirm } = useConsole();
  const state = useLoad('/internal/playlists', () =>
    api.request<{ playlists: PlaylistRow[] }>('GET', '/internal/playlists'),
  );
  const [editing, setEditing] = useState<{ id: string; starts: string; ends: string } | null>(null);
  const put = (id: string, body: Record<string, unknown>, title: string) =>
    confirm({
      title,
      body: 'Changes the live schedule; the matchmaker checks it on every queue.',
      confirmLabel: 'Apply',
      reason: 'none',
      run: async () => {
        await api.request('PUT', `/internal/playlists/${encodeURIComponent(id)}`, body);
        setEditing(null);
        state.reload();
      },
      done: 'Playlist updated',
    });
  return (
    <section className="adm-card adm-card--wide">
      <header>
        <h2>Playlists</h2>
      </header>
      <StateBlock state={state} empty="No playlists." isEmpty={(d) => d.playlists.length === 0}>
        {(d) => (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Playlist</th>
                  <th>Phase</th>
                  <th>Window</th>
                  <th>Flags</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {d.playlists.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name ?? p.id}
                      <div className="adm-sub adm-mono">{p.id}</div>
                    </td>
                    <td>
                      <Badge tone={p.phase === 'live' ? 'good' : 'neutral'}>{p.phase}</Badge>
                    </td>
                    <td>
                      {editing?.id === p.id ? (
                        <form
                          className="adm-inline-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const startsAt = fromLocalInput(editing.starts);
                            const endsAt = fromLocalInput(editing.ends);
                            if (startsAt === undefined || endsAt === undefined) return;
                            put(p.id, { startsAt, endsAt }, `Set the live window of ${p.id}`);
                          }}
                        >
                          <label className="adm-field">
                            <span>From</span>
                            <input
                              type="datetime-local"
                              value={editing.starts}
                              onChange={(e) => setEditing({ ...editing, starts: e.target.value })}
                            />
                          </label>
                          <label className="adm-field">
                            <span>Until</span>
                            <input
                              type="datetime-local"
                              value={editing.ends}
                              onChange={(e) => setEditing({ ...editing, ends: e.target.value })}
                            />
                          </label>
                          <button type="submit" className="adm-btn adm-btn--small adm-btn--primary">
                            Save…
                          </button>
                          <button
                            type="button"
                            className="adm-btn adm-btn--small"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          {shortTime(p.startsAt)} → {shortTime(p.endsAt)}{' '}
                          <button
                            type="button"
                            className="adm-btn adm-btn--small adm-btn--ghost"
                            onClick={() =>
                              setEditing({
                                id: p.id,
                                starts: toLocalInput(p.startsAt),
                                ends: toLocalInput(p.endsAt),
                              })
                            }
                          >
                            Edit
                          </button>
                        </>
                      )}
                    </td>
                    <td>
                      {p.featured && <Badge tone="info">featured</Badge>}{' '}
                      {p.hidden && <Badge tone="bad">hidden</Badge>} {p.overridden && <Badge>override</Badge>}
                    </td>
                    <td className="adm-actions">
                      <button
                        type="button"
                        className="adm-btn adm-btn--small"
                        onClick={() =>
                          put(
                            p.id,
                            { featured: !p.featured },
                            `${p.featured ? 'Unfeature' : 'Feature'} ${p.id}`,
                          )
                        }
                      >
                        {p.featured ? 'Unfeature' : 'Feature'}
                      </button>
                      <button
                        type="button"
                        className={`adm-btn adm-btn--small ${p.hidden ? '' : 'adm-btn--danger'}`}
                        onClick={() =>
                          put(p.id, { hidden: !p.hidden }, `${p.hidden ? 'Show' : 'Hide'} ${p.id}`)
                        }
                      >
                        {p.hidden ? 'Show' : 'Hide'}
                      </button>
                      {p.overridden && (
                        <button
                          type="button"
                          className="adm-btn adm-btn--small adm-btn--ghost"
                          onClick={() =>
                            confirm({
                              title: `Reset ${p.id}`,
                              body: 'Drops the override; the schedule shipped with the game applies again.',
                              confirmLabel: 'Reset',
                              reason: 'none',
                              run: async () => {
                                await api.request(
                                  'DELETE',
                                  `/internal/playlists/${encodeURIComponent(p.id)}`,
                                );
                                state.reload();
                              },
                              done: 'Playlist reset',
                            })
                          }
                        >
                          Reset
                        </button>
                      )}
                    </td>
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

function ErrorsPanel() {
  const { api, now } = useConsole();
  const [source, setSource] = useState<'client' | 'server'>('client');
  const [hours, setHours] = useState(24);
  const url = `/internal/errors/top${query({ source, hours, limit: 25 })}`;
  const state = useLoad(url, () => api.request<{ errors: ErrorGroup[] }>('GET', url));
  return (
    <section className="adm-card adm-card--wide">
      <header>
        <h2>Top errors</h2>
        <div className="adm-inline-form">
          <label className="adm-field">
            <span>Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value as 'client' | 'server')}>
              <option value="client">browsers</option>
              <option value="server">servers</option>
            </select>
          </label>
          <label className="adm-field">
            <span>Window</span>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={1}>1 hour</option>
              <option value={24}>24 hours</option>
              <option value={168}>7 days</option>
            </select>
          </label>
        </div>
      </header>
      <StateBlock state={state} empty="No errors in this window." isEmpty={(d) => d.errors.length === 0}>
        {(d) => (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Count</th>
                  <th>Error</th>
                  <th>{source === 'client' ? 'Players' : 'Services'}</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {d.errors.map((e, i) => (
                  <tr key={i}>
                    <td>{e.occurrences}</td>
                    <td className="adm-col-wide">
                      <strong>{e.type}</strong>: {e.message}
                      {e.sampleStack && (
                        <details>
                          <summary>Stack</summary>
                          <pre className="adm-pre">{e.sampleStack}</pre>
                        </details>
                      )}
                    </td>
                    <td>{source === 'client' ? e.players : (e.services ?? '—')}</td>
                    <td title={shortTime(e.lastSeen)}>{relativeTime(e.lastSeen, now())}</td>
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
