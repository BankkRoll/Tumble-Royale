/**
 * Placement and registry regressions: draining servers, the placement lock,
 * lock renewal, record lifetimes, registry pruning, single-use queue tickets,
 * all-or-nothing enqueue, the lobby chat limiter, the public lobby view and
 * the placement record the API checks results against.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BanLookup } from '../src/bans.ts';
import { loadConfig } from '../src/config.ts';
import { Matchmaker, MMError, SERVER_PRUNE_MS, type CustomLobby } from '../src/matchmaker.ts';
import { MemoryStore } from '../src/store.ts';
import type { Player, QueueTicket } from '../src/tickets.ts';
import { testEnv } from './helpers.ts';

const cfg = loadConfig(testEnv());
const player = (userId: string): Player => ({ userId, name: `${userId}#0001`, region: 'na' });
const ticket = (leader: string, members: string[] = [leader]): QueueTicket => ({
  typ: 'queue',
  sub: leader,
  pid: members.length > 1 ? `party-${leader}` : `solo:${leader}`,
  leaderId: leader,
  playlistId: 'main-show',
  queue: 'casual',
  teamSize: 1,
  maxPlayers: 40,
  minPlayers: 2,
  botsAllowed: true,
  region: 'na',
  members: members.map((userId) => ({ userId, name: `${userId}#0001`, mu: 25, sigma: 8.3, ordinal: 0 })),
});

function setup(opts: { bans?: BanLookup } = {}) {
  const clock = { now: Date.parse('2026-10-06T12:00:00Z') };
  const store = new MemoryStore(() => clock.now);
  const mm = new Matchmaker(cfg, store, () => clock.now, opts.bans);
  const server = (id: string, capacity = 100) =>
    mm.registerServer({ id, url: `wss://${id}.test/ws`, region: 'na', capacity, load: 0 });
  /** A private show of `players` hosted by the first, started on whatever server has room. */
  const startShow = async (players: string[], maxPlayers = 2) => {
    const lobby = await mm.createLobby(player(players[0]!), { maxPlayers, bots: true, spectatorSlots: 0 });
    for (const p of players.slice(1)) await mm.joinLobby(player(p), lobby.code, false);
    return mm.startLobby(players[0]!, lobby.code, true);
  };
  return { clock, store, mm, server, startShow };
}

const rejects = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MMError);
  expect((err as MMError).code).toBe(code);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('draining game servers', () => {
  it('get no new matches but keep serving rejoins, and learn when no placed match is pending', async () => {
    const { mm, server, startShow } = setup();
    await server('gs-a');
    const record = await startShow(['h1']);
    expect(record.serverId).toBe('gs-a');
    expect((await mm.heartbeat('gs-a', { load: 0 })).pendingMatches).toBe(1);
    const answer = await mm.heartbeat('gs-a', { load: 2, matches: [record.matchId], draining: true });
    expect(answer).toMatchObject({ draining: true, pendingMatches: 0 });
    await rejects(startShow(['h2']), 'no_server');
    // Still registered: the running show stays reachable for a reload.
    expect((await mm.servers()).map((s) => s.id)).toEqual(['gs-a']);
    expect((await mm.rejoinMatch('h1', record.matchId)).server.id).toBe('gs-a');
    // A heartbeat without the flag (a restarted process) takes matches again.
    await mm.heartbeat('gs-a', { load: 2, matches: [record.matchId] });
    expect((await startShow(['h3'])).serverId).toBe('gs-a');
  });
});

describe('placement', () => {
  it('never lets two concurrent starts both take the last free seats of a server', async () => {
    const { mm, server, startShow } = setup();
    await server('gs-small', 4);
    const results = await Promise.allSettled([startShow(['a1'], 4), startShow(['b1'], 4)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as MMError).code).toBe('no_server');
    expect((await mm.effectiveServers())[0]!.load).toBe(4);
  });

  it('keeps the lobby lock while a slow start is still working', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slow = false;
    const bans: BanLookup = {
      scopes: async (ids) => {
        if (slow) await gate;
        return new Map(ids.map((id) => [id, new Set<string>()]));
      },
    };
    const { clock, store, mm, server } = setup({ bans });
    await server('gs-a');
    const lobby = await mm.createLobby(player('h1'), { maxPlayers: 2 });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    slow = true;
    const start = mm.startLobby('h1', lobby.code, true);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      clock.now += 1500;
      await vi.advanceTimersByTimeAsync(1700);
    }
    // 9 s in, well past the 5 s lock TTL: the renewal kept it.
    expect(await store.get(`lobby-lock:${lobby.code}`)).not.toBeNull();
    release();
    await start;
    expect(await store.get(`lobby-lock:${lobby.code}`)).toBeNull();
  });

  it('records where a match went and whom it sent there', async () => {
    const { mm, server, startShow } = setup();
    await server('gs-a');
    const record = await startShow(['h1', 'p2'], 4);
    expect(await mm.getPlacement(record.matchId)).toEqual({
      matchId: record.matchId,
      serverId: 'gs-a',
      queue: 'custom',
      playlistId: record.playlistId,
      players: ['h1', 'p2'],
      spectators: [],
    });
    expect(await mm.getPlacement('m_unknown')).toBeNull();
  });
});

