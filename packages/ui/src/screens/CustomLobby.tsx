/**
 * Custom lobby create / join (docs/design/SCREENS.md §5.9) and match history.
 */
import { useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Panel, TypeBadge } from '../components/bits.tsx';
import { Button, Slider, Toggle } from '../components/controls.tsx';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';
import type { CustomLobbyOptions, RoundType } from '../store/types.ts';
import { shakeNo } from '../theme/motion.ts';
import { Icon } from '../components/icons/index.tsx';
import { roundTypeStyle } from '../theme/tokens.ts';

const CODE_LEN = 6;
const TYPE_ORDER: RoundType[] = ['race', 'survival', 'team', 'hunt', 'logic', 'final'];

function CodeInput({ onSubmit }: { onSubmit: (code: string) => void }): JSX.Element {
  const [code, setCode] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const submit = (): void => {
    if (code.length !== CODE_LEN) {
      playCue('ui.error');
      if (ref.current) shakeNo(ref.current);
      return;
    }
    onSubmit(code);
  };
  return (
    <div className="tr-col" style={{ gap: '1em', alignItems: 'center' }}>
      <div ref={ref} className="tr-code-cells" aria-hidden>
        {Array.from({ length: CODE_LEN }, (_, i) => (
          <span key={i} className={`tr-code-cell${i === code.length ? ' is-caret' : ''}`}>
            {code[i] ?? ''}
          </span>
        ))}
      </div>
      <input
        className="tr-input tr-code-input"
        value={code}
        maxLength={CODE_LEN}
        aria-label="Lobby code"
        placeholder="ENTER CODE"
        data-nav=""
        data-autofocus=""
        onChange={(e) =>
          setCode(
            e.target.value
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')
              .slice(0, CODE_LEN),
          )
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <Button variant="go" size="lg" cue="ui.confirm" onClick={submit}>
        Join show
      </Button>
    </div>
  );
}

/** Custom lobby screen. */
export function CustomLobbyScreen(): JSX.Element {
  const lobby = useUI((s) => s.customLobby);
  const catalog = useUI((s) => s.roundCatalog);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const online = useUI((s) => s.onlineStatus.state === 'online');
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [reveal, setReveal] = useState(false);
  const [opts, setOpts] = useState<CustomLobbyOptions>({
    rounds: catalog.slice(0, 5).map((r) => r.id),
    bots: true,
    maxPlayers: 40,
    timerScale: 1,
    spectators: true,
    isPrivate: true,
  });
  const patch = (p: Partial<CustomLobbyOptions>): void => setOpts((o) => ({ ...o, ...p }));
  const back = (): void => {
    if (lobby) uiEvents.emit('leaveCustom');
    ui.getState().setScreen('menu');
  };

  return (
    <div className="tr-screen tr-custom" data-nav-scope="0">
      <div className="tr-custom-head">
        <Button variant="secondary" data-nav-back="" cue="ui.back" hint="Esc" onClick={back}>
          <Icon name="chevron-left" size="0.9em" /> Back
        </Button>
        <h1 className="tr-title tr-h2">Custom show</h1>
      </div>
      {lobby ? (
        <div className="tr-custom-body">
          <Panel tilt={-1} className="tr-custom-code">
            <span className="tr-label">Lobby code</span>
            <div className="tr-code-big">{streamer && !reveal ? '••••••' : lobby.code}</div>
            <div className="tr-row" style={{ justifyContent: 'center' }}>
              {streamer && (
                <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)}>
                  {reveal ? 'Hide' : 'Reveal'}
                </Button>
              )}
              <Button
                size="sm"
                variant="sky"
                onClick={() => {
                  void navigator.clipboard?.writeText(lobby.code);
                  uiEvents.emit('copyInvite', { code: lobby.code });
                  ui.getState().pushToast({ kind: 'success', title: 'Code copied!' });
                }}
              >
                <Icon name="copy" size="1em" /> Copy
              </Button>
            </div>
          </Panel>
          <Panel tilt={0.6} delay={80} className="tr-custom-players">
            <div className="tr-panel-head">
              <h2 className="tr-title tr-h3 tr-grow">Tumblers ({lobby.players.length})</h2>
              {lobby.isHost && (
                <Button
                  variant="go"
                  cue="ui.confirm"
                  autoFocusNav
                  onClick={() => uiEvents.emit('startCustom')}
                >
                  Start show
                </Button>
              )}
            </div>
            <div className="tr-custom-player-grid tr-scroll">
              {lobby.players.map((p) => (
                <div key={p.id} className="tr-custom-player">
                  <TumblerAvatar colors={p.colors} size="2.6em" blink={false} noShadow />
                  <span className="tr-ellipsis">{p.name}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : (
        <div className="tr-custom-body">
          <Panel tilt={-0.6} className="tr-custom-form">
            <div className="tr-seg" role="tablist" data-nav-tabs="">
              {(['create', 'join'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={t === tab}
                  aria-pressed={t === tab}
                  data-nav=""
                  onClick={() => setTab(t)}
                >
                  {t === 'create' ? 'Create' : 'Join with code'}
                </button>
              ))}
            </div>
            {tab === 'join' ? (
              online ? (
                <CodeInput onSubmit={(code) => uiEvents.emit('joinCode', { code })} />
              ) : (
                <div className="tr-empty">
                  <Icon name="globe" size="3em" />
                  <p>Joining with a code needs the online servers, which aren't reachable right now.</p>
                  <Button variant="sky" onClick={() => uiEvents.emit('retryOnline')}>
                    <Icon name="refresh" size="1em" /> Retry
                  </Button>
                </div>
              )
            ) : (
              <div className="tr-custom-create">
                <div className="tr-custom-rounds tr-scroll">
                  <span className="tr-label">Rounds · {opts.rounds.length} picked</span>
                  {TYPE_ORDER.map((type) => {
                    const rounds = catalog.filter((r) => r.type === type);
                    if (rounds.length === 0) return null;
                    return (
                      <div key={type} className="tr-col" style={{ gap: '0.3em' }}>
                        <span className="tr-label" style={{ color: roundTypeStyle[type].color }}>
                          {roundTypeStyle[type].label}
                        </span>
                        <div className="tr-row tr-wrap">
                          {rounds.map((r) => {
                            const on = opts.rounds.includes(r.id);
                            return (
                              <button
                                key={r.id}
                                type="button"
                                className={`tr-round-pick${on ? ' is-on' : ''}`}
                                aria-pressed={on}
                                data-nav=""
                                onClick={() => {
                                  playCue('ui.toggle');
                                  patch({
                                    rounds: on
                                      ? opts.rounds.filter((x) => x !== r.id)
                                      : [...opts.rounds, r.id],
                                  });
                                }}
                              >
                                {on ? <Icon name="check" size="0.85em" /> : null}
                                {r.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="tr-custom-side">
                  <div className="tr-settings-row">
                    <span>Bots fill empty spots</span>
                    <Toggle label="Bots" checked={opts.bots} onChange={(bots) => patch({ bots })} />
                  </div>
                  <div className="tr-settings-row">
                    <span>Max players</span>
                    <Slider
                      label="Max players"
                      value={opts.maxPlayers}
                      min={2}
                      max={60}
                      step={1}
                      format={(v) => String(v)}
                      onChange={(maxPlayers) => patch({ maxPlayers })}
                    />
                  </div>
                  <div className="tr-settings-row">
                    <span>Round timers</span>
                    <Slider
                      label="Round timer scale"
                      value={opts.timerScale}
                      min={0.5}
                      max={2}
                      step={0.25}
                      format={(v) => `×${v}`}
                      onChange={(timerScale) => patch({ timerScale })}
                    />
                  </div>
                  <div className="tr-settings-row">
                    <span>Allow spectators</span>
                    <Toggle
                      label="Spectators"
                      checked={opts.spectators}
                      onChange={(spectators) => patch({ spectators })}
                    />
                  </div>
                  <div className="tr-custom-actions">
                    <Button
                      variant="go"
                      size="lg"
                      cue="ui.confirm"
                      disabled={opts.rounds.length === 0 || !online}
                      data-testid="custom-create"
                      onClick={() => uiEvents.emit('createCustom', { options: opts })}
                    >
                      <Icon name="globe" size="1.1em" /> Create online lobby
                    </Button>
                    <Button
                      variant="sky"
                      size="lg"
                      cue="ui.confirm"
                      disabled={opts.rounds.length === 0}
                      data-testid="custom-offline"
                      onClick={() => uiEvents.emit('playCustomOffline', { options: opts })}
                    >
                      <Icon name="bot" size="1.1em" /> Play now vs bots
                    </Button>
                  </div>
                  {!online && (
                    <p className="tr-small tr-muted tr-custom-note">
                      The online servers are offline right now — invite codes need them. You can still play
                      your custom show against bots.
                    </p>
                  )}
                </div>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

/** Last 20 shows. */
export function MatchHistoryScreen(): JSX.Element {
  const history = useUI((s) => s.matchHistory);
  return (
    <div className="tr-screen tr-history" data-nav-scope="0">
      <div className="tr-custom-head">
        <Button
          variant="secondary"
          data-nav-back=""
          cue="ui.back"
          hint="Esc"
          autoFocusNav
          onClick={() => ui.getState().setScreen('menu')}
        >
          <Icon name="chevron-left" size="0.9em" /> Back
        </Button>
        <h1 className="tr-title tr-h2">Match history</h1>
      </div>
      <Panel className="tr-history-list tr-scroll">
        {history.length === 0 && <div className="tr-empty">No shows yet. Go make some history!</div>}
        {history.map((m, i) => (
          <div
            key={m.id}
            className={`tr-history-row is-${m.result}`}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <span className="tr-history-result">
              <Icon
                name={m.result === 'crown' ? 'crown' : m.result === 'final' ? 'flag' : 'close'}
                size="1.3em"
              />
            </span>
            <div className="tr-col tr-grow" style={{ gap: '0.25em', minWidth: 0 }}>
              <b>
                {m.playlist} <small className="tr-muted">· {new Date(m.time).toLocaleDateString()}</small>
              </b>
              <div className="tr-row tr-wrap" style={{ gap: '0.3em' }}>
                {m.rounds.map((r, j) => (
                  <span
                    key={j}
                    className={`tr-history-round${r.qualified ? ' is-q' : ' is-out'}`}
                    title={r.name}
                  >
                    <TypeBadge type={r.type} style={{ fontSize: '0.6em' }} /> {r.name}
                  </span>
                ))}
              </div>
            </div>
            <span className="tr-chip tr-chip--lemon">+{m.xp} XP</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}
