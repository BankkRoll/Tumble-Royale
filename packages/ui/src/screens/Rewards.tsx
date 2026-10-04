/**
 * End-of-show rewards (docs/design/SCREENS.md §11): XP lines counting up, XP
 * bar filling across level-ups, Gumballs + pass progress, unlock capsule
 * reveals and ranked RP change.
 *
 * The whole sequence is a pure function of elapsed time `t`, so "skip" is
 * just `t = ∞` and nothing can get stuck half-animated.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Bar, Coin } from '../components/bits.tsx';
import { ItemPreview } from '../components/ItemPreview.tsx';
import { Button } from '../components/controls.tsx';
import { formatNumber } from '../components/hooks.ts';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type { RewardsSummary } from '../store/types.ts';
import { confettiSets, rarityLabels } from '../theme/tokens.ts';
import { fireConfetti } from '../transitions/Confetti.tsx';
import { Icon } from '../components/icons/index.tsx';
import { RankEmblem } from './menu/ProfileTab.tsx';
import { ReplayPicker } from './Replay.tsx';

const LINE_GAP = 350;
const LINE_COUNT = 400;
const SEG = 700;
const BURST = 650;
const UNLOCK = 1500;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const ease = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);

interface Segment {
  level: number;
  from: number;
  to: number;
  needed: number;
  start: number;
}

interface Plan {
  lineAt: number[];
  xpStart: number;
  segments: Segment[];
  gumAt: number;
  unlockAt: number[];
  rankAt: number;
  doneAt: number;
}

function plan(r: RewardsSummary): Plan {
  const lineAt = r.xpLines.map((_, i) => 300 + i * LINE_GAP);
  const xpStart = 300 + r.xpLines.length * LINE_GAP + 300;
  const segments: Segment[] = [];
  let t = xpStart;
  for (let L = r.levelFrom.level; L <= r.levelTo.level; L++) {
    const first = L === r.levelFrom.level;
    const last = L === r.levelTo.level;
    const needed = first ? r.levelFrom.xpToNext : r.levelTo.xpToNext;
    segments.push({
      level: L,
      from: first ? r.levelFrom.xp : 0,
      to: last ? r.levelTo.xp : needed,
      needed,
      start: t,
    });
    t += SEG + (last ? 0 : BURST);
  }
  const gumAt = t + 200;
  const unlockStart = gumAt + 900;
  const unlockAt = r.unlocks.map((_, i) => unlockStart + i * UNLOCK);
  const rankAt = unlockStart + r.unlocks.length * UNLOCK;
  return { lineAt, xpStart, segments, gumAt, unlockAt, rankAt, doneAt: rankAt + (r.ranked ? 1200 : 0) };
}

/** Collected cue/fx thresholds so each fires exactly once as `t` passes it. */
function beats(r: RewardsSummary, p: Plan): { at: number; fire: () => void }[] {
  const out: { at: number; fire: () => void }[] = [];
  p.lineAt.forEach((at) => out.push({ at, fire: () => playCue('ui.reward') }));
  p.segments.slice(0, -1).forEach((s) =>
    out.push({
      at: s.start + SEG,
      fire: () => {
        playCue('ui.levelUp');
        fireConfetti({
          x: 0.72,
          y: 0.3,
          ring: true,
          count: 90,
          speed: 700,
          colors: confettiSets.levelUp,
          silent: true,
        });
      },
    }),
  );
  out.push({ at: p.gumAt, fire: () => playCue('ui.reward') });
  r.unlocks.forEach((u, i) => {
    out.push({ at: (p.unlockAt[i] ?? 0) + 600, fire: () => playCue(`ui.rarity.${u.rarity}`) });
    if (u.rarity === 'legendary' || u.rarity === 'mythic') {
      out.push({
        at: (p.unlockAt[i] ?? 0) + 650,
        fire: () =>
          fireConfetti({
            x: 0.72,
            y: 0.62,
            ring: true,
            count: 120,
            colors: confettiSets.victory,
            silent: true,
          }),
      });
    }
  });
  if (r.ranked)
    out.push({
      at: p.rankAt,
      fire: () => playCue(r.ranked && r.ranked.to.tier !== r.ranked.from.tier ? 'ui.stamp' : 'ui.reward'),
    });
  return out;
}

function RewardsActions({ hint }: { hint?: string | undefined }): JSX.Element {
  return (
    <div className="tr-rewards-actions tr-interactive" data-nav-scope="1">
      <ReplayPicker />
      {hint && <span className="tr-small tr-muted">{hint}</span>}
      <Button
        variant="secondary"
        size="lg"
        data-nav-back=""
        cue="ui.back"
        onClick={() => uiEvents.emit('backToLobby')}
      >
        <Icon name="home" size="1.1em" /> Back to lobby
      </Button>
      <Button variant="go" size="lg" autoFocusNav cue="ui.confirm" onClick={() => uiEvents.emit('playAgain')}>
        <Icon name="refresh" size="1.1em" /> Play again
      </Button>
    </div>
  );
}

