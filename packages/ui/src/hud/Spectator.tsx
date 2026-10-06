/**
 * Spectator and broadcast UI (docs/design/SCREENS.md §9.6.2).
 *
 * Responsibilities:
 * - {@link SpectatorBar}: the watcher's toolbar on the personal HUD (camera
 *   mode, previous/next, player list, broadcast overlay, help);
 * - {@link BroadcastLayer}: the clean broadcaster overlay that replaces the
 *   personal HUD (round card, timer, qualified count or team scores,
 *   standings strip, the followed player's name card), the optional
 *   chroma-key backdrop, and the hotkey help card;
 * - {@link SpectatorRosterSheet}: the searchable player list (follow, pin).
 *
 * Every control has a hotkey and a controller button (read by the game), and
 * a click/tap target here for mouse and touch. Names arrive already masked
 * for Streamer Mode.
 */
import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BotTag } from '../components/bits.tsx';
import { Button } from '../components/controls.tsx';
import { formatClock, useDisplayName } from '../components/hooks.ts';
import { Icon } from '../components/icons/index.tsx';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { keyLabel } from '../screens/overlays/SettingsSheet.tsx';
import { uiEvents } from '../store/events.ts';
import {
  SPECTATOR_HELP,
  SPECTATOR_MODE_LABELS,
  broadcastActive,
  searchRoster,
  type SpectatorHelpRow,
} from '../store/spectator.ts';
import type { BindAction, PadBindAction, SpectatorRosterEntry } from '../store/types.ts';
import { ui, useUI } from '../store/uiStore.ts';
import { roundTypeStyle } from '../theme/tokens.ts';
import { padGlyph } from './glyphs.ts';
import { TeamShapeIcon } from './widgets.tsx';

/** Rows the broadcast standings strip shows. */
const STRIP_ROWS = 8;

/** The key or button for an action on the last-used device ('' on touch or when unbound). */
function useBindingLabel(): (action: BindAction | null, pad: PadBindAction | null) => string {
  const device = useUI((s) => s.hud.device);
  const binds = useUI((s) => s.settings.controls.keybinds);
  const padBinds = useUI((s) => s.settings.controls.padBinds);
  return (action, pad) => {
    if (device === 'touch') return '';
    if (device === 'gamepad') return pad ? padGlyph(pad, padBinds) : '';
    const pair = action ? binds[action] : undefined;
    return pair ? keyLabel(pair[0] || pair[1] || '') : '';
  };
}

/**
 * The watcher's toolbar on the personal HUD while spectating: camera mode,
 * previous/next, the player list, the broadcast overlay and help. Hidden in
 * broadcast mode (the overlay replaces it) and outside spectating.
 */
export const SpectatorBar = memo(function SpectatorBar(): JSX.Element | null {
  const spec = useUI(
    useShallow((s) => ({
      live: s.spectator?.live ?? false,
      mode: s.spectator?.mode ?? 'follow',
      pinned: s.spectator?.pinnedId ?? null,
      note: s.spectator?.note ?? null,
      broadcast: s.spectator?.broadcast ?? false,
    })),
  );
  const label = useBindingLabel();
  if (!spec.live || spec.broadcast) return null;
  const hint = (a: BindAction, p: PadBindAction): { hint?: string } => {
    const h = label(a, p);
    return h ? { hint: h } : {};
  };
  return (
    <div className="tr-spec-bar tr-interactive" data-nav-scope="5" data-testid="spectator-bar">
      <Button
        size="sm"
        variant="secondary"
        {...hint('spectateCamera', 'spectateCamera')}
        aria-label={`Camera: ${SPECTATOR_MODE_LABELS[spec.mode]}. Switch camera`}
        data-testid="spectator-camera"
        onClick={() => uiEvents.emit('spectatorCamera', { mode: 'next' })}
      >
        <Icon name="camera" size="1em" /> {SPECTATOR_MODE_LABELS[spec.mode]}
      </Button>
      {spec.mode === 'director' && spec.note && (
        <span className="tr-chip tr-spec-note" role="status">
          {spec.note}
        </span>
      )}
      {spec.pinned !== null && (
        <span className="tr-chip tr-spec-pin">
          <Icon name="lock" size="0.9em" /> Pinned
        </span>
      )}
      <Button
        size="sm"
        variant="secondary"
        {...hint('spectateRoster', 'spectateRoster')}
        aria-label="Find a player"
        data-testid="spectator-roster-open"
        onClick={() => ui.getState().setOverlay('spectatorRoster')}
      >
        <Icon name="friends" size="1em" /> Players
      </Button>
      <Button
        size="sm"
        variant="secondary"
        {...hint('broadcastOverlay', 'broadcastOverlay')}
        aria-label="Broadcast overlay"
        data-testid="spectator-broadcast"
        onClick={() => uiEvents.emit('broadcastToggle', { what: 'overlay' })}
      >
        <Icon name="monitor" size="1em" /> Broadcast
      </Button>
      <Button
        size="sm"
        variant="ghost"
        {...hint('broadcastHelp', 'broadcastHelp')}
        aria-label="Spectator controls"
        onClick={() => uiEvents.emit('broadcastToggle', { what: 'help' })}
      >
        ?
      </Button>
      {spec.mode === 'free' && <FreeCamHint />}
    </div>
  );
});

