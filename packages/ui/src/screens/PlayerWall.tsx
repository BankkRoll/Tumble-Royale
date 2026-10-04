/**
 * THE PLAYER WALL — end-of-show recap (docs/design/SCREENS.md §10).
 *
 * A stadium wall of cubbies, one per participant. The show replays round by
 * round: eliminated Tumblers' cells flash, their trapdoors swing open and they
 * tumble out of the wall; the counter rolls down (100 → 60 → 30 → 12 → 1); the
 * winner's cell glows, the wall shakes and the Crown drops onto them.
 *
 * Responsibilities:
 * - drive the single authoritative timeline (`playerWallTimeline`) and emit
 *   every beat as a `playerWallEvent` intent so the three.js wall can sync;
 * - render the full DOM/CSS wall (works with no 3D scene at all), or only the
 *   overlay (banners, counter, skip) when `render3D` is set;
 * - skip / auto-continue.
 */
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { BotTag, TypeBadge } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { useDisplayName } from '../components/hooks.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { uiEvents } from '../store/events.ts';
import { keyboardBusy } from '../store/inputOwnership.ts';
import { playerWallTimeline } from '../store/playerWallTimeline.ts';
import { useUI } from '../store/uiStore.ts';
import type {
  FaceExpression,
  PlayerWallEvent,
  PlayerWallOptions,
  ShowPlayer,
  ShowSummary,
} from '../store/types.ts';
import { prefersReducedMotion, screenShake } from '../theme/motion.ts';
import { confettiSets } from '../theme/tokens.ts';
import { Icon } from '../components/icons/index.tsx';
import { fireConfetti, fireFireworks } from '../transitions/Confetti.tsx';

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

/** Cell height / width. */
const CELL_ASPECT = 1.22;

/**
 * Chooses the column count that maximises cell size for `n` cells in a box.
 * Gaps and the frame padding scale with the cell (see wall.css), so they are
 * expressed as fractions of a cell.
 * @param gapRatio Gap between cells as a fraction of the cell width.
 * @param frameRatio Total frame padding + border (both sides) as a fraction of a cell.
 * @returns `{ cols, rows, cell }` with `cell` = cell width in px.
 */
export function wallGrid(
  n: number,
  width: number,
  height: number,
  gapRatio = 0.1,
  frameRatio = 0.42,
): { cols: number; rows: number; cell: number } {
  let best = { cols: 1, rows: n, cell: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = width / (cols + gapRatio * (cols - 1) + frameRatio);
    const ch = height / (rows * CELL_ASPECT + gapRatio * (rows - 1) + frameRatio);
    const cell = Math.min(cw, ch);
    if (cell > best.cell) best = { cols, rows, cell };
  }
  return best;
}

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

// -----------------------------------------------------------------------------
// Cell state
// -----------------------------------------------------------------------------

type CellPhase = 'hidden' | 'idle' | 'flash' | 'open' | 'falling' | 'gone' | 'winner' | 'crowned';

interface WallState {
  cells: Record<number, CellPhase>;
  banner: { kind: 'title' | 'round' | 'focus' | 'winner' | 'nowinner'; roundIndex: number; key: number };
  countIndex: number;
  finale: boolean;
  ended: boolean;
}

type WallAction =
  | { type: 'reset'; ids: number[] }
  | { type: 'cells'; ids: number[]; phase: CellPhase }
  | { type: 'banner'; banner: WallState['banner']['kind']; roundIndex?: number }
  | { type: 'count'; index: number }
  | { type: 'finale' }
  | { type: 'end' }
  | { type: 'skip'; summary: ShowSummary; countIndex: number };

