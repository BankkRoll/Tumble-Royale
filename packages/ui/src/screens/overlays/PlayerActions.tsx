/**
 * Per-player actions: the shared player card opened from chat names, friend
 * and recent rows, party slots, lobby members and the spectate banner,
 * the report dialog with its reason picker, the action row on profile cards,
 * and the confirmations for removing and blocking.
 *
 * Mute is local (persisted by the game); block, report and friend requests
 * need the online account, so those buttons only appear when it is reachable.
 */
import { useState, type JSX, type ReactNode } from 'react';
import { Button } from '../../components/controls.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { openWhisper } from '../../hud/ChatWidget.tsx';
import { uiEvents } from '../../store/events.ts';
import { PRESENCE_LABEL, social, useSocial, type PlayerRef } from '../../store/social.ts';
import type { ReportReason } from '../../store/types.ts';
import { ui, useUI } from '../../store/uiStore.ts';

/** Report reasons in display order. */
export const REPORT_REASONS: { id: ReportReason; label: string; hint: string }[] = [
  { id: 'harassment', label: 'Harassment', hint: 'Abusive chat, threats, hate' },
  { id: 'offensive_name', label: 'Offensive name', hint: 'Name or tag breaks the rules' },
  { id: 'cheating', label: 'Cheating', hint: 'Speed, flying, impossible moves' },
  { id: 'griefing', label: 'Griefing', hint: 'Ruining rounds on purpose' },
  { id: 'spam', label: 'Spam', hint: 'Flooding chat or pings' },
  { id: 'other', label: 'Something else', hint: 'Tell us in the details' },
];

// NOTE: a dialog dismissed without a button never reports back, so a stale
// listener is dropped when the next confirmation opens.
let pendingConfirm: (() => void) | null = null;

function confirm(id: string, title: string, body: string, label: string, onYes: () => void): void {
  ui.getState().showDialog({
    id,
    kind: 'confirm',
    title,
    body,
    buttons: [
      { id: 'cancel', label: 'Cancel', variant: 'secondary', autofocus: true },
      { id: 'confirm', label, variant: 'danger' },
    ],
  });
  pendingConfirm?.();
  const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (dialogId !== id) return;
    off();
    pendingConfirm = null;
    if (buttonId === 'confirm') onYes();
  });
  pendingConfirm = off;
}

/**
 * Asks before a destructive action (club kicks, hand-overs, leaving).
 *
 * @param id - Dialog id.
 * @param title - Question.
 * @param body - What will happen.
 * @param label - Confirm button label.
 * @param onYes - Runs when confirmed.
 */
export function confirmAction(
  id: string,
  title: string,
  body: string,
  label: string,
  onYes: () => void,
): void {
  confirm(id, title, body, label, onYes);
}

/**
 * Asks before removing a friend.
 *
 * @param userId - Friend's account id.
 * @param name - Display name for the prompt.
 */
export function confirmRemoveFriend(userId: string, name: string): void {
  confirm(
    'remove-friend',
    `Remove ${name}?`,
    'They leave your friends list. You can send a new request any time.',
    'Remove',
    () => uiEvents.emit('removeFriend', { userId }),
  );
}

/**
 * Asks before blocking a player.
 *
 * @param userId - Account id.
 * @param name - Display name for the prompt.
 */
export function confirmBlock(userId: string, name: string): void {
  confirm(
    'block-player',
    `Block ${name}?`,
    "You won't see their chat or pings, they can't send you requests or invites, and any friendship ends. Unblock from the Friends sheet.",
    'Block',
    () => uiEvents.emit('blockPlayer', { userId, name }),
  );
}

/**
 * Wraps a player's avatar/name so clicking it opens the shared player card.
 *
 * @param player - Who the card is for.
 * @param disabled - Render plain content (e.g. your own row).
 */
