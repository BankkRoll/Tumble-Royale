/**
 * Routes what the player types in the global chat widget.
 *
 * Responsibilities:
 * - parse the input (`parseChatInput`: channels, `/w`, `/r`, `/party`,
 *   `/all`, `/mute`, `/help`) against the live chat state and friends list;
 * - hand each message to the transport that owns its channel: the game
 *   server (show), the matchmaker (private-show lobby), the account API
 *   (party, whispers);
 * - post local System notices (command help and errors, joins and leaves).
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
  type ChatChannel,
  type WhisperTarget,
} from '@tumble/ui';

/** Sends text on one channel. */
export type ChatSend = (text: string) => void;
/** Sends a whisper. */
export type WhisperSend = (to: WhisperTarget, text: string) => void;

const routes: Partial<Record<Exclude<ChatChannel, 'whisper' | 'system'>, ChatSend>> = {};
let whisperRoute: WhisperSend | null = null;
let systemSeq = 0;

/**
 * Registers (or clears, with null) the sender for a channel.
 *
 * @param channel - Show, lobby or party.
 * @param send - Sender, or null when the transport went away.
 */
export function setChatRoute(
  channel: Exclude<ChatChannel, 'whisper' | 'system'>,
  send: ChatSend | null,
): void {
  if (send) routes[channel] = send;
  else delete routes[channel];
}

/** Registers (or clears) the whisper sender. */
export function setWhisperRoute(send: WhisperSend | null): void {
  whisperRoute = send;
}

/**
 * Posts a System notice (always shown, never filtered).
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

/** Turns a channel (tab) on or off. */
export function setChannel(channel: ChatChannel, on: boolean, writable = on): void {
  social.getState().dispatchChat({ type: 'available', channel, on, writable });
  if (!on) social.getState().dispatchChat({ type: 'clear', channel });
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Friends by `name` or `name#tag`. */
function findFriend(name: string): WhisperTarget | null {
  const q = norm(name);
  const f = ui
    .getState()
    .friends.find((x) => !x.recent && (norm(x.name) === q || `${norm(x.name)}#${x.tag}` === q));
  return f ? { userId: f.id, name: f.name } : null;
}

/** Anyone the player can see by name: chat senders, friends, party and lobby members. */
function findMuteKey(name: string): { key: string; name: string } | null {
  const q = norm(name);
  const lines = social.getState().chat.lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const from = lines[i]!.from;
    if (from.key !== 'system' && norm(from.name) === q) return { key: from.key, name: from.name };
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
  const c = s.chat;
  const cmd = parseChatInput(raw, { ...c, findFriend });
  switch (cmd.kind) {
    case 'none':
      return;
    case 'send': {
      const send = routes[cmd.channel];
      if (send) send(cmd.text);
      else systemNotice("That chat isn't connected right now");
      return;
    }
    case 'whisper':
      if (!whisperRoute) return systemNotice('Whispers need the online servers');
      s.dispatchChat({ type: 'whisperTo', target: cmd.to });
      whisperRoute(cmd.to, cmd.text);
      return;
    case 'switch':
      if (cmd.to) s.dispatchChat({ type: 'whisperTo', target: cmd.to });
      else s.dispatchChat({ type: 'focus', channel: cmd.channel });
      // Switching is a step towards typing: keep the input open.
      s.dispatchChat({ type: 'open', channel: cmd.channel });
      return;
    case 'mute': {
      const who = findMuteKey(cmd.name);
      if (!who) return systemNotice(`No player called ${cmd.name} here`);
      // The game's mute handler persists the list and confirms with a toast.
      uiEvents.emit('mutePlayer', { key: who.key, name: who.name, muted: cmd.muted });
      return;
    }
    case 'help':
      for (const l of CHAT_HELP) systemNotice(l);
      s.dispatchChat({ type: 'open', channel: 'system' });
      return;
    case 'error':
      systemNotice(cmd.message);
      s.dispatchChat({ type: 'open', channel: 'system' });
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