function reducer(s: WallState, a: WallAction): WallState {
  switch (a.type) {
    case 'reset':
      return {
        cells: Object.fromEntries(a.ids.map((id) => [id, 'hidden' as CellPhase])),
        banner: { kind: 'title', roundIndex: -1, key: 0 },
        countIndex: 0,
        finale: false,
        ended: false,
      };
    case 'cells': {
      const cells = { ...s.cells };
      for (const id of a.ids) cells[id] = a.phase;
      return { ...s, cells };
    }
    case 'banner':
      return {
        ...s,
        banner: { kind: a.banner, roundIndex: a.roundIndex ?? s.banner.roundIndex, key: s.banner.key + 1 },
      };
    case 'count':
      return { ...s, countIndex: a.index };
    case 'finale':
      return { ...s, finale: true };
    case 'end':
      return { ...s, ended: true };
    case 'skip': {
      const cells: Record<number, CellPhase> = {};
      const out = new Set(a.summary.rounds.flatMap((r) => r.eliminatedIds));
      for (const p of a.summary.players)
        cells[p.id] = p.id === a.summary.winnerId ? 'crowned' : out.has(p.id) ? 'gone' : 'idle';
      const hasWinner = a.summary.winnerId >= 0;
      return {
        cells,
        banner: { kind: hasWinner ? 'winner' : 'nowinner', roundIndex: -1, key: s.banner.key + 1 },
        countIndex: a.countIndex,
        finale: true,
        ended: true,
      };
    }
  }
}

const AWW = ['aww!', 'noooo!', 'bye!', 'wheee!', 'oof!', 'help!', 'not again!'];

