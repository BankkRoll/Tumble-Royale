/**
 * Challenges: a season-milestone strip, then Daily and Weekly card grids.
 * Each card has an illustrated icon inside a chunky progress ring, a big
 * "2 / 3" readout, a reward chip, and one clear state — in progress (with a
 * labelled "Swap" when swaps are left today), ready to claim (glowing Claim),
 * or claimed. Claiming bursts confetti from the card and pops the reward.
 * docs/design/SCREENS.md §5.4.
 */
import { useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar, Coin, ItemArt } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow, useReducedMotion } from '../../components/hooks.ts';
import { Icon, challengeIcon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { Challenge, ChallengesData } from '../../store/types.ts';
import { confettiSets } from '../../theme/tokens.ts';
import { fireConfetti } from '../../transitions/Confetti.tsx';

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

function Ring({
  value,
  done,
  metric,
}: {
  value: number;
  done: boolean;
  metric: string | undefined;
}): JSX.Element {
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={`tr-ch-ring${done ? ' is-done' : ''}`} aria-hidden>
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={RING_R} className="tr-ch-ring-bg" />
        <circle
          cx="32"
          cy="32"
          r={RING_R}
          className="tr-ch-ring-fg"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - v)}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span className="tr-ch-ring-icon">
        <Icon name={done ? 'check' : challengeIcon(metric)} size="2em" />
      </span>
    </span>
  );
}

function RewardChip({ c }: { c: Challenge }): JSX.Element {
  const k = c.reward.kind;
  return (
    <span className="tr-ch-reward">
      {k === 'stars' ? <Icon name="star" size="1.1em" /> : <Coin currency={k} />}
      <b>{formatNumber(c.reward.amount)}</b>
      <small>{k === 'xp' ? 'XP' : k === 'gems' ? 'Gems' : k === 'stars' ? 'Stars' : 'Gumballs'}</small>
      {c.bonus && (
        <>
          <span className="tr-ch-plus">+</span>
          <b>{formatNumber(c.bonus.amount)}</b>
          <small>{c.bonus.kind === 'xp' ? 'XP' : c.bonus.kind === 'gems' ? 'Gems' : 'Gumballs'}</small>
        </>
      )}
      {c.gems !== undefined && c.gems > 0 && (
        <>
          <span className="tr-ch-plus">+</span>
          <Coin currency="gems" />
          <b>{formatNumber(c.gems)}</b>
          <small>Gems</small>
        </>
      )}
    </span>
  );
}

