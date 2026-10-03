import { describe, expect, it } from 'vitest';
import {
  INITIAL_CHAT,
  linesOf,
  parseChatInput,
  reduceChat,
  type ChatLine,
  type ChatState,
  type CommandContext,
} from '../src/store/chatChannels.ts';

const PAL = { userId: 'u-pal', name: 'Zippy Noodle' };
let n = 0;
const line = (over: Partial<ChatLine> = {}): ChatLine => ({
  id: `l${++n}`,
  from: { userId: 'u-x', name: 'X', key: 'u-x' },
  text: 'hi',
  at: n,
  ...over,
});

function withChannels(...on: ('show' | 'lobby' | 'party' | 'whisper')[]): ChatState {
  return on.reduce((s, c) => reduceChat(s, { type: 'available', channel: c, on: true }), INITIAL_CHAT);
}

describe('chat channels', () => {
  it('starts on System and moves to the live channel when one appears', () => {
    expect(INITIAL_CHAT.active).toBe('system');
    expect(withChannels('party').active).toBe('party');
    expect(withChannels('party', 'show').active).toBe('party');
  });

  it('counts unread per channel, except for the open tab and your own lines', () => {
    let s = withChannels('party', 'show');
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'show' }) });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'party', self: true }) });
    expect(s.unread).toMatchObject({ show: 1, party: 0 });
    s = reduceChat(s, { type: 'open', channel: 'party' });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'party' }) });
    expect(s.unread.party).toBe(0);
    s = reduceChat(s, { type: 'focus', channel: 'show' });
    expect(s.unread.show).toBe(0);
  });

  it('dedupes lines, caps history and filters by channel', () => {
    let s = withChannels('show');
    const l = line({ channel: 'show' });
    s = reduceChat(s, { type: 'receive', line: l });
    expect(reduceChat(s, { type: 'receive', line: l })).toBe(s);
    for (let i = 0; i < 250; i++) s = reduceChat(s, { type: 'receive', line: line({ channel: 'system' }) });
    expect(s.lines).toHaveLength(200);
    expect(linesOf(s, 'show')).toHaveLength(0);
  });

  it('drops a channel that goes away and falls back to the next useful tab', () => {
    let s = withChannels('show', 'party');
    s = reduceChat(s, { type: 'focus', channel: 'show' });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'show' }) });
    s = reduceChat(s, { type: 'available', channel: 'show', on: false });
    expect(s.active).toBe('party');
    expect(s.unread.show).toBe(0);
    expect(reduceChat(s, { type: 'focus', channel: 'show' })).toBe(s);
  });

  it('cycles through available tabs only, both ways', () => {
    let s = withChannels('party', 'whisper');
    s = reduceChat(s, { type: 'focus', channel: 'party' });
    s = reduceChat(s, { type: 'cycle', dir: 1 });
    expect(s.active).toBe('whisper');
    s = reduceChat(s, { type: 'cycle', dir: 1 });
    expect(s.active).toBe('system');
    s = reduceChat(s, { type: 'cycle', dir: 1 });
    expect(s.active).toBe('party');
    s = reduceChat(s, { type: 'cycle', dir: -1 });
    expect(s.active).toBe('system');
  });

  it('remembers who to reply to and who the Whispers tab talks to', () => {
    let s = withChannels('whisper');
    s = reduceChat(s, {
      type: 'receive',
      line: line({ channel: 'whisper', from: { userId: PAL.userId, name: PAL.name, key: PAL.userId } }),
    });
    expect(s.replyTo).toEqual(PAL);
    expect(s.whisperTo).toEqual(PAL);
    s = reduceChat(s, { type: 'whisperTo', target: { userId: 'u2', name: 'Other' } });
    expect(s.active).toBe('whisper');
    expect(s.whisperTo?.name).toBe('Other');
    expect(s.replyTo).toEqual(PAL);
  });

  it('opens in quick mode and closes back to text', () => {
    let s = reduceChat(INITIAL_CHAT, { type: 'open', mode: 'quick' });
    expect(s).toMatchObject({ open: true, mode: 'quick' });
    s = reduceChat(s, { type: 'close' });
    expect(s).toMatchObject({ open: false, mode: 'text' });
  });
});

