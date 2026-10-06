/**
 * Friends / party sheet and the notifications drop-down.
 * docs/design/SCREENS.md §5.8, §12.5.
 *
 * Responsibilities:
 * - party: invite code/link, members (click for the player card), a button to
 *   open the chat widget on the Party tab;
 * - add friends by `name#tag` or by searching names;
 * - requests (accept / decline incoming, cancel outgoing), friends grouped by
 *   presence with invite / join / profile / remove / block, recent players
 *   with real presence for friends and "Add friend" for everyone else, and
 *   the blocked list with unblock;
 * - the Club section (`ClubPanel.tsx`), one switch away from friends;
 * - offline: an honest empty state with Retry instead of dead buttons;
 * - notifications with inline Accept/Decline and Join/Decline (party and club).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button, Segmented } from '../../components/controls.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { clubs, useClubs } from '../../store/clubs.ts';
import { uiEvents } from '../../store/events.ts';
import {
  PRESENCE_LABEL,
  social,
  useSocial,
  type PlayerRef,
  type PlayerSearchResult,
} from '../../store/social.ts';
import type { Friend, NotificationItem, Presence } from '../../store/types.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { setChatOpen } from '../../hud/ChatWidget.tsx';
import { ClubPanel } from './ClubPanel.tsx';
import { confirmBlock, confirmRemoveFriend, PlayerButton } from './PlayerActions.tsx';
import { openJoinCode } from './PrivateShow.tsx';

const PRESENCE_CLS: Record<Presence, string> = {
  online: 'is-online',
  inMenu: 'is-online',
  inQueue: 'is-busy',
  inShow: 'is-busy',
  offline: 'is-offline',
};

/** `name#1234` exactly: an add-by-tag request rather than a search. */
const NAME_TAG = /^.{3,16}#\d{4}$/;

const refOf = (f: { id: string; name: string; tag?: string }): PlayerRef => ({
  userId: f.id,
  name: f.name,
  ...(f.tag ? { tag: f.tag } : {}),
  key: f.id,
});

function presenceText(f: Friend): string {
  const base = PRESENCE_LABEL[f.presence];
  return f.playlist && (f.presence === 'inShow' || f.presence === 'inQueue')
    ? `${base}: ${f.playlist}`
    : base;
}

