/**
 * Private shows, as dialogs over the main menu (docs/design/SCREENS.md §5.9):
 *
 * - `PrivateShowDialog`: pick rounds and house rules, then play them against
 *   bots right away or get an invite code (needs the online servers). Once a
 *   lobby exists the same dialog shows its code, who joined and Start.
 * - `JoinCodeDialog`: type a friend's invite code. Opened from the start
 *   card, the private show dialog and the friends sheet.
 */
import { useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button, Slider, Toggle } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { CustomLobbyOptions, CustomLobbyState, RoundType } from '../../store/types.ts';
import { shakeNo } from '../../theme/motion.ts';
import { roundTypeStyle } from '../../theme/tokens.ts';

const CODE_LEN = 6;
const TYPE_ORDER: RoundType[] = ['race', 'survival', 'team', 'hunt', 'logic', 'final'];

function closeOverlay(): void {
  playCue('ui.back');
  ui.getState().setOverlay('none');
}

function DialogShell({
  label,
  title,
  className,
  onClose = closeOverlay,
  children,
}: {
  label: string;
  title: string;
  className: string;
  onClose?: () => void;
  children: JSX.Element | (JSX.Element | null | false)[];
}): JSX.Element {
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="12"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="tr-dim" onClick={onClose} />
      <div className={`tr-panel tr-pshow tr-enter-pop ${className}`}>
        <div className="tr-pshow-head">
          <h2 className="tr-title tr-h2 tr-grow">{title}</h2>
          <button
            type="button"
            className="tr-close"
            data-nav=""
            data-nav-back=""
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Join with a code
// -----------------------------------------------------------------------------

/** Opens the join-with-code dialog. */
export function openJoinCode(): void {
  playCue('ui.click');
  ui.getState().setOverlay('joinCode');
}

/** Small dialog for a friend's invite code. */
export function JoinCodeDialog(): JSX.Element {
  const online = useUI((s) => s.onlineStatus.state === 'online');
  const [code, setCode] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const submit = (): void => {
    if (code.length !== CODE_LEN) {
      playCue('ui.error');
      if (ref.current) shakeNo(ref.current);
      return;
    }
    uiEvents.emit('joinCode', { code });
  };
  return (
    <DialogShell label="Join with a code" title="Join with a code" className="tr-pshow--join">
      {online ? (
        <div className="tr-col tr-pshow-join">
          <p className="tr-muted tr-small">Ask the host for their 6-character invite code.</p>
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
            aria-label="Invite code"
            placeholder="CODE"
            autoComplete="off"
            data-nav=""
            data-autofocus=""
            data-testid="join-code-input"
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
          <Button
            variant="go"
            size="lg"
            cue="ui.confirm"
            disabled={code.length !== CODE_LEN}
            onClick={submit}
          >
            Join show
          </Button>
        </div>
      ) : (
        <div className="tr-empty">
          <Icon name="globe" size="3em" />
          <p>Invite codes need the online servers, which aren't reachable right now.</p>
          <Button variant="sky" data-autofocus="" onClick={() => uiEvents.emit('retryOnline')}>
            <Icon name="refresh" size="1em" /> Try again
          </Button>
        </div>
      )}
    </DialogShell>
  );
}

// -----------------------------------------------------------------------------
// Private show
// -----------------------------------------------------------------------------

/** Opens the private show dialog. */
export function openPrivateShow(): void {
  playCue('ui.confirm');
  ui.getState().setOverlay('privateShow');
}

function RoundPicker({
  picked,
  onChange,
}: {
  picked: string[];
  onChange: (rounds: string[]) => void;
}): JSX.Element {
  const catalog = useUI((s) => s.roundCatalog);
  const all = picked.length === catalog.length;
  return (
    <section className="tr-pshow-rounds" aria-label="Rounds">
      <div className="tr-pshow-section-head">
        <span className="tr-label tr-grow">
          Rounds <b className="tr-pshow-count">{picked.length}</b>
          <span className="tr-muted"> / {catalog.length}</span>
        </span>
        <button
          type="button"
          className="tr-link-btn"
          data-nav=""
          onClick={() => {
            playCue('ui.toggle');
            onChange(all ? [] : catalog.map((r) => r.id));
          }}
        >
          {all ? 'Clear all' : 'Pick all'}
        </button>
      </div>
      <div className="tr-pshow-round-list tr-scroll">
        {TYPE_ORDER.map((type) => {
          const rounds = catalog.filter((r) => r.type === type);
          if (rounds.length === 0) return null;
          const style = roundTypeStyle[type];
          return (
            <div key={type} className="tr-pshow-group" style={{ ['--type' as string]: style.color }}>
              <span className="tr-pshow-group-label">{style.label}</span>
              <div className="tr-row tr-wrap" style={{ gap: '0.35em' }}>
                {rounds.map((r) => {
                  const on = picked.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`tr-round-pick${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      data-nav=""
                      onClick={() => {
                        playCue('ui.toggle');
                        onChange(on ? picked.filter((x) => x !== r.id) : [...picked, r.id]);
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
    </section>
  );
}

function SetupView(): JSX.Element {
  const catalog = useUI((s) => s.roundCatalog);
  const online = useUI((s) => s.onlineStatus.state === 'online');
  const [opts, setOpts] = useState<CustomLobbyOptions>({
    rounds: catalog.slice(0, 5).map((r) => r.id),
    bots: true,
    maxPlayers: 40,
    timerScale: 1,
    spectators: true,
    isPrivate: true,
  });
  const patch = (p: Partial<CustomLobbyOptions>): void => setOpts((o) => ({ ...o, ...p }));
  const none = opts.rounds.length === 0;
  return (
    <>
      <div className="tr-pshow-body">
        <RoundPicker picked={opts.rounds} onChange={(rounds) => patch({ rounds })} />
        <section className="tr-pshow-rules" aria-label="House rules">
          <span className="tr-label">House rules</span>
          <div className="tr-settings-row">
            <span>Fill empty spots with bots</span>
            <Toggle label="Bots" checked={opts.bots} onChange={(bots) => patch({ bots })} />
          </div>
          {!opts.bots && (
            <span className="tr-small tr-muted">
              Vs-bots play still adds the fewest bots your rounds need (a rival for finals, full teams for
              team rounds).
            </span>
          )}
          <div className="tr-settings-row">
            <span>Players</span>
            <Slider
              label="Players"
              value={opts.maxPlayers}
              min={2}
              max={60}
              step={1}
              format={(v) => String(v)}
              onChange={(maxPlayers) => patch({ maxPlayers })}
            />
          </div>
          <div className="tr-settings-row">
            <span>Round length</span>
            <Slider
              label="Round length"
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
        </section>
      </div>
      <div className="tr-pshow-foot">
        <button type="button" className="tr-link-btn" data-nav="" onClick={openJoinCode}>
          <Icon name="key" size="1em" /> Have a code?
        </button>
        <span className="tr-grow" />
        {!online && (
          <span className="tr-small tr-muted tr-pshow-note">Invite codes need the online servers</span>
        )}
        <Button
          variant="sky"
          cue="ui.confirm"
          disabled={none || !online}
          data-testid="custom-create"
          onClick={() => uiEvents.emit('createCustom', { options: opts })}
        >
          <Icon name="friends" size="1.1em" /> Invite friends
        </Button>
        <Button
          variant="go"
          cue="ui.confirm"
          autoFocusNav
          disabled={none}
          data-testid="custom-offline"
          onClick={() => {
            ui.getState().setOverlay('none');
            uiEvents.emit('playCustomOffline', { options: opts });
          }}
        >
          <Icon name="bot" size="1.1em" /> Play with bots
        </Button>
      </div>
    </>
  );
}

function LobbyView({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const catalog = useUI((s) => s.roundCatalog);
  const [reveal, setReveal] = useState(false);
  const names = lobby.options.rounds.map((id) => catalog.find((r) => r.id === id)?.name ?? id);
  return (
    <>
      <div className="tr-pshow-body tr-pshow-body--lobby">
        <section className="tr-pshow-code" aria-label="Invite code">
          <span className="tr-label">Invite code</span>
          <div className="tr-code-big" data-testid="lobby-code">
            {streamer && !reveal ? '••••••' : lobby.code}
          </div>
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
              <Icon name="copy" size="1em" /> Copy code
            </Button>
          </div>
          <p className="tr-small tr-muted">
            {names.length} round{names.length === 1 ? '' : 's'} · up to {lobby.options.maxPlayers} players
            {lobby.options.bots ? ' · bots fill the rest' : ''}
          </p>
        </section>
        <section className="tr-pshow-players" aria-label="Players">
          <span className="tr-label">In the lobby · {lobby.players.length}</span>
          <div className="tr-custom-player-grid tr-scroll">
            {lobby.players.map((p) => (
              <div key={p.id} className="tr-custom-player">
                <TumblerAvatar colors={p.colors} size="2.2em" blink={false} noShadow />
                <span className="tr-ellipsis">{p.name}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="tr-pshow-foot">
        <Button variant="secondary" cue="ui.back" onClick={() => uiEvents.emit('leaveCustom')}>
          Leave
        </Button>
        <span className="tr-grow" />
        {lobby.isHost ? (
          <Button variant="go" cue="ui.confirm" autoFocusNav onClick={() => uiEvents.emit('startCustom')}>
            Start show
          </Button>
        ) : (
          <span className="tr-small tr-muted">Waiting for the host to start…</span>
        )}
      </div>
    </>
  );
}

/** Private show setup, or the lobby once one is created or joined. */
export function PrivateShowDialog(): JSX.Element {
  const lobby = useUI((s) => s.customLobby);
  // Closing keeps a joined lobby; Leave is the explicit way out.
  return (
    <DialogShell
      label="Private show"
      title={lobby ? 'Your private show' : 'Private show'}
      className="tr-pshow--setup"
    >
      {lobby ? <LobbyView lobby={lobby} /> : <SetupView />}
    </DialogShell>
  );
}
