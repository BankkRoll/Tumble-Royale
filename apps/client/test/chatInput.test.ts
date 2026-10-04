/**
 * The chat input against the real router: commands that keep the player
 * typing leave the input open, sends close it, and the draft survives
 * anything but a send or Esc.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_CHAT, social, ui } from '@tumble/ui';
import { cancelChatInput, setChatOpen, submitChatInput } from '@tumble/ui/hud';
import {
  bindChatRouter,
  setChatRoom,
  setChatRoute,
  setPartyChat,
  setWhisperRoute,
} from '../src/game/social/chatRouter.ts';

const colors = { primary: '#fff', secondary: '#000', pattern: 'plain' as const };
const sent: string[] = [];
let unbind: () => void = () => undefined;

beforeAll(() => {
  unbind = bindChatRouter();
});
afterAll(() => unbind());

beforeEach(() => {
  sent.length = 0;
  social.setState({ chat: INITIAL_CHAT, chatDraft: '' });
  ui.getState().setFriends([{ id: 'u-pal', name: 'Zippy', tag: '0420', presence: 'inMenu', colors }]);
  setChatRoom('show', 'write');
  setChatRoute('show', (t) => sent.push(`show:${t}`));
  setChatRoute('party', (t) => sent.push(`party:${t}`));
  setPartyChat(true);
  setWhisperRoute((to, t) => sent.push(`whisper:${to.name}:${t}`));
  setChatOpen(true);
});

const chat = () => social.getState().chat;

describe('submitting the chat input', () => {
  it('closes after a plain message', () => {
    submitChatInput('gg');
    expect(sent).toEqual(['show:gg']);
    expect(chat().open).toBe(false);
  });

  it('closes on an empty Enter without sending', () => {
    submitChatInput('   ');
    expect(sent).toEqual([]);
    expect(chat().open).toBe(false);
  });

  it.each([
    ['/p', 'party'],
    ['/w Zippy', 'whisper'],
    ['/all', 'all'],
  ] as const)('%s switches tab and keeps the input open', (cmd, tab) => {
    submitChatInput(cmd);
    expect(chat().open).toBe(true);
    expect(chat().active).toBe(tab);
    expect(sent).toEqual([]);
  });

  it('/r keeps typing to the last whisperer', () => {
    social.getState().pushChat({
      id: 'w1',
      channel: 'whisper',
      from: { userId: 'u-pal', name: 'Zippy', tag: '0420', key: 'u-pal' },
      text: 'psst',
      at: 1,
    });
    submitChatInput('/r');
    expect(chat().open).toBe(true);
    expect(chat().active).toBe('whisper');
  });

  it('/help lists the commands and keeps the input open', () => {
    submitChatInput('/help');
    expect(chat().open).toBe(true);
    expect(chat().lines.some((l) => l.channel === 'system')).toBe(true);
  });

  it('a command with a message sends it and closes', () => {
    submitChatInput('/p on my way');
    expect(sent).toEqual(['party:on my way']);
    expect(chat().open).toBe(false);
  });
});

describe('chat draft', () => {
  it('survives the input closing without a send (wipes, clicking the game)', () => {
    social.getState().setChatDraft('half a thou');
    setChatOpen(false);
    setChatOpen(true);
    expect(social.getState().chatDraft).toBe('half a thou');
  });

  it('is cleared by a send and by Esc', () => {
    social.getState().setChatDraft('hello');
    submitChatInput('hello');
    expect(social.getState().chatDraft).toBe('');
    setChatOpen(true);
    social.getState().setChatDraft('never mind');
    cancelChatInput();
    expect(social.getState().chatDraft).toBe('');
    expect(chat().open).toBe(false);
  });

  it('is cleared when a command keeps the input open, ready for the message', () => {
    social.getState().setChatDraft('/p');
    submitChatInput('/p');
    expect(social.getState().chatDraft).toBe('');
    expect(chat().open).toBe(true);
  });
});