function Name({ name, tag }: { name: string; tag?: string }): JSX.Element {
  return (
    <b className="tr-ellipsis">
      {name}
      {tag && <small className="tr-muted">#{tag}</small>}
    </b>
  );
}

function FriendRow({ f, inParty }: { f: Friend; inParty: boolean }): JSX.Element {
  const [sent, setSent] = useState(false);
  const [more, setMore] = useState(false);
  const canInvite = !inParty && f.presence !== 'offline';
  return (
    <div className="tr-friend-wrap">
      <div className="tr-friend">
        <PlayerButton player={refOf(f)}>
          <TumblerAvatar colors={f.colors} size="2.4em" blink={false} noShadow />
          <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
            <Name name={f.name} tag={f.tag} />
            <span className={`tr-presence ${PRESENCE_CLS[f.presence]}`}>{presenceText(f)}</span>
          </div>
        </PlayerButton>
        {f.joinable && !inParty && (
          <Button size="sm" variant="go" onClick={() => uiEvents.emit('joinFriend', { userId: f.id })}>
            Join
          </Button>
        )}
        {f.lobbyCode && (
          <Button size="sm" variant="go" onClick={() => uiEvents.emit('joinCode', { code: f.lobbyCode! })}>
            Join show
          </Button>
        )}
        {canInvite && (
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
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={more}
          aria-label={`More for ${f.name}`}
          onClick={() => setMore((m) => !m)}
        >
          More
        </Button>
      </div>
      {more && (
        <div className="tr-friend-more">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => uiEvents.emit('inspectPlayer', { playerId: f.id, name: f.name })}
          >
            View profile
          </Button>
          <Button size="sm" variant="secondary" onClick={() => confirmRemoveFriend(f.id, f.name)}>
            Remove friend
          </Button>
          <Button size="sm" variant="secondary" onClick={() => confirmBlock(f.id, f.name)}>
            Block
          </Button>
          <Button size="sm" variant="ghost" onClick={() => social.getState().openPlayerMenu(refOf(f))}>
            Mute or report
          </Button>
        </div>
      )}
    </div>
  );
}

function RelationButton({
  userId,
  name,
  relation,
}: {
  userId: string;
  name: string;
  relation: Friend['relation'] | 'self';
}): JSX.Element | null {
  const [sent, setSent] = useState(false);
  if (relation === 'self' || relation === 'friend') return null;
  if (relation === 'incoming')
    return (
      <Button
        size="sm"
        variant="mint"
        onClick={() => uiEvents.emit('friendRequestAction', { userId, action: 'accept' })}
      >
        Accept
      </Button>
    );
  const pending = sent || relation === 'outgoing';
  return (
    <Button
      size="sm"
      variant={pending ? 'mint' : 'sky'}
      disabled={pending}
      onClick={() => {
        setSent(true);
        uiEvents.emit('requestFriend', { userId, name });
      }}
    >
      {pending ? 'Requested' : 'Add friend'}
    </Button>
  );
}

function RecentRow({ f }: { f: Friend }): JSX.Element {
  const friend = f.relation === 'friend';
  return (
    <div className="tr-friend">
      <PlayerButton player={refOf(f)}>
        <TumblerAvatar colors={f.colors} size="2.4em" blink={false} noShadow />
        <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
          <Name name={f.name} tag={f.tag} />
          {friend ? (
            <span className={`tr-presence ${PRESENCE_CLS[f.presence]}`}>{presenceText(f)}</span>
          ) : (
            <small className="tr-muted">Played together recently</small>
          )}
        </div>
      </PlayerButton>
      <RelationButton userId={f.id} name={f.name} relation={f.relation ?? 'none'} />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => uiEvents.emit('inspectPlayer', { playerId: f.id, name: f.name })}
      >
        Profile
      </Button>
    </div>
  );
}

function SearchResults({ results }: { results: PlayerSearchResult[] }): JSX.Element {
  return (
    <div className="tr-col" style={{ gap: '0.3em' }} data-testid="search-results">
      {results.map((r) => (
        <div key={r.userId} className="tr-friend">
          <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
            <Name name={r.name} tag={r.tag} />
            <small className="tr-muted">Level {r.level}</small>
          </div>
          {r.relation === 'friend' && <span className="tr-chip tr-chip--good">Friend</span>}
          <RelationButton userId={r.userId} name={r.name} relation={r.relation} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => uiEvents.emit('inspectPlayer', { playerId: r.userId, name: r.name })}
          >
            Profile
          </Button>
        </div>
      ))}
    </div>
  );
}

function AddFriend(): JSX.Element {
  const [text, setText] = useState('');
  const search = useSocial((s) => s.search);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const query = text.trim();
  const onChange = (v: string): void => {
    setText(v);
    window.clearTimeout(timer.current);
    const q = v.trim();
    if (q.length < 2 || NAME_TAG.test(q)) {
      social.getState().setSearch({ query: '', results: [], loading: false });
      return;
    }
    timer.current = window.setTimeout(() => uiEvents.emit('searchPlayers', { query: q }), 300);
  };
  const showResults = query.length >= 2 && !NAME_TAG.test(query) && search.query === query;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }}>
      <form
        className="tr-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (NAME_TAG.test(query)) {
            uiEvents.emit('addFriend', { nameTag: query });
            onChange('');
          } else if (query.length >= 2) {
            uiEvents.emit('searchPlayers', { query });
          } else {
            playCue('ui.error');
            ui.getState().pushToast({
              kind: 'warning',
              title: 'Type a name or name#1234',
              body: 'Search by name, or add directly with a tag like Wobbleton#0420.',
            });
          }
        }}
      >
        <input
          className="tr-input"
          placeholder="Find players or name#1234"
          value={text}
          data-nav=""
          maxLength={21}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Find players by name, or add by name and tag"
        />
        <Button type="submit" size="sm" variant="mint">
          {NAME_TAG.test(query) ? 'Add' : 'Search'}
        </Button>
      </form>
      {showResults &&
        (search.loading ? (
          <small className="tr-muted">Searching…</small>
        ) : search.results.length === 0 ? (
          <small className="tr-muted">No players found. Try their exact name#tag.</small>
        ) : (
          <SearchResults results={search.results} />
        ))}
    </div>
  );
}

