/**
 * Per-player actions: the action menu opened from chat lines and friend rows,
 * the report dialog with its reason picker, the action row on profile cards,
 * and the confirmations for removing and blocking.
 *
 * Mute is local (persisted by the game); block, report and friend requests
 * need the online account, so those buttons only appear when it is reachable.
 */
import { useState, type JSX } from 'react';
import { Button } from '../../components/controls.tsx';
import { uiEvents } from '../../store/events.ts';
import { social, useSocial, type PlayerRef } from '../../store/social.ts';
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

/** Player actions for one player, as a row of buttons. */
export function PlayerActionRow({ p, compact }: { p: PlayerRef; compact?: boolean }): JSX.Element {
  const online = useSocial((s) => s.availability === 'online');
  const muted = useSocial((s) => s.muted.includes(p.key));
  const blocked = useSocial((s) => !!p.userId && s.blocked.some((b) => b.userId === p.userId));
  const outgoing = useSocial((s) => !!p.userId && s.outgoing.some((r) => r.userId === p.userId));
  const isFriend = useUI((s) => !!p.userId && s.friends.some((f) => f.id === p.userId && !f.recent));
  const isSelf = useUI((s) => !!p.userId && s.profile?.id === p.userId);
  const [sent, setSent] = useState(false);
  if (isSelf) return <></>;
  const account = online && !!p.userId && !p.isBot;
  const size = compact ? 'sm' : 'md';
  return (
    <div className="tr-player-actions">
      {account && !isFriend && !blocked && (
        <Button
          size={size}
          variant={sent || outgoing ? 'mint' : 'sky'}
          disabled={sent || outgoing}
          onClick={() => {
            setSent(true);
            uiEvents.emit('requestFriend', { userId: p.userId!, name: p.name });
          }}
        >
          {sent || outgoing ? 'Request sent' : 'Add friend'}
        </Button>
      )}
      <Button
        size={size}
        variant="secondary"
        onClick={() => uiEvents.emit('mutePlayer', { key: p.key, name: p.name, muted: !muted })}
      >
        {muted ? 'Unmute' : 'Mute'}
      </Button>
      {account &&
        (blocked ? (
          <Button
            size={size}
            variant="secondary"
            onClick={() => uiEvents.emit('unblockPlayer', { userId: p.userId! })}
          >
            Unblock
          </Button>
        ) : (
          <Button size={size} variant="secondary" onClick={() => confirmBlock(p.userId!, p.name)}>
            Block
          </Button>
        ))}
      {account && (
        <Button size={size} variant="danger" onClick={() => social.getState().openReport(p)}>
          Report
        </Button>
      )}
    </div>
  );
}

/** Action menu for the player picked from chat or a friend row. */
export function PlayerMenu(): JSX.Element | null {
  const p = useSocial((s) => s.playerMenu);
  const online = useSocial((s) => s.availability === 'online');
  if (!p) return null;
  const close = (): void => social.getState().openPlayerMenu(null);
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="16"
      role="dialog"
      aria-modal="true"
      aria-label={`Actions for ${p.name}`}
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-player-menu tr-enter-pop" data-testid="player-menu">
        <b className="tr-title tr-h3">
          {p.name}
          {p.tag && <small className="tr-muted">#{p.tag}</small>}
        </b>
        {p.isBot && <small className="tr-muted">Bot</small>}
        {online && p.userId && !p.isBot && (
          <Button
            variant="sky"
            block
            onClick={() => {
              close();
              uiEvents.emit('inspectPlayer', { playerId: p.userId!, name: p.name });
            }}
          >
            View profile
          </Button>
        )}
        <PlayerActionRow p={p} />
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
