import { MAX_PLAYERS } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  KICKED_TITLE,
  liveStartedLobby,
  lobbyOptions,
  optionsToSettings,
  reduceLobbyEvent,
  toCustomLobbyState,
} from '../src/game/online/lobbyState.ts';
import type { Lobby } from '../src/game/online/matchmaker.ts';

const colors = { primary: '#fff', secondary: '#000', pattern: 'dots' as const };

function lobby(over: Partial<Lobby> = {}): Lobby {
  return {
    code: 'ABCDEF',
    hostId: 'host',
    region: 'na',
    settings: {
      playlistId: 'main-show',
      rounds: ['r1', 'r2'],
      maxPlayers: 12,
      bots: true,
      roundTimeScale: 1.5,
      lobbyCountdownSec: 20,
      spectatorSlots: 2,
      minPlayers: 3,
    },
    players: [
      { userId: 'host', name: 'Host#0001', joinedAt: 0, ready: true, awaySince: null },
      { userId: 'me', name: 'Me#0002', joinedAt: 1, ready: false, awaySince: null },
      { userId: 'ann', name: 'Ann#0003', joinedAt: 2, ready: true, awaySince: 99 },
    ],
    spectators: [{ userId: 'sam', name: 'Sam#0004', joinedAt: 3, ready: false, awaySince: null }],
    status: 'open',
    matchId: null,
    locked: true,
    banned: [{ userId: 'eve', name: 'Eve#0005' }],
    ...over,
  };
}

describe('host tools in a running private show', () => {
  const started = lobby({ status: 'started', matchId: 'm_1' });

  it('lists only players the game server still has in the show, and always the host', () => {
    const live = liveStartedLobby(started, new Set(['me']));
    expect(live.players.map((p) => p.userId)).toEqual(['host', 'me']);
    expect(started.players).toHaveLength(3);
  });

  it('keeps every spectator, whom the server roster never lists, so the host can still remove one', () => {
    expect(liveStartedLobby(started, new Set(['me'])).spectators.map((s) => s.userId)).toEqual(['sam']);
  });

  it('keeps the frozen roster until the server sent its first one', () => {
    expect(liveStartedLobby(started, null)).toBe(started);
  });

  it('keeps spectators who are still watching', () => {
    expect(liveStartedLobby(started, new Set(['sam'])).spectators.map((s) => s.userId)).toEqual(['sam']);
  });
});

describe('lobbyOptions', () => {
  it('turns lobby settings into Play again options without sharing the round list', () => {
    const l = lobby();
    const o = lobbyOptions(l.settings);
    expect(o).toEqual({
      rounds: ['r1', 'r2'],
      bots: true,
      maxPlayers: 12,
      timerScale: 1.5,
      spectators: true,
      spectatorSlots: 2,
      countdownSec: 20,
      minPlayers: 3,
      roundVoting: true,
      spectatorChat: false,
      isPrivate: true,
    });
    expect(o.rounds).not.toBe(l.settings.rounds);
    expect(lobbyOptions({ ...l.settings, roundVoting: false }).roundVoting).toBe(false);
    expect(lobbyOptions({ ...l.settings, spectatorChat: true }).spectatorChat).toBe(true);
  });
});

describe('toCustomLobbyState', () => {
  it('maps members, roles, readiness, presence and host tools state', () => {
    const st = toCustomLobbyState(lobby(), 'me', () => colors);
    expect(st.isHost).toBe(false);
    expect(st.players.map((p) => [p.name, p.isHost, p.isSelf, p.ready, p.away])).toEqual([
      ['Host', true, false, true, false],
      ['Me', false, true, false, false],
      ['Ann', false, false, true, true],
    ]);
    expect(st.spectators.map((s) => s.id)).toEqual(['sam']);
    expect(st.options).toMatchObject({
      rounds: ['r1', 'r2'],
      maxPlayers: 12,
      timerScale: 1.5,
      countdownSec: 20,
      spectators: true,
      spectatorSlots: 2,
      minPlayers: 3,
    });
    expect(st.locked).toBe(true);
    expect(st.banned).toEqual([{ id: 'eve', name: 'Eve' }]);
  });

  it('copes with a matchmaker that predates host tools', () => {
    const old = lobby({
      players: [{ userId: 'host', name: 'Host#1' }],
      spectators: [],
      settings: { ...lobby().settings, minPlayers: undefined, spectatorSlots: 0 },
    });
    delete old.locked;
    delete old.banned;
    const st = toCustomLobbyState(old, 'host', () => colors);
    expect(st).toMatchObject({
      isHost: true,
      locked: false,
      banned: [],
      options: { minPlayers: 1, spectators: false },
    });
    expect(st.players[0]).toMatchObject({ ready: true, away: false });
  });
});

