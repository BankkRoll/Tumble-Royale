import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_CHAT, social, ui, uiEvents } from '@tumble/ui';
import { routeChatInput, setChannel, setChatRoute, setWhisperRoute } from '../src/game/social/chatRouter.ts';

const colors = { primary: '#fff', secondary: '#000', pattern: 'plain' as const };
const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  social.setState({ chat: INITIAL_CHAT, muted: [] });
  ui.getState().setFriends([{ id: 'u-pal', name: 'Zippy Noodle', tag: '0420', presence: 'inMenu', colors }]);
  setChatRoute('party', null);
  setChatRoute('show', null);
  setWhisperRoute(null);
});

const system = () =>
  social
    .getState()
    .chat.lines.filter((l) => l.channel === 'system')
    .map((l) => l.text);

describe('chat router', () => {
  it('sends to the active channel through its route', () => {
    setChannel('party', true);
    setChatRoute('party', (t) => sent.push(`party:${t}`));
    routeChatInput('ready?');
    expect(sent).toEqual(['party:ready?']);
  });

  it('whispers friends by name and focuses the Whispers tab', () => {
    setChannel('whisper', true);
    setWhisperRoute((to, t) => sent.push(`${to.userId}:${t}`));
    routeChatInput('/w Zippy Noodle on my way');
    expect(sent).toEqual(['u-pal:on my way']);
    expect(social.getState().chat.whisperTo).toEqual({ userId: 'u-pal', name: 'Zippy Noodle' });
  });

  it('turns errors and /help into System notices and opens that tab', () => {
    routeChatInput('/frobnicate');
    routeChatInput('/help');
    expect(system()[0]).toMatch(/Unknown command/);
    expect(system().some((t) => t.startsWith('/w name message'))).toBe(true);
    expect(social.getState().chat).toMatchObject({ open: true, active: 'system' });
  });

  it('refuses typing in an offline show but keeps the tab for pings', () => {
    setChannel('show', true, false);
    setChatRoute('show', (t) => sent.push(t));
    social.getState().dispatchChat({ type: 'focus', channel: 'show' });
    routeChatInput('anyone?');
    expect(sent).toEqual([]);
    expect(system()[0]).toMatch(/Only quick pings/);
  });

  it('/mute finds a chat sender by name and emits the mute intent', () => {
    social.getState().pushChat({
      id: 'x',
      channel: 'show',
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

  it('a channel that goes away is cleared', () => {
    setChannel('party', true);
    social
      .getState()
      .pushChat({ id: 'p', channel: 'party', from: { name: 'A', key: 'a' }, text: 'hi', at: 1 });
    setChannel('party', false);
    expect(social.getState().chat.lines).toEqual([]);
    expect(social.getState().chat.available.party).toBe(false);
  });
});
