import { describe, expect, it } from 'vitest';
import {
  CHAT_OFFLINE,
  INITIAL_CHAT,
  chatPlaceholder,
  chatTabs,
  feedLines,
  linesOf,
  parseChatInput,
  publicRoom,
  reduceChat,
  type ChatAction,
  type ChatLine,
  type ChatState,
  type CommandContext,
} from '../src/store/chatChannels.ts';

const PAL = { userId: 'u-pal', name: 'Zippy Noodle', tag: '0420' };
let n = 0;
const line = (over: Partial<ChatLine> = {}): ChatLine => ({
  id: `l${++n}`,
  from: { userId: 'u-x', name: 'X', key: 'u-x' },
  text: 'hi',
  at: n,
  ...over,
});
const sys = (text: string): ChatLine =>
  line({ channel: 'system', text, from: { name: 'System', key: 'system' } });

const apply = (s: ChatState, ...actions: ChatAction[]): ChatState => actions.reduce(reduceChat, s);
/** Online in the menu: the global room is writable. */
const online = (): ChatState => apply(INITIAL_CHAT, { type: 'room', room: 'global', access: 'write' });

describe('chat tabs', () => {
  it('defaults to All, even with nothing connected', () => {
    expect(INITIAL_CHAT.active).toBe('all');
    expect(chatTabs(INITIAL_CHAT)).toEqual(['all']);
    expect(chatTabs(online())).toEqual(['all']);
  });

  it('shows Party only in a party and Whispers only once there is a conversation', () => {
    let s = apply(online(), { type: 'party', on: true }, { type: 'whispers', on: true });
    expect(chatTabs(s)).toEqual(['all', 'party']);
    s = reduceChat(s, {
      type: 'receive',
      line: line({ channel: 'whisper', from: { ...PAL, key: PAL.userId } }),
    });
    expect(chatTabs(s)).toEqual(['all', 'party', 'whisper']);
    s = apply(s, { type: 'focus', channel: 'party' }, { type: 'party', on: false });
    expect(chatTabs(s)).toEqual(['all', 'whisper']);
    expect(s.active).toBe('all');
    expect(chatTabs(apply(online(), { type: 'whisperTo', target: PAL }))).toEqual(['all']);
    expect(
      chatTabs(apply(online(), { type: 'whispers', on: true }, { type: 'whisperTo', target: PAL })),
    ).toEqual(['all', 'whisper']);
  });

  it('cycles through shown tabs only, both ways', () => {
    let s = apply(online(), { type: 'party', on: true }, { type: 'whispers', on: true });
    s = reduceChat(s, { type: 'whisperTo', target: PAL });
    expect(s.active).toBe('whisper');
    s = reduceChat(s, { type: 'cycle', dir: 1 });
    expect(s.active).toBe('all');
    s = reduceChat(s, { type: 'cycle', dir: 1 });
    expect(s.active).toBe('party');
    s = reduceChat(s, { type: 'cycle', dir: -1 });
    expect(s.active).toBe('all');
    expect(reduceChat(online(), { type: 'focus', channel: 'party' }).active).toBe('all');
  });

  it('counts unread on Party and Whispers only, never your own or the open tab', () => {
    let s = apply(online(), { type: 'party', on: true }, { type: 'whispers', on: true });
    s = reduceChat(s, { type: 'receive', line: line() });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'party' }) });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'party', self: true }) });
    s = reduceChat(s, { type: 'receive', line: sys('Pal joined the party') });
    expect(s.unread).toEqual({ all: 0, party: 1, club: 0, whisper: 0 });
    s = reduceChat(s, { type: 'open', channel: 'party' });
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'party' }) });
    expect(s.unread.party).toBe(0);
  });

  it('shows a Club tab only in a club, counts its unread and drops its lines on leaving', () => {
    expect(chatTabs(online())).not.toContain('club');
    let s = apply(online(), { type: 'party', on: true }, { type: 'club', on: true });
    expect(chatTabs(s)).toEqual(['all', 'party', 'club']);
    s = reduceChat(s, { type: 'receive', line: line({ channel: 'club' }) });
    expect(s.unread.club).toBe(1);
    expect(linesOf(s, 'club')).toHaveLength(1);
    s = reduceChat(s, { type: 'focus', channel: 'club' });
    expect(s.unread.club).toBe(0);
    s = apply(s, { type: 'club', on: false }, { type: 'clear', target: 'club' });
    expect(s.active).toBe('all');
    expect(s.lines.some((l) => l.channel === 'club')).toBe(false);
  });

  it('dedupes lines and caps history', () => {
    let s = online();
    const l = line();
    s = reduceChat(s, { type: 'receive', line: l });
    expect(reduceChat(s, { type: 'receive', line: l })).toBe(s);
    for (let i = 0; i < 250; i++) s = reduceChat(s, { type: 'receive', line: sys('x') });
    expect(s.lines).toHaveLength(200);
  });

  it('remembers who to reply to and who the Whispers tab talks to', () => {
    let s = apply(online(), { type: 'whispers', on: true });
    s = reduceChat(s, {
      type: 'receive',
      line: line({ channel: 'whisper', from: { ...PAL, key: PAL.userId } }),
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
    expect(s).toMatchObject({ open: true, mode: 'quick', active: 'all' });
    s = reduceChat(s, { type: 'close' });
    expect(s).toMatchObject({ open: false, mode: 'text' });
  });

  it('keeps a single hint, replaced rather than stacked', () => {
    let s = reduceChat(INITIAL_CHAT, { type: 'hint', text: 'Slow down a little', at: 1 });
    s = reduceChat(s, { type: 'hint', text: 'Slow down a little', at: 2 });
    expect(s.hint).toEqual({ text: 'Slow down a little', at: 2 });
    expect(s.lines).toEqual([]);
  });
});

