import { describe, expect, it } from 'vitest';
import { MMError } from '../src/errors.ts';
import {
  expiredMembers,
  kickMember,
  LOBBY_AWAY_GRACE_MS,
  nextHost,
  normalizeLobby,
  readiness,
  removeMember,
  setRole,
  startBlocker,
  transferHost,
  unban,
  validateSettings,
} from '../src/lobbyRules.ts';
import { DEFAULT_CUSTOM, type CustomLobby, type LobbySeat } from '../src/matchmaker.ts';

const seat = (userId: string, joinedAt: number, extra: Partial<LobbySeat> = {}): LobbySeat => ({
  userId,
  name: `${userId}#0001`,
  joinedAt,
  ready: false,
  awaySince: null,
  ...extra,
});

function lobby(over: Partial<CustomLobby> = {}): CustomLobby {
  return {
    code: 'ABCDEF',
    hostId: 'h',
    region: 'na',
    settings: { ...DEFAULT_CUSTOM, maxPlayers: 4, spectatorSlots: 1 },
    players: [seat('h', 0, { ready: true }), seat('a', 10), seat('b', 20)],
    spectators: [],
    status: 'open',
    matchId: null,
    locked: false,
    banned: [],
    createdAt: 0,
    ...over,
  };
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof MMError) return err.code;
    throw err;
  }
  return 'ok';
};

describe('lobby rules', () => {
  it('fills fields missing from lobbies stored before host tools existed', () => {
    const old = {
      ...lobby(),
      players: [{ userId: 'h', name: 'h', joinedAt: 0 }],
      settings: { ...DEFAULT_CUSTOM, minPlayers: undefined },
    } as unknown as CustomLobby;
    delete (old as Partial<CustomLobby>).banned;
    delete (old as Partial<CustomLobby>).locked;
    const n = normalizeLobby(old);
    expect(n).toMatchObject({ locked: false, banned: [], settings: { minPlayers: 1 } });
    expect(n.players[0]).toMatchObject({ ready: true, awaySince: null });
  });

  it('only the host kicks, never themselves, and kicks ban', () => {
    const l = lobby();
    expect(code(() => kickMember(l, 'a', 'b'))).toBe('not_host');
    expect(code(() => kickMember(l, 'h', 'h'))).toBe('self_kick');
    expect(code(() => kickMember(l, 'h', 'zz'))).toBe('not_a_member');
    kickMember(l, 'h', 'a');
    expect(l.players.map((p) => p.userId)).toEqual(['h', 'b']);
    expect(l.banned).toEqual([{ userId: 'a', name: 'a#0001' }]);
    expect(code(() => unban(l, 'b', 'a'))).toBe('not_host');
    unban(l, 'h', 'a');
    expect(l.banned).toEqual([]);
    expect(code(() => unban(l, 'h', 'a'))).toBe('not_banned');
  });

  it('passes the crown to the longest-present connected player', () => {
    const l = lobby();
    l.players[1]!.awaySince = 5;
    expect(nextHost(l)).toBe('h');
    removeMember(l, 'h');
    expect(l.hostId).toBe('b');
    expect(l.players.find((p) => p.userId === 'b')!.ready).toBe(true);
    // With everyone away, the oldest player still takes it so the lobby keeps a host.
    l.players.forEach((p) => (p.awaySince = 1));
    expect(nextHost(l)).toBe('a');
    expect(removeMember(l, 'a').closed).toBe(false);
    expect(removeMember(l, 'b').closed).toBe(true);
  });

  it('transfers hosting only to players', () => {
    const l = lobby({ spectators: [seat('s', 30)] });
    expect(code(() => transferHost(l, 'a', 'b'))).toBe('not_host');
    expect(code(() => transferHost(l, 'h', 'h'))).toBe('already_host');
    expect(code(() => transferHost(l, 'h', 's'))).toBe('not_a_player');
    transferHost(l, 'h', 'b');
    expect(l.hostId).toBe('b');
  });

  it('validates settings against the members already inside', () => {
    const l = lobby({ spectators: [seat('s', 30)] });
    expect(code(() => validateSettings(l, { ...l.settings, maxPlayers: 2 }))).toBe('too_many_players');
    expect(code(() => validateSettings(l, { ...l.settings, spectatorSlots: 0 }))).toBe('too_many_spectators');
    expect(code(() => validateSettings(l, { ...l.settings, minPlayers: 5 }))).toBe('min_over_max');
    expect(code(() => validateSettings(l, { ...l.settings, maxPlayers: 3, minPlayers: 3 }))).toBe('ok');
  });

  it('switches roles within the slots and keeps the host playing', () => {
    const l = lobby();
    expect(code(() => setRole(l, 'h', true))).toBe('host_must_play');
    setRole(l, 'a', true);
    expect(l.spectators.map((s) => s.userId)).toEqual(['a']);
    expect(code(() => setRole(l, 'b', true))).toBe('spectators_full');
    l.settings.spectatorSlots = 0;
    expect(code(() => setRole(l, 'b', true))).toBe('no_spectators');
    setRole(l, 'a', false);
    expect(l.players.map((p) => p.userId)).toEqual(['h', 'b', 'a']);
    expect(code(() => setRole(l, 'nobody', false))).toBe('not_a_member');
  });

  it('blocks a start until enough players, and until ready unless forced', () => {
    const l = lobby({ settings: { ...DEFAULT_CUSTOM, minPlayers: 4 } });
    expect(startBlocker(l, true)?.code).toBe('not_enough_players');
    l.settings.minPlayers = 2;
    expect(readiness(l)).toEqual({ ready: 1, total: 3, waitingOn: ['a#0001', 'b#0001'] });
    expect(startBlocker(l, false)?.code).toBe('not_ready');
    expect(startBlocker(l, true)).toBeNull();
    l.players.forEach((p) => (p.ready = true));
    expect(startBlocker(l, false)).toBeNull();
    const solo = lobby({
      players: [seat('h', 0, { ready: true })],
      settings: { ...DEFAULT_CUSTOM, bots: false },
    });
    expect(startBlocker(solo, true)?.code).toBe('not_enough_players');
  });

  it('finds members away past the grace period', () => {
    const l = lobby();
    l.players[1]!.awaySince = 1000;
    expect(expiredMembers(l, 1000 + LOBBY_AWAY_GRACE_MS - 1)).toEqual([]);
    expect(expiredMembers(l, 1000 + LOBBY_AWAY_GRACE_MS)).toEqual(['a']);
  });
});