/** Deterministic small hash for per-player comedy choices. */
function hash(n: number, salt: number): number {
  let x = (n * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 15;
  return x;
}

// -----------------------------------------------------------------------------
// Cell
// -----------------------------------------------------------------------------

interface CellProps {
  player: ShowPlayer;
  phase: CellPhase;
  enterDelay: number;
  label: string;
  /** Registers the avatar node for the WAAPI fall. */
  register: (id: number, el: HTMLDivElement | null) => void;
}

const EXPRESSION: Record<CellPhase, FaceExpression> = {
  hidden: 'happy',
  idle: 'happy',
  flash: 'scared',
  open: 'scared',
  falling: 'dizzy',
  gone: 'dizzy',
  winner: 'grin',
  crowned: 'cheer',
};

const WallCell = memo(function WallCell({
  player,
  phase,
  enterDelay,
  label,
  register,
}: CellProps): JSX.Element {
  const bubble = hash(player.id, 7) % 10 < 3 ? AWW[hash(player.id, 3) % AWW.length] : null;
  return (
    <div
      className={`tr-wall-cell is-${phase}${player.isLocal ? ' is-local' : ''}${player.isParty ? ' is-party' : ''}`}
      style={{ animationDelay: `${enterDelay}ms` }}
      aria-label={`${label}${phase === 'gone' ? ', eliminated' : phase === 'crowned' ? ', winner' : ''}`}
    >
      <div className="tr-wall-cubby">
        <div className="tr-wall-spot" aria-hidden />
        <div className="tr-wall-avatar" ref={(el) => register(player.id, el)}>
          <TumblerAvatar
            colors={player.colors}
            hat={phase === 'crowned' ? 'crown' : player.hat}
            expression={EXPRESSION[phase]}
            size="100%"
            blink={phase === 'idle'}
            noShadow={phase === 'falling'}
          />
        </div>
        <div className="tr-wall-door" aria-hidden />
        {(phase === 'falling' || phase === 'gone') && (
          <div className="tr-wall-poof" aria-hidden>
            <i style={{ background: player.colors.primary }} />
            <i style={{ background: player.colors.secondary }} />
            <i style={{ background: player.colors.primary }} />
          </div>
        )}
        {phase === 'falling' && bubble && <span className="tr-wall-bubble">{bubble}</span>}
        {phase === 'falling' && player.isLocal && <span className="tr-wall-thatsyou">That's you!</span>}
        {phase === 'gone' && <span className="tr-wall-x">✗</span>}
        {(phase === 'winner' || phase === 'crowned') && <div className="tr-wall-rays" aria-hidden />}
        {phase === 'winner' && <span className="tr-wall-crown-drop">👑</span>}
      </div>
      <div className="tr-wall-plate">
        {player.isParty && <span aria-label="Party member">👥</span>}
        <span className="tr-ellipsis">{label}</span>
        <BotTag isBot={player.isBot} />
      </div>
      {player.isLocal && <span className="tr-wall-you">YOU</span>}
    </div>
  );
});

// -----------------------------------------------------------------------------
// Wall
// -----------------------------------------------------------------------------

/** Props for the standalone `PlayerWall`. */
export interface PlayerWallProps {
  summary: ShowSummary;
  options: PlayerWallOptions;
  /** Restart key. */
  runKey?: number;
  /** Called for every beat (in addition to the `playerWallEvent` intent). */
  onEvent?: (e: PlayerWallEvent) => void;
  /** Continue pressed or auto-continue fired. */
  onContinue?: () => void;
}

/**
 * The wall + overlay. Usable standalone; `PlayerWallScreen` wires it to the store.
 * @example <PlayerWall summary={summary} options={{ render3D: false, autoContinueMs: 6000 }} />
 */
export function PlayerWall({
  summary,
  options,
  runKey = 0,
  onEvent,
  onContinue,
}: PlayerWallProps): JSX.Element {
  const reduceMotion = useUI((s) => s.settings.accessibility.reduceMotion);
  const name = useDisplayName();
  const vp = useViewport();
  const timeline = useMemo(() => playerWallTimeline(summary, { reduceMotion }), [summary, reduceMotion]);
  const [state, dispatch] = useReducer(reducer, summary, (s) =>
    reducer({} as WallState, { type: 'reset', ids: s.players.map((p) => p.id) }),
  );
  const avatars = useRef(new Map<number, HTMLDivElement>());
  const frameRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const cancelFx = useRef<(() => void) | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;

  const register = useCallback((id: number, el: HTMLDivElement | null) => {
    if (el) avatars.current.set(id, el);
    else avatars.current.delete(id);
  }, []);

  const fall = useCallback((e: Extract<PlayerWallEvent, { type: 'cellDrop' }>) => {
    const el = avatars.current.get(e.playerId);
    if (!el) return;
    if (prefersReducedMotion()) {
      el.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(24px)' },
        ],
        { duration: 300, fill: 'forwards' },
      );
      return;
    }
    const drop = window.innerHeight * 1.25;
    const lean = e.spin > 0 ? 8 : -8;
    const frames: Keyframe[] = [
      { transform: 'translate(0, 0) rotate(0deg)', easing: 'cubic-bezier(.2,.8,.4,1)' },
      { transform: `translate(0, -14%) rotate(${lean}deg)`, offset: 0.1, easing: 'ease-in' },
    ];
    if (e.hang) {
      frames.push(
        { transform: `translate(0, 18%) rotate(${-lean}deg)`, offset: 0.22, easing: 'ease-in-out' },
        { transform: `translate(0, 14%) rotate(${lean}deg)`, offset: 0.32, easing: 'ease-in-out' },
        {
          transform: `translate(0, 20%) rotate(${-lean / 2}deg)`,
          offset: 0.4,
          easing: 'cubic-bezier(.45,0,.95,.55)',
        },
      );
    }
    frames.push({ transform: `translate(${e.drift * 300}%, ${drop}px) rotate(${e.spin}deg)` });
    el.animate(frames, { duration: e.hang ? 1500 : 1100, fill: 'forwards' });
  }, []);

  const handle = useCallback(
    (e: PlayerWallEvent) => {
      onEventRef.current?.(e);
      uiEvents.emit('playerWallEvent', e);
      switch (e.type) {
        case 'wallStart':
          playCue('ui.whoosh');
          break;
        case 'cellsIn':
          dispatch({ type: 'cells', ids: summary.players.map((p) => p.id), phase: 'idle' });
          break;
        case 'roundBanner':
          playCue('ui.stamp');
          dispatch({ type: 'banner', banner: 'round', roundIndex: e.roundIndex });
          break;
        case 'cellFlash':
          playCue('ui.wall.flash');
          dispatch({ type: 'cells', ids: e.playerIds, phase: 'flash' });
          break;
        case 'trapdoorOpen':
          playCue('ui.wall.trapdoor');
          dispatch({ type: 'cells', ids: e.playerIds, phase: 'open' });
          break;
        case 'cellDrop':
          playCue('ui.wall.fall');
          dispatch({ type: 'cells', ids: [e.playerId], phase: 'falling' });
          fall(e);
          timers.current.push(
            window.setTimeout(
              () => dispatch({ type: 'cells', ids: [e.playerId], phase: 'gone' }),
              e.hang ? 1500 : 1100,
            ),
          );
          break;
        case 'counter':
          playCue('ui.wall.counter');
          playCue('ui.wall.aww');
          dispatch({ type: 'count', index: e.roundIndex + 1 });
          break;
        case 'roundEnd':
          break;
        case 'winnerFocus':
          playCue('ui.wall.shake');
          dispatch({ type: 'finale' });
          dispatch({ type: 'banner', banner: 'focus' });
          dispatch({ type: 'cells', ids: [e.playerId], phase: 'winner' });
          if (frameRef.current) screenShake(frameRef.current, 7, 500);
          break;
        case 'crownDrop':
          timers.current.push(
            window.setTimeout(() => {
              playCue('ui.wall.crown');
              dispatch({ type: 'cells', ids: [e.playerId], phase: 'crowned' });
            }, 700),
          );
          break;
        case 'winnerReveal':
          dispatch({ type: 'banner', banner: 'winner' });
          fireConfetti({ x: 0.5, y: 0.35, count: 200, colors: confettiSets.victory });
          cancelFx.current = fireFireworks(3);
          break;
        case 'wallEnd':
          dispatch({ type: 'end' });
          if (summary.winnerId < 0) dispatch({ type: 'banner', banner: 'nowinner' });
          break;
        case 'skip':
          break;
      }
    },
    [summary, fall],
  );

  const clearTimers = (): void => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };

  useEffect(() => {
    dispatch({ type: 'reset', ids: summary.players.map((p) => p.id) });
    for (const el of avatars.current.values()) for (const a of el.getAnimations()) a.cancel();
    for (const e of timeline.events) timers.current.push(window.setTimeout(() => handle(e), e.t));
    return () => {
      clearTimers();
      cancelFx.current?.();
    };
  }, [timeline, runKey, handle, summary]);

  const skip = useCallback(() => {
    if (state.ended) return;
    clearTimers();
    for (const el of avatars.current.values()) for (const a of el.getAnimations()) a.cancel();
    playCue('ui.whoosh');
    const skipEvent: PlayerWallEvent = { type: 'skip', t: -1 };
    onEventRef.current?.(skipEvent);
    uiEvents.emit('playerWallEvent', skipEvent);
    dispatch({ type: 'skip', summary, countIndex: timeline.counts.length - 1 });
    if (summary.winnerId >= 0) fireConfetti({ x: 0.5, y: 0.35, count: 120, colors: confettiSets.victory });
    const endEvent: PlayerWallEvent = { type: 'wallEnd', t: -1 };
    onEventRef.current?.(endEvent);
    uiEvents.emit('playerWallEvent', endEvent);
  }, [state.ended, summary, timeline]);

  useEffect(() => {
    if (!state.ended || options.autoContinueMs <= 0) return;
    const id = window.setTimeout(() => onContinueRef.current?.(), options.autoContinueMs);
    return () => window.clearTimeout(id);
  }, [state.ended, options.autoContinueMs]);

  // Hold Space to skip: a tap shouldn't nuke the best moment of the show by accident.
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    let timer = 0;
    const down = (e: KeyboardEvent): void => {
      // A space typed in the chat must reach the field, not start the skip.
      if (e.code !== 'Space' || e.repeat || state.ended || keyboardBusy(e)) return;
      e.preventDefault();
      setHolding(true);
      timer = window.setTimeout(() => {
        setHolding(false);
        skip();
      }, 600);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      window.clearTimeout(timer);
      setHolding(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [skip, state.ended]);

  // Grid area: leave room for the banner on top and controls at the bottom.
  const portrait = vp.h > vp.w;
  const areaW = Math.min(vp.w * 0.94, 1500);
  const areaH = vp.h * (portrait ? 0.62 : 0.66);
  const grid = wallGrid(summary.players.length, areaW, areaH);
  const winner = summary.players.find((p) => p.id === summary.winnerId);
  const round = state.banner.roundIndex >= 0 ? summary.rounds[state.banner.roundIndex] : undefined;
  const counts = timeline.counts;

  return (
    <div className={`tr-wall-stage${options.render3D ? ' is-3d' : ''}${state.finale ? ' is-finale' : ''}`}>
      <div className="tr-wall-top">
        <div key={state.banner.key} className="tr-wall-banner tr-slam">
          {state.banner.kind === 'title' && (
            <>
              <span className="tr-label">{summary.showName}</span>
              <span className="tr-title tr-h2">The Tumble Wall</span>
            </>
          )}
          {state.banner.kind === 'round' && round && (
            <>
              <TypeBadge type={round.type} />
              <span className="tr-title tr-h2">
                Round {state.banner.roundIndex + 1} — {round.name}
              </span>
            </>
          )}
          {state.banner.kind === 'focus' && (
            <span className="tr-title tr-h2 tr-title--lemon">And the Crown goes to…</span>
          )}
          {state.banner.kind === 'winner' && winner && (
            <span className="tr-title tr-h1 tr-title--lemon">{name(winner)} wins!</span>
          )}
          {state.banner.kind === 'nowinner' && <span className="tr-title tr-h2">No Crown this time!</span>}
        </div>
        <div className="tr-wall-counter" aria-label={`${counts[state.countIndex] ?? 0} Tumblers remain`}>
          {counts.slice(0, state.countIndex).map((c, i) => (
            <span key={i} className="tr-wall-count-past">
              {c}
              <i>→</i>
            </span>
          ))}
          <span
            key={state.countIndex}
            className={`tr-wall-count-now${counts[state.countIndex] === 1 ? ' is-one' : ''}`}
          >
            {counts[state.countIndex] ?? 0}
          </span>
        </div>
      </div>

      <div
        ref={frameRef}
        className="tr-wall-frame"
        style={{ ['--cell' as string]: `${grid.cell}px`, ['--cols' as string]: String(grid.cols) }}
      >
        <div className="tr-wall-bulbs" aria-hidden />
        <div className="tr-wall-grid">
          {summary.players.map((p, i) => {
            const row = Math.floor(i / grid.cols);
            const col = i % grid.cols;
            return (
              <WallCell
                key={p.id}
                player={p}
                phase={state.cells[p.id] ?? 'hidden'}
                enterDelay={row * 90 + col * 25}
                label={name(p)}
                register={register}
              />
            );
          })}
        </div>
      </div>

      <div className="tr-wall-bottom tr-interactive" data-nav-scope="1">
        <span className="tr-chip tr-chip--ink">
          <Icon name="ticket" size="1em" /> {summary.showName}
        </span>
        <span className="tr-spacer" />
        {state.ended ? (
          <Button
            variant="go"
            size="lg"
            autoFocusNav
            cue="ui.confirm"
            className="tr-enter-pop"
            onClick={() => onContinueRef.current?.()}
          >
            Continue ▸
          </Button>
        ) : (
          <Button
            variant="secondary"
            autoFocusNav
            hint="Hold Space"
            className={holding ? 'is-holding' : ''}
            onClick={skip}
            cue={null}
          >
            Skip ▸▸
          </Button>
        )}
      </div>
    </div>
  );
}

/** Store-wired player wall screen. */
export function PlayerWallScreen(): JSX.Element | null {
  const summary = useUI((s) => s.playerWall);
  const options = useUI((s) => s.playerWallOptions);
  const seq = useUI((s) => s.playerWallSeq);
  if (!summary) return null;
  return (
    <div className="tr-screen tr-playerwall">
      {!options.render3D && <div className="tr-wall-bg" aria-hidden />}
      <PlayerWall
        summary={summary}
        options={options}
        runKey={seq}
        onContinue={() => uiEvents.emit('continue', { from: 'playerWall' })}
      />
    </div>
  );
}
