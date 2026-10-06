/**
 * Routes what the player types in the global chat widget.
 *
 * Responsibilities:
 * - parse the input (`parseChatInput`: plain text to the open tab, `/w`,
 *   `/r`, `/p`, `/c`, `/all`, `/mute`, `/help`) against the live chat state
 *   and friends list;
 * - hand each message to the transport that owns its target: All goes to
 *   the current public room (game server for a show, matchmaker for a
 *   private-show lobby, account API gateway for the menu's global room);
 *   Party, Club and Whispers go to the account API;
 * - post System notices (joins, leaves, command help), which show inline in
 *   every tab, and refusals as the single inline hint.
 *
 * Transports register themselves while they exist (a show session, the
 * matchmaker link, the account), so the router never holds stale sockets.
 */
import {
  bindUI,
  CHAT_HELP,
  parseChatInput,
  social,
  ui,
  uiEvents,
  type PublicRoom,
  type RoomAccess,
  type WhisperTarget,
} from '@tumble/ui';

/** Sends text to one room or the party. */
export type ChatSend = (text: string) => void;
/** Sends a whisper. */
export type WhisperSend = (to: WhisperTarget, text: string) => void;
/** Where {@link ChatSend}s are registered. */
export type ChatRouteKey = PublicRoom | 'party' | 'club';

const routes: Partial<Record<ChatRouteKey, ChatSend>> = {};
let whisperRoute: WhisperSend | null = null;
let systemSeq = 0;

/**
 * Registers (or clears, with null) the sender for a room or the party.
 *
 * @param key - `show`, `lobby`, `global` or `party`.
 * @param send - Sender, or null when the transport went away.
 */
export function setChatRoute(key: ChatRouteKey, send: ChatSend | null): void {
  if (send) routes[key] = send;
  else delete routes[key];
}

/** Registers (or clears) the whisper sender, which also turns whispers on or off. */
export function setWhisperRoute(send: WhisperSend | null): void {
  whisperRoute = send;
  social.getState().dispatchChat({ type: 'whispers', on: send !== null });
  if (!send) social.getState().dispatchChat({ type: 'clear', target: 'whisper' });
}

/**
 * Posts a System notice: greyed, inline in every tab, never filtered.
 *
 * @param text - Notice.
 */
export function systemNotice(text: string): void {
  social.getState().pushChat({
    id: `sys-${Date.now()}-${++systemSeq}`,
    channel: 'system',
    from: { name: 'System', key: 'system' },
    text,
    at: Date.now(),
  });
}

/**
 * Shows a short refusal (rate limit, chat ban, offline) once, replacing any
 * previous one, so repeated refusals never flood the feed.
 *
 * @param text - Hint.
 */
export function chatHint(text: string): void {
  social.getState().dispatchChat({ type: 'hint', text, at: Date.now() });
}

/**
 * Sets how the player may use a public room; turning it off drops its lines.
 *
 * @param room - Room.
 * @param access - `off`, `read` (pings only) or `write`.
 */
export function setChatRoom(room: PublicRoom, access: RoomAccess): void {
  social.getState().dispatchChat({ type: 'room', room, access });
  if (access === 'off') social.getState().dispatchChat({ type: 'clear', target: room });
}

/**
 * Turns the Party tab on or off; off drops the party's lines.
 *
 * @param on - In a party with someone else.
 */
export function setPartyChat(on: boolean): void {
  social.getState().dispatchChat({ type: 'party', on });
  if (!on) social.getState().dispatchChat({ type: 'clear', target: 'party' });
}

/**
 * Turns the Club tab on or off; off drops the club's lines.
 *
 * @param on - In a club.
 */
export function setClubChat(on: boolean): void {
  social.getState().dispatchChat({ type: 'club', on });
  if (!on) social.getState().dispatchChat({ type: 'clear', target: 'club' });
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Friends by `name` or `name#tag`. */
function findFriend(name: string): WhisperTarget | null {
  const q = norm(name);
  const f = ui
    .getState()
    .friends.find((x) => !x.recent && (norm(x.name) === q || `${norm(x.name)}#${x.tag}` === q));
  return f ? { userId: f.id, name: f.name, tag: f.tag } : null;
}

/** Anyone the player can see by name: chat senders, friends, party and lobby members. */
function findMuteKey(name: string): { key: string; name: string } | null {
  const q = norm(name);
  const lines = social.getState().chat.lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const from = lines[i]!.from;
    if (from.key === 'system') continue;
    if (norm(from.name) === q || (from.tag && `${norm(from.name)}#${from.tag}` === q))
      return { key: from.key, name: from.name };
  }
  const s = ui.getState();
  const friend = s.friends.find((f) => norm(f.name) === q || `${norm(f.name)}#${f.tag}` === q);
  if (friend) return { key: friend.id, name: friend.name };
  const member =
    s.party?.members.find((m) => !m.isSelf && norm(m.name) === q) ??
    [...(s.customLobby?.players ?? []), ...(s.customLobby?.spectators ?? [])].find(
      (m) => !m.isSelf && norm(m.name) === q,
    );
  return member ? { key: member.id, name: member.name } : null;
}

/**
 * Handles one submitted input line.
 *
 * @param raw - What the player typed.
 */
export function routeChatInput(raw: string): void {
  const s = social.getState();
  const cmd = parseChatInput(raw, { ...s.chat, findFriend });
  switch (cmd.kind) {
    case 'none':
      return;
    case 'send': {
      const send = routes[cmd.to];
      if (send) send(cmd.text);
      else chatHint('Chat needs the online servers');
      return;
    }
    case 'whisper':
      if (!whisperRoute) return chatHint('Whispers need the online servers');
      s.dispatchChat({ type: 'whisperTo', target: cmd.to });
      whisperRoute(cmd.to, cmd.text);
      return;
    case 'switch':
      if (cmd.to) s.dispatchChat({ type: 'whisperTo', target: cmd.to });
      // Switching is a step towards typing: keep the input open.
      s.dispatchChat({ type: 'open', channel: cmd.channel });
      return;
    case 'mute': {
      const who = findMuteKey(cmd.name);
      if (!who) return chatHint(`No player called ${cmd.name} here`);
      // The game's mute handler persists the list and confirms with a toast.
      uiEvents.emit('mutePlayer', { key: who.key, name: who.name, muted: cmd.muted });
      return;
    }
    case 'help':
      for (const l of CHAT_HELP) systemNotice(l);
      s.dispatchChat({ type: 'open' });
      return;
    case 'hint':
      chatHint(cmd.message);
      return;
  }
}

/**
 * Subscribes the router to the widget's `sendChat` intent.
 *
 * @returns Unsubscribe.
 */
export function bindChatRouter(): () => void {
  return bindUI({ onSendChat: ({ text }) => routeChatInput(text) });
}