describe('public rooms', () => {
  it('All talks to the show, then the private lobby, then the menu room', () => {
    let s = online();
    expect(publicRoom(INITIAL_CHAT)).toBeNull();
    expect(publicRoom(s)).toBe('global');
    s = reduceChat(s, { type: 'room', room: 'lobby', access: 'write' });
    expect(publicRoom(s)).toBe('lobby');
    s = reduceChat(s, { type: 'room', room: 'show', access: 'write' });
    expect(publicRoom(s)).toBe('show');
    s = reduceChat(s, { type: 'room', room: 'show', access: 'off' });
    expect(publicRoom(s)).toBe('lobby');
  });

  it('All shows the current room plus System notices; other tabs also get System notices', () => {
    let s = apply(online(), { type: 'party', on: true });
    const menu = line({ text: 'menu hi' });
    const show = line({ text: 'show hi', room: 'show' });
    const party = line({ text: 'party hi', channel: 'party' });
    const notice = sys('Pal joined the party');
    for (const l of [menu, show, party, notice]) s = reduceChat(s, { type: 'receive', line: l });
    expect(linesOf(s, 'all')).toEqual([menu, notice]);
    expect(linesOf(s, 'party')).toEqual([party, notice]);
    s = reduceChat(s, { type: 'room', room: 'show', access: 'write' });
    expect(linesOf(s, 'all')).toEqual([show, notice]);
    expect(feedLines(s)).toEqual([show, party, notice]);
  });

  it('clearing a room drops only its lines', () => {
    let s = online();
    const keep = line();
    s = apply(
      s,
      { type: 'receive', line: keep },
      { type: 'receive', line: line({ room: 'show' }) },
      { type: 'clear', target: 'show' },
    );
    expect(s.lines).toEqual([keep]);
  });
});

describe('placeholders', () => {
  it('says where the message goes', () => {
    let s = online();
    expect(chatPlaceholder(s)).toBe('Message everyone');
    s = apply(s, { type: 'party', on: true }, { type: 'focus', channel: 'party' });
    expect(chatPlaceholder(s)).toBe('Message your party');
    s = apply(s, { type: 'whispers', on: true }, { type: 'whisperTo', target: PAL });
    expect(chatPlaceholder(s)).toBe('Whisper Zippy Noodle#0420');
  });

  it('explains offline in one line, and ping-only shows', () => {
    expect(chatPlaceholder(INITIAL_CHAT)).toBe(CHAT_OFFLINE);
    const offlineShow = reduceChat(INITIAL_CHAT, { type: 'room', room: 'show', access: 'read' });
    expect(chatPlaceholder(offlineShow)).toBe(CHAT_OFFLINE);
    const botsOnly = reduceChat(online(), { type: 'room', room: 'show', access: 'read' });
    expect(chatPlaceholder(botsOnly)).toMatch(/quick pings/);
  });
});

