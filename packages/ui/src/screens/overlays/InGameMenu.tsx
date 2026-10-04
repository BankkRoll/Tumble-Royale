/**
 * In-round menu (Esc / Start / the HUD menu button): where you are in the
 * show, your controls, Settings and Leave show. Rounds never pause (the show
 * runs for everyone), so the header says so instead of "Paused".
 */
import { type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../../audio-cues.ts';
import { TypeBadge } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { BIND_ACTION_LABELS } from '../../store/defaults.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { BindAction, LocalStatus, ShowSeat } from '../../store/types.ts';
import { PAD_GLYPHS, controlGlyph } from '../../hud/glyphs.ts';
import { keyLabel } from './SettingsSheet.tsx';
import { ShowHostTools } from './ShowHostTools.tsx';

const STATUS: Record<LocalStatus, { label: string; tone: string }> = {
  playing: { label: 'Still in it', tone: 'is-playing' },
  qualified: { label: 'Qualified', tone: 'is-qualified' },
  eliminated: { label: 'Eliminated', tone: 'is-out' },
  spectating: { label: 'Spectating', tone: 'is-out' },
};

/**
 * What the local player is doing while they watch: knocked-out players are
 * "Eliminated · Spectating"; spectator seats (and anyone still in the show
 * between their own rounds) are just "Spectating".
 *
 * @param seat - The local show seat.
 */
export function spectatingLabel(seat: ShowSeat | null): string {
  return seat?.outOfShow && !seat.spectator ? 'Eliminated · Spectating' : 'Spectating';
}

const CONTROL_ROWS: BindAction[] = ['jump', 'dive', 'grab', 'emoteWheel'];
const SPECTATE_ROWS: BindAction[] = ['spectatePrev', 'spectateNext'];

/** Opens the in-round menu. */
export function openInGameMenu(): void {
  playCue('ui.whoosh');
  ui.getState().setOverlay('inGameMenu');
}

function close(): void {
  playCue('ui.back');
  ui.getState().setOverlay('none');
}

/**
 * Leave-show dialog body, accurate per mode: offline the profile banks the
 * played rounds on the spot; online the game server reports the leaver's
 * rounds with the show and the account API grants them then.
 *
 * @param seat - The local seat (null outside a show: treated as offline).
 * @returns Dialog body copy.
 */
export function leaveShowBody(seat: ShowSeat | null): string {
  const rounds = seat?.online
    ? 'Rewards for the rounds you already played are added when the show finishes.'
    : 'Rewards for the rounds you already played are saved now.';
  return `You'll be out of this show and back in the menu. ${rounds} Show and placement bonuses need you to stay until the end.`;
}

let pendingLeave: (() => void) | null = null;

/**
 * Asks "Leave the show?" and emits `leaveShow` only on an explicit confirm.
 * Every Leave button in a show goes through here, so no single key press
 * (Esc, pad B) can drop a player out of the show.
 */
export function confirmLeaveShow(): void {
  const seat = ui.getState().showSeat;
  // NOTE: a second open (double click, menu then watch choice) must not stack listeners and emit twice.
  pendingLeave?.();
  ui.getState().showDialog({
    id: 'leaveShow',
    kind: 'confirm',
    title: 'Leave the show?',
    body: leaveShowBody(seat),
    buttons: [
      {
        id: 'cancel',
        label: seat?.outOfShow || seat?.spectator ? 'Keep watching' : 'Keep playing',
        variant: 'secondary',
        autofocus: true,
      },
      { id: 'confirm', label: 'Leave show', variant: 'danger' },
    ],
  });
  const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (dialogId !== 'leaveShow') return;
    off();
    pendingLeave = null;
    if (buttonId === 'confirm') {
      ui.getState().setOverlay('none');
      uiEvents.emit('leaveShow');
    }
  });
  pendingLeave = off;
}