describe('reduceLobbyEvent', () => {
  it('applies updates and announces a crown handed to me', () => {
    const before = lobby();
    const after = lobby({ hostId: 'me' });
    const r = reduceLobbyEvent(before, { type: 'lobby_update', lobby: after }, 'me');
    expect(r.next).toBe(after);
    expect(r.notice?.title).toBe("You're the host now");
    expect(reduceLobbyEvent(null, { type: 'lobby_update', lobby: after }, 'me').notice).toBeNull();
  });

  it('tells members about a new invite code', () => {
    const r = reduceLobbyEvent(lobby(), { type: 'lobby_update', lobby: lobby({ code: 'ZZZZZZ' }) }, 'me');
    expect(r.notice?.body).toContain('ZZZZZZ');
  });

  it('drops the lobby once it starts (match_found takes over)', () => {
    const r = reduceLobbyEvent(lobby(), { type: 'lobby_update', lobby: lobby({ status: 'started' }) }, 'me');
    expect(r).toEqual({ next: null, notice: null, removed: false });
  });

  it('removes a kicked player with a dialog, and an away one with a toast', () => {
    const kicked = reduceLobbyEvent(
      lobby(),
      { type: 'lobby_kicked', code: 'ABCDEF', reason: 'kicked' },
      'me',
    );
    expect(kicked).toMatchObject({
      next: null,
      removed: true,
      notice: { title: KICKED_TITLE, dialog: true },
    });
    const away = reduceLobbyEvent(lobby(), { type: 'lobby_kicked', code: 'ABCDEF', reason: 'away' }, 'me');
    expect(away.notice).toMatchObject({ dialog: false });
  });

  it('ignores late events for a lobby the player is no longer in', () => {
    const current = lobby({ code: 'NEWONE' });
    expect(reduceLobbyEvent(current, { type: 'lobby_kicked', code: 'OLDONE' }, 'me').next).toBe(current);
    expect(reduceLobbyEvent(current, { type: 'lobby_closed', code: 'OLDONE' }, 'me').next).toBe(current);
    const without = lobby({ players: [lobby().players[0]!] });
    expect(reduceLobbyEvent(current, { type: 'lobby_update', lobby: without }, 'me').next).toBe(current);
  });

  it('closes the lobby', () => {
    const r = reduceLobbyEvent(lobby(), { type: 'lobby_closed', code: 'ABCDEF' }, 'me');
    expect(r).toMatchObject({ next: null, removed: true, notice: { title: 'The private show closed' } });
  });
});

describe('optionsToSettings', () => {
  it('renames and clamps to what the matchmaker accepts', () => {
    expect(
      optionsToSettings({
        timerScale: 3,
        maxPlayers: MAX_PLAYERS + 1,
        countdownSec: 500,
        minPlayers: 0,
        spectatorSlots: 20,
        rounds: Array.from({ length: 14 }, (_, i) => `r${i}`),
      }),
    ).toEqual({
      roundTimeScale: 2,
      maxPlayers: MAX_PLAYERS,
      lobbyCountdownSec: 120,
      minPlayers: 1,
      spectatorSlots: 10,
      rounds: Array.from({ length: 10 }, (_, i) => `r${i}`),
    });
    expect(optionsToSettings({ spectators: false })).toEqual({ spectatorSlots: 0 });
    expect(optionsToSettings({ spectators: true })).toEqual({ spectatorSlots: 2 });
    expect(optionsToSettings({ bots: false })).toEqual({ bots: false });
    expect(optionsToSettings({ roundVoting: false })).toEqual({ roundVoting: false });
  });
});