/**
 * The account's reward is still on its way (or will only show on the
 * profile). Online progress is never estimated locally, so this waits
 * honestly instead of showing made-up numbers.
 */
function PendingRewards({ state }: { state: 'arriving' | 'deferred' }): JSX.Element {
  return (
    <div className="tr-screen tr-rewards">
      <div className="tr-rewards-grid">
        <div
          className="tr-panel tr-rewards-xp tr-enter tr-interactive"
          style={{ ['--tilt' as string]: '-1deg' }}
          role="status"
          aria-live="polite"
          data-testid={`rewards-${state}`}
        >
          <h1 className="tr-title tr-h2">Show rewards</h1>
          {state === 'arriving' ? (
            <div className="tr-empty">
              <span className="tr-gumball-spinner" />
              <p>Rewards arriving…</p>
              <p className="tr-small tr-muted">The servers are tallying your show.</p>
            </div>
          ) : (
            <div className="tr-empty">
              <Icon name="gift" size="3em" />
              <p>Rewards will appear in your profile</p>
              <p className="tr-small tr-muted">
                They're taking longer than usual to arrive. Nothing is lost.
              </p>
            </div>
          )}
        </div>
      </div>
      <RewardsActions />
    </div>
  );
}

/** Rewards screen. */
export function RewardsScreen(): JSX.Element | null {
  const r = useUI((s) => s.rewards);
  const pending = useUI((s) => s.rewardsPending);
  const [t, setT] = useState(0);
  const start = useRef(0);
  const fired = useRef(new Set<number>());
  const p = useMemo(() => (r ? plan(r) : null), [r]);
  const beatList = useMemo(() => (r && p ? beats(r, p) : []), [r, p]);

  useEffect(() => {
    if (!p) return;
    start.current = performance.now();
    fired.current.clear();
    setT(0);
    const id = window.setInterval(() => {
      const now = performance.now() - start.current;
      setT(now);
      if (now > p.doneAt + 100) window.clearInterval(id);
    }, 33);
    return () => window.clearInterval(id);
  }, [p]);

  useEffect(() => {
    beatList.forEach((b, i) => {
      if (t >= b.at && !fired.current.has(i)) {
        fired.current.add(i);
        if (t - b.at < 400) b.fire();
      }
    });
  }, [t, beatList]);

  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape' || e.key.startsWith('Arrow')) return;
      setT((cur) => {
        if (cur >= p.doneAt) return cur;
        start.current = performance.now() - p.doneAt;
        return p.doneAt;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  if (!r || !p) return pending ? <PendingRewards state={pending} /> : null;

  const lineVals = r.xpLines.map((l, i) => Math.round(l.xp * ease((t - (p.lineAt[i] ?? 0)) / LINE_COUNT)));
  const totalXp = lineVals.reduce((a, b) => a + b, 0);
  let seg = p.segments[0] as Segment;
  for (const s of p.segments) if (t >= s.start) seg = s;
  const segP = ease((t - seg.start) / SEG);
  const barValue =
    t < p.xpStart
      ? r.levelFrom.xp / r.levelFrom.xpToNext
      : (seg.from + (seg.to - seg.from) * segP) / seg.needed;
  const segIdx = p.segments.indexOf(seg);
  const inBurst = segIdx < p.segments.length - 1 && t >= seg.start + SEG;
  const shownLevel = inBurst ? seg.level + 1 : seg.level;
  const gumP = ease((t - p.gumAt) / 800);
  const done = t >= p.doneAt;

  return (
    <div className="tr-screen tr-rewards">
      <div className="tr-rewards-grid">
        <div
          className="tr-panel tr-rewards-xp tr-enter tr-interactive"
          style={{ ['--tilt' as string]: '-1deg' }}
        >
          <h1 className="tr-title tr-h2">Show rewards</h1>
          <div className="tr-col" style={{ gap: '0.35em' }}>
            {r.xpLines.map((l, i) =>
              t >= (p.lineAt[i] ?? 0) ? (
                <div key={i} className="tr-xp-line">
                  <span className="tr-grow">{l.label}</span>
                  <b>+{formatNumber(lineVals[i] ?? 0)} XP</b>
                </div>
              ) : null,
            )}
          </div>
          <div className="tr-xp-total">
            <span>Total</span>
            <b className="tr-title tr-h3 tr-title--lemon">+{formatNumber(totalXp)} XP</b>
          </div>
          {r.challenges && r.challenges.length > 0 && t >= p.gumAt && (
            <div className="tr-col tr-enter" style={{ gap: '0.3em' }}>
              <span className="tr-label">Challenges</span>
              {r.challenges.map((c, i) => (
                <div key={i} className="tr-row tr-small">
                  <span className="tr-grow tr-ellipsis">{c.title}</span>
                  <span>
                    {Math.round(c.from + (c.to - c.from) * gumP)}/{c.goal}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="tr-col tr-rewards-right">
          <div
            className="tr-panel tr-rewards-level tr-enter"
            style={{ ['--tilt' as string]: '0.8deg', animationDelay: '120ms' }}
          >
            {inBurst && (
              // Floats above the panel so the slam never overlaps the badge or the XP bar.
              <span
                key={`lvl-${shownLevel}`}
                className="tr-levelup-ribbon tr-title tr-h3 tr-title--lemon tr-slam"
                role="status"
              >
                Level up!
              </span>
            )}
            <div className="tr-row">
              <span
                key={shownLevel}
                className={`tr-level-badge tr-level-badge--big${inBurst ? ' is-levelup' : ''}`}
              >
                <small>LV</small>
                {shownLevel}
              </span>
              <div className="tr-col tr-grow" style={{ gap: '0.3em' }}>
                <span className="tr-label">Level progress</span>
                <Bar
                  value={inBurst ? 1 : barValue}
                  large
                  className="tr-bar--instant"
                  label="Level progress"
                />
              </div>
            </div>
            {t >= p.gumAt && (
              <div className="tr-row tr-wrap tr-enter-pop" style={{ marginTop: '0.8em' }}>
                <span className="tr-currency">
                  <Coin currency="gumballs" /> +{formatNumber(Math.round(r.gumballs * gumP))}
                </span>
                {r.crowns > 0 && (
                  <span className="tr-currency">
                    <Coin currency="crown" /> +{r.crowns}
                  </span>
                )}
                {r.pass && (
                  <span className="tr-chip tr-chip--grape">
                    <Icon name="star" size="1em" /> Tier{' '}
                    {r.pass.tierFrom + Math.round((r.pass.tierTo - r.pass.tierFrom) * gumP)}
                    {r.pass.tierTo > r.pass.tierFrom ? ` (+${r.pass.tierTo - r.pass.tierFrom})` : ''}
                  </span>
                )}
              </div>
            )}
            {r.pass && t >= p.gumAt && (
              <Bar
                value={r.pass.progressFrom + (r.pass.progressTo - r.pass.progressFrom) * gumP}
                color="var(--grape)"
                className="tr-bar--instant"
                label="Pass tier progress"
              />
            )}
          </div>

          {r.unlocks.length > 0 && t >= (p.unlockAt[0] ?? Infinity) && (
            <div className="tr-panel tr-rewards-unlocks tr-enter" style={{ ['--tilt' as string]: '-0.6deg' }}>
              <span className="tr-label">Unlocked!</span>
              <div className="tr-row tr-wrap">
                {r.unlocks.map((u, i) => {
                  const at = p.unlockAt[i] ?? 0;
                  if (t < at) return null;
                  const opened = t >= at + 600;
                  return (
                    <div
                      key={u.id}
                      className={`tr-capsule tr-capsule--${u.rarity}${opened ? ' is-open' : ''}`}
                      style={{ ['--art-a' as string]: u.art[0], ['--art-b' as string]: u.art[1] }}
                    >
                      {opened ? (
                        <>
                          <span className="tr-capsule-burst" aria-hidden />
                          <ItemPreview item={u} className="tr-capsule-icon" />
                          <b className="tr-ellipsis">{u.name}</b>
                          <span className={`tr-rarity-band tr-rarity-band--${u.rarity}`}>
                            {rarityLabels[u.rarity]}
                          </span>
                        </>
                      ) : (
                        <span className="tr-capsule-shell tr-loop" aria-label="Mystery capsule" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {r.ranked && t >= p.rankAt && (
            <div className="tr-panel tr-rewards-rank tr-enter" style={{ ['--tilt' as string]: '0.6deg' }}>
              <RankEmblem
                rank={{
                  ...r.ranked.to,
                  rp: Math.round(
                    r.ranked.from.rp + (r.ranked.to.rp - r.ranked.from.rp) * ease((t - p.rankAt) / 900),
                  ),
                }}
              />
              <span
                className={`tr-chip ${r.ranked.delta >= 0 ? 'tr-chip--good' : 'tr-chip--bad'} tr-rank-delta`}
              >
                {r.ranked.delta >= 0 ? '+' : ''}
                {r.ranked.delta} RP
              </span>
              {r.ranked.to.tier !== r.ranked.from.tier && (
                <span className="tr-title tr-h3 tr-title--mint tr-slam">Promoted!</span>
              )}
            </div>
          )}
        </div>
      </div>

      <RewardsActions hint={done ? undefined : 'Press any key to skip'} />
    </div>
  );
}
