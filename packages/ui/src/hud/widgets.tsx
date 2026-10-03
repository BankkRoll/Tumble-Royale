/**
 * In-round HUD widgets. Each selects only the HUD fields it draws so a 15 Hz
 * `setHud` only re-renders what changed.
 */
import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../audio-cues.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { Button } from '../components/controls.tsx';
import { formatClock, useDisplayName } from '../components/hooks.ts';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';
import { squash } from '../theme/motion.ts';
import { roundTypeStyle } from '../theme/tokens.ts';

/** Round timer pill; turns tangerine < 30 s and bubblegum + pulsing < 10 s. */
export const HudTimer = memo(function HudTimer(): JSX.Element | null {
  const { timeLeft, timeTotal, overtime } = useUI(
    useShallow((s) => ({ timeLeft: s.hud.timeLeft, timeTotal: s.hud.timeTotal, overtime: s.hud.overtime })),
  );
  const secs = Math.ceil(timeLeft);
  const lastSec = useRef(secs);
  useEffect(() => {
    if (secs !== lastSec.current && secs <= 5 && secs >= 1) playCue('ui.countdown.tick');
    lastSec.current = secs;
  }, [secs]);
  if (timeLeft < 0 && !overtime) return null;
  const urgency = overtime ? 'over' : timeLeft <= 10 ? 'crit' : timeLeft <= 30 ? 'warn' : 'ok';
  const frac = timeTotal > 0 ? Math.max(0, Math.min(1, timeLeft / timeTotal)) : 1;
  return (
    <div
      className={`tr-hud-timer is-${urgency}`}
      role="timer"
      aria-label={overtime ? 'Overtime' : `${secs} seconds left`}
    >
      <span className="tr-hud-timer-ring" style={{ ['--p' as string]: `${frac * 360}deg` }} aria-hidden>
        ⏱
      </span>
      <span key={urgency === 'crit' ? secs : 0} className="tr-hud-timer-val">
        {overtime ? 'OVERTIME!' : formatClock(timeLeft)}
      </span>
    </div>
  );
});

/** "QUALIFIED 12 / 26" (race/final), "ALIVE 18" (survival/logic), hidden for team/hunt. */
export const QualifyCounter = memo(function QualifyCounter(): JSX.Element | null {
  const { type, qualified, target, alive } = useUI(
    useShallow((s) => ({
      type: s.hud.roundType,
      qualified: s.hud.qualified,
      target: s.hud.qualifyTarget,
      alive: s.hud.alive,
    })),
  );
  const numRef = useRef<HTMLSpanElement>(null);
  const shown = type === 'survival' || type === 'logic' ? alive : qualified;
  useEffect(() => {
    if (numRef.current) squash(numRef.current, 1.4);
  }, [shown]);
  if (type === 'team' || type === 'hunt') return null;
  const survival = type === 'survival' || type === 'logic';
  const full = !survival && target > 0 && qualified >= target;
  return (
    <div className={`tr-hud-qual${full ? ' is-full' : ''}`}>
      <span className="tr-hud-qual-label">{survival ? 'ALIVE' : 'QUALIFIED'}</span>
      <span className="tr-hud-qual-num">
        <span ref={numRef} className="tr-hud-qual-cur">
          {shown}
        </span>
        {!survival && <span className="tr-hud-qual-of">/ {target}</span>}
      </span>
    </div>
  );
});

/** Objective chip; collapses to its icon after 8 s. */
export const ObjectiveChip = memo(function ObjectiveChip(): JSX.Element | null {
  const objective = useUI((s) => s.hud.objective);
  const type = useUI((s) => s.hud.roundType);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(false);
    const id = window.setTimeout(() => setCollapsed(true), 8000);
    return () => window.clearTimeout(id);
  }, [objective]);
  if (!objective) return null;
  return (
    <div className={`tr-hud-objective${collapsed ? ' is-collapsed' : ''}`} title={objective}>
      <span aria-hidden>{roundTypeStyle[type].icon}</span>
      <span className="tr-hud-objective-text">{objective}</span>
    </div>
  );
});

/** Race progress bar with leader markers and your marker. */
export const RaceProgress = memo(function RaceProgress(): JSX.Element | null {
  const { type, progress, leaders, color } = useUI(
    useShallow((s) => ({
      type: s.hud.roundType,
      progress: s.hud.progress,
      leaders: s.hud.leaders,
      color: s.hud.localColor,
    })),
  );
  const status = useUI((s) => s.hud.localStatus);
  const name = useDisplayName();
  if (type !== 'race' && type !== 'final') return null;
  return (
    <div className="tr-hud-race" aria-label={`Race progress ${Math.round(progress * 100)}%`}>
      <div className="tr-hud-race-track">
        <span className="tr-hud-race-fill" style={{ width: `${progress * 100}%`, background: color }} />
        {leaders.map((l, i) => (
          <span
            key={l.id}
            className="tr-hud-race-leader"
            style={{ left: `${l.progress * 100}%`, background: l.color }}
            title={name({ id: l.id, name: l.name, isBot: true })}
          >
            {i === 0 ? '👑' : i + 1}
          </span>
        ))}
        {status === 'playing' && (
          <span
            className="tr-hud-race-you"
            style={{ left: `${progress * 100}%`, background: color }}
            aria-label="You"
          />
        )}
        <span className="tr-hud-race-flag" aria-hidden>
          🏁
        </span>
      </div>
    </div>
  );
});

