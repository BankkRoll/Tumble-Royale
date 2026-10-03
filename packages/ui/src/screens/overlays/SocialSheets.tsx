/**
 * Friends / party sheet (invite link, party list, friend search, presence
 * sections) and the notifications drop-down. docs/design/SCREENS.md §5.8, §12.5.
 */
import { useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { Icon } from '../../components/icons/index.tsx';
import type { Friend, Presence } from '../../store/types.ts';

const PRESENCE: Record<Presence, { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'is-online' },
  inMenu: { label: 'In the menu', cls: 'is-online' },
  inShow: { label: 'In a show', cls: 'is-busy' },
  offline: { label: 'Offline', cls: 'is-offline' },
};

function FriendRow({ f, inParty }: { f: Friend; inParty: boolean }): JSX.Element {
  const [sent, setSent] = useState(false);
  return (
    <div className="tr-friend">
      <TumblerAvatar colors={f.colors} size="2.4em" blink={false} noShadow />
      <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
        <b className="tr-ellipsis">
          {f.name}
          <small className="tr-muted">#{f.tag}</small>
        </b>
        <span className={`tr-presence ${PRESENCE[f.presence].cls}`}>{PRESENCE[f.presence].label}</span>
      </div>
      {!inParty && f.presence !== 'offline' && (
        <Button
          size="sm"
          variant={sent ? 'mint' : 'sky'}
          disabled={sent}
          onClick={() => {
            setSent(true);
            uiEvents.emit('inviteFriend', { friendId: f.id });
          }}
        >
          {sent ? 'Sent!' : 'Invite'}
        </Button>
      )}
    </div>
  );
}

