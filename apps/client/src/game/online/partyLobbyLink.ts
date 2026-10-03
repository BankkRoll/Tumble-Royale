/**
 * Adapts the API realtime socket to the menu lobby's {@link PartyLobbyLink}:
 * outgoing `party_lobby` frames and fellow members' relayed frames.
 */
import { PARTY_LOBBY_TYPE, type PartyLobbyFrame } from '@tumble/shared';
import type { PartyLobbyLink } from '../views/partyLobbyView.ts';
import type { JsonSocket } from './jsonSocket.ts';

/**
 * Wraps the realtime socket for the party lobby.
 *
 * @param socket - The account's API gateway socket.
 * @example
 * new MenuView({ ..., lobbyLink: partyLobbyLink(realtime) });
 */
export function partyLobbyLink(socket: JsonSocket): PartyLobbyLink {
  return {
    send: (msg) => socket.send({ ...msg }),
    onFrame: (fn) =>
      socket.on(PARTY_LOBBY_TYPE, (m) => {
        if (typeof m.userId === 'string') fn(m.userId, m as unknown as PartyLobbyFrame);
      }),
    onOpen: (fn) => socket.on('socket_open', fn),
  };
}