export function PlayerButton({
  player,
  disabled,
  children,
}: {
  player: PlayerRef;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  if (disabled) return <div className="tr-player-link is-static">{children}</div>;
  return (
    <button
      type="button"
      className="tr-player-link"
      data-nav=""
      aria-label={`Player card for ${player.name}`}
      onClick={() => social.getState().openPlayerMenu(player)}
    >
      {children}
    </button>
  );
}

/** What the local player can do with another player right now. */
function useRelations(p: PlayerRef) {
  const online = useSocial((s) => s.availability === 'online');
  const muted = useSocial((s) => s.muted.includes(p.key));
  const blocked = useSocial((s) => !!p.userId && s.blocked.some((b) => b.userId === p.userId));
  const outgoing = useSocial((s) => !!p.userId && s.outgoing.some((r) => r.userId === p.userId));
  const incoming = useSocial((s) => !!p.userId && s.incoming.some((r) => r.userId === p.userId));
  const friend = useUI((s) => (p.userId ? s.friends.find((f) => f.id === p.userId && !f.recent) : undefined));
  const isSelf = useUI((s) => !!p.userId && s.profile?.id === p.userId);
  const party = useUI((s) => s.party);
  const lobby = useUI((s) => s.customLobby);
  const me = party?.members.find((m) => m.isSelf);
  const inMyParty = !!p.userId && !!party?.members.some((m) => m.id === p.userId && !m.isSelf);
  const inMyLobby =
    !!p.userId &&
    !!lobby &&
    [...lobby.players, ...lobby.spectators].some((m) => m.id === p.userId && !m.isSelf);
  const account = online && !!p.userId && !p.isBot;
  return {
    online,
    muted,
    blocked,
    outgoing,
    incoming,
    friend,
    isSelf,
    account,
    inMyParty,
    partyFull: !!party && party.members.length >= party.maxSize,
    leader: !!me?.isLeader,
    lobbyHost: inMyLobby && !!lobby?.isHost && !lobby.started,
  };
}

/** Player actions for one player, as a wrapping row of buttons. */
export function PlayerActionRow({
  p,
  compact,
  onDone,
}: {
  p: PlayerRef;
  compact?: boolean;
  /** Called after an action that should close the surrounding card. */
  onDone?: () => void;
}): JSX.Element {
  const r = useRelations(p);
  const [sent, setSent] = useState(false);
  const [invited, setInvited] = useState(false);
  if (r.isSelf) return <></>;
  const size = compact ? 'sm' : 'md';
  const done = (): void => onDone?.();
  const uid = p.userId ?? '';
  return (
    <div className="tr-player-actions">
      {r.account && r.friend && (
        <Button
          size={size}
          variant="sky"
          onClick={() => {
            done();
            openWhisper(uid, p.name, p.tag);
          }}
        >
          Whisper
        </Button>
      )}
      {r.account && r.friend?.joinable && !r.inMyParty && (
        <Button
          size={size}
          variant="go"
          onClick={() => {
            done();
            uiEvents.emit('joinFriend', { userId: uid });
          }}
        >
          Join party
        </Button>
      )}
      {r.account && r.friend && !r.inMyParty && !r.partyFull && r.friend.presence !== 'offline' && (
        <Button
          size={size}
          variant={invited ? 'mint' : 'sky'}
          disabled={invited}
          onClick={() => {
            setInvited(true);
            uiEvents.emit('inviteFriend', { friendId: uid });
          }}
        >
          {invited ? 'Invite sent' : 'Invite to party'}
        </Button>
      )}
      {r.account && !r.friend && !r.blocked && r.incoming && (
        <Button
          size={size}
          variant="mint"
          onClick={() => uiEvents.emit('friendRequestAction', { userId: uid, action: 'accept' })}
        >
          Accept friend
        </Button>
      )}
      {r.account && !r.friend && !r.blocked && !r.incoming && (
        <Button
          size={size}
          variant={sent || r.outgoing ? 'mint' : 'sky'}
          disabled={sent || r.outgoing}
          onClick={() => {
            setSent(true);
            uiEvents.emit('requestFriend', { userId: uid, name: p.name });
          }}
        >
          {sent || r.outgoing ? 'Requested' : 'Add friend'}
        </Button>
      )}
      {r.leader && r.inMyParty && (
        <>
          <Button
            size={size}
            variant="secondary"
            onClick={() => {
              done();
              uiEvents.emit('promotePartyMember', { memberId: uid });
            }}
          >
            Make leader
          </Button>
          <Button
            size={size}
            variant="secondary"
            onClick={() => {
              done();
              uiEvents.emit('kickPartyMember', { memberId: uid });
            }}
          >
            Kick from party
          </Button>
        </>
      )}
      {r.lobbyHost && (
        <>
          <Button
            size={size}
            variant="secondary"
            onClick={() => {
              done();
              uiEvents.emit('transferCustomHost', { userId: uid });
            }}
          >
            Make host
          </Button>
          <Button
            size={size}
            variant="secondary"
            onClick={() => {
              done();
              uiEvents.emit('kickCustomMember', { userId: uid });
            }}
          >
            Kick from show
          </Button>
        </>
      )}
      <Button
        size={size}
        variant="secondary"
        onClick={() => uiEvents.emit('mutePlayer', { key: p.key, name: p.name, muted: !r.muted })}
      >
        {r.muted ? 'Unmute' : 'Mute'}
      </Button>
      {r.account &&
        (r.blocked ? (
          <Button
            size={size}
            variant="secondary"
            onClick={() => uiEvents.emit('unblockPlayer', { userId: uid })}
          >
            Unblock
          </Button>
        ) : (
          <Button
            size={size}
            variant="secondary"
            onClick={() => {
              done();
              confirmBlock(uid, p.name);
            }}
          >
            Block
          </Button>
        ))}
      {r.account && (
        <Button size={size} variant="danger" onClick={() => social.getState().openReport(p)}>
          Report
        </Button>
      )}
    </div>
  );
}

/** The shared player card: chat names, friend rows, party slots, lobby members, spectate banner. */
export function PlayerMenu(): JSX.Element | null {
  const p = useSocial((s) => s.playerMenu);
  const online = useSocial((s) => s.availability === 'online');
  const friend = useUI((s) => (p?.userId ? s.friends.find((f) => f.id === p.userId) : undefined));
  const member = useUI((s) => (p?.userId ? s.party?.members.find((m) => m.id === p.userId) : undefined));
  if (!p) return null;
  const close = (): void => social.getState().openPlayerMenu(null);
  const colors = friend?.colors ?? member?.colors;
  const tag = p.tag ?? friend?.tag ?? member?.tag;
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="16"
      role="dialog"
      aria-modal="true"
      aria-label={`${p.name}'s player card`}
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-player-menu tr-enter-pop" data-testid="player-menu">
        <div className="tr-row tr-player-head">
          {colors && <TumblerAvatar colors={colors} size="3.2em" blink={false} noShadow />}
          <div className="tr-col" style={{ gap: '0.1em', minWidth: 0, textAlign: 'left' }}>
            <b className="tr-title tr-h3 tr-ellipsis">
              {p.name}
              {tag && <small className="tr-muted">#{tag}</small>}
            </b>
            {p.isBot ? (
              <small className="tr-muted">Bot</small>
            ) : friend && !friend.recent ? (
              <span className={`tr-presence ${friend.presence === 'offline' ? 'is-offline' : 'is-online'}`}>
                {PRESENCE_LABEL[friend.presence]}
                {friend.playlist ? `: ${friend.playlist}` : ''}
              </span>
            ) : member ? (
              <small className="tr-muted">{member.isLeader ? 'Party leader' : 'In your party'}</small>
            ) : null}
          </div>
        </div>
        {online && p.userId && !p.isBot && (
          <Button
            variant="sky"
            block
            autoFocusNav
            onClick={() => {
              close();
              uiEvents.emit('inspectPlayer', { playerId: p.userId!, name: p.name, direct: true });
            }}
          >
            View profile
          </Button>
        )}
        <PlayerActionRow p={p} onDone={close} />
        <Button variant="ghost" data-nav-back="" hint="Esc" onClick={close}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** Report dialog: pick a reason, add optional details, send. */
export function ReportDialog(): JSX.Element | null {
  const p = useSocial((s) => s.reportTarget);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  if (!p || !p.userId) return null;
  const close = (): void => {
    setReason(null);
    setDetails('');
    social.getState().openReport(null);
  };
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="17"
      role="dialog"
      aria-modal="true"
      aria-label={`Report ${p.name}`}
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-report tr-enter-pop" data-testid="report-dialog">
        <h2 className="tr-title tr-h3">Report {p.name}</h2>
        <div className="tr-report-reasons" role="radiogroup" aria-label="Reason">
          {REPORT_REASONS.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={reason === r.id}
              data-nav=""
              className={`tr-report-reason${reason === r.id ? ' is-picked' : ''}`}
              onClick={() => setReason(r.id)}
            >
              <b>{r.label}</b>
              <small>{r.hint}</small>
            </button>
          ))}
        </div>
        <textarea
          className="tr-input tr-report-details"
          placeholder="What happened? (optional)"
          maxLength={500}
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          aria-label="Details"
        />
        <div className="tr-row">
          <Button variant="secondary" data-nav-back="" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason}
            onClick={() => {
              if (!reason) return;
              uiEvents.emit('reportPlayer', {
                userId: p.userId!,
                reason,
                ...(details.trim() ? { details: details.trim() } : {}),
              });
              close();
            }}
          >
            Send report
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Player menu + report dialog layer (mounted once by the App). */
export function SocialLayer(): JSX.Element {
  return (
    <>
      <PlayerMenu />
      <ReportDialog />
    </>
  );
}
