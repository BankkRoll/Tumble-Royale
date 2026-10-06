/**
 * "How you went out": the short replay after a knock-out, before the
 * "Keep watching / Leave show" choice.
 *
 * Responsibilities:
 * - frame the replay (letterbox, title, the cause line, a slow-motion tag
 *   while the decisive moment plays, a progress bar);
 * - a Skip button; any key, click or pad button skips too (the game listens
 *   for those itself, so this layer only emits `elimReplaySkip`);
 * - under Reduce Motion the game shows one still frame: no letterbox slide,
 *   no progress animation;
 * - the cause is announced once through a polite live region.
 */
import { type JSX } from 'react';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icons/index.tsx';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';

/** The elimination replay chrome; renders nothing while none is showing. */
export function ElimReplayLayer(): JSX.Element | null {
  const r = useUI((s) => s.elimReplay);
  const touch = useUI((s) => s.isTouch);
  if (!r) return null;
  const still = r.mode === 'still';
  return (
    <div
      className={`tr-elim-replay is-${r.mode}`}
      role="region"
      aria-label="How you went out"
      data-testid="elim-replay"
      data-mode={r.mode}
    >
      <div className="tr-elim-replay-bar is-top" aria-hidden />
      <div className="tr-elim-replay-head">
        <span className="tr-replay-badge">
          <Icon name="film" size="1.1em" /> {still ? 'Replay still' : 'Replay'}
        </span>
        <h2 className="tr-title tr-h3">How you went out</h2>
        {r.slow && !still && (
          <span className="tr-chip tr-elim-replay-slow" data-testid="elim-replay-slow">
            Slow-mo
          </span>
        )}
      </div>
      <p className="tr-elim-replay-cause" role="status" aria-live="polite" data-testid="elim-replay-cause">
        {r.cause}
      </p>
      <div className="tr-elim-replay-bar is-bottom">
        <div
          className="tr-elim-replay-progress"
          role="progressbar"
          aria-label="Replay progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(r.progress * 100)}
        >
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, r.progress)) * 100)}%` }} />
        </div>
        <div className="tr-row tr-elim-replay-actions tr-interactive">
          <span className="tr-small tr-elim-replay-hint">
            {r.mode === 'loading' ? 'Loading replay…' : touch ? 'Tap to skip' : 'Press any key to skip'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            data-testid="elim-replay-skip"
            onClick={() => uiEvents.emit('elimReplaySkip')}
          >
            Skip <Icon name="chevron-right" size="0.9em" />
          </Button>
        </div>
      </div>
    </div>
  );
}
