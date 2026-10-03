/**
 * Private-show lobby chat: the widget's Lobby tab while the player sits in an
 * open private-show lobby, carried by the matchmaker WebSocket (`lobby_chat`),
 * plus System notices when members come and go.
 */
import { social } from '@tumble/ui';
import type { Lobby, MatchmakerClient } from '../online/matchmaker.ts';
import type { TypedMessage } from '../online/jsonSocket.ts';
import { setChannel, setChatRoute, systemNotice } from './chatRouter.ts';

/** Chat refusals from the matchmaker, shown as System notices. */
const LOBBY_CHAT_ERRORS = new Set(['chat_rate', 'chat_banned', 'empty_message', 'no_lobby']);

const shortName = (name: string): string => name.replace(/#\d+$/, '');

/**
 * Updates the Lobby tab and notices for a lobby change.
 *
 * @param prev - Lobby before the change.
 * @param next - Lobby after it (null = left, `started` = moved to the game server).
 * @param me - Local account id.
 * @param mm - Matchmaker link that carries the chat.
 */
export function syncLobbyChat(
  prev: Lobby | null,
  next: Lobby | null,
  me: string | null,
  mm: MatchmakerClient | null,
): void {
  const open = next !== null && next.status === 'open' && mm !== null;
  if (!open || prev?.code !== next?.code) setChannel('lobby', false);
  if (open) {
    setChannel('lobby', true);
    setChatRoute('lobby', (text) => mm.socket.send({ type: 'lobby_chat', text }));
  } else {
    setChatRoute('lobby', null);
  }
  if (!prev || !next || prev.code !== next.code || next.status !== 'open') return;
  const seats = (l: Lobby) => new Map([...l.players, ...l.spectators].map((p) => [p.userId, p]));
  const before = seats(prev);
  const after = seats(next);
  for (const [id, p] of after)
    if (!before.has(id) && id !== me) systemNotice(`${shortName(p.name)} joined the lobby`);
  for (const [id, p] of before)
    if (!after.has(id) && id !== me) systemNotice(`${shortName(p.name)} left the lobby`);
  if (prev.hostId !== next.hostId) {
    const host = after.get(next.hostId);
    systemNotice(
      next.hostId === me ? 'You are the host now' : `${shortName(host?.name ?? 'Someone')} is the host now`,
    );
  }
}

/**
 * Shows a relayed lobby chat line.
 *
 * @param m - `lobby_chat` event.
 * @param me - Local account id.
 */
export function onLobbyChat(m: TypedMessage, me: string | null): void {
  const from = m.from as { userId?: string; name?: string } | undefined;
  if (!from?.userId || typeof m.text !== 'string') return;
  social.getState().pushChat({
    id: String(m.id ?? `l${Date.now()}`),
    channel: 'lobby',
    from: { userId: from.userId, name: shortName(from.name ?? 'Tumbler'), key: from.userId },
    text: m.text,
    ...(typeof m.masked === 'string' ? { masked: m.masked } : {}),
    ...(from.userId === me ? { self: true } : {}),
    at: typeof m.at === 'number' ? m.at : Date.now(),
  });
}

/**
 * Shows a refused lobby chat line as a System notice.
 *
 * @param m - `error` event from the matchmaker socket.
 */
export function onLobbyChatError(m: TypedMessage): void {
  if (typeof m.code === 'string' && LOBBY_CHAT_ERRORS.has(m.code))
    systemNotice(String(m.message ?? 'Message not sent'));
}
