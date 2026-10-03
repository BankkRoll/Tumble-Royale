/**
 * Match history: the last 20 shows.
 */
import type { JSX } from 'react';
import { TypeBadge, Panel } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icons/index.tsx';
import { ui, useUI } from '../store/uiStore.ts';
import { OpenReplayButton } from './Replay.tsx';

/** Last 20 shows. */
export function MatchHistoryScreen(): JSX.Element {
  const history = useUI((s) => s.matchHistory);
  return (
    <div className="tr-screen tr-history" data-nav-scope="0">
      <div className="tr-custom-head">
        <Button
          variant="secondary"
          data-nav-back=""
          cue="ui.back"
          hint="Esc"
          autoFocusNav
          onClick={() => ui.getState().setScreen('menu')}
        >
          <Icon name="chevron-left" size="0.9em" /> Back
        </Button>
        <h1 className="tr-title tr-h2 tr-grow">Match history</h1>
        <OpenReplayButton />
      </div>
      <Panel className="tr-history-list tr-scroll">
        {history.length === 0 && <div className="tr-empty">No shows yet. Go make some history!</div>}
        {history.map((m, i) => (
          <div
            key={m.id}
            className={`tr-history-row is-${m.result}`}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <span className="tr-history-result">
              <Icon
                name={m.result === 'crown' ? 'crown' : m.result === 'final' ? 'flag' : 'close'}
                size="1.3em"
              />
            </span>
            <div className="tr-col tr-grow" style={{ gap: '0.25em', minWidth: 0 }}>
              <b>
                {m.playlist} <small className="tr-muted">· {new Date(m.time).toLocaleDateString()}</small>
              </b>
              <div className="tr-row tr-wrap" style={{ gap: '0.3em' }}>
                {m.rounds.map((r, j) => (
                  <span
                    key={j}
                    className={`tr-history-round${r.qualified ? ' is-q' : ' is-out'}`}
                    title={r.name}
                  >
                    <TypeBadge type={r.type} style={{ fontSize: '0.6em' }} /> {r.name}
                  </span>
                ))}
              </div>
            </div>
            <span className="tr-chip tr-chip--lemon">+{m.xp} XP</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}
