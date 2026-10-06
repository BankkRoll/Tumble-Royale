/**
 * System layers: toasts (cards + in-round feed), modal dialogs and the
 * reconnecting curtain.
 */
import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';
import type { ConnectionState, DialogButton, Toast } from '../store/types.ts';
import { Button } from './controls.tsx';
import { TumblerAvatar } from './TumblerAvatar.tsx';

const TOAST_ICON: Record<Toast['kind'], string> = {
  info: '💬',
  success: '✅',
  warning: '⚠️',
  error: '💥',
  reward: '🎁',
  social: '👋',
};

function ToastCard({ toast }: { toast: Toast }): JSX.Element {
  const duration = toast.durationMs ?? 4000;
  useEffect(() => {
    playCue('ui.toast');
    if (duration <= 0) return;
    const id = window.setTimeout(() => ui.getState().dismissToast(toast.id), duration);
    return () => window.clearTimeout(id);
  }, [toast.id, duration]);
  return (
    <div className={`tr-toast tr-toast--${toast.kind} tr-interactive`} role="status">
      <span className="tr-toast-icon" aria-hidden>
        {toast.icon ?? TOAST_ICON[toast.kind]}
      </span>
      <div className="tr-grow">
        <div className="tr-toast-title">{toast.title}</div>
        {toast.body && <div className="tr-toast-body">{toast.body}</div>}
        {toast.actions && (
          <div className="tr-row" style={{ marginTop: '0.4em' }}>
            {toast.actions.map((a, i) => (
              <Button
                key={a.id}
                size="sm"
                variant={i === 0 ? 'mint' : 'secondary'}
                onClick={() => {
                  uiEvents.emit('toastAction', { toastId: toast.id, actionId: a.id });
                  ui.getState().dismissToast(toast.id);
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="tr-toast-close"
        aria-label="Dismiss"
        onClick={() => ui.getState().dismissToast(toast.id)}
      >
        ✕
      </button>
      {duration > 0 && <i className="tr-toast-timer" style={{ animationDuration: `${duration}ms` }} />}
    </div>
  );
}

function FeedLine({ toast }: { toast: Toast }): JSX.Element {
  // Feed lines always fade: 0 (sticky) would otherwise dismiss at once.
  const duration = toast.durationMs || 3500;
  useEffect(() => {
    const id = window.setTimeout(() => ui.getState().dismissToast(toast.id), duration);
    return () => window.clearTimeout(id);
  }, [toast.id, duration]);
  return (
    <div className="tr-feed-line" style={toast.color ? { ['--accent' as string]: toast.color } : undefined}>
      {toast.icon && <span aria-hidden>{toast.icon}</span>}
      <span>{toast.title}</span>
    </div>
  );
}

/** Toast cards (top-right) and in-round feed (left). */
export const ToastLayer = memo(function ToastLayer(): JSX.Element {
  const toasts = useUI((s) => s.toasts);
  return (
    <>
      <div className="tr-toasts" aria-live="polite">
        {toasts
          .filter((t) => t.variant === 'card')
          .map((t) => (
            <ToastCard key={t.id} toast={t} />
          ))}
      </div>
      <div className="tr-feed" aria-live="polite">
        {toasts
          .filter((t) => t.variant === 'feed')
          .map((t) => (
            <FeedLine key={t.id} toast={t} />
          ))}
      </div>
    </>
  );
});

function defaultButtons(kind: string): DialogButton[] {
  if (kind === 'confirm' || kind === 'purchase') {
    return [
      { id: 'cancel', label: 'Cancel', variant: 'secondary', autofocus: true },
      { id: 'confirm', label: 'Confirm', variant: kind === 'purchase' ? 'mint' : 'primary' },
    ];
  }
  return [{ id: 'ok', label: 'OK', autofocus: true }];
}

/** Modal dialog (confirm / error / info / purchase). */
export const DialogLayer = memo(function DialogLayer(): JSX.Element | null {
  const dialog = useUI((s) => s.dialog);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dialog) return;
    if (dialog.kind === 'error') playCue('ui.error');
    const el = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
    el?.focus({ preventScroll: true });
  }, [dialog]);
  if (!dialog) return null;
  const buttons = dialog.buttons ?? defaultButtons(dialog.kind);
  const cancelId =
    buttons.find((b) => b.id === 'cancel' || b.id === 'ok' || b.variant === 'secondary')?.id ??
    buttons[0]?.id ??
    'ok';
  const resolve = (buttonId: string): void => {
    uiEvents.emit('dialogResult', { dialogId: dialog.id, buttonId });
    ui.getState().closeDialog();
  };
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="20"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tr-dialog-title"
    >
      <div className="tr-dim" onClick={() => resolve(cancelId)} />
      <div
        ref={ref}
        className={`tr-panel tr-dialog tr-dialog--${dialog.kind} tr-enter-pop`}
        style={{ ['--tilt' as string]: '-1deg' }}
      >
        <div className="tr-dialog-icon" aria-hidden>
          {dialog.icon ??
            (dialog.kind === 'error'
              ? '😵'
              : dialog.kind === 'purchase'
                ? '🛍️'
                : dialog.kind === 'confirm'
                  ? '🤔'
                  : '💬')}
        </div>
        <h2 id="tr-dialog-title" className="tr-title tr-h2">
          {dialog.title}
        </h2>
        {dialog.body && <p className="tr-dialog-body">{dialog.body}</p>}
        {dialog.code && (
          <button
            type="button"
            className="tr-chip tr-chip--ink tr-dialog-code"
            data-nav=""
            onClick={() => void navigator.clipboard?.writeText(dialog.code ?? '')}
            title="Copy error code"
          >
            {dialog.code} 📋
          </button>
        )}
        <div className="tr-row tr-dialog-buttons">
          {buttons.map((b) => (
            <Button
              key={b.id}
              variant={b.variant ?? 'primary'}
              autoFocusNav={b.autofocus}
              data-nav-back={b.id === cancelId ? '' : undefined}
              cue={b.id === cancelId ? 'ui.back' : 'ui.confirm'}
              onClick={() => resolve(b.id)}
            >
              {b.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
});

/**
 * Curtain status line: the attempt number and the countdown to the next try.
 *
 * @param conn - Connection state.
 * @param now - Epoch ms.
 * @returns Copy, or null when there is no attempt to report.
 */
export function reconnectStatusLine(conn: ConnectionState, now: number): string | null {
  if (conn.attempt === undefined || conn.maxAttempts === undefined) return null;
  const of = `Attempt ${conn.attempt} of ${conn.maxAttempts}`;
  if (conn.nextAttemptAt === undefined) return of;
  const secs = Math.ceil((conn.nextAttemptAt - now) / 1000);
  return secs > 0 ? `${of} in ${secs}s` : `${of}…`;
}

/** Re-renders every 250 ms while `active` (curtain countdown). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Reconnecting curtain; after the last attempt fails it offers Try again and Leave. */
export const ConnectionLayer = memo(function ConnectionLayer(): JSX.Element | null {
  const conn = useUI((s) => s.connection);
  const colors = useUI((s) => s.profile?.colors);
  const now = useNow(conn.status === 'reconnecting');
  if (conn.status === 'lost') {
    return (
      <div
        className="tr-reconnect tr-interactive"
        data-nav-scope="25"
        role="alertdialog"
        aria-live="assertive"
        data-testid="connection-lost"
      >
        <div className="tr-dim" />
        <div className="tr-panel tr-reconnect-card tr-enter-pop">
          <h2 className="tr-title tr-h2">Connection lost</h2>
          <p className="tr-muted">
            {conn.message ?? "We couldn't get your Tumbler back into the show."}
            {conn.maxAttempts !== undefined && ` Tried ${conn.maxAttempts} times.`}
          </p>
          <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
            <Button
              variant="go"
              autoFocusNav
              cue="ui.confirm"
              data-testid="connection-retry"
              onClick={() => uiEvents.emit('retryConnection')}
            >
              Try again
            </Button>
            <Button
              variant="secondary"
              data-nav-back=""
              cue="ui.back"
              data-testid="connection-leave"
              onClick={() => uiEvents.emit('leaveShow')}
            >
              Leave
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (conn.status !== 'reconnecting' && conn.status !== 'connecting') return null;
  const line = reconnectStatusLine(conn, now);
  return (
    <div className="tr-reconnect tr-interactive" data-nav-scope="25" role="alertdialog" aria-live="assertive">
      <div className="tr-dim" />
      <div className="tr-panel tr-reconnect-card tr-enter-pop">
        <div className="tr-wheel" aria-hidden>
          <div className="tr-wheel-ring" />
          <div className="tr-wheel-runner">
            <TumblerAvatar
              colors={colors ?? { primary: '#5aa9ff', secondary: '#fff', pattern: 'plain' }}
              expression="determined"
              size="4.2em"
              blink={false}
              noShadow
            />
          </div>
        </div>
        <h2 className="tr-title tr-h2">{conn.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</h2>
        <p className="tr-muted">{conn.message ?? 'Hold on, your Tumbler is running back to the show.'}</p>
        {line && (
          <p className="tr-small" data-testid="reconnect-attempt">
            {line}
          </p>
        )}
        <div className="tr-dots-loading" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        {/* Reconnects run their attempts out first (Leave comes with Connection lost); a first join can be abandoned. */}
        {conn.status === 'connecting' && (
          <Button
            variant="secondary"
            data-nav-back=""
            cue="ui.back"
            onClick={() => uiEvents.emit('leaveShow')}
          >
            Leave
          </Button>
        )}
      </div>
    </div>
  );
});
