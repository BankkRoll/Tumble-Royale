/**
 * "Keep watching / Leave show" once the local player is knocked out: the
 * in-round sheet after the ELIMINATED stamp, and the same choice over the
 * results wall when the player is out of the show. Keep watching (the
 * default, picked automatically by Auto-spectate) keeps the show running for
 * them as a spectator until the winner and the end-of-show wall.
 */
import { memo, useEffect, useState, type JSX } from 'react';
import { Button } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import { confirmLeaveShow } from './InGameMenu.tsx';
import type { WatchChoice } from '../../store/types.ts';

/**
 * Whole seconds until `at` (epoch ms), ticking every 250 ms; null when `at` is null.
 *
 * @param at - Deadline.
 */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The rewards line under the choice, true for the show's mode: offline the
 * profile banks the played rounds at once; online the account API grants
 * them when the server reports the show.
 *
 * @param online - The show runs on a game server.
 * @returns Copy for the panel.
 */
export function watchChoiceRewardsNote(online: boolean): string {
  return online
    ? 'Stay to the end for full show rewards. If you leave, the rounds you played still count once the show ends.'
    : 'Stay to the end for full show rewards. If you leave, the rounds you played still count.';
}

/** Choice panel body shared by the in-round sheet and the results card. */
export const WatchChoicePanel = memo(function WatchChoicePanel({
  choice,
  title,
}: {
  choice: WatchChoice | null;
  title: string;
}): JSX.Element {
  const online = useUI((s) => s.showSeat?.online ?? false);
  const secs = useSecondsUntil(choice?.autoAt ?? null);
  return (
    <div className="tr-panel tr-elim-panel" data-testid="watch-choice">
      <div className="tr-title tr-h3">{title}</div>
      {choice?.remaining !== undefined && choice.remaining > 0 && (
        <span className="tr-chip">{choice.remaining} still in the show</span>
      )}
      <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
        <Button
          variant="sky"
          size="lg"
          autoFocusNav
          // Back (Esc, pad B) keeps watching: Esc also frees the mouse, so it must never leave the show.
          data-nav-back=""
          data-testid="watch-keep"
          onClick={() => uiEvents.emit('spectate')}
        >
          <Icon name="eye" size="1.1em" /> Keep watching
          {secs !== null && <span className="tr-muted"> ({secs})</span>}
        </Button>
        <Button variant="secondary" size="lg" data-testid="watch-leave" onClick={confirmLeaveShow}>
          <Icon name="home" size="1.1em" /> Leave show
        </Button>
      </div>
      <p className="tr-small tr-muted" style={{ margin: 0, maxWidth: '28em', textAlign: 'center' }}>
        {watchChoiceRewardsNote(online)}
      </p>
    </div>
  );
});

/**
 * The choice over show screens (results wall, between rounds, loading): the
 * in-round sheet covers the `round` screen itself.
 */
export function WatchChoiceLayer(): JSX.Element | null {
  const choice = useUI((s) => s.watchChoice);
  const inRound = useUI((s) => s.screen === 'round');
  if (!choice || inRound) return null;
  return (
    <div className="tr-elim-sheet tr-interactive" data-nav-scope="8">
      <WatchChoicePanel choice={choice} title="You're out of the show" />
    </div>
  );
}