/** One-line free camera controls for the last-used device. */
function FreeCamHint(): JSX.Element | null {
  const device = useUI((s) => s.hud.device);
  if (device === 'touch') return <span className="tr-small tr-muted">Drag to look · stick to fly</span>;
  return (
    <span className="tr-small tr-muted tr-spec-fly">
      {device === 'gamepad'
        ? 'Left stick fly · LT/RT down/up · L3 faster'
        : 'WASD fly · Q/E down/up · Shift faster'}
    </span>
  );
}

/** Team name, colour and shape for a roster row in team rounds. */
function useTeams(): readonly {
  name: string;
  color: string;
  shape?: 'circle' | 'square' | 'triangle' | 'diamond';
}[] {
  return useUI((s) => s.hud.teams);
}

/** Status glyph for a roster or standings row. */
function StatusMark({ status }: { status: SpectatorRosterEntry['status'] }): JSX.Element | null {
  if (status === 'qualified')
    return (
      <span className="tr-bc-status is-in" aria-label="Qualified">
        <Icon name="check" size="0.9em" />
      </span>
    );
  if (status === 'eliminated')
    return (
      <span className="tr-bc-status is-out" aria-label="Eliminated">
        <Icon name="close" size="0.9em" />
      </span>
    );
  return null;
}

/** Round card: type chip, name and where it sits in the show. */
const BroadcastRoundCard = memo(function BroadcastRoundCard(): JSX.Element | null {
  const intro = useUI((s) => s.roundIntro);
  if (!intro) return null;
  const style = roundTypeStyle[intro.type];
  return (
    <div className="tr-bc-round" data-testid="broadcast-round">
      <span className="tr-bc-type" style={{ ['--type' as string]: style.color }}>
        <span aria-hidden>{style.icon}</span> {intro.isFinal ? 'FINAL' : style.label}
      </span>
      <b className="tr-bc-round-name">{intro.name}</b>
      <span className="tr-bc-round-of">
        {intro.isFinal ? 'Final round' : `Round ${intro.roundIndex + 1} of ${intro.roundCount}`}
      </span>
    </div>
  );
});

/** Big round clock (hidden in untimed rounds). */
const BroadcastTimer = memo(function BroadcastTimer(): JSX.Element | null {
  const { timeLeft, overtime } = useUI(
    useShallow((s) => ({ timeLeft: s.hud.timeLeft, overtime: s.hud.overtime })),
  );
  if (timeLeft < 0 && !overtime) return null;
  return (
    <div className={`tr-bc-timer${timeLeft <= 10 || overtime ? ' is-crit' : ''}`} role="timer">
      {overtime ? 'OVERTIME' : formatClock(timeLeft)}
    </div>
  );
});

/** Qualified / alive count, or the team scores in team rounds. */
const BroadcastScore = memo(function BroadcastScore(): JSX.Element | null {
  const h = useUI(
    useShallow((s) => ({
      type: s.hud.roundType,
      qualified: s.hud.qualified,
      target: s.hud.qualifyTarget,
      alive: s.hud.alive,
      teams: s.hud.teams,
    })),
  );
  if (h.teams.length > 0) {
    const top = Math.max(...h.teams.map((t) => t.score));
    return (
      <div className="tr-bc-teams" data-testid="broadcast-teams">
        {h.teams.map((t, i) => (
          <div
            key={i}
            className={`tr-bc-team${t.score === top && top > 0 ? ' is-top' : ''}`}
            style={{ ['--team' as string]: t.color }}
          >
            {t.shape && <TeamShapeIcon shape={t.shape} color={t.color} />}
            <span>{t.name}</span>
            <b key={t.score}>{t.score}</b>
          </div>
        ))}
      </div>
    );
  }
  const survival = h.type === 'survival' || h.type === 'logic';
  return (
    <div className="tr-bc-count" data-testid="broadcast-count">
      <span className="tr-bc-count-label">{survival ? 'ALIVE' : 'QUALIFIED'}</span>
      <b>
        {survival ? h.alive : h.qualified}
        {!survival && h.target > 0 && <span className="tr-bc-count-of"> / {h.target}</span>}
      </b>
    </div>
  );
});

