/**
 * Daily (3) and weekly (6) challenges with progress, reroll and claim.
 * docs/design/SCREENS.md §5.4.
 */
import type { JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar, Coin, Panel } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatRemaining, useNow } from '../../components/hooks.ts';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import type { Challenge } from '../../store/types.ts';

function ChallengeCard({ c, delay }: { c: Challenge; delay: number }): JSX.Element {
  const done = c.progress >= c.goal;
  return (
    <div
      className={`tr-challenge${done && !c.claimed ? ' is-done' : ''}${c.claimed ? ' is-claimed' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="tr-challenge-icon" aria-hidden>
        {c.icon}
      </span>
      <div className="tr-col tr-grow" style={{ gap: '0.3em', minWidth: 0 }}>
        <b>{c.title}</b>
        <div className="tr-row">
          <Bar
            value={c.progress / c.goal}
            color={done ? 'var(--mint)' : 'var(--lemon)'}
            className="tr-grow"
          />
          <span className="tr-small tr-nowrap">
            {Math.min(c.progress, c.goal)}/{c.goal}
          </span>
        </div>
      </div>
      <span className="tr-challenge-reward">
        {c.reward.kind === 'stars' ? '⭐' : <Coin currency={c.reward.kind} />} {c.reward.amount}
      </span>
      {c.claimed ? (
        <span className="tr-chip tr-chip--mint">✓</span>
      ) : done ? (
        <Button
          size="sm"
          variant="mint"
          cue={null}
          onClick={() => {
            playCue('ui.claim');
            uiEvents.emit('claimChallenge', { id: c.id });
          }}
        >
          Claim
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={!c.canReroll}
          aria-label="Reroll challenge"
          onClick={() => uiEvents.emit('rerollChallenge', { id: c.id })}
        >
          🔄
        </Button>
      )}
    </div>
  );
}

/** Challenges tab. */
export function ChallengesTab(): JSX.Element {
  const data = useUI((s) => s.challenges);
  const now = useNow(1000);
  if (!data) return <Panel className="tr-challenges">No challenges yet — check back soon!</Panel>;
  const daily = data.list.filter((c) => c.cadence === 'daily');
  const weekly = data.list.filter((c) => c.cadence === 'weekly');
  return (
    <div className="tr-challenges">
      <Panel tilt={-0.6} className="tr-col">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">Daily</h2>
          <span className="tr-chip tr-chip--lemon">🔄 {formatRemaining(data.dailyResetsAt - now)}</span>
        </div>
        {daily.map((c, i) => (
          <ChallengeCard key={c.id} c={c} delay={i * 60} />
        ))}
      </Panel>
      <Panel tilt={0.6} delay={80} className="tr-col">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">Weekly</h2>
          <span className="tr-chip tr-chip--grape">🔄 {formatRemaining(data.weeklyResetsAt - now)}</span>
        </div>
        <div className="tr-col tr-scroll" style={{ maxHeight: '100%' }}>
          {weekly.map((c, i) => (
            <ChallengeCard key={c.id} c={c} delay={i * 60} />
          ))}
        </div>
      </Panel>
    </div>
  );
}
