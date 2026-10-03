/**
 * Match history: the last 20 shows with expandable per-round results,
 * opened from the Profile tab's "See all". Back returns to Profile.
 */
import type { JSX } from 'react';
import { Panel } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icons/index.tsx';
import { ui, useUI } from '../store/uiStore.ts';
import { HistoryList } from './menu/ProfileTab.tsx';

/** Back to the Profile tab the screen was opened from. */
export function closeMatchHistory(): void {
  const s = ui.getState();
  s.setMenuTab('profile');
  s.setScreen('menu', { transition: 'fade' });
}
import { OpenReplayButton } from './Replay.tsx';

/** Last 20 shows. */
export function MatchHistoryScreen(): JSX.Element {
  const history = useUI((s) => s.matchHistory);
  return (
    <div className="tr-screen tr-history" data-nav-scope="0" data-testid="match-history">
      <div className="tr-custom-head">
        <Button
          variant="secondary"
          data-nav-back=""
          cue="ui.back"
          hint="Esc"
          autoFocusNav
          data-testid="history-back"
          onClick={closeMatchHistory}
        >
          <Icon name="chevron-left" size="0.9em" /> Back
        </Button>
        <h1 className="tr-title tr-h2 tr-grow">Match history</h1>
        <small className="tr-muted">Last {Math.min(20, history.length)} shows</small>
        <OpenReplayButton />
      </div>
      <Panel className="tr-scroll">
        <HistoryList entries={history.slice(0, 20)} />
      </Panel>
    </div>
  );
}