/** Compact standings: the first rows of the roster by place. */
const BroadcastStandings = memo(function BroadcastStandings(): JSX.Element | null {
  const roster = useUI((s) => s.spectator?.roster);
  const teams = useTeams();
  const rows = useMemo(
    () =>
      [...(roster ?? [])]
        .sort(
          (a, b) =>
            (a.status === 'eliminated' ? 1 : 0) - (b.status === 'eliminated' ? 1 : 0) ||
            (a.place || Infinity) - (b.place || Infinity) ||
            a.id - b.id,
        )
        .slice(0, STRIP_ROWS),
    [roster],
  );
  if (rows.length === 0) return null;
  return (
    <ol className="tr-bc-standings" aria-label="Standings" data-testid="broadcast-standings">
      {rows.map((r) => {
        const team = r.team >= 0 ? teams[r.team] : undefined;
        return (
          <li key={r.id} className={`tr-bc-row${r.following ? ' is-on' : ''} is-${r.status}`}>
            <span className="tr-bc-place">{r.place > 0 ? r.place : '–'}</span>
            <span className="tr-bc-swatch" style={{ background: r.color }} aria-hidden />
            {team?.shape && <TeamShapeIcon shape={team.shape} color={team.color} />}
            <span className="tr-bc-name tr-ellipsis">{r.name}</span>
            <StatusMark status={r.status} />
          </li>
        );
      })}
    </ol>
  );
});

/** Who the camera is on: name card, or the camera mode when it follows nobody. */
const BroadcastNameCard = memo(function BroadcastNameCard(): JSX.Element {
  const spec = useUI((s) => s.spectate);
  const mode = useUI((s) => s.spectator?.mode ?? 'follow');
  const note = useUI((s) => s.spectator?.note ?? null);
  const pinned = useUI((s) => s.spectator?.pinnedId ?? null);
  const name = useDisplayName();
  const following = spec && (mode === 'follow' || mode === 'director');
  return (
    <div className="tr-bc-card" data-testid="broadcast-card">
      {following ? (
        <>
          <TumblerAvatar colors={spec.player.colors} hat={spec.player.hat} size="2.8em" blink={false} />
          <span className="tr-col tr-bc-card-text">
            <span className="tr-row" style={{ gap: '0.4em', minWidth: 0 }}>
              <b className="tr-ellipsis">{name(spec.player)}</b>
              <BotTag isBot={spec.player.isBot} />
              {pinned === spec.player.id && <Icon name="lock" size="0.9em" />}
            </span>
            <span className="tr-small">{spec.detail}</span>
          </span>
        </>
      ) : (
        <span className="tr-bc-card-mode">
          <Icon name="camera" size="1.1em" /> {SPECTATOR_MODE_LABELS[mode]}
        </span>
      )}
      {mode === 'director' && note && <span className="tr-bc-note">{note}</span>}
    </div>
  );
});

