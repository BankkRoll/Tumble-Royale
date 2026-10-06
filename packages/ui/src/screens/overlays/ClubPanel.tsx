/**
 * The Club section of the social sheet. docs/design/SCREENS.md §5.8.
 *
 * Responsibilities:
 * - without a club: invites (accept / decline), requests waiting on a club
 *   (cancel), search by name or tag, recommended open clubs and the found-a-
 *   club form (name, tag, description, join mode, emblem), with the shared
 *   club rules checked inline before anything is sent;
 * - in a club: the header (emblem, name, tag, members, role) and the tabs
 *   Roster (presence, roles, Party up, promote / demote / hand over / kick,
 *   invite friends), Chat, Goals (weekly goals, claims, the contribution
 *   board), Requests (officers) and Settings (edit, leave, disband, report);
 * - honest loading, empty, error, switched-off and offline states.
 *
 * Every control is a real button or input with `data-nav`, so the keyboard
 * and gamepad navigator reach it; rows wrap on phones. Streamer Mode hides
 * other players' tags (`#1234` and club tags) like everywhere else.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  CLUB_DESCRIPTION_MAX,
  CLUB_EMBLEM_COLORS,
  CLUB_EMBLEM_MOTIFS,
  CLUB_JOIN_MODES,
  CLUB_NAME_MAX,
  CLUB_REPORT_REASONS,
  CLUB_TAG_MAX,
  CLUB_TEXT_MESSAGES,
  DEFAULT_CLUB_EMBLEM,
  checkClubDescription,
  checkClubName,
  checkClubTag,
  clubCan,
  clubOutranks,
  type ClubEmblem,
  type ClubJoinMode,
  type ClubReportReason,
} from '@tumble/shared';
import { Button, Segmented, Swatch } from '../../components/controls.tsx';
import { streamerSafeAccount } from '../../names.ts';
import { linesOf } from '../../store/chatChannels.ts';
import {
  CLUB_REPORT_LABEL,
  CLUB_ROLE_LABEL,
  JOIN_MODE_LABEL,
  clubs,
  useClubs,
  type ClubCardView,
  type ClubMemberView,
  type ClubTab,
  type MyClubView,
} from '../../store/clubs.ts';
import { uiEvents } from '../../store/events.ts';
import { PRESENCE_LABEL, useSocial, visibleChat } from '../../store/social.ts';
import type { Presence } from '../../store/types.ts';
import { useUI } from '../../store/uiStore.ts';
import { confirmAction } from './PlayerActions.tsx';

const PRESENCE_CLS: Record<Presence, string> = {
  online: 'is-online',
  inMenu: 'is-online',
  inQueue: 'is-busy',
  inShow: 'is-busy',
  offline: 'is-offline',
};

/**
 * A club emblem: the motif drawn in two palette colours.
 *
 * @param props.emblem - Emblem.
 * @param props.size - CSS size.
 */
