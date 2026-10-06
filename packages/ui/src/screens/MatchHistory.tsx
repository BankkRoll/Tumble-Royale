/**
 * Match history: the last 20 shows (older pages on request for an online
 * account) with expandable per-round results,
 * opened from the Profile tab's "See all". Back returns to Profile.
 */
import type { JSX } from 'react';
import { Panel } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icons/index.tsx';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';
import { HistoryList } from './menu/ProfileTab.tsx';

/** Back to the Profile tab the screen was opened from. */
export function closeMatchHistory(): void {
  const s = ui.getState();
  s.setMenuTab('profile');
  s.setScreen('menu', { transition: 'fade' });
}
import { OpenReplayButton } from './Replay.tsx';

/** The last 20 shows, and older pages for an online account. */
export function MatchHistoryScreen(): JSX.Element {
  const history = useUI((s) => s.matchHistory);
  const paging = useUI((s) => s.matchHistoryPaging);
  const shown = paging ? history : history.slice(0, 20);
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
        <small className="tr-muted">Last {shown.length} shows</small>
        <OpenReplayButton />
      </div>
      <Panel className="tr-scroll">
        <HistoryList entries={shown} />
        {paging?.next && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="history-more"
            disabled={paging.loading}
            onClick={() => uiEvents.emit('loadMoreMatches')}
          >
            {paging.loading ? <span className="tr-gumball-spinner tr-gumball-spinner--sm" /> : 'Show older'}
          </Button>
        )}
      </Panel>
    </div>
  );
}