function ChallengeCard({
  c,
  delay,
  swapsLeft,
}: {
  c: Challenge;
  delay: number;
  swapsLeft: number | undefined;
}): JSX.Element {
  const done = c.progress >= c.goal;
  const [popping, setPopping] = useState(false);
  const reduce = useReducedMotion();
  const state = c.claimed ? 'claimed' : done ? 'ready' : 'progress';
  const canSwap = !done && !c.claimed && c.canReroll && (swapsLeft ?? 0) > 0;
  return (
    <article
      className={`tr-ch-card is-${state}${popping ? ' is-popping' : ''} tr-ch-card--${c.cadence}`}
      style={{ animationDelay: `${delay}ms` }}
      data-testid={`challenge-${c.id}`}
      data-state={state}
    >
      <Ring value={c.progress / c.goal} done={done} metric={c.metric} />
      <div className="tr-col tr-grow" style={{ gap: '0.35em', minWidth: 0 }}>
        <b className="tr-ch-title">{c.title}</b>
        <span className="tr-ch-count">
          <b>{formatNumber(Math.min(c.progress, c.goal))}</b>
          <span className="tr-muted"> / {formatNumber(c.goal)}</span>
        </span>
        <RewardChip c={c} />
      </div>
      <div className="tr-ch-action">
        {state === 'claimed' ? (
          <span className="tr-ch-stamp">
            <Icon name="check" size="1em" /> Claimed
          </span>
        ) : state === 'ready' ? (
          <Button
            size="sm"
            variant="mint"
            cue={null}
            className="tr-ch-claim"
            data-testid="challenge-claim"
            onClick={(e) => {
              playCue('ui.claim');
              if (!reduce) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                fireConfetti({
                  x: (r.left + r.width / 2) / window.innerWidth,
                  y: r.top / window.innerHeight,
                  count: 60,
                  spread: 40,
                  speed: 700,
                  colors: confettiSets.candy,
                });
              }
              setPopping(true);
              window.setTimeout(() => uiEvents.emit('claimChallenge', { id: c.id }), reduce ? 0 : 380);
            }}
          >
            Claim
          </Button>
        ) : canSwap ? (
          <Button
            size="sm"
            variant="ghost"
            className="tr-ch-swap"
            aria-label={`Swap "${c.title}" for a new challenge`}
            onClick={() => uiEvents.emit('rerollChallenge', { id: c.id })}
          >
            <Icon name="swap" size="1em" /> Swap
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function MilestoneStrip(): JSX.Element | null {
  const pass = useUI((s) => s.pass);
  if (!pass) return null;
  const upcoming = pass.tiers
    .filter((t) => t.tier > pass.currentTier && (t.free?.item || t.premium?.item))
    .slice(0, 4);
  return (
    <button
      type="button"
      className="tr-panel tr-ch-milestones"
      data-nav=""
      onClick={() => ui.getState().setMenuTab('pass')}
      aria-label="Season Pass progress — open the pass"
    >
      <span className="tr-col" style={{ gap: '0.2em', minWidth: '9em' }}>
        <span className="tr-label">Season progress</span>
        <b className="tr-title tr-h3">Tier {pass.currentTier}</b>
        <Bar value={pass.tierProgress} color="var(--lemon)" label="Progress to next tier" />
        <small className="tr-muted">Challenge XP fills the pass</small>
      </span>
      <span className="tr-ch-milestone-items">
        {upcoming.map((t) => {
          const r = t.free?.item ? t.free : t.premium;
          const item = r?.item;
          if (!item) return null;
          return (
            <span
              key={t.tier}
              className={`tr-ch-milestone tr-rar-frame tr-rar-frame--${item.rarity}`}
              title={`Tier ${t.tier}: ${item.name}`}
            >
              <ItemArt item={item} className="tr-ch-milestone-art" />
              <small>Tier {t.tier}</small>
            </span>
          );
        })}
      </span>
      <Icon name="chevron-right" size="1.2em" />
    </button>
  );
}

function Section({
  title,
  cadence,
  data,
  now,
}: {
  title: string;
  cadence: 'daily' | 'weekly';
  data: ChallengesData;
  now: number;
}): JSX.Element {
  const list = data.list.filter((c) => c.cadence === cadence);
  const resets = cadence === 'daily' ? data.dailyResetsAt : data.weeklyResetsAt;
  const ready = list.filter((c) => !c.claimed && c.progress >= c.goal).length;
  return (
    <section className={`tr-ch-section tr-ch-section--${cadence}`}>
      <header className="tr-ch-head">
        <h2 className="tr-title tr-h3">{title}</h2>
        <span className="tr-chip tr-chip--ink">
          <Icon name="clock" size="1em" /> New in {formatRemaining(resets - now)}
        </span>
        {ready > 0 && <span className="tr-chip tr-chip--mint">{ready} to claim</span>}
        {cadence === 'daily' && data.rerollsLeft !== undefined && (
          <span className="tr-chip" title="Swap an unfinished challenge for a new one">
            <Icon name="swap" size="1em" /> Swaps {data.rerollsLeft}/{data.rerollsPerDay ?? 1} today
          </span>
        )}
      </header>
      <div className="tr-ch-grid">
        {list.map((c, i) => (
          <ChallengeCard key={c.id} c={c} delay={i * 50} swapsLeft={data.rerollsLeft} />
        ))}
      </div>
    </section>
  );
}

/** Challenges tab. */
export function ChallengesTab(): JSX.Element {
  const data = useUI((s) => s.challenges);
  const now = useNow(1000);
  if (!data) return <div className="tr-panel tr-empty">No challenges yet — check back soon!</div>;
  return (
    <div className="tr-challenges">
      <MilestoneStrip />
      <div className="tr-panel tr-ch-board">
        <Section title="Daily" cadence="daily" data={data} now={now} />
        <Section title="Weekly" cadence="weekly" data={data} now={now} />
      </div>
    </div>
  );
}