/** Team score pills. */
export const TeamScores = memo(function TeamScores(): JSX.Element | null {
  const teams = useUI((s) => s.hud.teams);
  if (teams.length === 0) return null;
  const top = Math.max(...teams.map((t) => t.score));
  return (
    <div className="tr-hud-teams">
      {teams.map((t, i) => (
        <div
          key={i}
          className={`tr-hud-team${t.isMine ? ' is-mine' : ''}`}
          style={{ ['--team' as string]: t.color }}
        >
          {t.score === top && top > 0 && <span className="tr-hud-team-crown">👑</span>}
          <span className="tr-hud-team-name">{t.name}</span>
          <span key={t.score} className="tr-hud-team-score">
            {t.score}
          </span>
        </div>
      ))}
    </div>
  );
});

/** Ping / FPS readout. */
export const NetStats = memo(function NetStats(): JSX.Element | null {
  const { ping, fps } = useUI(useShallow((s) => ({ ping: s.hud.ping, fps: s.hud.fps })));
  const showPing = useUI((s) => s.settings.gameplay.showPing);
  const showFps = useUI((s) => s.settings.graphics.showFps);
  if (!showPing && !showFps) return null;
  const pingQ = ping < 80 ? 'good' : ping < 160 ? 'warn' : 'bad';
  return (
    <div className="tr-hud-net">
      {showPing && <span className={`is-${pingQ}`}>{ping} ms</span>}
      {showFps && <span>{fps} fps</span>}
    </div>
  );
});

const HINTS: Record<'keyboard' | 'gamepad' | 'touch', [string, string][]> = {
  keyboard: [
    ['WASD', 'Move'],
    ['Space', 'Jump'],
    ['Ctrl', 'Dive'],
    ['Shift', 'Grab'],
    ['E', 'Emote'],
  ],
  gamepad: [
    ['Ⓛ', 'Move'],
    ['Ⓐ', 'Jump'],
    ['Ⓧ', 'Dive'],
    ['RT', 'Grab'],
    ['✚', 'Emote'],
  ],
  touch: [],
};

/** Bottom-left controls hint. */
export const ControlsHint = memo(function ControlsHint(): JSX.Element | null {
  const { show, device } = useUI(useShallow((s) => ({ show: s.hud.controlsHint, device: s.hud.device })));
  if (!show || device === 'touch') return null;
  return (
    <div className="tr-hud-hint">
      {HINTS[device].map(([k, label]) => (
        <span key={label} className="tr-hud-hint-item">
          <kbd>{k}</kbd>
          {label}
        </span>
      ))}
    </div>
  );
});

/** 3 · 2 · 1 numerals. GO! is a stamp. */
export const CountdownNumerals = memo(function CountdownNumerals(): JSX.Element | null {
  const n = useUI((s) => s.countdown);
  useEffect(() => {
    if (n !== null && n > 0) playCue('ui.countdown.tick');
  }, [n]);
  if (n === null || n <= 0) return null;
  return (
    <div className="tr-countdown" aria-live="assertive">
      <span key={n} className={`tr-countdown-num tr-countdown-num--${Math.min(3, n)}`}>
        {n}
      </span>
    </div>
  );
});

/** Bottom spectating bar with Q/E cycling. */
export const SpectateBanner = memo(function SpectateBanner(): JSX.Element | null {
  const spec = useUI((s) => s.spectate);
  const name = useDisplayName();
  if (!spec) return null;
  return (
    <div className="tr-spectate tr-interactive" data-nav-scope="5">
      <Button
        variant="secondary"
        size="sm"
        hint="Q"
        aria-label="Previous player"
        onClick={() => uiEvents.emit('spectateNext', { dir: -1 })}
      >
        ◀
      </Button>
      <div key={spec.player.id} className="tr-spectate-card">
        <span className="tr-label tr-spectate-label">Spectating</span>
        <TumblerAvatar colors={spec.player.colors} hat={spec.player.hat} size="2.6em" blink={false} />
        <span className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
          <b className="tr-ellipsis">{name(spec.player)}</b>
          <span className="tr-small tr-muted">
            {spec.detail} · {spec.index + 1}/{spec.count}
          </span>
        </span>
        {spec.qualified && <span className="tr-chip tr-chip--good">✓ Qualified</span>}
      </div>
      <Button
        variant="secondary"
        size="sm"
        hint="E"
        aria-label="Next player"
        onClick={() => uiEvents.emit('spectateNext', { dir: 1 })}
      >
        ▶
      </Button>
    </div>
  );
});

/** Spectate / Back to lobby / Play again after elimination. */
export const EliminatedSheet = memo(function EliminatedSheet(): JSX.Element | null {
  const open = useUI((s) => s.eliminatedSheet);
  if (!open) return null;
  return (
    <div className="tr-elim-sheet tr-interactive" data-nav-scope="8">
      <div className="tr-panel tr-elim-panel">
        <div className="tr-title tr-h3">What now, champ?</div>
        <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
          <Button
            variant="sky"
            size="lg"
            autoFocusNav
            onClick={() => {
              ui.getState().setEliminatedSheet(false);
              uiEvents.emit('spectate');
            }}
          >
            👀 Spectate
          </Button>
          <Button
            variant="secondary"
            size="lg"
            data-nav-back=""
            cue="ui.back"
            onClick={() => uiEvents.emit('backToLobby')}
          >
            🏠 Back to lobby
          </Button>
          <Button variant="go" size="lg" cue="ui.confirm" onClick={() => uiEvents.emit('playAgain')}>
            🔁 Play again
          </Button>
        </div>
      </div>
    </div>
  );
});

/** Announcer caption chip (Accessibility → Captions). */
export const CaptionChip = memo(function CaptionChip(): JSX.Element | null {
  const caption = useUI((s) => s.caption);
  const enabled = useUI((s) => s.settings.accessibility.captions);
  if (!enabled || !caption) return null;
  return (
    <div className="tr-caption" key={caption} aria-live="polite">
      <span aria-hidden>📣</span> {caption}
    </div>
  );
});
