/**
 * Floating dev menu: every preset (grouped, searchable, deep-linkable),
 * auto-play buttons, accessibility toggles and a live intent log.
 * Toggle with the backtick key.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { ui, uiEvents, useUI } from '@tumble/ui';
import { autoplayRunning, runShow, stopAutoplay } from './autoplay.ts';
import { PRESETS, applyPreset, type Preset } from './presets.ts';

const GROUPS: Preset['group'][] = [
  'First launch',
  'Menu',
  'Show flow',
  'In round',
  'End of show',
  'Overlays & system',
];

/** The preview harness control panel. */
export function DevMenu(): JSX.Element {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('dev') !== '0');
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(() => new URLSearchParams(location.search).get('screen') ?? '');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const a11y = useUI((s) => s.settings.accessibility);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const screen = useUI((s) => s.screen);

  useEffect(
    () =>
      uiEvents.onAny((name, payload) => {
        if (name === 'touchInput') return;
        const text = payload === undefined ? name : `${name} ${JSON.stringify(payload).slice(0, 80)}`;
        setLog((l) => [text, ...l].slice(0, 10));
      }),
    [],
  );
  useEffect(() => {
    const id = window.setInterval(() => setRunning(autoplayRunning()), 300);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '`') setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return GROUPS.map(
      (g) =>
        [
          g,
          PRESETS.filter(
            (p) =>
              p.group === g && (!f || p.label.toLowerCase().includes(f) || p.id.toLowerCase().includes(f)),
          ),
        ] as const,
    );
  }, [filter]);

  if (!open) {
    return (
      <button type="button" className="dev-fab" onClick={() => setOpen(true)} title="Dev menu (`)">
        🛠
      </button>
    );
  }
  return (
    <aside className="dev-menu">
      <header className="dev-head">
        <b>Tumble UI preview</b>
        <span className="dev-screen">{screen}</span>
        <button type="button" onClick={() => setOpen(false)} title="Hide (`)">
          ✕
        </button>
      </header>
      <div className="dev-row">
        <button
          type="button"
          className="dev-go"
          onClick={() => void runShow({ win: true, fromSplash: true })}
        >
          ▶ Auto-play show (win)
        </button>
        <button type="button" className="dev-go" onClick={() => void runShow({ win: false })}>
          ▶ Auto-play (eliminated)
        </button>
        <button
          type="button"
          className="dev-go dev-fast"
          onClick={() => void runShow({ win: true, speed: 0.5 })}
        >
          ⏩ 2×
        </button>
        {running && (
          <button type="button" onClick={() => stopAutoplay()}>
            ■ Stop
          </button>
        )}
      </div>
      <div className="dev-row dev-toggles">
        <label>
          <input
            type="checkbox"
            checked={a11y.reduceMotion}
            onChange={(e) =>
              ui.getState().updateSettings('accessibility', { reduceMotion: e.target.checked })
            }
          />{' '}
          Reduce motion
        </label>
        <label>
          <input
            type="checkbox"
            checked={a11y.reduceFlashing}
            onChange={(e) =>
              ui.getState().updateSettings('accessibility', { reduceFlashing: e.target.checked })
            }
          />{' '}
          No flashing
        </label>
        <label>
          <input
            type="checkbox"
            checked={streamer}
            onChange={(e) => ui.getState().updateSettings('gameplay', { streamerMode: e.target.checked })}
          />{' '}
          Streamer
        </label>
        <label>
          CB
          <select
            value={a11y.colorBlind}
            onChange={(e) =>
              ui
                .getState()
                .updateSettings('accessibility', { colorBlind: e.target.value as typeof a11y.colorBlind })
            }
          >
            <option value="off">off</option>
            <option value="protanopia">protan</option>
            <option value="deuteranopia">deutan</option>
            <option value="tritanopia">tritan</option>
          </select>
        </label>
        <label>
          Scale {Math.round(a11y.uiScale * 100)}%
          <input
            type="range"
            min={0.8}
            max={1.4}
            step={0.05}
            value={a11y.uiScale}
            onChange={(e) =>
              ui.getState().updateSettings('accessibility', { uiScale: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <input
        className="dev-search"
        placeholder="Filter screens…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="dev-list">
        {groups.map(([g, list]) =>
          list.length === 0 ? null : (
            <section key={g}>
              <h4>{g}</h4>
              {list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === active ? 'is-active' : ''}
                  title={`?screen=${p.id}`}
                  onClick={() => {
                    setActive(p.id);
                    applyPreset(p.id);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </section>
          ),
        )}
      </div>
      <div className="dev-log">
        <h4>Intents → game</h4>
        {log.length === 0 && <i>Click things…</i>}
        {log.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </aside>
  );
}
