/**
 * Lobby mini-games on the menu Play tab: the Games button with its compact
 * picker, and the small score HUD shown top-centre over the 3D platform
 * while a game runs.
 *
 * The UI only asks: the solo player or party leader picks a game
 * (`lobbyGameStart`) or stops it (`lobbyGameStop`); the game publishes the
 * HUD into `ui.lobbyGames`. Neither element ever covers the start card or
 * blocks the Play button.
 */
import { memo, useEffect, useRef, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { LOBBY_GAME_INFO, LOBBY_GAME_KINDS } from '@tumble/shared';
import { playCue } from '../../audio-cues.ts';
import { Icon, type IconName } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { keyboardBusy } from '../../store/inputOwnership.ts';
import { featureOn } from '../../store/liveOps.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { LobbyGameHud, LobbyGameId } from '../../store/types.ts';

/** Picker icon per game. */
export const LOBBY_GAME_ICONS: Readonly<Record<LobbyGameId, IconName>> = {
  goal: 'flag',
  potato: 'fire',
  targets: 'target',
};

/**
 * Why a game cannot start right now, or null when it can.
 *
 * @param game - The game.
 * @param canStart - Solo or party leader.
 * @param players - Tumblers on the platform.
 */
export function lobbyGameBlocker(game: LobbyGameId, canStart: boolean, players: number): string | null {
  if (!canStart) return 'The party leader picks the game';
  const min = LOBBY_GAME_INFO[game].minPlayers;
  if (players < min) return `Needs ${min}+ players`;
  return null;
}

function closePicker(): void {
  ui.getState().setLobbyGames({ pickerOpen: false });
}

/** Props for {@link LobbyGamesButton}. */
export interface LobbyGamesButtonProps {
  /** Extra class on the root (the menu layout places it). */
  className?: string;
}

/**
 * The Games sticker button and its picker. Renders on the menu Play tab
 * only; the picker opens upward like the emote picker.
 *
 * @param props - Optional `className`.
 * @returns The button and picker, or null off the Play tab.
 * @example
 * <LobbyGamesButton className="my-menu__games" />
 */
export const LobbyGamesButton = memo(function LobbyGamesButton({
  className,
}: LobbyGamesButtonProps): JSX.Element | null {
  // party.lobbyGames off hides the picker too (the API already strips game frames).
  const visible = useUI(
    (s) => s.screen === 'menu' && s.menuTab === 'play' && featureOn(s.liveOps.flags, 'party.lobbyGames'),
  );
  const { open, canStart, players, running } = useUI(
    useShallow((s) => ({
      open: s.lobbyGames.pickerOpen,
      canStart: s.lobbyGames.canStart,
      players: s.lobbyGames.players,
      running: s.lobbyGames.hud !== null && s.lobbyGames.hud.phase !== 'results',
    })),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) {
      if (ui.getState().lobbyGames.pickerOpen) closePicker();
      return;
    }
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape' || keyboardBusy(e)) return;
      // Capture phase: closing the picker must not also count as menu Back.
      e.preventDefault();
      playCue('ui.back');
      closePicker();
    };
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closePicker();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [visible, open]);

  if (!visible) return null;

  const toggle = (): void => {
    playCue(open ? 'ui.back' : 'ui.whoosh');
    ui.getState().setLobbyGames({ pickerOpen: !open });
  };

  return (
    <div
      ref={rootRef}
      className={`tr-lobby-games${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      {open && (
        <div
          className="tr-lobby-games-panel"
          role="menu"
          aria-label="Lobby games"
          data-testid="lobby-games-panel"
        >
          <div className="tr-lobby-games-head">
            <span className="tr-lobby-games-title">Lobby games</span>
            <span className="tr-lobby-games-sub">{players === 1 ? 'Solo' : `${players} players`}</span>
          </div>
          <div className="tr-lobby-games-list">
            {LOBBY_GAME_KINDS.map((id, i) => {
              const info = LOBBY_GAME_INFO[id];
              const blocked = running ? null : lobbyGameBlocker(id, canStart, players);
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  data-nav=""
                  data-autofocus={i === 0 ? true : undefined}
                  data-testid={`lobby-game-${id}`}
                  className={`tr-lobby-game tr-lobby-game--${id}`}
                  disabled={running || blocked !== null}
                  title={blocked ?? info.rule}
                  onPointerEnter={() => playCue('ui.hover')}
                  onClick={() => {
                    playCue('ui.confirm');
                    closePicker();
                    uiEvents.emit('lobbyGameStart', { game: id });
                  }}
                >
                  <span className="tr-lobby-game-icon" aria-hidden>
                    <Icon name={LOBBY_GAME_ICONS[id]} size="1.5em" />
                  </span>
                  <span className="tr-lobby-game-text">
                    <b className="tr-lobby-game-name">{info.title}</b>
                    <small className="tr-lobby-game-rule">{blocked ?? info.rule}</small>
                  </span>
                </button>
              );
            })}
          </div>
          {running && canStart && (
            <button
              type="button"
              data-nav=""
              className="tr-lobby-games-stop"
              data-testid="lobby-game-stop"
              onClick={() => {
                playCue('ui.back');
                closePicker();
                uiEvents.emit('lobbyGameStop');
              }}
            >
              End game
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        data-nav=""
        className="tr-lobby-games-btn"
        data-testid="lobby-games"
        aria-label="Lobby games"
        title="Lobby games"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <span className="tr-lobby-games-btn-face" aria-hidden>
          <Icon name="gamepad" size="1.9em" />
        </span>
        <span className="tr-lobby-games-btn-label">Games</span>
      </button>
    </div>
  );
});

function clock(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * Score HUD for the running lobby game: title and clock, the scoreboard
 * (teams or players), the 3-2-1 intro with the one-line rules, call-outs
 * and the results line.
 *
 * @param props.hud - What to show (pass `ui.lobbyGames.hud`).
 * @param props.flash - Blink the stage on a goal (off with Reduce flashing).
 * @returns The HUD.
 */
export function LobbyGameScore({ hud, flash = true }: { hud: LobbyGameHud; flash?: boolean }): JSX.Element {
  const intro = hud.phase === 'intro';
  return (
    <div
      className={`tr-lgame tr-lgame--${hud.kind} is-${hud.phase}${hud.spectating ? ' is-spectating' : ''}`}
      data-testid="lobby-game-hud"
      role="status"
      aria-live="polite"
    >
      <div className="tr-lgame-bar">
        <span className="tr-lgame-title">{hud.title}</span>
        {hud.clock !== null && hud.phase === 'play' && (
          <span className={`tr-lgame-clock${hud.clock <= 10 ? ' is-low' : ''}`}>{clock(hud.clock)}</span>
        )}
        {hud.spectating && hud.phase !== 'results' && <span className="tr-lgame-tag">Watching</span>}
      </div>
      <div className="tr-lgame-rows">
        {hud.rows.map((r) => (
          <span
            key={r.id}
            className={`tr-lgame-row${r.self ? ' is-self' : ''}${r.out ? ' is-out' : ''}${r.it ? ' is-it' : ''}`}
            style={{ ['--row' as string]: r.color }}
          >
            <span className="tr-lgame-name tr-ellipsis">{r.label}</span>
            <b className="tr-lgame-score">{r.it ? 'IT' : r.out && hud.kind === 'potato' ? 'OUT' : r.score}</b>
          </span>
        ))}
      </div>
      {hud.fuse !== null && hud.phase === 'play' && (
        <span className="tr-lgame-fuse" aria-label="Fuse">
          <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, hud.fuse))})` }} />
        </span>
      )}
      {intro && (
        <div className="tr-lgame-intro">
          <span key={hud.countdown} className="tr-lgame-count">
            {hud.countdown > 0 ? hud.countdown : 'GO!'}
          </span>
          <span className="tr-lgame-rule">{hud.rule}</span>
        </div>
      )}
      {hud.banner && hud.phase === 'play' && (
        <span key={hud.banner.seq} className={`tr-lgame-banner is-${hud.banner.tone}`}>
          {hud.banner.text}
        </span>
      )}
      {flash && hud.kind === 'goal' && hud.banner && hud.phase === 'play' && (
        <span key={`flash-${hud.banner.seq}`} className="tr-lgame-flash" aria-hidden />
      )}
      {hud.phase === 'results' && hud.result && (
        <span className={`tr-lgame-result${hud.won ? ' is-won' : ''}`}>{hud.result}</span>
      )}
    </div>
  );
}

/**
 * The HUD slot on the Play tab: renders {@link LobbyGameScore} while a game
 * runs, nothing otherwise.
 */
export const LobbyGameHudSlot = memo(function LobbyGameHudSlot(): JSX.Element | null {
  const hud = useUI((s) => s.lobbyGames.hud);
  const calm = useUI((s) => s.settings.accessibility.reduceFlashing);
  if (!hud) return null;
  return (
    <div className="tr-play-lgame">
      <LobbyGameScore hud={hud} flash={!calm} />
    </div>
  );
});
