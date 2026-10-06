/**
 * Round replays in the UI.
 *
 * Responsibilities:
 * - `ReplayLayer`: the viewer chrome over the replay scene (title, Exit,
 *   scrub bar with elimination / qualification markers, play/pause, seek,
 *   speed 0.25×–2×, camera modes, prev/next player, Save replay). Everything
 *   is a big `data-nav` button so pads and touch work as well as the mouse;
 *   the game maps keys and pad buttons itself;
 * - `WatchReplayButton` / `ReplayPicker`: entry points on the results and
 *   rewards screens;
 * - `OpenReplayButton`: loads a saved replay file (Profile / Match history).
 *
 * The UI only emits intents (`replayOpen`, `replayOpenLive`,
 * `replayOpenFile`, `replayCommand`); the game owns playback.
 */
import { useRef, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icons/index.tsx';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type { ReplayCameraMode, ReplayCommand, ReplayRoundEntry } from '../store/types.ts';

/** Speeds offered on the speed strip (mirrors the game's clock). */
export const REPLAY_SPEED_STEPS: readonly number[] = [0.25, 0.5, 1, 1.5, 2];

const CAMERAS: readonly { mode: ReplayCameraMode; label: string }[] = [
  { mode: 'follow', label: 'Follow' },
  { mode: 'free', label: 'Free' },
  { mode: 'pov', label: 'Your view' },
];

function send(cmd: ReplayCommand): void {
  uiEvents.emit('replayCommand', cmd);
}

/**
 * `m:ss.t` playhead label.
 *
 * @param s - Seconds.
 */
export function formatReplayTime(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

function speedLabel(v: number): string {
  return `${v}×`;
}

/** The replay viewer chrome; renders nothing while no replay is open. */
export function ReplayLayer(): JSX.Element | null {
  const r = useUI((s) => s.replay);
  const touch = useUI((s) => s.isTouch);
  if (!r) return null;
  const pct = (t: number): string => `${r.duration > 0 ? Math.min(100, (t / r.duration) * 100) : 0}%`;
  return (
    <div
      className="tr-replay"
      data-nav-scope="12"
      role="region"
      aria-label="Replay"
      data-testid="replay-viewer"
    >
      <div className="tr-replay-top tr-interactive">
        <span className="tr-replay-badge">
          <Icon name="film" size="1.1em" /> Replay
        </span>
        <div className="tr-col tr-grow" style={{ gap: '0.1em', minWidth: 0 }}>
          <h2 className="tr-title tr-h3 tr-ellipsis">{r.title}</h2>
          <span className="tr-small tr-replay-sub tr-ellipsis">{r.subtitle}</span>
          {r.reel && (
            <span className="tr-small tr-replay-reel tr-ellipsis" role="status" data-testid="replay-reel">
              <Icon name="star" size="1em" /> Highlight {r.reel.index + 1}/{r.reel.count} · {r.reel.label}
            </span>
          )}
        </div>
        {r.canSave && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="replay-save"
            onClick={() => send({ type: 'save' })}
          >
            <Icon name="download" size="1em" /> Save replay
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          hint={touch ? undefined : 'Esc'}
          cue="ui.back"
          data-nav-back=""
          data-testid="replay-exit"
          onClick={() => send({ type: 'exit' })}
        >
          <Icon name="close" size="0.9em" /> Exit replay
        </Button>
      </div>

      <div className="tr-replay-bar tr-panel tr-interactive">
        <div className="tr-replay-scrub">
          <input
            type="range"
            className="tr-replay-range"
            data-nav=""
            min={0}
            max={Math.max(0.1, r.duration)}
            step={0.05}
            value={Math.min(r.time, r.duration)}
            aria-label="Replay position"
            aria-valuetext={`${formatReplayTime(r.time)} of ${formatReplayTime(r.duration)}`}
            onChange={(e) => send({ type: 'seek', t: Number(e.currentTarget.value) })}
            style={{ ['--pos' as string]: pct(r.time) }}
          />
          <div className="tr-replay-markers" aria-hidden={r.markers.length > 24}>
            {r.markers.map((m, i) => (
              <button
                key={`${m.t}-${i}`}
                type="button"
                className={`tr-replay-marker is-${m.kind}`}
                style={{ left: pct(m.t) }}
                title={`${formatReplayTime(m.t)} · ${m.label}`}
                aria-label={`${m.label} at ${formatReplayTime(m.t)}`}
                tabIndex={-1}
                onClick={() => {
                  playCue('ui.click');
                  // Land a beat early so the moment itself plays out.
                  send({ type: 'seek', t: Math.max(0, m.t - 2) });
                }}
              />
            ))}
          </div>
        </div>

        <div className="tr-replay-controls">
          <div className="tr-row tr-replay-transport">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Back 5 seconds"
              onClick={() => send({ type: 'seekBy', seconds: -5 })}
            >
              <Icon name="chevron-left" size="0.9em" /> 5s
            </Button>
            <Button
              variant="go"
              aria-label={r.playing ? 'Pause' : 'Play'}
              autoFocusNav
              data-testid="replay-toggle"
              onClick={() => send({ type: 'toggle' })}
            >
              <Icon name={r.playing ? 'pause' : 'play'} size="1.2em" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Forward 5 seconds"
              onClick={() => send({ type: 'seekBy', seconds: 5 })}
            >
              5s <Icon name="chevron-right" size="0.9em" />
            </Button>
            <span className="tr-replay-time" aria-live="off">
              {formatReplayTime(r.time)} <small>/ {formatReplayTime(r.duration)}</small>
            </span>
          </div>

          <div className="tr-row tr-replay-group" role="group" aria-label="Playback speed">
            {REPLAY_SPEED_STEPS.map((v) => (
              <button
                key={v}
                type="button"
                data-nav=""
                className={`tr-chip tr-replay-chip${r.speed === v ? ' is-on' : ''}`}
                aria-pressed={r.speed === v}
                onClick={() => {
                  playCue('ui.click');
                  send({ type: 'speed', speed: v });
                }}
              >
                {speedLabel(v)}
              </button>
            ))}
          </div>

          <div className="tr-row tr-replay-group" role="group" aria-label="Camera">
            {CAMERAS.map((c) => (
              <button
                key={c.mode}
                type="button"
                data-nav=""
                className={`tr-chip tr-replay-chip${r.camera === c.mode ? ' is-on' : ''}`}
                aria-pressed={r.camera === c.mode}
                disabled={c.mode === 'pov' && !r.povAvailable}
                onClick={() => {
                  playCue('ui.click');
                  send({ type: 'camera', mode: c.mode });
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="tr-row tr-replay-target" role="group" aria-label="Followed player">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Previous player"
              hint={touch ? undefined : 'Q'}
              onClick={() => send({ type: 'player', dir: -1 })}
            >
              <Icon name="chevron-left" size="0.9em" />
            </Button>
            <span className="tr-replay-who tr-ellipsis">
              {r.target ? (
                <>
                  <i className="tr-replay-swatch" style={{ background: r.target.color }} aria-hidden />
                  {r.target.name}
                </>
              ) : (
                'Free camera'
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Next player"
              hint={touch ? undefined : 'E'}
              onClick={() => send({ type: 'player', dir: 1 })}
            >
              <Icon name="chevron-right" size="0.9em" />
            </Button>
          </div>
        </div>
        {!touch && (
          <p className="tr-small tr-replay-hints">
            <kbd>Space</kbd> play/pause <kbd>←</kbd>
            <kbd>→</kbd> seek <kbd>↑</kbd>
            <kbd>↓</kbd> speed <kbd>C</kbd> camera <kbd>WASD</kbd> move free camera · drag to look, wheel to
            zoom
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * "Watch replay" for one recorded round (results screen).
 *
 * @param props.roundIndex - Round to offer; renders nothing when it wasn't recorded.
 */
export function WatchReplayButton({ roundIndex }: { roundIndex: number }): JSX.Element | null {
  const entry = useUI((s) => s.replays.find((e) => e.roundIndex === roundIndex));
  if (!entry) return null;
  return (
    <Button
      variant="secondary"
      data-testid="watch-replay"
      onClick={() => uiEvents.emit('replayOpen', { key: entry.key })}
    >
      <Icon name="film" size="1.1em" /> Watch replay
    </Button>
  );
}

function outcomeLabel(e: ReplayRoundEntry): string {
  return e.outcome === 'qualified' ? 'Qualified' : e.outcome === 'eliminated' ? 'Out' : 'Watched';
}

/** Round picker for the rewards screen: any round of the show just played. */
export function ReplayPicker(): JSX.Element | null {
  const entries = useUI((s) => s.replays);
  if (entries.length === 0) return null;
  return (
    <div className="tr-replay-picker" role="group" aria-label="Watch a replay" data-testid="replay-picker">
      <span className="tr-label">
        <Icon name="film" size="1.1em" /> Replays
      </span>
      {entries.map((e) => (
        <button
          key={e.key}
          type="button"
          data-nav=""
          className={`tr-chip tr-replay-pick is-${e.outcome}`}
          title={`${e.name} · ${outcomeLabel(e)} · ${formatReplayTime(e.duration)}`}
          onClick={() => {
            playCue('ui.confirm');
            uiEvents.emit('replayOpen', { key: e.key });
          }}
        >
          {e.isFinal ? 'Final' : `R${e.roundIndex + 1}`} · {e.name}
        </button>
      ))}
    </div>
  );
}

/** Loads a saved `.tumblereplay` file and asks the game to play it. */
export function OpenReplayButton(): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="secondary" size="sm" data-testid="open-replay" onClick={() => input.current?.click()}>
        <Icon name="upload" size="1em" /> Open replay
      </Button>
      <input
        ref={input}
        type="file"
        accept=".tumblereplay,application/octet-stream"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          void file
            .arrayBuffer()
            .then((bytes) => uiEvents.emit('replayOpenFile', { name: file.name, bytes }));
        }}
      />
    </>
  );
}