describe('chat commands', () => {
  const ctx = (s: ChatState, over: Partial<CommandContext> = {}): CommandContext => ({
    ...s,
    findFriend: (name) =>
      name.toLowerCase() === 'zippy noodle' || name.toLowerCase() === 'zippy noodle#0420' ? PAL : null,
    ...over,
  });

  it('plain text goes to everyone in the current room, no name needed', () => {
    expect(parseChatInput('  hello   there ', ctx(online()))).toEqual({
      kind: 'send',
      to: 'global',
      text: 'hello there',
    });
    const inShow = reduceChat(online(), { type: 'room', room: 'show', access: 'write' });
    expect(parseChatInput('gg', ctx(inShow))).toEqual({ kind: 'send', to: 'show', text: 'gg' });
    const inLobby = reduceChat(online(), { type: 'room', room: 'lobby', access: 'write' });
    expect(parseChatInput('gg', ctx(inLobby))).toEqual({ kind: 'send', to: 'lobby', text: 'gg' });
    expect(parseChatInput('   ', ctx(online()))).toEqual({ kind: 'none' });
  });

  it('never errors on plain text: offline and ping-only give a one-line hint', () => {
    expect(parseChatInput('hello', ctx(INITIAL_CHAT))).toEqual({ kind: 'hint', message: CHAT_OFFLINE });
    const botsOnly = reduceChat(online(), { type: 'room', room: 'show', access: 'read' });
    expect(parseChatInput('hello', ctx(botsOnly))).toMatchObject({ kind: 'hint' });
    for (const s of [INITIAL_CHAT, online(), botsOnly])
      expect(JSON.stringify(parseChatInput('hello', ctx(s)))).not.toMatch(/system|not allowed|read-only/i);
  });

  it('has no System send target', () => {
    const s = apply(online(), { type: 'receive', line: sys('Pal joined') });
    expect(parseChatInput('hey', ctx(s))).toMatchObject({ kind: 'send', to: 'global' });
    expect(parseChatInput('/system hey', ctx(s))).toMatchObject({ kind: 'hint' });
  });

  it('whispers by name with spaces, or switches to the friend without a message', () => {
    const s = apply(online(), { type: 'whispers', on: true });
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
    expect(parseChatInput('/w Nobody hi', ctx(s))).toMatchObject({ kind: 'hint' });
    expect(parseChatInput('/w', ctx(s))).toMatchObject({ kind: 'hint' });
    expect(parseChatInput('/w Zippy Noodle hi', ctx(INITIAL_CHAT))).toMatchObject({ kind: 'hint' });
  });

  it('/r replies to the last whisperer', () => {
    const s = apply(online(), { type: 'whispers', on: true });
    expect(parseChatInput('/r thanks', ctx(s))).toMatchObject({ kind: 'hint' });
    expect(parseChatInput('/r thanks', ctx(s, { replyTo: PAL }))).toEqual({
      kind: 'whisper',
      to: PAL,
      text: 'thanks',
    });
  });

  it('/p and /all switch or send', () => {
    const s = apply(online(), { type: 'party', on: true });
    expect(parseChatInput('/party', ctx(s))).toEqual({ kind: 'switch', channel: 'party' });
    expect(parseChatInput('/p ready up', ctx(s))).toEqual({ kind: 'send', to: 'party', text: 'ready up' });
    expect(parseChatInput('/all gg', ctx({ ...s, active: 'party' }))).toEqual({
      kind: 'send',
      to: 'global',
      text: 'gg',
    });
    expect(parseChatInput('/p hi', ctx(online()))).toMatchObject({ kind: 'hint' });
  });

  it('/c and the Club tab talk to the club, only while in one', () => {
    expect(parseChatInput('/c hi', ctx(online()))).toEqual({ kind: 'hint', message: "You're not in a club" });
    const s = apply(online(), { type: 'club', on: true });
    expect(parseChatInput('/club', ctx(s))).toEqual({ kind: 'switch', channel: 'club' });
    expect(parseChatInput('/c show at 8?', ctx(s))).toEqual({ kind: 'send', to: 'club', text: 'show at 8?' });
    expect(parseChatInput('anyone on', ctx({ ...s, active: 'club' }))).toEqual({
      kind: 'send',
      to: 'club',
      text: 'anyone on',
    });
    expect(chatPlaceholder({ ...s, active: 'club' })).toBe('Message your club');
  });

  it('/mute, /unmute, /help and unknown commands', () => {
    const s = online();
    expect(parseChatInput('/mute Bot Bob', ctx(s))).toEqual({ kind: 'mute', name: 'Bot Bob', muted: true });
    expect(parseChatInput('/unmute Bot Bob', ctx(s))).toEqual({
      kind: 'mute',
      name: 'Bot Bob',
      muted: false,
    });
    expect(parseChatInput('/help', ctx(s))).toEqual({ kind: 'help' });
    expect(parseChatInput('/dance', ctx(s))).toMatchObject({ kind: 'hint' });
  });
});