/** The hotkey help card (spectating, with or without the broadcast overlay). */
export const SpectatorHelpCard = memo(function SpectatorHelpCard(): JSX.Element | null {
  const open = useUI((s) => !!s.spectator?.live && s.spectator.help && s.screen === 'round');
  const device = useUI((s) => s.hud.device);
  const label = useBindingLabel();
  if (!open) return null;
  const glyph = (r: SpectatorHelpRow): string => {
    if (r.fixed) return device === 'gamepad' ? r.fixed[1] : r.fixed[0];
    return label(r.action, r.pad) || '—';
  };
  const rows = SPECTATOR_HELP.filter((r) => device !== 'gamepad' || r.pad !== null || r.fixed);
  return (
    <div
      className="tr-bc-help tr-interactive"
      role="dialog"
      aria-label="Spectator controls"
      data-testid="broadcast-help"
    >
      <div className="tr-row" style={{ gap: '0.5em' }}>
        <b className="tr-grow">Spectator controls</b>
        <button
          type="button"
          className="tr-close"
          aria-label="Close help"
          onClick={() => uiEvents.emit('broadcastToggle', { what: 'help', on: false })}
        >
          <Icon name="close" size="0.9em" />
        </button>
      </div>
      <dl className="tr-bc-help-list">
        {rows.map((r) => (
          <div key={r.label} className="tr-bc-help-row">
            <dt>
              <kbd>{glyph(r)}</kbd>
            </dt>
            <dd>{r.label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});

/**
 * The broadcaster's screen: the clean overlay (and, on request, a chroma-key
 * backdrop in place of the world) while broadcast mode is on, plus the help
 * card whenever it is open.
 */
export const BroadcastLayer = memo(function BroadcastLayer(): JSX.Element | null {
  const active = useUI(broadcastActive);
  const chroma = useUI((s) => s.spectator?.chroma ?? false);
  if (!active) return <SpectatorHelpCard />;
  return (
    <>
      {chroma && <div className="tr-bc-chroma" data-testid="broadcast-chroma" aria-hidden />}
      <div className="tr-bc" data-testid="broadcast-overlay" aria-label="Broadcast overlay">
        <div className="tr-bc-top">
          <BroadcastRoundCard />
          <BroadcastTimer />
          <BroadcastScore />
        </div>
        <BroadcastStandings />
        <BroadcastNameCard />
      </div>
      <SpectatorHelpCard />
    </>
  );
});

/**
 * The searchable player list (overlay `spectatorRoster`): type to filter,
 * pick a row to follow that player, the lock to pin them. Tab or Esc closes.
 */
export function SpectatorRosterSheet(): JSX.Element {
  const roster = useUI((s) => s.spectator?.roster ?? []);
  const pinned = useUI((s) => s.spectator?.pinnedId ?? null);
  const teams = useTeams();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => searchRoster(roster, query), [roster, query]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const close = (): void => ui.getState().setOverlay('none');
  const follow = (id: number): void => {
    uiEvents.emit('spectatorFollow', { id });
    close();
  };
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="12"
      role="dialog"
      aria-modal="true"
      aria-label="Players"
      data-testid="spectator-roster"
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-panel tr-spec-roster tr-enter-pop">
        <div className="tr-row" style={{ gap: '0.5em' }}>
          <h2 className="tr-title tr-h2 tr-grow">Players</h2>
          <button
            type="button"
            className="tr-close"
            data-nav=""
            data-nav-back=""
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        <input
          ref={input}
          className="tr-input"
          value={query}
          placeholder="Search by name or place"
          aria-label="Search players"
          autoComplete="off"
          data-nav=""
          data-testid="spectator-roster-search"
          onChange={(e) => setQuery(e.target.value.slice(0, 32))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rows[0]) follow(rows[0].id);
            else if (e.key === 'Tab' || e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="tr-spec-roster-list tr-scroll" role="list">
          {rows.length === 0 && <p className="tr-muted tr-small">Nobody matches “{query}”.</p>}
          {rows.map((r) => {
            const team = r.team >= 0 ? teams[r.team] : undefined;
            return (
              <div
                key={r.id}
                role="listitem"
                className={`tr-spec-roster-row is-${r.status}${r.following ? ' is-on' : ''}`}
              >
                <button
                  type="button"
                  className="tr-spec-roster-pick"
                  data-nav=""
                  aria-label={`Watch ${r.name}`}
                  data-testid="spectator-roster-row"
                  onClick={() => follow(r.id)}
                >
                  <span className="tr-bc-place">{r.place > 0 ? r.place : '–'}</span>
                  <span className="tr-bc-swatch" style={{ background: r.color }} aria-hidden />
                  {team?.shape && <TeamShapeIcon shape={team.shape} color={team.color} />}
                  <span className="tr-grow tr-ellipsis">{r.name}</span>
                  <BotTag isBot={r.isBot} />
                  {r.isParty && <span className="tr-chip tr-chip--small">Party</span>}
                  {!r.isParty && r.isClub && <span className="tr-chip tr-chip--small">Club</span>}
                  <StatusMark status={r.status} />
                </button>
                <button
                  type="button"
                  className={`tr-spec-roster-pin${r.pinned ? ' is-on' : ''}`}
                  data-nav=""
                  aria-pressed={r.pinned}
                  aria-label={r.pinned ? `Unpin ${r.name}` : `Pin ${r.name}`}
                  onClick={() => uiEvents.emit('spectatorPin', { id: pinned === r.id ? null : r.id })}
                >
                  <Icon name="lock" size="0.9em" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