/** Friends & party side sheet. */
export function FriendsSheet(): JSX.Element {
  const friends = useUI((s) => s.friends);
  const party = useUI((s) => s.party);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const code = party?.code ?? '';
  const link = `tumble.gg/join/${code}`;
  const self = party?.members.find((m) => m.isSelf);
  const memberIds = new Set(party?.members.map((m) => m.id));
  const groups: [string, Friend[]][] = [
    ['Online', friends.filter((f) => !f.recent && (f.presence === 'online' || f.presence === 'inMenu'))],
    ['In a show', friends.filter((f) => !f.recent && f.presence === 'inShow')],
    ['Offline', friends.filter((f) => !f.recent && f.presence === 'offline')],
    ['Recent players', friends.filter((f) => f.recent)],
  ];
  return (
    <div
      className="tr-sheet-wrap tr-interactive"
      data-nav-scope="10"
      role="dialog"
      aria-modal="true"
      aria-label="Friends and party"
    >
      <div className="tr-dim" onClick={() => ui.getState().setOverlay('none')} />
      <aside className="tr-sheet tr-friends">
        <div className="tr-sheet-head">
          <h2 className="tr-title tr-h2 tr-grow">Party & friends</h2>
          <button
            type="button"
            className="tr-close"
            data-nav=""
            data-nav-back=""
            aria-label="Close"
            onClick={() => {
              playCue('ui.back');
              ui.getState().setOverlay('none');
            }}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        <div className="tr-sheet-body tr-scroll">
          {code && (
            <div className="tr-invite-box">
              <span className="tr-label">Invite link</span>
              <div className="tr-row">
                <code className="tr-invite-link tr-grow tr-ellipsis">
                  {streamer && !reveal ? 'tumble.gg/join/••••••' : link}
                </code>
                {streamer && (
                  <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)}>
                    {reveal ? 'Hide' : 'Reveal'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={copied ? 'mint' : 'primary'}
                  autoFocusNav
                  onClick={() => {
                    void navigator.clipboard?.writeText(`https://${link}`);
                    uiEvents.emit('copyInvite', { code });
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  {copied ? (
                    'Copied!'
                  ) : (
                    <>
                      <Icon name="copy" size="1em" /> Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
          {party && (
            <div className="tr-col" style={{ gap: '0.4em' }}>
              <span className="tr-label">
                Party {party.members.length}/{party.maxSize}
              </span>
              {party.members.map((m) => (
                <div key={m.id} className="tr-friend">
                  <TumblerAvatar colors={m.colors} size="2.4em" blink={false} noShadow />
                  <b className="tr-grow tr-ellipsis">
                    {m.isLeader ? <Icon name="crown" size="0.9em" /> : null}
                    {m.name}
                    {m.isSelf ? ' (you)' : ''}
                  </b>
                  <span className={`tr-chip ${m.ready ? 'tr-chip--good' : ''}`}>
                    {m.ready ? (
                      <>
                        <Icon name="check" size="0.85em" /> Ready
                      </>
                    ) : (
                      'Not ready'
                    )}
                  </span>
                  {self?.isLeader && !m.isSelf && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Kick ${m.name}`}
                      onClick={() => uiEvents.emit('kickPartyMember', { memberId: m.id })}
                    >
                      <Icon name="close" size="1em" />
                    </Button>
                  )}
                </div>
              ))}
              {party.members.length > 1 && (
                <Button size="sm" variant="secondary" onClick={() => uiEvents.emit('leaveParty')}>
                  Leave party
                </Button>
              )}
            </div>
          )}
          <form
            className="tr-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^.{3,16}#\d{4}$/.test(search.trim())) {
                playCue('ui.error');
                ui.getState().pushToast({
                  kind: 'warning',
                  title: 'Use name#1234',
                  body: 'Friend tags look like Wobbleton#0420.',
                });
                return;
              }
              uiEvents.emit('addFriend', { nameTag: search.trim() });
              setSearch('');
            }}
          >
            <input
              className="tr-input"
              placeholder="Add friend: name#1234"
              value={search}
              data-nav=""
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Add friend by name and tag"
            />
            <Button type="submit" size="sm" variant="mint">
              Add
            </Button>
          </form>
          {groups.map(([label, list]) =>
            list.length === 0 ? null : (
              <div key={label} className="tr-col" style={{ gap: '0.3em' }}>
                <span className="tr-label">
                  {label} · {list.length}
                </span>
                {list.map((f) => (
                  <FriendRow key={f.id} f={f} inParty={memberIds.has(f.id)} />
                ))}
              </div>
            ),
          )}
        </div>
      </aside>
    </div>
  );
}

/** Notifications drop-down under the bell. */
export function NotificationsPanel(): JSX.Element {
  const items = useUI((s) => s.notifications);
  const icon = { invite: 'party', friendRequest: 'friends', news: 'news', reward: 'gift' } as const;
  return (
    <div className="tr-notif-wrap tr-interactive" data-nav-scope="10">
      <div className="tr-notif-catcher" onClick={() => ui.getState().setOverlay('none')} />
      <div className="tr-panel tr-notif tr-enter-pop" role="dialog" aria-label="Notifications">
        <div className="tr-row">
          <h2 className="tr-title tr-h3 tr-grow">Notifications</h2>
          <button
            type="button"
            className="tr-close"
            data-nav=""
            data-nav-back=""
            aria-label="Close"
            onClick={() => ui.getState().setOverlay('none')}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        {items.length === 0 && <p className="tr-muted">All quiet. Suspiciously quiet.</p>}
        <div className="tr-col tr-scroll" style={{ maxHeight: '60vh' }}>
          {items.map((n) => (
            <div key={n.id} className={`tr-notif-item${n.read ? '' : ' is-unread'}`}>
              <Icon name={icon[n.kind]} size="1.6em" />
              <div className="tr-col tr-grow" style={{ gap: 0 }}>
                <b>{n.title}</b>
                {n.body && <small>{n.body}</small>}
              </div>
            </div>
          ))}
        </div>
        {items.some((n) => !n.read) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => ui.getState().setNotifications(items.map((n) => ({ ...n, read: true })))}
          >
            Mark all read
          </Button>
        )}
      </div>
    </div>
  );
}