export function ClubEmblemBadge({
  emblem,
  size = '2.4em',
}: {
  emblem: ClubEmblem;
  size?: string;
}): JSX.Element {
  return (
    <span
      className={`tr-club-emblem tr-club-emblem--${emblem.motif}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        ['--a' as string]: emblem.primary,
        ['--b' as string]: emblem.secondary,
      }}
    />
  );
}

/** `[TAG]`, or nothing in Streamer Mode (unless it is the player's own club). */
function TagLabel({ tag, own }: { tag: string; own?: boolean }): JSX.Element | null {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  if (streamer && !own) return null;
  return <span className="tr-club-tag">[{tag}]</span>;
}

function ClubCard({ c, children }: { c: ClubCardView; children?: ReactNode }): JSX.Element {
  return (
    <div className="tr-friend tr-club-card" data-testid="club-card">
      <ClubEmblemBadge emblem={c.emblem} />
      <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
        <b className="tr-ellipsis">
          {c.name} <TagLabel tag={c.tag} />
        </b>
        <small className="tr-muted">
          {c.memberCount}/{c.maxMembers} members · {JOIN_MODE_LABEL[c.joinMode].split(':')[0]}
        </small>
        {c.description && <small className="tr-club-desc">{c.description}</small>}
      </div>
      {children}
    </div>
  );
}

function JoinButton({ c }: { c: ClubCardView }): JSX.Element {
  const pending = useClubs((s) => s.pending.some((p) => p.id === c.id));
  const busy = useClubs((s) => s.busy);
  if (pending)
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => uiEvents.emit('clubCancelRequest', { clubId: c.id })}
      >
        Cancel request
      </Button>
    );
  if (c.joinMode === 'invite') return <span className="tr-chip">Invite only</span>;
  if (c.memberCount >= c.maxMembers) return <span className="tr-chip">Full</span>;
  return (
    <Button
      size="sm"
      variant="go"
      disabled={busy}
      onClick={() => uiEvents.emit('clubJoin', { clubId: c.id })}
    >
      {c.joinMode === 'open' ? 'Join' : 'Ask to join'}
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Without a club
// -----------------------------------------------------------------------------

function EmblemPicker({
  value,
  onChange,
}: {
  value: ClubEmblem;
  onChange(e: ClubEmblem): void;
}): JSX.Element {
  const [part, setPart] = useState<'primary' | 'secondary'>('primary');
  return (
    <div className="tr-col tr-club-emblem-picker" style={{ gap: '0.4em' }}>
      <div className="tr-row" style={{ flexWrap: 'wrap', gap: '0.4em' }}>
        <ClubEmblemBadge emblem={value} size="3.2em" />
        <Segmented
          label="Emblem pattern"
          value={value.motif}
          options={CLUB_EMBLEM_MOTIFS.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }))}
          onChange={(motif) => onChange({ ...value, motif })}
        />
      </div>
      <Segmented
        label="Emblem colour to change"
        value={part}
        options={[
          { value: 'primary', label: 'Background' },
          { value: 'secondary', label: 'Pattern' },
        ]}
        onChange={setPart}
      />
      <div className="tr-row tr-club-swatches" role="group" aria-label="Emblem colours">
        {CLUB_EMBLEM_COLORS.map((c) => (
          <Swatch
            key={c}
            color={c}
            selected={value[part] === c}
            onSelect={() => onChange({ ...value, [part]: c })}
          />
        ))}
      </div>
    </div>
  );
}

function CreateClub({ onDone }: { onDone(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [description, setDescription] = useState('');
  const [joinMode, setJoinMode] = useState<ClubJoinMode>('open');
  const [emblem, setEmblem] = useState<ClubEmblem>(DEFAULT_CLUB_EMBLEM);
  const [touched, setTouched] = useState(false);
  const busy = useClubs((s) => s.busy);
  const checks = {
    name: checkClubName(name),
    tag: checkClubTag(tag),
    description: checkClubDescription(description),
  };
  const problem = (field: keyof typeof checks): string | null => {
    const c = checks[field];
    return touched && !c.ok ? CLUB_TEXT_MESSAGES[field][c.reason] : null;
  };
  const valid = checks.name.ok && checks.tag.ok && checks.description.ok;
  return (
    <form
      className="tr-col tr-club-form"
      style={{ gap: '0.5em' }}
      data-testid="club-create"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!valid || !checks.name.ok || !checks.tag.ok || !checks.description.ok) return;
        uiEvents.emit('clubCreate', {
          name: checks.name.value,
          tag: checks.tag.value,
          description: checks.description.value,
          emblem,
          joinMode,
        });
        onDone();
      }}
    >
      <label className="tr-col" style={{ gap: '0.2em' }}>
        <span className="tr-label">Club name</span>
        <input
          className="tr-input"
          data-nav=""
          value={name}
          maxLength={CLUB_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={problem('name') ? true : undefined}
        />
        {problem('name') && <small className="tr-field-error">{problem('name')}</small>}
      </label>
      <label className="tr-col" style={{ gap: '0.2em' }}>
        <span className="tr-label">Tag (shown as [TAG])</span>
        <input
          className="tr-input"
          data-nav=""
          value={tag}
          maxLength={CLUB_TAG_MAX}
          onChange={(e) => setTag(e.target.value.toUpperCase())}
          aria-invalid={problem('tag') ? true : undefined}
        />
        {problem('tag') && <small className="tr-field-error">{problem('tag')}</small>}
      </label>
      <label className="tr-col" style={{ gap: '0.2em' }}>
        <span className="tr-label">Description (optional)</span>
        <textarea
          className="tr-input"
          data-nav=""
          rows={2}
          value={description}
          maxLength={CLUB_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
        />
        {problem('description') && <small className="tr-field-error">{problem('description')}</small>}
      </label>
      <span className="tr-label">Who can join</span>
      <Segmented
        label="Who can join"
        value={joinMode}
        options={CLUB_JOIN_MODES.map((m) => ({ value: m, label: JOIN_MODE_LABEL[m].split(':')[0]! }))}
        onChange={setJoinMode}
      />
      <span className="tr-label">Emblem</span>
      <EmblemPicker value={emblem} onChange={setEmblem} />
      <div className="tr-row" style={{ flexWrap: 'wrap' }}>
        <Button type="submit" variant="go" disabled={busy}>
          Found the club
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Discovery(): JSX.Element {
  const discovery = useClubs((s) => s.discovery);
  const [text, setText] = useState('');
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const query = text.trim();
  const showResults = query.length >= 2 && discovery.query === query;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }}>
      <span className="tr-label">Find a club</span>
      <input
        className="tr-input"
        placeholder="Club name or tag"
        aria-label="Search clubs by name or tag"
        data-nav=""
        value={text}
        maxLength={24}
        onChange={(e) => {
          setText(e.target.value);
          window.clearTimeout(timer.current);
          const q = e.target.value.trim();
          if (q.length >= 2)
            timer.current = window.setTimeout(() => uiEvents.emit('clubSearch', { query: q }), 300);
        }}
      />
      {showResults &&
        (discovery.loading ? (
          <small className="tr-muted">Searching…</small>
        ) : discovery.results.length === 0 ? (
          <small className="tr-muted">No clubs match. Try the exact tag, or found your own.</small>
        ) : (
          <div className="tr-col" style={{ gap: '0.3em' }} data-testid="club-results">
            {discovery.results.map((c) => (
              <ClubCard key={c.id} c={c}>
                <JoinButton c={c} />
              </ClubCard>
            ))}
          </div>
        ))}
      {discovery.recommended.length > 0 && (
        <>
          <span className="tr-label">Recommended · open and active</span>
          {discovery.recommended.map((c) => (
            <ClubCard key={c.id} c={c}>
              <JoinButton c={c} />
            </ClubCard>
          ))}
        </>
      )}
    </div>
  );
}

function NoClub(): JSX.Element {
  const invites = useClubs((s) => s.invites);
  const pending = useClubs((s) => s.pending);
  const guest = useUI((s) => s.profile?.isGuest ?? true);
  const [creating, setCreating] = useState(false);
  if (creating) return <CreateClub onDone={() => setCreating(false)} />;
  return (
    <div className="tr-col" style={{ gap: '0.6em' }} data-testid="club-none">
      <p className="tr-muted">
        Clubs are your crew between shows: a roster, a chat and weekly goals that pay everyone who plays.
      </p>
      {guest && (
        <p className="tr-club-note" data-testid="club-guest-note">
          Link an email, Discord or Google sign-in (Settings, Account) to join or found a club.
        </p>
      )}
      {invites.length > 0 && (
        <div className="tr-col" style={{ gap: '0.3em' }}>
          <span className="tr-label">Invites · {invites.length}</span>
          {invites.map((i) => (
            <ClubCard key={i.club.id} c={i.club}>
              <Button
                size="sm"
                variant="mint"
                onClick={() => uiEvents.emit('clubInviteAnswer', { clubId: i.club.id, accept: true })}
              >
                Join
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => uiEvents.emit('clubInviteAnswer', { clubId: i.club.id, accept: false })}
              >
                Decline
              </Button>
            </ClubCard>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="tr-col" style={{ gap: '0.3em' }}>
          <span className="tr-label">Waiting for an answer · {pending.length}</span>
          {pending.map((c) => (
            <ClubCard key={c.id} c={c}>
              <JoinButton c={c} />
            </ClubCard>
          ))}
        </div>
      )}
      <Button variant="sky" block disabled={guest} onClick={() => setCreating(true)}>
        Found a club
      </Button>
      <Discovery />
    </div>
  );
}

// -----------------------------------------------------------------------------
// In a club
// -----------------------------------------------------------------------------

function MemberRow({ m, myRole }: { m: ClubMemberView; myRole: string }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const [more, setMore] = useState(false);
  const online = m.presence === 'online' || m.presence === 'inMenu';
  const canManage = !m.isSelf && clubOutranks(myRole, m.role);
  return (
    <div className="tr-friend-wrap">
      <div className="tr-friend" data-testid="club-member">
        <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
          <b className="tr-ellipsis">
            {m.name}
            <small className="tr-muted">#{streamer && !m.isSelf ? '••••' : m.tag}</small>
            {m.isSelf ? ' (you)' : ''}
          </b>
          <span className={`tr-presence ${PRESENCE_CLS[m.presence]}`}>{PRESENCE_LABEL[m.presence]}</span>
        </div>
        <span className={`tr-chip${m.role === 'owner' ? ' tr-chip--lemon' : ''}`}>
          {CLUB_ROLE_LABEL[m.role]}
        </span>
        {!m.isSelf && online && (
          <Button size="sm" variant="sky" onClick={() => uiEvents.emit('clubPartyUp', { userId: m.userId })}>
            Party up
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={more}
            aria-label={`Manage ${m.name}`}
            onClick={() => setMore((x) => !x)}
          >
            Manage
          </Button>
        )}
      </div>
      {more && canManage && (
        <div className="tr-friend-more">
          {clubCan(myRole, 'setRole') && m.role === 'member' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => uiEvents.emit('clubMember', { userId: m.userId, action: 'officer' })}
            >
              Make officer
            </Button>
          )}
          {clubCan(myRole, 'setRole') && m.role === 'officer' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => uiEvents.emit('clubMember', { userId: m.userId, action: 'member' })}
            >
              Make member
            </Button>
          )}
          {clubCan(myRole, 'transfer') && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                confirmAction(
                  'club-transfer',
                  `Make ${m.name} the owner?`,
                  'You become an officer. Only the new owner can give it back.',
                  'Hand over',
                  () => uiEvents.emit('clubMember', { userId: m.userId, action: 'transfer' }),
                )
              }
            >
              Make owner
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              confirmAction(
                'club-kick',
                `Remove ${m.name}?`,
                'They leave the club and cannot rejoin for 24 hours.',
                'Remove',
                () => uiEvents.emit('clubMember', { userId: m.userId, action: 'kick' }),
              )
            }
          >
            Remove from club
          </Button>
        </div>
      )}
    </div>
  );
}

function InviteFriends({ club }: { club: MyClubView }): JSX.Element | null {
  const friends = useUI((s) => s.friends);
  const [sent, setSent] = useState<string[]>([]);
  const inClub = new Set(club.members.map((m) => m.userId));
  const list = friends.filter((f) => !f.recent && !inClub.has(f.id));
  if (list.length === 0) return null;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }}>
      <span className="tr-label">Invite friends</span>
      {list.map((f) => (
        <div key={f.id} className="tr-friend">
          <b className="tr-grow tr-ellipsis">{f.name}</b>
          <Button
            size="sm"
            variant={sent.includes(f.id) ? 'mint' : 'sky'}
            disabled={sent.includes(f.id)}
            onClick={() => {
              setSent((s) => [...s, f.id]);
              uiEvents.emit('clubInvite', { userId: f.id });
            }}
          >
            {sent.includes(f.id) ? 'Invited' : 'Invite'}
          </Button>
        </div>
      ))}
    </div>
  );
}

function Roster({ club, role }: { club: MyClubView; role: string }): JSX.Element {
  return (
    <div className="tr-col" style={{ gap: '0.3em' }} data-testid="club-roster">
      {club.members.map((m) => (
        <MemberRow key={m.userId} m={m} myRole={role} />
      ))}
      {clubCan(role, 'invite') && <InviteFriends club={club} />}
    </div>
  );
}

function ClubChat({ club }: { club: MyClubView }): JSX.Element {
  const chat = useSocial((s) => s.chat);
  const muted = useSocial((s) => s.muted);
  const blocked = useSocial((s) => s.blocked);
  const showChat = useUI((s) => s.settings.gameplay.showChat);
  const filter = useUI((s) => s.settings.gameplay.chatFilter);
  const [text, setText] = useState('');
  const lines = useMemo(
    () =>
      visibleChat(linesOf(chat, 'club'), {
        showChat,
        filter,
        muted,
        blocked: blocked.map((b) => b.userId),
      }).filter((l) => l.channel === 'club'),
    [chat, showChat, filter, muted, blocked],
  );
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="tr-col tr-club-chat" style={{ gap: '0.4em' }} data-testid="club-chat">
      <div ref={list} className="tr-club-chat-lines tr-scroll" aria-live="polite">
        {lines.length === 0 ? (
          <small className="tr-muted">No messages yet. Say hi to {club.name}!</small>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="tr-club-chat-line">
              <b>{l.self ? 'You' : l.from.name}:</b> <span>{l.display}</span>
            </div>
          ))
        )}
      </div>
      <form
        className="tr-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          uiEvents.emit('clubChat', { text });
          setText('');
        }}
      >
        <input
          className="tr-input tr-grow"
          data-nav=""
          placeholder="Message your club"
          aria-label="Club chat message"
          value={text}
          maxLength={160}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" variant="mint">
          Send
        </Button>
      </form>
    </div>
  );
}

function Goals(): JSX.Element {
  const goals = useClubs((s) => s.goals);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  useEffect(() => {
    uiEvents.emit('clubGoals');
  }, []);
  if (goals.status === 'error' && !goals.data)
    return (
      <div className="tr-col" style={{ gap: '0.4em' }}>
        <p className="tr-muted">The club goals didn't load.</p>
        <Button size="sm" variant="sky" onClick={() => uiEvents.emit('clubGoals')}>
          Retry
        </Button>
      </div>
    );
  if (!goals.data) return <small className="tr-muted">Loading this week's goals…</small>;
  const d = goals.data;
  const days = Math.max(0, Math.ceil((d.refreshesAt - Date.now()) / 86_400_000));
  return (
    <div className="tr-col" style={{ gap: '0.5em' }} data-testid="club-goals">
      <small className="tr-muted">
        New goals in {days} day{days === 1 ? '' : 's'}. Everyone who plays at least one show this week earns
        each finished goal.
      </small>
      {!d.eligible && <p className="tr-club-note">Play a show this week to share in the rewards.</p>}
      {d.goals.map((g) => (
        <div key={g.goalId} className="tr-club-goal">
          <div className="tr-row" style={{ flexWrap: 'wrap' }}>
            <b className="tr-grow">{g.title}</b>
            <small className="tr-muted">
              +{g.reward.xp} XP · +{g.reward.gumballs} Gumballs
            </small>
          </div>
          <div
            className="tr-club-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={g.target}
            aria-valuenow={g.progress}
            aria-label={g.title}
          >
            <span style={{ width: `${Math.min(100, (g.progress / g.target) * 100)}%` }} />
          </div>
          <div className="tr-row">
            <small className="tr-grow">
              {g.progress}/{g.target}
            </small>
            {g.claimed ? (
              <span className="tr-chip tr-chip--good">Collected</span>
            ) : g.completed && d.eligible ? (
              <Button
                size="sm"
                variant="go"
                onClick={() => uiEvents.emit('clubClaim', { week: d.week, goalId: g.goalId })}
              >
                Collect
              </Button>
            ) : g.completed ? (
              <span className="tr-chip">Done</span>
            ) : null}
          </div>
        </div>
      ))}
      <span className="tr-label">This week's crew</span>
      {d.contributions.length === 0 ? (
        <small className="tr-muted">Nobody has played for the club this week yet.</small>
      ) : (
        <ol className="tr-club-board">
          {d.contributions.map((c) => (
            <li key={c.userId}>
              <b className="tr-grow tr-ellipsis">
                {c.name}
                <small className="tr-muted">#{streamer ? '••••' : c.tag}</small>
              </b>
              <small>
                {c.shows} shows · {c.crowns} crowns · {c.rounds} rounds
              </small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Requests(): JSX.Element {
  const requests = useClubs((s) => s.joinRequests);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  if (requests.length === 0) return <small className="tr-muted">No one is waiting to join.</small>;
  return (
    <div className="tr-col" style={{ gap: '0.3em' }} data-testid="club-requests">
      {requests.map((r) => {
        const shown = streamerSafeAccount(r, streamer);
        return (
          <div key={r.userId} className="tr-friend">
            <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
              <b className="tr-ellipsis">
                {shown.name}
                <small className="tr-muted">#{shown.tag}</small>
              </b>
              <small className="tr-muted">Level {r.level}</small>
            </div>
            <Button
              size="sm"
              variant="mint"
              onClick={() => uiEvents.emit('clubRequestAnswer', { userId: r.userId, accept: true })}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => uiEvents.emit('clubRequestAnswer', { userId: r.userId, accept: false })}
            >
              Decline
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ReportClub({ club }: { club: ClubCardView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ClubReportReason>('name');
  const [details, setDetails] = useState('');
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Report this club
      </Button>
    );
  return (
    <div className="tr-col" style={{ gap: '0.4em' }}>
      <span className="tr-label">What's wrong?</span>
      <Segmented
        label="Report reason"
        value={reason}
        options={CLUB_REPORT_REASONS.map((r) => ({ value: r, label: CLUB_REPORT_LABEL[r] }))}
        onChange={setReason}
      />
      <textarea
        className="tr-input"
        data-nav=""
        rows={2}
        maxLength={500}
        placeholder="Details (optional)"
        aria-label="Report details"
        value={details}
        onChange={(e) => setDetails(e.target.value)}
      />
      <div className="tr-row">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            uiEvents.emit('clubReport', {
              clubId: club.id,
              reason,
              ...(details.trim() ? { details: details.trim() } : {}),
            });
            setOpen(false);
          }}
        >
          Send report
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Settings({ club, role }: { club: MyClubView; role: string }): JSX.Element {
  const [description, setDescription] = useState(club.description);
  const [name, setName] = useState(club.name);
  const [tag, setTag] = useState(club.tag);
  const [emblem, setEmblem] = useState<ClubEmblem>(club.emblem);
  const canEdit = clubCan(role, 'edit');
  const canRename = clubCan(role, 'rename');
  const desc = checkClubDescription(description);
  const nameCheck = checkClubName(name);
  const tagCheck = checkClubTag(tag);
  return (
    <div className="tr-col" style={{ gap: '0.6em' }} data-testid="club-settings">
      {canRename && (
        <div className="tr-col" style={{ gap: '0.3em' }}>
          <span className="tr-label">Name and tag</span>
          <div className="tr-row" style={{ flexWrap: 'wrap' }}>
            <input
              className="tr-input tr-grow"
              data-nav=""
              aria-label="Club name"
              value={name}
              maxLength={CLUB_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="tr-input tr-club-tag-input"
              data-nav=""
              aria-label="Club tag"
              value={tag}
              maxLength={CLUB_TAG_MAX}
              onChange={(e) => setTag(e.target.value.toUpperCase())}
            />
            <Button
              size="sm"
              variant="mint"
              disabled={!nameCheck.ok || !tagCheck.ok || (name === club.name && tag === club.tag)}
              onClick={() => uiEvents.emit('clubEdit', { name, tag })}
            >
              Rename
            </Button>
          </div>
          {!nameCheck.ok && (
            <small className="tr-field-error">{CLUB_TEXT_MESSAGES.name[nameCheck.reason]}</small>
          )}
          {!tagCheck.ok && (
            <small className="tr-field-error">{CLUB_TEXT_MESSAGES.tag[tagCheck.reason]}</small>
          )}
        </div>
      )}
      {canEdit && (
        <>
          <span className="tr-label">Who can join</span>
          <Segmented
            label="Who can join"
            value={club.joinMode}
            options={CLUB_JOIN_MODES.map((m) => ({ value: m, label: JOIN_MODE_LABEL[m].split(':')[0]! }))}
            onChange={(joinMode) => uiEvents.emit('clubEdit', { joinMode })}
          />
          <label className="tr-col" style={{ gap: '0.2em' }}>
            <span className="tr-label">Description</span>
            <textarea
              className="tr-input"
              data-nav=""
              rows={2}
              value={description}
              maxLength={CLUB_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {!desc.ok && (
            <small className="tr-field-error">{CLUB_TEXT_MESSAGES.description[desc.reason]}</small>
          )}
          <span className="tr-label">Emblem</span>
          <EmblemPicker value={emblem} onChange={setEmblem} />
          <Button
            size="sm"
            variant="mint"
            disabled={!desc.ok}
            onClick={() => uiEvents.emit('clubEdit', { description, emblem })}
          >
            Save description and emblem
          </Button>
        </>
      )}
      {!canEdit && <p className="tr-muted">Officers and the owner look after the club's settings.</p>}
      <div className="tr-row" style={{ flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            confirmAction(
              'club-leave',
              `Leave ${club.name}?`,
              role === 'owner'
                ? 'The longest-serving officer (or member) becomes the owner. Unclaimed goals stay with the club.'
                : 'Unclaimed goal rewards stay with the club.',
              'Leave',
              () => uiEvents.emit('clubLeave', {}),
            )
          }
        >
          Leave club
        </Button>
        {clubCan(role, 'disband') && (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              confirmAction(
                'club-disband',
                `Disband ${club.name}?`,
                'Everyone is removed and the club is gone for good. Its name becomes free again.',
                'Disband',
                () => uiEvents.emit('clubLeave', { disband: true }),
              )
            }
          >
            Disband
          </Button>
        )}
      </div>
      <ReportClub club={club} />
    </div>
  );
}

const TABS: { id: ClubTab; label: string; officers?: boolean }[] = [
  { id: 'roster', label: 'Roster' },
  { id: 'chat', label: 'Chat' },
  { id: 'goals', label: 'Goals' },
  { id: 'requests', label: 'Requests', officers: true },
  { id: 'settings', label: 'Settings' },
];

function MyClub({ club }: { club: MyClubView }): JSX.Element {
  const role = useClubs((s) => s.role) ?? 'member';
  const tab = useClubs((s) => s.tab);
  const requests = useClubs((s) => s.joinRequests.length);
  const tabs = TABS.filter((t) => !t.officers || clubCan(role, 'acceptRequest'));
  return (
    <div className="tr-col" style={{ gap: '0.6em' }} data-testid="club-page">
      <div className="tr-club-head">
        <ClubEmblemBadge emblem={club.emblem} size="3.4em" />
        <div className="tr-col tr-grow" style={{ gap: 0, minWidth: 0 }}>
          <h3 className="tr-title tr-h3 tr-ellipsis">
            {club.name} <TagLabel tag={club.tag} own />
          </h3>
          <small className="tr-muted">
            {club.memberCount}/{club.maxMembers} members · you are {CLUB_ROLE_LABEL[role].toLowerCase()}
          </small>
        </div>
      </div>
      {club.description && <p className="tr-club-desc">{club.description}</p>}
      <div className="tr-club-tabs tr-scroll-x" role="tablist" aria-label="Club" data-nav-tabs="">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-nav=""
            aria-selected={t.id === tab}
            className={`tr-club-tab${t.id === tab ? ' is-active' : ''}`}
            onClick={() => clubs.getState().setTab(t.id)}
          >
            {t.label}
            {t.id === 'requests' && requests > 0 ? ` · ${requests}` : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label}>
        {tab === 'roster' && <Roster club={club} role={role} />}
        {tab === 'chat' && <ClubChat club={club} />}
        {tab === 'goals' && <Goals />}
        {tab === 'requests' && <Requests />}
        {tab === 'settings' && <Settings key={`${club.name}:${club.tag}`} club={club} role={role} />}
      </div>
    </div>
  );
}

/** The Club section of the social sheet. */
export function ClubPanel(): JSX.Element {
  const status = useClubs((s) => s.status);
  const error = useClubs((s) => s.error);
  const club = useClubs((s) => s.club);
  useEffect(() => {
    if (clubs.getState().status === 'idle') uiEvents.emit('clubRefresh');
  }, []);
  if (status === 'disabled')
    return (
      <p className="tr-muted" data-testid="club-disabled">
        Clubs are switched off for a moment. Your club is safe and will be back soon.
      </p>
    );
  if (status === 'error' && !club)
    return (
      <div className="tr-col" style={{ gap: '0.4em' }} data-testid="club-error">
        <p className="tr-muted">{error ?? "Your club didn't load."}</p>
        <Button size="sm" variant="sky" autoFocusNav onClick={() => uiEvents.emit('clubRefresh')}>
          Retry
        </Button>
      </div>
    );
  if (status === 'idle' || (status === 'loading' && !club))
    return (
      <small className="tr-muted" role="status" data-testid="club-loading">
        Loading your club…
      </small>
    );
  return club ? <MyClub club={club} /> : <NoClub />;
}
