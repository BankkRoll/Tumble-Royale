/**
 * Bans and mutes across all players, with expiry and lifting.
 */
import { useState } from 'react';
import { Badge, Pager, PlayerLink, StateBlock, useConsole, useLoad } from '../components.tsx';
import { banState, query, relativeTime, SCOPE_LABELS, shortTime } from '../format.ts';
import type { BanRow } from '../types.ts';

const PAGE = 50;

/** The sanctions list. */
export function SanctionsView() {
  const { api, confirm, now } = useConsole();
  const [active, setActive] = useState<'1' | 'expired' | '0'>('1');
  const [scope, setScope] = useState('');
  const [offset, setOffset] = useState(0);
  const url = `/internal/bans${query({ active, scope, limit: PAGE, offset })}`;
  const state = useLoad(url, () =>
    api.request<{ bans: BanRow[]; offset: number; limit: number }>('GET', url),
  );

  return (
    <section aria-labelledby="sanctions-title">
      <header className="adm-view-head">
        <h1 id="sanctions-title">Sanctions</h1>
        <button type="button" className="adm-btn" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>
      <form className="adm-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter sanctions">
        <label className="adm-field">
          <span>State</span>
          <select
            value={active}
            onChange={(e) => {
              setActive(e.target.value as typeof active);
              setOffset(0);
            }}
          >
            <option value="1">active</option>
            <option value="expired">expired or lifted</option>
            <option value="0">all</option>
          </select>
        </label>
        <label className="adm-field">
          <span>Kind</span>
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">any</option>
            <option value="all">suspensions</option>
            <option value="chat">mutes</option>
            <option value="ranked">ranked bans</option>
          </select>
        </label>
      </form>
      <StateBlock state={state} empty="No sanctions match." isEmpty={(d) => d.bans.length === 0}>
        {(d) => (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Kind</th>
                    <th>Reason</th>
                    <th>Since</th>
                    <th>Ends</th>
                    <th>State</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {d.bans.map((b) => {
                    const st = banState(b, now());
                    const who = b.displayName ? `${b.displayName}#${b.tag}` : b.userId.slice(0, 8);
                    return (
                      <tr key={b.id}>
                        <td>
                          <PlayerLink id={b.userId} label={who} />
                        </td>
                        <td>
                          <Badge tone={b.scope === 'all' ? 'bad' : 'warn'}>
                            {SCOPE_LABELS[b.scope] ?? b.scope}
                          </Badge>
                        </td>
                        <td>{b.reason}</td>
                        <td title={shortTime(b.createdAt)}>{relativeTime(b.createdAt, now())}</td>
                        <td title={shortTime(b.expiresAt)}>
                          {b.expiresAt ? relativeTime(b.expiresAt, now()) : 'Permanent'}
                        </td>
                        <td>
                          <Badge tone={st === 'active' ? 'bad' : 'neutral'}>{st}</Badge>
                        </td>
                        <td>
                          {st === 'active' && (
                            <button
                              type="button"
                              className="adm-btn adm-btn--small"
                              onClick={() =>
                                confirm({
                                  title: `Lift ${SCOPE_LABELS[b.scope] ?? b.scope} on ${who}`,
                                  body: 'Takes effect on every server at once.',
                                  confirmLabel: 'Lift',
                                  run: async (reason) => {
                                    await api.request('DELETE', `/internal/bans/${b.id}`, { reason });
                                    state.reload();
                                  },
                                  done: 'Lifted',
                                })
                              }
                            >
                              Lift
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager offset={d.offset} limit={d.limit} count={d.bans.length} onPage={setOffset} />
          </>
        )}
      </StateBlock>
    </section>
  );
}