function Requests(): JSX.Element | null {
  const incoming = useSocial((s) => s.incoming);
  const outgoing = useSocial((s) => s.outgoing);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }} data-testid="friend-requests">
      <span className="tr-label">Requests · {incoming.length + outgoing.length}</span>
      {incoming.map((r) => (
        <div key={`in-${r.userId}`} className="tr-friend">
          <TumblerAvatar colors={r.colors} size="2.4em" blink={false} noShadow />
          <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
            <Name name={r.name} tag={r.tag} />
            <small className="tr-muted">Wants to be friends</small>
          </div>
          <Button
            size="sm"
            variant="mint"
            onClick={() => uiEvents.emit('friendRequestAction', { userId: r.userId, action: 'accept' })}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => uiEvents.emit('friendRequestAction', { userId: r.userId, action: 'decline' })}
          >
            Decline
          </Button>
        </div>
      ))}
      {outgoing.map((r) => (
        <div key={`out-${r.userId}`} className="tr-friend">
          <TumblerAvatar colors={r.colors} size="2.4em" blink={false} noShadow />
          <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
            <Name name={r.name} tag={r.tag} />
            <small className="tr-muted">Request sent</small>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => uiEvents.emit('friendRequestAction', { userId: r.userId, action: 'cancel' })}
          >
            Cancel
          </Button>
        </div>
      ))}
    </div>
  );
}

function Blocked(): JSX.Element | null {
  const blocked = useSocial((s) => s.blocked);
  const [open, setOpen] = useState(false);
  if (blocked.length === 0) return null;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }}>
      <button
        type="button"
        className="tr-label tr-section-toggle"
        data-nav=""
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Blocked · {blocked.length}
      </button>
      {open &&
        blocked.map((b) => (
          <div key={b.userId} className="tr-friend">
            <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
              <Name name={b.name} tag={b.tag} />
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => uiEvents.emit('unblockPlayer', { userId: b.userId })}
            >
              Unblock
            </Button>
          </div>
        ))}
    </div>
  );
}

