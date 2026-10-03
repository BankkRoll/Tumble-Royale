/**
 * Post-round and end-of-show screens: round results grid, between-rounds
 * tease, FINAL ROUND hype, victory and winner cam.
 * docs/design/SCREENS.md §9.11–§9.15.
 */
import { useEffect, useMemo, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { CountUp, RoundDots, TypeBadge } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { useDisplayName, useReducedFlashing, useSequence } from '../components/hooks.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type { ResultsEntry } from '../store/types.ts';
import { confettiSets } from '../theme/tokens.ts';
import { Icon } from '../components/icons/index.tsx';
import { fireConfetti, fireFireworks } from '../transitions/Confetti.tsx';

const FLIP_START = 900;
const FLIP_SPREAD = 1600;

/** Qualified/eliminated portrait grid with the flip reveal. */
export function RoundResultsScreen(): JSX.Element | null {
  const results = useUI((s) => s.results);
  const name = useDisplayName();

  const ordered = useMemo(() => {
    if (!results) return { cells: [] as ResultsEntry[], flipDelay: new Map<number, number>(), localDelay: 0 };
    const reveal = [...results.entries].sort((a, b) => {
      if (a.player.isLocal) return 1;
      if (b.player.isLocal) return -1;
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      return (a.place || 999) - (b.place || 999);
    });
    const step = Math.min(40, FLIP_SPREAD / Math.max(1, reveal.length));
    const flipDelay = new Map<number, number>();
    let localDelay = 0;
    reveal.forEach((e, i) => {
      const d = FLIP_START + i * step + (e.player.isLocal ? 450 : 0);
      flipDelay.set(e.player.id, d);
      if (e.player.isLocal) localDelay = d;
    });
    return { cells: results.entries, flipDelay, localDelay };
  }, [results]);

  useEffect(() => {
    if (!results) return;
    const local = results.entries.find((e) => e.player.isLocal);
    if (!local) return;
    const id = window.setTimeout(() => {
      playCue('ui.stamp');
      if (local.qualified)
        fireConfetti({ x: 0.5, y: 0.5, count: 60, colors: confettiSets.qualified, silent: true });
    }, ordered.localDelay + 250);
    return () => window.clearTimeout(id);
  }, [results, ordered.localDelay]);

  const step = useSequence([FLIP_START + FLIP_SPREAD + 600], results);
  if (!results) return null;
  const q = results.entries.filter((e) => e.qualified).length;
  const out = results.entries.length - q;

  return (
    <div className={`tr-screen tr-results${results.render3D ? ' tr-results--3d' : ''}`}>
      {!results.render3D && (
        <div className="tr-results-head tr-enter-drop">
          <TypeBadge type={results.roundType} />
          <h1 className="tr-title tr-h2">{results.roundName} — results</h1>
        </div>
      )}
      {!results.render3D && (
        <div
          className="tr-results-grid"
          style={{
            ['--n' as string]: String(results.entries.length),
            ['--rows' as string]: String(Math.ceil(results.entries.length / 8)),
            ['--rows-m' as string]: String(Math.ceil(results.entries.length / 5)),
          }}
        >
          {ordered.cells.map((e, i) => (
            <div
              key={e.player.id}
              className={`tr-res-card${e.qualified ? ' is-q' : ' is-out'}${e.player.isLocal ? ' is-local' : ''}`}
              style={{
                ['--enter' as string]: `${Math.min(i * 18, 600)}ms`,
                ['--flip' as string]: `${ordered.flipDelay.get(e.player.id) ?? FLIP_START}ms`,
              }}
            >
              <div className="tr-res-inner">
                <div className="tr-res-front">
                  <TumblerAvatar
                    colors={e.player.colors}
                    hat={e.player.hat}
                    expression={e.qualified ? 'grin' : 'sad'}
                    size="56%"
                    blink={false}
                    noShadow
                  />
                  <span className="tr-res-name tr-ellipsis">{name(e.player)}</span>
                  <span className="tr-res-mark" aria-label={e.qualified ? 'Qualified' : 'Eliminated'}>
                    {e.qualified ? <Icon name="check" size="0.8em" /> : <Icon name="close" size="0.8em" />}
                  </span>
                  {e.player.isLocal && <span className="tr-res-you">YOU</span>}
                </div>
                <div className="tr-res-back" aria-hidden />
              </div>
            </div>
          ))}
        </div>
      )}
      {(step >= 1 || results.render3D) && (
        <div className="tr-results-summary tr-enter">
          <span className="tr-chip tr-chip--good">
            <Icon name="check" size="0.9em" /> {q} qualified
          </span>
          <span className="tr-chip tr-chip--bad">
            <Icon name="close" size="0.9em" /> {out} eliminated
          </span>
        </div>
      )}
    </div>
  );
}

/** "PLAYERS REMAINING 40 → 26" + next round tease. */
export function BetweenRoundsScreen(): JSX.Element | null {
  const info = useUI((s) => s.betweenRounds);
  const step = useSequence([400, 1500, 2300], info);
  useEffect(() => {
    if (step === 3) playCue('ui.stamp');
  }, [step]);
  if (!info) return null;
  return (
    <div className="tr-screen tr-between">
      <div className="tr-between-inner">
        <div className="tr-label tr-between-label">Players remaining</div>
        <div className="tr-title tr-between-count">
          {step >= 1 ? (
            <CountUp
              value={info.remaining}
              from={info.remainingBefore}
              durationMs={900}
              onStep={() => playCue('ui.reward')}
            />
          ) : (
            info.remainingBefore
          )}
        </div>
        <RoundDots index={info.roundIndex + 1} count={info.roundCount} />
        {step >= 2 && (
          <div className="tr-panel tr-between-next tr-enter" style={{ ['--tilt' as string]: '-2deg' }}>
            <span className="tr-label">Next up</span>
            <TypeBadge type={info.next.type} />
            {step >= 3 ? (
              <div className="tr-title tr-h2 tr-slam">{info.next.name}</div>
            ) : (
              <div className="tr-title tr-h2 tr-between-mystery">???</div>
            )}
            {info.next.isFinal && step >= 3 && (
              <span className="tr-chip tr-chip--lemon">
                <Icon name="crown" size="1em" /> It's the final!
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** FINAL ROUND hype card with finalist lineup. */
export function FinalHypeScreen(): JSX.Element | null {
  const info = useUI((s) => s.finalHype);
  const name = useDisplayName();
  useEffect(() => {
    playCue('ui.stamp.final');
  }, []);
  if (!info) return null;
  return (
    <div className="tr-screen tr-finalhype">
      <div
        className="tr-sunburst-spin tr-loop"
        style={{ ['--sb-a' as string]: '#ffd23f', ['--sb-b' as string]: '#ffb021' }}
      />
      <div className="tr-finalhype-inner">
        <div className="tr-title tr-h1 tr-slam">Final round!</div>
        <div className="tr-title tr-h3 tr-title--pink tr-enter-pop" style={{ animationDelay: '400ms' }}>
          {info.finalists.length} Tumblers. 1 Crown.
        </div>
        <div className="tr-finalhype-lineup">
          {info.finalists.map((p, i) => (
            <div
              key={p.id}
              className={`tr-finalist${p.isLocal ? ' is-local' : ''}`}
              style={{ animationDelay: `${700 + i * 90}ms` }}
            >
              <TumblerAvatar colors={p.colors} hat={p.hat} expression="determined" size="4.6em" />
              <span className="tr-finalist-name tr-ellipsis">{name(p)}</span>
            </div>
          ))}
        </div>
        <div className="tr-chip tr-chip--ink tr-enter-pop" style={{ animationDelay: '1400ms' }}>
          {info.roundName}
        </div>
      </div>
      <div className="tr-vignette" />
    </div>
  );
}

/** You won: crown drop, crown counter, fireworks, photo mode. */
export function VictoryScreen(): JSX.Element | null {
  const v = useUI((s) => s.victory);
  const name = useDisplayName();
  const noFlash = useReducedFlashing();
  const step = useSequence([300, 1100, 1800]);
  useEffect(() => {
    if (step === 2) {
      playCue('ui.stamp.victory');
      fireConfetti({ x: 0.5, y: 0.55, count: 220, colors: confettiSets.victory });
    }
  }, [step]);
  useEffect(() => {
    let cancel = fireFireworks(noFlash ? 1 : 3);
    const id = window.setInterval(() => {
      cancel();
      cancel = fireFireworks(noFlash ? 1 : 3);
    }, 3200);
    return () => {
      cancel();
      window.clearInterval(id);
    };
  }, [noFlash]);
  if (!v) return null;
  return (
    <div className="tr-screen tr-victory">
      <div
        className="tr-sunburst-spin tr-loop"
        style={{ ['--sb-a' as string]: '#ffe680', ['--sb-b' as string]: '#ffd23f' }}
      />
      <div className="tr-victory-inner">
        <div className="tr-victory-hero">
          <TumblerAvatar
            colors={v.winner.colors}
            hat={step >= 2 ? 'crown' : v.winner.hat}
            expression="cheer"
            size="12em"
          />
          {step >= 1 && step < 2 && (
            <span className="tr-victory-crown" aria-hidden>
              👑
            </span>
          )}
        </div>
        {step >= 2 && (
          <div className="tr-title tr-h1 tr-title--lemon tr-slam">
            {v.isLocalWinner ? 'You won the Crown!' : `${name(v.winner)} wins!`}
          </div>
        )}
        {step >= 3 && (
          <div className="tr-col tr-enter" style={{ alignItems: 'center' }}>
            <div className="tr-currency tr-victory-crowns">
              <span className="tr-coin tr-coin--crown" />
              Crowns: <CountUp value={v.crownsAfter} from={v.crownsBefore} durationMs={900} delayMs={200} />
            </div>
            <div className="tr-row tr-interactive" data-nav-scope="1">
              <Button variant="secondary" size="lg" onClick={() => uiEvents.emit('photoMode')}>
                <Icon name="camera" size="1.1em" /> Photo mode
              </Button>
              <Button
                variant="go"
                size="lg"
                autoFocusNav
                cue="ui.confirm"
                onClick={() => uiEvents.emit('continue', { from: 'victory' })}
              >
                Continue
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Someone else won: winner banner over the 3D winner cam. */
export function WinnerCamScreen(): JSX.Element | null {
  const v = useUI((s) => s.victory);
  const name = useDisplayName();
  if (!v) return null;
  return (
    <div className="tr-screen tr-winnercam">
      <div className="tr-winnercam-banner tr-enter-drop">
        <span className="tr-label">Winner!</span>
        <div className="tr-row">
          <TumblerAvatar colors={v.winner.colors} hat="crown" expression="cheer" size="4em" />
          <div className="tr-title tr-h2">{name(v.winner)}</div>
        </div>
        <span className="tr-chip tr-chip--lemon">
          <Icon name="crown" size="1em" /> Took the Crown in {v.showName}
        </span>
      </div>
      <div className="tr-winnercam-actions tr-interactive" data-nav-scope="1">
        {['GG!', 'Wow!', 'Next time…'].map((t) => (
          <Button
            key={t}
            size="sm"
            variant="secondary"
            onClick={() => uiEvents.emit('quickPing', { kind: `chat:${t}` })}
          >
            {t}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => uiEvents.emit('photoMode')}>
          <Icon name="camera" size="1em" /> Photo mode
        </Button>
        <Button
          variant="go"
          size="lg"
          autoFocusNav
          cue="ui.confirm"
          onClick={() => uiEvents.emit('continue', { from: 'winnerCam' })}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
