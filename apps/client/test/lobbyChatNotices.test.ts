/**
 * Private-lobby System notices are plain text, so Streamer Mode has to mask
 * strangers' names when the notice is written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, INITIAL_CHAT, maskedName, social, ui } from '@tumble/ui';
import type { Lobby, LobbySeat, MatchmakerClient } from '../src/game/online/matchmaker.ts';
import { syncLobbyChat } from '../src/game/social/lobbyChat.ts';

const mm = { socket: { send: () => undefined } } as unknown as MatchmakerClient;
const seat = (userId: string, name: string): LobbySeat => ({ userId, name });

function lobby(players: LobbySeat[], hostId = 'u-me'): Lobby {
  return {
    code: 'QWERTY',
    hostId,
    region: 'eu',
    settings: {} as Lobby['settings'],
    players,
    spectators: [],
    status: 'open',
    matchId: null,
  };
}

const notices = (): string[] =>
  social
    .getState()
    .chat.lines.filter((l) => l.channel === 'system')
    .map((l) => l.text);

function streamer(on: boolean): void {
  ui.setState({
    settings: { ...DEFAULT_SETTINGS, gameplay: { ...DEFAULT_SETTINGS.gameplay, streamerMode: on } },
  });
}

afterEach(() => {
  social.setState({ chat: INITIAL_CHAT });
  ui.setState({ settings: DEFAULT_SETTINGS, friends: [] });
});

describe('lobby notices', () => {
  const before = lobby([seat('u-me', 'Me#1')]);
  const after = lobby([seat('u-me', 'Me#1'), seat('u-x', 'RealPerson99#4242')]);

  it('name the joiner normally', () => {
    syncLobbyChat(before, after, 'u-me', mm);
    expect(notices()).toEqual(['RealPerson99 joined the lobby']);
  });

  it('mask a stranger in Streamer Mode, on join, leave and host change', () => {
    streamer(true);
    syncLobbyChat(before, after, 'u-me', mm);
    syncLobbyChat(after, lobby(after.players, 'u-x'), 'u-me', mm);
    syncLobbyChat(after, before, 'u-me', mm);
    const masked = maskedName('u-x');
    expect(notices()).toEqual([
      `${masked} joined the lobby`,
      `${masked} is the host now`,
      `${masked} left the lobby`,
    ]);
  });

  it('keep friends named in Streamer Mode', () => {
    streamer(true);
    ui.getState().setFriends([
      {
        id: 'u-x',
        name: 'RealPerson99',
        tag: '4242',
        presence: 'inMenu',
        colors: { primary: '#fff', secondary: '#000', pattern: 'plain' },
      },
    ]);
    syncLobbyChat(before, after, 'u-me', mm);
    expect(notices()).toEqual(['RealPerson99 joined the lobby']);
  });
});