/** Friends sheet body when the account servers are unreachable. */
/** Your Name#tag with a copy button: friends need the tag to find you. */
function MyTag({ masked }: { masked: boolean }): JSX.Element | null {
  const profile = useUI((s) => s.profile);
  const [copied, setCopied] = useState(false);
  if (!profile?.tag) return null;
  const full = `${profile.name}#${profile.tag}`;
  return (
    <div className="tr-my-tag" data-testid="my-tag">
      <span className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
        <span className="tr-label">Your name</span>
        <b className="tr-ellipsis">
          {profile.name}
          <span className="tr-my-tag-num">#{masked ? '••••' : profile.tag}</span>
        </b>
      </span>
      <Button
        size="sm"
        variant={copied ? 'mint' : 'secondary'}
        onClick={() => {
          void navigator.clipboard?.writeText(full);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </Button>
    </div>
  );
}

function OfflineFriends(): JSX.Element {
  const connecting = useSocial((s) => s.availability === 'connecting');
  return (
    <div className="tr-friends-offline" data-testid="friends-offline">
      <Icon name="friends" size="3em" />
      <h3 className="tr-title tr-h3">Friends need the online servers</h3>
      <p className="tr-muted">
        You're playing offline right now, so there's nobody to add or invite. Your Tumbler and progress are
        saved on this device. Once the servers are reachable you can add friends, form a party of up to four
        and chat with them here.
      </p>
      <Button
        variant="sky"
        disabled={connecting}
        autoFocusNav
        onClick={() => {
          social.getState().setAvailability('connecting');
          uiEvents.emit('retryOnline');
        }}
      >
        {connecting ? 'Connecting…' : 'Retry'}
      </Button>
      <small className="tr-muted">Offline shows against bots work any time from the Play tab.</small>
    </div>
  );
}

/** Friends & party side sheet. */
export function FriendsSheet(): JSX.Element {
  const friends = useUI((s) => s.friends);
  const party = useUI((s) => s.party);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const availability = useSocial((s) => s.availability);
  const section = useClubs((s) => s.section);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [kickArmed, setKickArmed] = useState<string | null>(null);
  const code = party?.code ?? '';
  const link = `${globalThis.location?.origin ?? ''}/join/${code}`;
  const copy = (what: 'code' | 'link'): void => {
    void navigator.clipboard?.writeText(what === 'code' ? code : link);
    uiEvents.emit('copyInvite', { code });
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1600);
  };
  const self = party?.members.find((m) => m.isSelf);
  const memberIds = new Set(party?.members.map((m) => m.id));
  const mine = friends.filter((f) => !f.recent);
  const groups: [string, Friend[]][] = [
    ['Online', mine.filter((f) => f.presence === 'online' || f.presence === 'inMenu')],
    ['In queue', mine.filter((f) => f.presence === 'inQueue')],
    ['In a show', mine.filter((f) => f.presence === 'inShow')],
    ['Offline', mine.filter((f) => f.presence === 'offline')],
  ];
  const recent = friends.filter((f) => f.recent);
  const online = availability === 'online';
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
          {online && (
            <Segmented
              label="Friends or club"
              value={section}
              options={[
                { value: 'friends', label: 'Friends & party' },
                { value: 'club', label: 'Club' },
              ]}
              onChange={(s) => clubs.getState().setSection(s)}
            />
          )}
          {!online ? (
            <OfflineFriends />
          ) : section === 'club' ? (
            <ClubPanel />
          ) : (
            <>
              <MyTag masked={streamer && !reveal} />
              <Button variant="sky" block onClick={openJoinCode}>
                <Icon name="key" size="1em" /> Join a party or show with a code
              </Button>
              {code && (
                <div className="tr-invite-box">
                  <span className="tr-label">Party code</span>
                  <div className="tr-row">
                    <code className="tr-invite-code tr-grow">{streamer && !reveal ? '••••••' : code}</code>
                    {streamer && (
                      <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)}>
                        {reveal ? 'Hide' : 'Reveal'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={copied === 'code' ? 'mint' : 'primary'}
                      autoFocusNav
                      onClick={() => copy('code')}
                    >
                      {copied === 'code' ? 'Copied!' : 'Copy code'}
                    </Button>
                  </div>
                  <span className="tr-label">Invite link</span>
                  <div className="tr-row">
                    <code className="tr-invite-link tr-grow tr-ellipsis">
                      {streamer && !reveal ? link.replace(code, '••••••') : link.replace(/^https?:\/\//, '')}
                    </code>
                    <Button
                      size="sm"
                      variant={copied === 'link' ? 'mint' : 'sky'}
                      onClick={() => copy('link')}
                    >
                      {copied === 'link' ? 'Copied!' : 'Copy link'}
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
                      <PlayerButton
                        player={{ userId: m.id, name: m.name, ...(m.tag ? { tag: m.tag } : {}), key: m.id }}
                        disabled={m.isSelf}
                      >
                        <TumblerAvatar colors={m.colors} size="2.4em" blink={false} noShadow />
                        <b className="tr-grow tr-ellipsis">
                          {m.isLeader ? <Icon name="crown" size="0.9em" /> : null}
                          {m.name}
                          {m.tag && (
                            <small className="tr-muted">#{streamer && !reveal ? '••••' : m.tag}</small>
                          )}
                          {m.isSelf ? ' (you)' : ''}
                        </b>
                      </PlayerButton>
                      {m.isLeader ? (
                        <span
                          className="tr-chip tr-chip--lemon"
                          title="The leader readies up by pressing Play"
                        >
                          Leader
                        </span>
                      ) : (
                        <span className={`tr-chip ${m.ready ? 'tr-chip--good' : ''}`}>
                          {m.ready ? (
                            <>
                              <Icon name="check" size="0.85em" /> Ready
                            </>
                          ) : (
                            'Not ready'
                          )}
                        </span>
                      )}
                      {self?.isLeader && !m.isSelf && kickArmed !== m.id && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Make ${m.name} party leader`}
                            title="Make leader"
                            data-testid="party-promote"
                            onClick={() => uiEvents.emit('promotePartyMember', { memberId: m.id })}
                          >
                            <Icon name="crown" size="1em" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Kick ${m.name}`}
                            onClick={() => setKickArmed(m.id)}
                          >
                            <Icon name="close" size="1em" />
                          </Button>
                        </>
                      )}
                      {self?.isLeader && kickArmed === m.id && (
                        <>
                          <Button
                            size="sm"
                            variant="danger"
                            cue="ui.confirm"
                            aria-label={`Confirm: kick ${m.name}`}
                            onClick={() => {
                              setKickArmed(null);
                              uiEvents.emit('kickPartyMember', { memberId: m.id });
                            }}
                          >
                            Kick
                          </Button>
                          <Button size="sm" variant="ghost" cue="ui.back" onClick={() => setKickArmed(null)}>
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                  {party.members.length > 1 && (
                    <Button
                      size="sm"
                      variant="sky"
                      data-testid="party-chat-open"
                      onClick={() => {
                        ui.getState().setOverlay('none');
                        setChatOpen(true, { channel: 'party' });
                      }}
                    >
                      Chat with your party
                    </Button>
                  )}
                  {party.members.length > 1 && (
                    <Button size="sm" variant="secondary" onClick={() => uiEvents.emit('leaveParty')}>
                      Leave party
                    </Button>
                  )}
                </div>
              )}
              <AddFriend />
              <Requests />
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
              {mine.length === 0 && (
                <p className="tr-muted tr-friends-empty">
                  No friends yet. Search for a name above, or add someone you just played with.
                </p>
              )}
              {recent.length > 0 && (
                <div className="tr-col" style={{ gap: '0.3em' }}>
                  <span className="tr-label">Recent players · {recent.length}</span>
                  {recent.map((f) => (
                    <RecentRow key={f.id} f={f} />
                  ))}
                </div>
              )}
              <Blocked />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function NotificationActions({ n }: { n: NotificationItem }): JSX.Element | null {
  const a = n.action;
  if (!a) return null;
  if (n.resolved) return <span className="tr-chip">{n.resolved}</span>;
  const resolve = (label: string): void =>
    ui
      .getState()
      .setNotifications(
        ui.getState().notifications.map((x) => (x.id === n.id ? { ...x, resolved: label, read: true } : x)),
      );
  if (a.kind === 'friendRequest')
    return (
      <div className="tr-row tr-notif-actions">
        <Button
          size="sm"
          variant="mint"
          onClick={() => {
            resolve('Accepted');
            uiEvents.emit('friendRequestAction', { userId: a.userId, action: 'accept' });
          }}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            resolve('Declined');
            uiEvents.emit('friendRequestAction', { userId: a.userId, action: 'decline' });
          }}
        >
          Decline
        </Button>
      </div>
    );
  if (a.kind === 'clubInvite')
    return (
      <div className="tr-row tr-notif-actions">
        <Button
          size="sm"
          variant="go"
          onClick={() => {
            resolve('Joined');
            uiEvents.emit('clubInviteAnswer', { clubId: a.clubId, accept: true });
          }}
        >
          Join club
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            resolve('Declined');
            uiEvents.emit('clubInviteAnswer', { clubId: a.clubId, accept: false });
          }}
        >
          Decline
        </Button>
      </div>
    );
  return (
    <div className="tr-row tr-notif-actions">
      <Button
        size="sm"
        variant="go"
        onClick={() => {
          resolve('Joined');
          uiEvents.emit('partyInviteAction', { userId: a.userId, code: a.code, action: 'join' });
        }}
      >
        Join
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          resolve('Declined');
          uiEvents.emit('partyInviteAction', { userId: a.userId, code: a.code, action: 'decline' });
        }}
      >
        Decline
      </Button>
    </div>
  );
}

/** Notifications drop-down under the bell. */
export function NotificationsPanel(): JSX.Element {
  const items = useUI((s) => s.notifications);
  const icon = { invite: 'party', friendRequest: 'friends', news: 'news', reward: 'gift' } as const;
  // Opening the panel is reading it; the bell badge clears once the panel closes.
  useEffect(
    () => () => {
      const list = ui.getState().notifications;
      if (list.some((n) => !n.read)) ui.getState().setNotifications(list.map((n) => ({ ...n, read: true })));
    },
    [],
  );
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
              <div className="tr-col tr-grow" style={{ gap: '0.3em' }}>
                <b>{n.title}</b>
                {n.body && <small>{n.body}</small>}
                <NotificationActions n={n} />
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
