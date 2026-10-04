/**
 * Host tools once a private show is running on the game server: the host can
 * still remove a player (with a confirm). The kick goes through the
 * matchmaker, which bans them from the code and despawns them on the server.
 * Renders nothing for anyone but the host of a started private show.
 */
import { useState, type JSX } from 'react';
import { Button } from '../../components/controls.tsx';
import { useAccountName } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';

/** Removable players of the running private show, for its host. */
export function ShowHostTools(): JSX.Element | null {
  const lobby = useUI((s) => s.customLobby);
  const [armed, setArmed] = useState<string | null>(null);
  const nameOf = useAccountName();
  if (!lobby?.started || !lobby.isHost) return null;
  const others = [...lobby.players, ...lobby.spectators].filter((m) => !m.isSelf);
  if (others.length === 0) return null;
  return (
    <section className="tr-col tr-igm-host" aria-label="Host tools" data-testid="show-host-tools">
      <span className="tr-label">
        <Icon name="crown" size="0.9em" /> Your private show
      </span>
      <div className="tr-lobby-members tr-scroll">
        {others.map((m) => (
          <div key={m.id} className="tr-lobby-member">
            <span className="tr-grow tr-ellipsis">{nameOf(m)}</span>
            {armed === m.id ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  cue="ui.confirm"
                  onClick={() => {
                    setArmed(null);
                    uiEvents.emit('kickCustomMember', { userId: m.id });
                  }}
                >
                  Remove
                </Button>
                <Button size="sm" variant="ghost" cue="ui.back" onClick={() => setArmed(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${nameOf(m)}`}
                data-testid="show-kick"
                onClick={() => setArmed(m.id)}
              >
                <Icon name="close" size="1em" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
