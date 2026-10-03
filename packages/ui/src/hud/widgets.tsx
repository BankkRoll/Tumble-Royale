/**
 * In-round HUD widgets. Each selects only the HUD fields it draws so a 15 Hz
 * `setHud` only re-renders what changed.
 */
import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../audio-cues.ts';
import { BotTag } from '../components/bits.tsx';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { Button } from '../components/controls.tsx';
import { WatchChoicePanel } from '../screens/overlays/WatchChoice.tsx';
import { keyLabel } from '../screens/overlays/SettingsSheet.tsx';
import { formatClock, useDisplayName } from '../components/hooks.ts';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import { squash } from '../theme/motion.ts';
import { Icon } from '../components/icons/index.tsx';
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
            {i === 0 ? <Icon name="crown" size="0.9em" /> : i + 1}
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
          <Icon name="flag" size="1.4em" />
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
          {t.score === top && top > 0 && (
            <span className="tr-hud-team-crown">
              <Icon name="crown" size="1em" />
            </span>
          )}
          <span className="tr-hud-team-name">{t.name}</span>
          <span key={t.score} className="tr-hud-team-score">
            {t.score}
          </span>
        </div>
      ))}
    </div>
  );
});

/** Ping / FPS readout. The ping hides when `hud.ping` is negative (offline). */
export const NetStats = memo(function NetStats(): JSX.Element | null {
  const { ping, fps } = useUI(useShallow((s) => ({ ping: s.hud.ping, fps: s.hud.fps })));
  const showPing = useUI((s) => s.settings.gameplay.showPing);
  const showFps = useUI((s) => s.settings.graphics.showFps);
  // A negative ping means there is no server (offline show): nothing to report.
  const hasPing = showPing && ping >= 0;
  if (!hasPing && !showFps) return null;
  const pingQ = ping < 80 ? 'good' : ping < 160 ? 'warn' : 'bad';
  return (
    <div className="tr-hud-net">
      {hasPing && <span className={`is-${pingQ}`}>{ping} ms</span>}
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

/** Grab feedback: who you hold (stamina) or who holds you (mash meter). */
export const GrabStatus = memo(function GrabStatus(): JSX.Element | null {
  const grab = useUI((s) => s.hud.grab);
  const device = useUI((s) => s.hud.device);
  if (grab.mode === 'none') return null;
  const mash = device === 'gamepad' ? 'Ⓐ' : device === 'touch' ? 'Jump' : 'Space';
  const text =
    grab.mode === 'held'
      ? `Grabbed${grab.name ? ` by ${grab.name}` : ''}! Mash ${mash} to break free`
      : grab.mode === 'holding'
        ? `Holding ${grab.name || 'a Tumbler'}`
        : 'Carrying';
  return (
    <div className={`tr-hud-grab is-${grab.mode}`} role="status" data-testid="grab-status">
      <span className="tr-hud-grab-text">{text}</span>
      <span className="tr-hud-grab-bar" aria-hidden>
        <i style={{ width: `${Math.round(grab.meter * 100)}%` }} />
      </span>
    </div>
  );
});

/** Prompt to lock the mouse to the camera while it is free; Esc reminder once locked. */
export const CameraLockHint = memo(function CameraLockHint(): JSX.Element | null {
  const { lock, device } = useUI(useShallow((s) => ({ lock: s.cameraLock, device: s.hud.device })));
  if (lock === 'off' || device !== 'keyboard') return null;
  return (
    <div className={`tr-hud-camlock is-${lock}`} role="status" data-testid="camera-lock-hint">
      {lock === 'unlocked' ? (
        <>
          <b>Click</b> or start moving to lock the camera
        </>
      ) : (
        <>
          <kbd>Esc</kbd> frees the mouse
        </>
      )}
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

/** Prev/next hints per device: the rebindable keys, the pad's shoulder buttons, nothing on touch. */
function useSpectateHints(): [string | undefined, string | undefined] {
  const device = useUI((s) => s.hud.device);
  const prev = useUI((s) => s.settings.controls.keybinds.spectatePrev[0]);
  const next = useUI((s) => s.settings.controls.keybinds.spectateNext[0]);
  if (device === 'touch') return [undefined, undefined];
  if (device === 'gamepad') return ['LB', 'RB'];
  return [prev ? keyLabel(prev) : undefined, next ? keyLabel(next) : undefined];
}

/** Bottom spectating bar: who you're watching, prev/next (keys, pad shoulders, tap) and who is left. */
export const SpectateBanner = memo(function SpectateBanner(): JSX.Element | null {
  const spec = useUI((s) => s.spectate);
  const out = useUI((s) => s.showSeat?.outOfShow ?? false);
  const name = useDisplayName();
  const [prevHint, nextHint] = useSpectateHints();
  if (!spec) return null;
  return (
    <div className="tr-spectate tr-interactive" data-nav-scope="5" data-testid="spectate-banner">
      <Button
        variant="secondary"
        size="sm"
        {...(prevHint ? { hint: prevHint } : {})}
        aria-label="Previous player"
        onClick={() => uiEvents.emit('spectateNext', { dir: -1 })}
      >
        <Icon name="chevron-left" size="1em" />
      </Button>
      <div key={spec.player.id} className="tr-spectate-card">
        <span className="tr-label tr-spectate-label">{out ? 'Eliminated · Spectating' : 'Spectating'}</span>
        <TumblerAvatar colors={spec.player.colors} hat={spec.player.hat} size="2.6em" blink={false} />
        <span className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
          <span className="tr-row" style={{ gap: '0.4em', minWidth: 0 }}>
            <b className="tr-ellipsis">{name(spec.player)}</b>
            <BotTag isBot={spec.player.isBot} />
          </span>
          <span className="tr-small tr-muted">
            {spec.detail} · {spec.index + 1}/{spec.count}
            {spec.remaining !== undefined && ` · ${spec.remaining} still in`}
          </span>
        </span>
        {spec.qualified && (
          <span className="tr-chip tr-chip--good">
            <Icon name="check" size="0.9em" /> Qualified
          </span>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        {...(nextHint ? { hint: nextHint } : {})}
        aria-label="Next player"
        onClick={() => uiEvents.emit('spectateNext', { dir: 1 })}
      >
        <Icon name="chevron-right" size="1em" />
      </Button>
    </div>
  );
});

/** "Keep watching / Leave show" after the ELIMINATED stamp. */
export const EliminatedSheet = memo(function EliminatedSheet(): JSX.Element | null {
  const open = useUI((s) => s.eliminatedSheet);
  const choice = useUI((s) => s.watchChoice);
  if (!open) return null;
  return (
    <div className="tr-elim-sheet tr-interactive" data-nav-scope="8">
      <WatchChoicePanel choice={choice} title="Knocked out!" />
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
      <Icon name="megaphone" size="1.2em" /> {caption}
    </div>
  );
});
