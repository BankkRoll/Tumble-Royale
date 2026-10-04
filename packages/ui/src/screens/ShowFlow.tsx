/**
 * Show flow screens before play: match found burst, pre-show lobby, show
 * intro card, round loading, flyover title card and rules card.
 * docs/design/SCREENS.md §7–§9.4.
 */
import { useEffect, useRef, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Bar, RoundDots, TipCarousel, TypeBadge } from '../components/bits.tsx';
import { formatClock, useNow, useReducedFlashing, useSequence } from '../components/hooks.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { useUI } from '../store/uiStore.ts';
import { roundTypeStyle, tumblerSwatches } from '../theme/tokens.ts';
import { fireConfetti } from '../transitions/Confetti.tsx';

/** "SHOW FOUND!" burst. */
export function MatchFoundScreen(): JSX.Element {
  const noFlash = useReducedFlashing();
  useEffect(() => {
    playCue('ui.matchFound');
    const id = window.setTimeout(
      () => fireConfetti({ x: 0.5, y: 0.5, ring: true, count: 140, speed: 1000 }),
      250,
    );
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="tr-screen tr-matchfound">
      <div
        className="tr-sunburst-spin tr-loop"
        style={{ ['--sb-a' as string]: '#ff6fae', ['--sb-b' as string]: '#ff4f9a' }}
      />
      {!noFlash && <div className="tr-flash" />}
      <div className="tr-matchfound-rain" aria-hidden>
        {Array.from({ length: 40 }, (_, i) => (
          <span
            key={i}
            style={{
              left: `${10 + ((i * 37) % 80)}%`,
              animationDelay: `${(i % 10) * 60}ms`,
              background: tumblerSwatches[i % tumblerSwatches.length],
            }}
          />
        ))}
      </div>
      <div className="tr-matchfound-title">
        <div className="tr-title tr-h1 tr-title--lemon tr-slam">Show found!</div>
        <div className="tr-chip tr-chip--ink tr-enter-pop" style={{ animationDelay: '450ms' }}>
          Get ready to tumble…
        </div>
      </div>
      <div className="tr-vignette" />
    </div>
  );
}

/** Pre-show waiting platform overlay. */
export function PreShowScreen(): JSX.Element | null {
  const info = useUI((s) => s.preShow);
  const now = useNow(250);
  const lastTick = useRef(-1);
  const remaining = info ? Math.max(0, (info.startsAt - now) / 1000) : 0;
  const secs = Math.ceil(remaining);
  useEffect(() => {
    if (secs !== lastTick.current && secs <= 5 && secs > 0) playCue('ui.countdown.tick');
    lastTick.current = secs;
  }, [secs]);
  const joins = info?.joinFeed.length ?? 0;
  useEffect(() => {
    if (joins > 0) playCue('ui.joinTick');
  }, [joins]);
  if (!info) return null;
  const feed = info.joinFeed.slice(-6);
  const offset = info.joinFeed.length - feed.length;
  const ringPct = Math.min(1, remaining / 30);
  return (
    <div className="tr-screen tr-preshow">
      <div className="tr-preshow-head tr-enter-drop">
        <div
          className="tr-panel tr-panel--tight tr-preshow-title"
          style={{ ['--tilt' as string]: '-1.5deg' }}
        >
          <span className="tr-label">Tonight's show</span>
          <div className="tr-title tr-h2">{info.showName}</div>
          <span className="tr-chip tr-chip--lemon">{info.roundCount} rounds · 1 Crown</span>
        </div>
      </div>
      <div
        className={`tr-preshow-ring${secs <= 5 ? ' is-hot' : ''}`}
        style={{ ['--p' as string]: `${ringPct * 360}deg` }}
      >
        <span className="tr-preshow-ring-label">Starting in</span>
        <b key={secs <= 5 ? secs : 'n'}>{formatClock(remaining)}</b>
      </div>
      <div className="tr-preshow-feed" aria-live="polite">
        {feed.map((n, i) => (
          <div key={offset + i} className="tr-preshow-join">
            <span
              className="tr-preshow-dot"
              style={{ background: tumblerSwatches[(offset + i) % tumblerSwatches.length] }}
            />
            <b>{n}</b> joined!
          </div>
        ))}
      </div>
      <div className="tr-preshow-count tr-panel tr-panel--tight">
        <div className="tr-row">
          <span className="tr-title tr-h3">
            {info.playersJoined} / {info.maxPlayers}
          </span>
          <span className="tr-small tr-muted">Tumblers on the platform</span>
        </div>
        <Bar value={info.playersJoined / info.maxPlayers} color="var(--mint)" />
      </div>
      <div className="tr-preshow-hint">
        <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>1–4</kbd> emote — go bonk someone while you wait!
      </div>
    </div>
  );
}

/** "THE SHOW BEGINS! · ROUND 1 OF 5". */
export function ShowIntroScreen(): JSX.Element | null {
  const info = useUI((s) => s.showIntro);
  const step = useSequence([450, 1100]);
  useEffect(() => {
    if (step === 1) playCue('ui.stamp');
  }, [step]);
  if (!info) return null;
  return (
    <div className="tr-screen tr-showintro">
      <div className="tr-sunburst-spin tr-loop" />
      <div className="tr-showintro-inner">
        <div className="tr-label tr-showintro-name tr-enter-pop">{info.showName}</div>
        {step >= 1 && <div className="tr-title tr-h1 tr-slam">The show begins!</div>}
        {step >= 2 && (
          <div className="tr-col tr-enter" style={{ alignItems: 'center' }}>
            <RoundDots index={info.roundIndex} count={info.roundCount} />
            <div className="tr-title tr-h2 tr-title--pink">
              Round {info.roundIndex + 1} of {info.roundCount}
            </div>
          </div>
        )}
      </div>
      <div className="tr-vignette" />
    </div>
  );
}

/** Flyover title card (3D flyover runs behind). */
export function RoundIntroScreen(): JSX.Element | null {
  const info = useUI((s) => s.roundIntro);
  const now = useNow(1000);
  const step = useSequence([0, 600, 750], info?.roundId);
  useEffect(() => {
    if (step === 1) playCue('ui.stamp');
  }, [step]);
  if (!info) return null;
  const t = roundTypeStyle[info.type];
  const words = info.name.split(' ');
  const perLetter = Math.min(30, 700 / Math.max(1, info.name.length));
  let letterIndex = 0;
  return (
    <div className="tr-screen tr-roundintro" style={{ ['--type' as string]: t.color }}>
      <div className="tr-roundintro-card">
        {step >= 1 && <TypeBadge type={info.type} className="tr-slam tr-roundintro-badge" />}
        <h1 className="tr-title tr-roundintro-title" aria-label={info.name}>
          {words.map((word, wi) => (
            <span key={wi} className="tr-typeon-word" aria-hidden>
              {word.split('').map((ch) => {
                const i = letterIndex++;
                return (
                  <span key={i} className="tr-typeon" style={{ animationDelay: `${120 + i * perLetter}ms` }}>
                    {ch}
                  </span>
                );
              })}
              {wi < words.length - 1 ? ' ' : null}
            </span>
          ))}
        </h1>
        {step >= 2 && <div className="tr-roundintro-objective tr-enter-left">{info.objective}</div>}
        {step >= 2 && info.mutator && (
          <div className="tr-chip tr-chip--grape tr-enter-pop" title={info.mutator.description}>
            {info.mutator.icon} {info.mutator.name}: {info.mutator.description}
          </div>
        )}
        {step >= 3 && (
          <div className="tr-row tr-wrap tr-enter-pop">
            <span className="tr-chip tr-chip--lemon">
              {info.isFinal
                ? 'Last Tumbler wins the Crown'
                : `${info.qualifyTarget} of ${info.playerCount} ${info.type === 'survival' ? 'survive' : 'qualify'}`}
            </span>
            <RoundDots index={info.roundIndex} count={info.roundCount} />
          </div>
        )}
      </div>
      {info.tips.length > 0 && (
        <div className="tr-roundintro-tips">
          <TipCarousel tips={info.tips} now={now} intervalMs={3500} />
        </div>
      )}
    </div>
  );
}

/** Rules card with three pictogram steps. */
export function RulesScreen(): JSX.Element | null {
  const info = useUI((s) => s.roundIntro);
  if (!info) return null;
  const rules =
    info.rules.length > 0
      ? info.rules.slice(0, 3)
      : [{ icon: roundTypeStyle[info.type].icon, text: info.objective }];
  return (
    <div className="tr-screen tr-rules tr-center">
      <div className="tr-panel tr-rules-card tr-enter" style={{ ['--tilt' as string]: '-1deg' }}>
        <div className="tr-row" style={{ justifyContent: 'center' }}>
          <TypeBadge type={info.type} />
          <h2 className="tr-title tr-h2">{info.name}</h2>
        </div>
        <div className="tr-rules-steps">
          {rules.map((r, i) => (
            <div key={i} className="tr-rule" style={{ animationDelay: `${200 + i * 120}ms` }}>
              <span className="tr-rule-num">{i + 1}</span>
              <span className="tr-rule-icon" aria-hidden>
                {r.icon}
              </span>
              <span className="tr-rule-text">{r.text}</span>
            </div>
          ))}
        </div>
        <div className="tr-rules-ready">
          <TumblerAvatar
            colors={{ primary: '#ffd23f', secondary: '#ff8a3d', pattern: 'stripes' }}
            expression="determined"
            size="2.4em"
            blink={false}
            noShadow
          />
          Get ready…
        </div>
      </div>
    </div>
  );
}
