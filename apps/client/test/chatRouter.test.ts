import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_CHAT, social, ui, uiEvents } from '@tumble/ui';
import {
  routeChatInput,
  setChatRoom,
  setChatRoute,
  setPartyChat,
  setWhisperRoute,
} from '../src/game/social/chatRouter.ts';
import { SocialController } from '../src/game/social/socialController.ts';
import type { ApiClient } from '../src/game/api.ts';
import type { TypedMessage } from '../src/game/online/jsonSocket.ts';

const colors = { primary: '#fff', secondary: '#000', pattern: 'plain' as const };
const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  social.setState({ chat: INITIAL_CHAT, muted: [] });
  ui.getState().setFriends([{ id: 'u-pal', name: 'Zippy Noodle', tag: '0420', presence: 'inMenu', colors }]);
  for (const k of ['party', 'show', 'lobby', 'global'] as const) setChatRoute(k, null);
  setWhisperRoute(null);
});

const system = () =>
  social
    .getState()
    .chat.lines.filter((l) => l.channel === 'system')
    .map((l) => l.text);

describe('chat router', () => {
  it('plain text goes to everyone: the global room in the menu, the show in a show', () => {
    setChatRoom('global', 'write');
    setChatRoute('global', (t) => sent.push(`global:${t}`));
    routeChatInput('hi all');
    setChatRoom('show', 'write');
    setChatRoute('show', (t) => sent.push(`show:${t}`));
    routeChatInput('gg');
    setChatRoom('show', 'off');
    setChatRoom('lobby', 'write');
    setChatRoute('lobby', (t) => sent.push(`lobby:${t}`));
    routeChatInput('ready?');
    expect(sent).toEqual(['global:hi all', 'show:gg', 'lobby:ready?']);
    expect(social.getState().chat.hint).toBeNull();
  });

  it('sends to the party from the Party tab', () => {
    setChatRoom('global', 'write');
    setPartyChat(true);
    setChatRoute('party', (t) => sent.push(`party:${t}`));
    social.getState().dispatchChat({ type: 'focus', channel: 'party' });
    routeChatInput('ready?');
    expect(sent).toEqual(['party:ready?']);
  });

  it('whispers friends by name and focuses the Whispers tab', () => {
    setWhisperRoute((to, t) => sent.push(`${to.userId}:${t}`));
    routeChatInput('/w Zippy Noodle on my way');
    expect(sent).toEqual(['u-pal:on my way']);
    expect(social.getState().chat).toMatchObject({
      whisperTo: { userId: 'u-pal', name: 'Zippy Noodle', tag: '0420' },
      active: 'whisper',
    });
  });

  it('offline typing gives one short hint and no System spam', () => {
    for (let i = 0; i < 5; i++) routeChatInput('anyone?');
    expect(social.getState().chat.hint?.text).toBe('Chat needs the online servers');
    expect(social.getState().chat.lines).toEqual([]);
  });

  it('/help posts System notices inline without switching tabs; unknown commands only hint', () => {
    setChatRoom('global', 'write');
    routeChatInput('/frobnicate');
    expect(social.getState().chat.hint?.text).toMatch(/Unknown command/);
    expect(system()).toEqual([]);
    routeChatInput('/help');
    expect(system()[0]).toMatch(/Just type/);
    expect(social.getState().chat).toMatchObject({ open: true, active: 'all' });
  });

  it('a ping-only show refuses typing with a hint', () => {
    setChatRoom('global', 'write');
    setChatRoom('show', 'read');
    setChatRoute('show', (t) => sent.push(t));
    routeChatInput('anyone?');
    expect(sent).toEqual([]);
    expect(social.getState().chat.hint?.text).toMatch(/quick pings/);
  });

  it('/mute finds a chat sender by name and emits the mute intent', () => {
    social.getState().pushChat({
      id: 'x',
      room: 'show',
      from: { name: 'Bot Bob', key: 'name:Bot Bob', isBot: true },
      text: 'gg',
      at: 1,
    });
    const got: unknown[] = [];
    const off = uiEvents.on('mutePlayer', (p) => got.push(p));
    routeChatInput('/mute bot bob');
    off();
    expect(got).toEqual([{ key: 'name:Bot Bob', name: 'Bot Bob', muted: true }]);
  });

  it('a room or party that goes away is cleared', () => {
    setPartyChat(true);
    setChatRoom('show', 'write');
    social
      .getState()
      .pushChat({ id: 'p', channel: 'party', from: { name: 'A', key: 'a' }, text: 'hi', at: 1 });
    social.getState().pushChat({ id: 's', room: 'show', from: { name: 'A', key: 'a' }, text: 'gg', at: 2 });
    setPartyChat(false);
    setChatRoom('show', 'off');
    expect(social.getState().chat.lines).toEqual([]);
    expect(social.getState().chat.party).toBe(false);
  });
});

describe('global room over the realtime socket', () => {
  function fakeRealtime() {
    const handlers = new Map<string, ((m: TypedMessage) => void)[]>();
    const out: TypedMessage[] = [];
    return {
      out,
      connected: true,
      on(type: string, fn: (m: TypedMessage) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        return () => undefined;
      },
      send(m: TypedMessage) {
        out.push(m);
      },
      emit(m: TypedMessage) {
        for (const fn of handlers.get(m.type) ?? []) fn(m);
      },
    };
  }
  const host = {
    userId: () => 'u-me',
    colorsOf: () => colors,
    applyParty: () => undefined,
    partyId: () => null,
  };

  it('turns All on, sends typed text as global_chat and shows history and live lines once', () => {
    const rt = fakeRealtime();
    const c = new SocialController({} as ApiClient, rt, host);
    c.bind();
    expect(social.getState().chat.rooms.global).toBe('write');
    routeChatInput('hello everyone');
    expect(rt.out).toEqual([{ type: 'global_chat', text: 'hello everyone' }]);

    const line = { id: 'g1', from: { userId: 'u-x', name: 'Bean', tag: '0007' }, text: 'hi', at: 5 };
    rt.emit({ type: 'global_chat_history', lines: [line] });
    rt.emit({ type: 'global_chat', ...line });
    rt.emit({ type: 'global_chat', ...line, id: 'g2', from: { userId: 'u-me', name: 'Me', tag: '1' } });
    const lines = social.getState().chat.lines;
    expect(lines.map((l) => [l.from.name, l.room, !!l.self])).toEqual([
      ['Bean', 'global', false],
      ['Me', 'global', true],
    ]);

    rt.emit({ type: 'error', code: 'chat_rate', message: 'Slow down a little' });
    rt.emit({ type: 'error', code: 'chat_rate', message: 'Slow down a little' });
    expect(social.getState().chat.hint?.text).toBe('Slow down a little');
    expect(social.getState().chat.lines).toHaveLength(2);

    rt.emit({ type: 'socket_closed' });
    expect(social.getState().chat.rooms.global).toBe('off');
    expect(social.getState().chat.lines).toHaveLength(2);
    c.dispose();
    expect(social.getState().chat.lines).toEqual([]);
  });
});