describe('record lifetimes and the registry', () => {
  it('keeps a match record alive while its server keeps reporting the show', async () => {
    const { clock, mm, server, startShow } = setup();
    await server('gs-a');
    const kept = await startShow(['h1']);
    const dropped = await startShow(['h2']);
    for (let i = 0; i < 4; i++) {
      clock.now += 15 * 60_000;
      await mm.heartbeat('gs-a', { load: 4, matches: [kept.matchId] });
    }
    expect(await mm.getMatch(kept.matchId)).not.toBeNull();
    expect(await mm.getMatch(dropped.matchId)).toBeNull();
    // The placement outlives the record, for results delivered late from an outbox.
    expect(await mm.getPlacement(dropped.matchId)).not.toBeNull();
  });

  it('deletes registry entries of servers that went silent and never deregistered', async () => {
    const { clock, store, mm, server } = setup();
    await server('gs-dead');
    clock.now += 60_000;
    await server('gs-live');
    expect((await mm.servers()).map((s) => s.id)).toEqual(['gs-live']);
    expect(Object.keys(await store.hgetall('servers')).sort()).toEqual(['gs-dead', 'gs-live']);
    clock.now += SERVER_PRUNE_MS;
    await mm.registerServer({ id: 'gs-live', url: 'wss://l/ws', region: 'na', capacity: 10, load: 0 });
    await mm.servers();
    expect(Object.keys(await store.hgetall('servers'))).toEqual(['gs-live']);
  });
});

describe('queueing', () => {
  it('accepts a queue ticket once', async () => {
    const { mm } = setup();
    await mm.enqueue(player('u1'), ticket('u1'), 'ticket-1');
    await mm.cancel('u1');
    await rejects(mm.enqueue(player('u1'), ticket('u1'), 'ticket-1'), 'invalid_ticket');
    expect(await mm.entryFor('u1')).toBeNull();
    await mm.enqueue(player('u1'), ticket('u1'), 'ticket-2');
    expect(await mm.entryFor('u1')).not.toBeNull();
  });

  it('leaves every earlier entry in place when a later party member cannot queue', async () => {
    const { mm } = setup();
    const solo = await mm.enqueue(player('a'), ticket('a'));
    await mm.createLobby(player('b'), {});
    await rejects(mm.enqueue(player('a'), ticket('a', ['a', 'b'])), 'in_lobby');
    expect((await mm.entryFor('a'))?.id).toBe(solo.id);
  });
});

describe('lobby chat and the lobby view', () => {
  it('rate-limits before looking up bans', async () => {
    let lookups = 0;
    const bans: BanLookup = {
      scopes: async (ids) => {
        lookups++;
        return new Map(ids.map((id) => [id, new Set<string>()]));
      },
    };
    const { mm } = setup({ bans });
    await mm.createLobby(player('h1'), {});
    lookups = 0;
    for (let i = 0; i < 6; i++) await mm.lobbyChat('h1', `line ${i}`);
    expect(lookups).toBe(6);
    for (let i = 0; i < 20; i++) await rejects(mm.lobbyChat('h1', 'spam'), 'chat_rate');
    expect(lookups).toBe(6);
  });

  it('shows members everything and anyone else with the code no account ids or bans', async () => {
    const { mm } = setup();
    const lobby = await mm.createLobby(player('h1'), {});
    await mm.joinLobby(player('p2'), lobby.code, false);
    await mm.kickFromLobby('h1', lobby.code, 'p2');
    const member = (await mm.viewLobby('h1', lobby.code)) as CustomLobby;
    expect(member.banned.map((b) => b.userId)).toEqual(['p2']);
    const outsider = await mm.viewLobby('stranger', lobby.code);
    expect(outsider).toMatchObject({ code: lobby.code, players: 1, spectators: 0, public: true });
    const text = JSON.stringify(outsider);
    expect(text).not.toContain('h1');
    expect(text).not.toContain('p2');
  });
});