/** The in-round menu overlay. */
export function InGameMenu(): JSX.Element {
  const intro = useUI((s) => s.roundIntro);
  const showName = useUI((s) => s.showIntro?.showName ?? s.preShow?.showName ?? 'Show');
  const hud = useUI(
    useShallow((s) => ({
      status: s.hud.localStatus,
      qualified: s.hud.qualified,
      target: s.hud.qualifyTarget,
      alive: s.hud.alive,
    })),
  );
  const binds = useUI((s) => s.settings.controls.keybinds);
  const device = useUI((s) => s.hud.device);
  const outOfShow = useUI((s) => s.showSeat?.outOfShow ?? false);
  const watchingLabel = useUI((s) => spectatingLabel(s.showSeat));
  const replayLive = useUI((s) => s.replayLive);
  const status = outOfShow ? { label: watchingLabel, tone: 'is-out' } : STATUS[hud.status];
  return (
    <div
      className="tr-dialog-wrap tr-igm-wrap tr-interactive"
      data-nav-scope="13"
      role="dialog"
      aria-modal="true"
      aria-label="Show menu"
      data-testid="in-game-menu"
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-igm tr-enter-pop">
        <div className="tr-igm-head">
          <div className="tr-col tr-grow" style={{ gap: '0.15em', minWidth: 0 }}>
            <span className="tr-label">{showName}</span>
            <h2 className="tr-title tr-h2 tr-ellipsis">{intro?.name ?? 'Round'}</h2>
          </div>
          <button type="button" className="tr-close" data-nav="" aria-label="Close" onClick={close}>
            <Icon name="close" size="1em" />
          </button>
        </div>
        {intro && (
          <div className="tr-igm-facts">
            <TypeBadge type={intro.type} />
            <span className="tr-chip">
              {intro.isFinal ? 'Final' : `Round ${intro.roundIndex + 1} of ${intro.roundCount}`}
            </span>
            <span className={`tr-chip tr-igm-status ${status.tone}`}>{status.label}</span>
            {hud.target > 0 && hud.status === 'playing' && (
              <span className="tr-chip">
                {hud.qualified}/{hud.target} qualified
              </span>
            )}
          </div>
        )}
        {intro?.objective && <p className="tr-igm-objective">{intro.objective}</p>}
        <p className="tr-small tr-muted tr-igm-live">
          <i className="tr-status-dot is-online" aria-hidden /> The show keeps running while this menu is
          open.
        </p>
        {device !== 'touch' && (
          <div className="tr-igm-keys" aria-label="Controls">
            {(hud.status === 'spectating' || outOfShow ? SPECTATE_ROWS : CONTROL_ROWS).map((a) => (
              <span key={a} className="tr-hud-hint-item">
                <kbd>{controlGlyph(a, device, binds)}</kbd>
                {BIND_ACTION_LABELS[a]}
              </span>
            ))}
            <span className="tr-hud-hint-item" data-testid="igm-menu-key">
              <kbd>{device === 'gamepad' ? PAD_GLYPHS.pause : keyLabel(binds.pause[0] || 'Escape')}</kbd>
              {BIND_ACTION_LABELS.pause}
            </span>
            {device === 'keyboard' && (
              <span className="tr-hud-hint-item">
                <kbd>Esc</kbd>
                Free the mouse
              </span>
            )}
          </div>
        )}
        <ShowHostTools />
        <div className="tr-igm-actions">
          <Button variant="go" size="lg" block autoFocusNav cue="ui.confirm" data-nav-back="" onClick={close}>
            Resume
          </Button>
          {replayLive && (hud.status === 'eliminated' || hud.status === 'spectating') && (
            <Button
              variant="secondary"
              block
              data-testid="igm-replay"
              // The game closes this menu while the replay plays and reopens it on exit.
              onClick={() => uiEvents.emit('replayOpenLive')}
            >
              <Icon name="film" size="1.1em" /> Watch replay
            </Button>
          )}
          <Button
            variant="secondary"
            block
            data-testid="igm-settings"
            onClick={() => {
              playCue('ui.click');
              ui.getState().setOverlay('settings');
            }}
          >
            <Icon name="gear" size="1.1em" /> Settings
          </Button>
          {hud.status !== 'playing' && (
            <Button
              variant="secondary"
              block
              data-testid="igm-photo"
              onClick={() => {
                ui.getState().setOverlay('none');
                uiEvents.emit('photoMode');
              }}
            >
              <Icon name="camera" size="1.1em" /> Photo mode
            </Button>
          )}
          <Button variant="danger" block data-testid="igm-leave" onClick={confirmLeaveShow}>
            Leave show
          </Button>
        </div>
      </div>
    </div>
  );
}
