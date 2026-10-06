/**
 * Player lookup and the player page: account summary, balances, reports,
 * sanctions, warnings, name history, gifts (`GiftsCard.tsx`) and the
 * moderation actions on one player.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge, PlayerLink, StateBlock, useConsole, useLoad, type ActionRequest } from '../components.tsx';
import {
  BAN_DURATIONS,
  banState,
  isAdmin,
  MUTE_DURATIONS,
  REASON_LABELS,
  relativeTime,
  SCOPE_LABELS,
  shortTime,
} from '../format.ts';
import type { LookupUser, PlayerSummary } from '../types.ts';
import { PlayerGiftsCard } from './GiftsCard.tsx';

/** Player lookup with results, or the page of one player. */
export function PlayersView(props: { id?: string | undefined; q?: string | undefined }) {
  return props.id ? <PlayerPage id={props.id} /> : <PlayerSearch q={props.q ?? ''} />;
}

function PlayerSearch(props: { q: string }) {
  const { api, go, now } = useConsole();
  const [text, setText] = useState(props.q);
  const q = props.q.trim();
  const url = q ? `/internal/users/lookup?q=${encodeURIComponent(q)}` : null;
  const state = useLoad(url, () => api.request<{ users: LookupUser[] }>('GET', url!));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(`#/players?q=${encodeURIComponent(text.trim())}`);
  };
  return (
    <section aria-labelledby="players-title">
      <header className="adm-view-head">
        <h1 id="players-title">Players</h1>
      </header>
      <form className="adm-filters" role="search" onSubmit={submit}>
        <label className="adm-field adm-field--grow">
          <span>Account id, Name#1234 (friend code), email, or the start of a name</span>
          <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus />
        </label>
        <button type="submit" className="adm-btn adm-btn--primary" disabled={!text.trim()}>
          Search
        </button>
      </form>
      {url ? (
        <StateBlock state={state} empty={`No account matches “${q}”.`} isEmpty={(d) => d.users.length === 0}>
          {(d) => (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Account</th>
                    <th>Level</th>
                    <th>Last seen</th>
                    <th>Sanctions</th>
                  </tr>
                </thead>
                <tbody>
                  {d.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <PlayerLink id={u.id} label={`${u.displayName}#${u.tag}`} />
                        <div className="adm-sub adm-mono">{u.id}</div>
                      </td>
                      <td>
                        {u.isGuest ? (
                          <Badge>guest</Badge>
                        ) : (
                          <Badge tone="info">{u.providers.join(', ')}</Badge>
                        )}
                      </td>
                      <td>{u.level}</td>
                      <td title={shortTime(u.lastSeenAt)}>{relativeTime(u.lastSeenAt, now())}</td>
                      <td>
                        {u.bans
                          .filter((b) => banState(b, now()) === 'active')
                          .map((b) => (
                            <Badge key={b.id} tone="bad">
                              {SCOPE_LABELS[b.scope] ?? b.scope}
                            </Badge>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </StateBlock>
      ) : (
        <div className="adm-state">Search for a player to see their account.</div>
      )}
    </section>
  );
}

function Card(props: { title: string; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  return (
    <section className={`adm-card${props.wide ? ' adm-card--wide' : ''}`}>
      <header>
        <h2>{props.title}</h2>
        {props.actions}
      </header>
      {props.children}
    </section>
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
 * The moderation actions offered for one player.
 *
 * @param name - `name#tag` for the dialog text.
 * @param id - Account id.
 * @param send - Performs a request.
 * @param reload - Refreshes the page afterwards.
 * @returns One {@link ActionRequest} per button.
 */
export function playerActions(
  name: string,
  id: string,
  send: (method: 'POST', path: string, body: unknown) => Promise<unknown>,
  reload: () => void,
): Record<'warn' | 'mute' | 'suspend' | 'resetName', ActionRequest> {
  const after = async (p: Promise<unknown>) => {
    await p;
    reload();
  };
  return {
    warn: {
      title: `Warn ${name}`,
      body: 'Records a warning on the account and shows the player your reason.',
      confirmLabel: 'Warn',
      run: (reason) => after(send('POST', `/internal/users/${id}/warn`, { reason })),
      done: 'Warning sent',
    },
    mute: {
      title: `Mute ${name}`,
      body: 'Turns off global chat, party chat and whispers for this player at once, on every server.',
      confirmLabel: 'Mute',
      danger: true,
      durations: MUTE_DURATIONS,
      run: (reason, hours) =>
        after(
          send('POST', '/internal/bans', {
            userId: id,
            scope: 'chat',
            reason,
            durationHours: hours ?? undefined,
          }),
        ),
      done: 'Player muted',
    },
    suspend: {
      title: `Suspend ${name}`,
      body: 'Signs the player out of the game and every service immediately. They cannot play until it ends or is lifted.',
      confirmLabel: 'Suspend',
      danger: true,
      durations: BAN_DURATIONS,
      run: (reason, hours) =>
        after(
          send('POST', '/internal/bans', {
            userId: id,
            scope: 'all',
            reason,
            ...(hours ? { durationHours: hours } : {}),
          }),
        ),
      done: 'Player suspended',
    },
    resetName: {
      title: `Reset ${name}'s name`,
      body: 'Replaces the display name with a generated, safe one. The old name stays in the name history.',
      confirmLabel: 'Reset name',
      danger: true,
      run: (reason) => after(send('POST', `/internal/users/${id}/reset-name`, { reason })),
      done: 'Name reset',
    },
  };
}

function PlayerPage(props: { id: string }) {
  const { api, actor, confirm, now } = useConsole();
  const url = `/internal/users/${encodeURIComponent(props.id)}`;
  const state = useLoad(url, () => api.request<PlayerSummary>('GET', url));
  const [newName, setNewName] = useState('');
  const [currency, setCurrency] = useState<'gumballs' | 'gems' | 'crown_shards'>('gems');
  const [delta, setDelta] = useState('');
  const admin = isAdmin(actor.role);
  const send = (method: 'POST' | 'DELETE', path: string, body: unknown) => api.request(method, path, body);

  return (
    <section aria-labelledby="player-title">
      <StateBlock state={state} empty="" isEmpty={() => false}>
        {(p) => {
          const a = p.account;
          const name = `${a.displayName}#${a.tag}`;
          const actions = playerActions(name, a.id, send, state.reload);
          const activeBans = p.bans.filter((b) => b.active);
          const deltaNum = Number(delta);
          return (
            <>
              <header className="adm-view-head">
                <div>
                  <h1 id="player-title">{name}</h1>
                  <div className="adm-sub adm-mono">{a.id}</div>
                </div>
                <div className="adm-actions" role="toolbar" aria-label="Player actions">
                  <button type="button" className="adm-btn" onClick={() => confirm(actions.warn)}>
                    Warn
                  </button>
                  <button
                    type="button"
                    className="adm-btn adm-btn--danger"
                    onClick={() => confirm(actions.mute)}
                  >
                    Mute…
                  </button>
                  <button
                    type="button"
                    className="adm-btn adm-btn--danger"
                    onClick={() => confirm(actions.suspend)}
                  >
                    Suspend…
                  </button>
                  <button type="button" className="adm-btn" onClick={() => confirm(actions.resetName)}>
                    Reset name
                  </button>
                </div>
              </header>
              <div className="adm-grid">
                <Card title="Account">
                  <Facts
                    rows={[
                      ['Type', a.isGuest ? <Badge>guest</Badge> : <Badge tone="info">full account</Badge>],
                      ['Sign-in', a.providers.join(', ') || '—'],
                      ['Email', a.email ?? '—'],
                      ['Region', a.region],
                      [
                        'Created',
                        <span title={shortTime(a.createdAt)}>{relativeTime(a.createdAt, now())}</span>,
                      ],
                      [
                        'Last seen',
                        <span title={shortTime(a.lastSeenAt)}>{relativeTime(a.lastSeenAt, now())}</span>,
                      ],
                      ['Level', `${a.level} (${a.crowns} crowns)`],
                      [
                        'Shows',
                        p.stats
                          ? `${p.stats.showsPlayed} played, ${p.stats.wins} won`
                          : `${p.matches.total} recorded`,
                      ],
                      ['Staff', a.staffRole ?? '—'],
                    ]}
                  />
                </Card>
                <Card title="Sanctions">
                  {activeBans.length === 0 ? (
                    <p className="adm-muted">No active sanctions.</p>
                  ) : (
                    <ul className="adm-list">
                      {activeBans.map((b) => (
                        <li key={b.id}>
                          <Badge tone="bad">{SCOPE_LABELS[b.scope] ?? b.scope}</Badge>{' '}
                          {b.expiresAt ? `until ${shortTime(b.expiresAt)}` : 'permanent'} — {b.reason}{' '}
                          <button
                            type="button"
                            className="adm-btn adm-btn--small"
                            onClick={() =>
                              confirm({
                                title: `Lift ${SCOPE_LABELS[b.scope] ?? b.scope} on ${name}`,
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
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Warnings ({p.warnings.length})</h3>
                  {p.warnings.length === 0 ? (
                    <p className="adm-muted">None.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.warnings.map((w) => (
                        <li key={w.id}>
                          {shortTime(w.createdAt)} — {w.reason}{' '}
                          <span className="adm-muted">by {w.issuedBy}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>History</h3>
                  {p.bans.length === activeBans.length ? (
                    <p className="adm-muted">Nothing earlier.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.bans
                        .filter((b) => !b.active)
                        .map((b) => (
                          <li key={b.id}>
                            <Badge>{SCOPE_LABELS[b.scope] ?? b.scope}</Badge> {shortTime(b.createdAt)} —{' '}
                            {b.reason} <span className="adm-muted">({banState(b, now())})</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </Card>
                <Card title="Name">
                  <form
                    className="adm-inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const displayName = newName.trim();
                      if (!displayName) return;
                      confirm({
                        title: `Rename ${name}`,
                        body: `New name: ${displayName}`,
                        confirmLabel: 'Rename',
                        reason: 'optional',
                        run: async (reason) => {
                          await api.request('POST', `/internal/users/${a.id}/rename`, {
                            displayName,
                            ...(reason ? { reason } : {}),
                          });
                          setNewName('');
                          state.reload();
                        },
                        done: 'Renamed',
                      });
                    }}
                  >
                    <label className="adm-field adm-field--grow">
                      <span>New display name</span>
                      <input value={newName} maxLength={16} onChange={(e) => setNewName(e.target.value)} />
                    </label>
                    <button type="submit" className="adm-btn" disabled={!newName.trim()}>
                      Rename…
                    </button>
                  </form>
                  <h3>Previous names</h3>
                  {p.nameHistory.length === 0 ? (
                    <p className="adm-muted">No changes recorded.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.nameHistory.map((n, i) => (
                        <li key={i}>
                          {n.displayName}#{n.tag}{' '}
                          <span className="adm-muted">
                            until {shortTime(n.changedAt)} ({n.changedBy})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="Wallet">
                  <Facts
                    rows={[
                      ['Gumballs', a.gumballs],
                      ['Gems', a.gems],
                      ['Crown Shards', a.crownShards],
                      ['Gem debt', a.gemDebt],
                    ]}
                  />
                  {admin && (
                    <form
                      className="adm-inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!Number.isInteger(deltaNum) || deltaNum === 0) return;
                        confirm({
                          title: `${deltaNum > 0 ? 'Credit' : 'Debit'} ${Math.abs(deltaNum)} ${currency} ${deltaNum > 0 ? 'to' : 'from'} ${name}`,
                          body: 'Written to the ledger as an admin adjustment.',
                          confirmLabel: 'Adjust',
                          danger: deltaNum < 0,
                          run: async (reason) => {
                            await api.request('POST', `/internal/users/${a.id}/currency`, {
                              currency,
                              delta: deltaNum,
                              reason,
                            });
                            setDelta('');
                            state.reload();
                          },
                          done: 'Balance adjusted',
                        });
                      }}
                    >
                      <label className="adm-field">
                        <span>Currency</span>
                        <select
                          value={currency}
                          onChange={(e) => setCurrency(e.target.value as typeof currency)}
                        >
                          <option value="gems">Gems</option>
                          <option value="gumballs">Gumballs</option>
                          <option value="crown_shards">Crown Shards</option>
                        </select>
                      </label>
                      <label className="adm-field">
                        <span>Change (+/-)</span>
                        <input inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} />
                      </label>
                      <button
                        type="submit"
                        className="adm-btn"
                        disabled={!Number.isInteger(deltaNum) || deltaNum === 0}
                      >
                        Adjust…
                      </button>
                    </form>
                  )}
                  <h3>Purchases ({p.purchases.total})</h3>
                  {p.purchases.recent.length === 0 ? (
                    <p className="adm-muted">None.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.purchases.recent.map((x) => (
                        <li key={x.id}>
                          {shortTime(x.createdAt)} — {x.itemId} ({x.price} {x.currency}){' '}
                          <Badge>{x.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card
                  title={`Reports against (${Object.values(p.reportsAgainst.byStatus).reduce((s, n) => s + (n ?? 0), 0)})`}
                  wide
                >
                  {p.reportsAgainst.recent.length === 0 ? (
                    <p className="adm-muted">None.</p>
                  ) : (
                    <div className="adm-table-wrap">
                      <table className="adm-table">
                        <thead>
                          <tr>
                            <th>Filed</th>
                            <th>Reason</th>
                            <th>Status</th>
                            <th>By</th>
                            <th>Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.reportsAgainst.recent.map((r) => (
                            <tr key={r.id}>
                              <td>{shortTime(r.createdAt)}</td>
                              <td>{REASON_LABELS[r.reason] ?? r.reason}</td>
                              <td>
                                <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status}</Badge>
                              </td>
                              <td>
                                <PlayerLink
                                  id={r.reporterId}
                                  label={r.reporter ?? r.reporterId.slice(0, 8)}
                                />
                              </td>
                              <td>{r.details ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <h3>Reports filed by this player ({p.reportsBy.total})</h3>
                  {p.reportsBy.recent.length === 0 ? (
                    <p className="adm-muted">None.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.reportsBy.recent.map((r) => (
                        <li key={r.id}>
                          {shortTime(r.createdAt)} — {REASON_LABELS[r.reason] ?? r.reason} against{' '}
                          <PlayerLink id={r.targetUserId} label={r.target ?? r.targetUserId.slice(0, 8)} />{' '}
                          <Badge>{r.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title={`Cosmetics (${p.inventory.length})`} wide>
                  <div className="adm-table-wrap adm-table-wrap--short">
                    <table className="adm-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Slot</th>
                          <th>Source</th>
                          <th>Acquired</th>
                          {admin && <th aria-label="Actions" />}
                        </tr>
                      </thead>
                      <tbody>
                        {p.inventory.map((i) => (
                          <tr key={i.cosmeticId}>
                            <td>{i.name}</td>
                            <td>{i.slot ?? '—'}</td>
                            <td>{i.starter ? 'starter' : i.source}</td>
                            <td>{shortTime(i.acquiredAt)}</td>
                            {admin && (
                              <td>
                                {!i.starter && (
                                  <button
                                    type="button"
                                    className="adm-btn adm-btn--small adm-btn--danger"
                                    onClick={() =>
                                      confirm({
                                        title: `Revoke ${i.name} from ${name}`,
                                        body: 'Removes the item and takes it off every loadout that wears it.',
                                        confirmLabel: 'Revoke',
                                        danger: true,
                                        run: async (reason) => {
                                          await api.request(
                                            'DELETE',
                                            `/internal/users/${a.id}/inventory/${encodeURIComponent(i.cosmeticId)}`,
                                            { reason },
                                          );
                                          state.reload();
                                        },
                                        done: 'Item revoked',
                                      })
                                    }
                                  >
                                    Revoke
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <PlayerGiftsCard id={a.id} />
                <Card title="Recent matches" wide>
                  {p.matches.recent.length === 0 ? (
                    <p className="adm-muted">None recorded.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.matches.recent.map((m) => (
                        <li key={m.matchId}>
                          {shortTime(m.endedAt)} — {m.playlistId} ({m.queue}) placed {m.placement}
                          {m.crowned ? ' (crowned)' : ''}
                          <span className="adm-mono adm-muted">{m.matchId}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card
                  title="Moderation trail"
                  wide
                  actions={
                    <a className="adm-link" href={`#/audit?target=${encodeURIComponent(a.id)}`}>
                      Full log
                    </a>
                  }
                >
                  {p.audit.length === 0 ? (
                    <p className="adm-muted">No admin actions yet.</p>
                  ) : (
                    <ul className="adm-list">
                      {p.audit.map((e) => (
                        <li key={e.id}>
                          {shortTime(e.createdAt)} — <strong>{e.action}</strong> by {e.actorLabel}
                          {e.reason ? `: ${e.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </StateBlock>
    </section>
  );
}