describe('chat commands', () => {
  const ctx = (s: ChatState, over: Partial<CommandContext> = {}): CommandContext => ({
    active: s.active,
    available: s.available,
    writable: s.writable,
    whisperTo: s.whisperTo,
    replyTo: s.replyTo,
    findFriend: (name) =>
      name.toLowerCase() === 'zippy noodle' || name.toLowerCase() === 'zippy noodle#0420' ? PAL : null,
    ...over,
  });

  it('sends plain text to the active channel', () => {
    const s = withChannels('party');
    expect(parseChatInput('  hello   there ', ctx(s))).toEqual({
      kind: 'send',
      channel: 'party',
      text: 'hello there',
    });
    expect(parseChatInput('   ', ctx(s))).toEqual({ kind: 'none' });
  });

  it('whispers by name with spaces, or switches to the friend without a message', () => {
    const s = withChannels('whisper');
    expect(parseChatInput('/w Zippy Noodle see you in there', ctx(s))).toEqual({
      kind: 'whisper',
      to: PAL,
      text: 'see you in there',
    });
    expect(parseChatInput('/msg zippy noodle#0420', ctx(s))).toEqual({
      kind: 'switch',
      channel: 'whisper',
      to: PAL,
    });
    expect(parseChatInput('/w Nobody hi', ctx(s))).toMatchObject({ kind: 'error' });
    expect(parseChatInput('/w', ctx(s))).toMatchObject({ kind: 'error' });
    expect(parseChatInput('/w Zippy Noodle hi', ctx(INITIAL_CHAT))).toMatchObject({ kind: 'error' });
  });

  it('/r replies to the last whisperer', () => {
    const s = withChannels('whisper');
    expect(parseChatInput('/r thanks', ctx(s))).toMatchObject({ kind: 'error' });
    expect(parseChatInput('/r thanks', ctx(s, { replyTo: PAL }))).toEqual({
      kind: 'whisper',
      to: PAL,
      text: 'thanks',
    });
  });

  it('/party and /all switch or send, and refuse missing channels', () => {
    const s = withChannels('party', 'show');
    expect(parseChatInput('/party', ctx(s))).toEqual({ kind: 'switch', channel: 'party' });
    expect(parseChatInput('/p ready up', ctx(s))).toEqual({
      kind: 'send',
      channel: 'party',
      text: 'ready up',
    });
    expect(parseChatInput('/all gg', ctx(s))).toEqual({ kind: 'send', channel: 'show', text: 'gg' });
    const lobbyOnly = withChannels('lobby');
    expect(parseChatInput('/all hi', ctx(lobbyOnly))).toEqual({ kind: 'send', channel: 'lobby', text: 'hi' });
    expect(parseChatInput('/party hi', ctx(lobbyOnly))).toMatchObject({ kind: 'error' });
  });

  it('read-only and ping-only channels refuse typed text', () => {
    let s = reduceChat(INITIAL_CHAT, { type: 'available', channel: 'show', on: true, writable: false });
    expect(parseChatInput('hello', ctx(s))).toMatchObject({ kind: 'error' });
    s = reduceChat(s, { type: 'focus', channel: 'system' });
    expect(parseChatInput('hello', ctx(s))).toMatchObject({ kind: 'error' });
    const w = reduceChat(withChannels('whisper'), { type: 'focus', channel: 'whisper' });
    expect(parseChatInput('hello', ctx(w))).toMatchObject({ kind: 'error' });
  });

  it('/mute, /unmute, /help and unknown commands', () => {
    const s = withChannels('show');
    expect(parseChatInput('/mute Bot Bob', ctx(s))).toEqual({ kind: 'mute', name: 'Bot Bob', muted: true });
    expect(parseChatInput('/unmute Bot Bob', ctx(s))).toEqual({
      kind: 'mute',
      name: 'Bot Bob',
      muted: false,
    });
    expect(parseChatInput('/help', ctx(s))).toEqual({ kind: 'help' });
    expect(parseChatInput('/dance', ctx(s))).toMatchObject({ kind: 'error' });
  });
});
