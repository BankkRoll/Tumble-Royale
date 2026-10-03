/**
 * Private show host tools over HTTP + the event stream: kick/ban, live
 * settings, transfer, lock, new codes, ready checks, spectator seats,
 * host migration, reload recovery and the game-server kick hand-off.
 */
import type { AddressInfo } from 'node:net';
import { MAX_PLAYERS } from '@tumble/shared';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';
import { controlBase, type GameControl, type MatchTarget } from '../src/gameControl.ts';
import { LOBBY_AWAY_GRACE_MS } from '../src/lobbyRules.ts';
import { userChannel, type CustomLobby, type MMEvent } from '../src/matchmaker.ts';

const JWT_SECRET = TEST_SECRETS.JWT_SECRET;
const enc = (s: string) => new TextEncoder().encode(s);

let clock = 0;
let mmApp: MatchmakerApp;
let kicks: { target: MatchTarget; userId: string }[] = [];

beforeEach(async () => {
  clock = Date.parse('2026-10-02T12:00:00Z');
  kicks = [];
  const control: GameControl = {
    kick: async (target, userId) => {
      kicks.push({ target, userId });
      return true;
    },
  };
  const cfg = loadConfig(testEnv({ DEFAULT_GAME_SERVER_URL: 'ws://gs.test:7350/ws' }));
  mmApp = await buildMatchmaker(cfg, { now: () => clock, logger: false, control });
});
afterEach(async () => {
  await mmApp.close();
});

function access(userId: string): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ sid: 's', name: `${userId}#0001`, region: 'na', guest: true, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(enc(JWT_SECRET));
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, user: string, body?: unknown) {
  const res = await mmApp.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await access(user)}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const json = (res.body ? res.json() : {}) as { lobby: CustomLobby; error?: string };
  return { status: res.statusCode, body: json };
}

async function collect(userId: string): Promise<MMEvent[]> {
  const events: MMEvent[] = [];
  await mmApp.store.subscribe(userChannel(userId), (m) => events.push(JSON.parse(m) as MMEvent));
  return events;
}

const lastLobby = (events: MMEvent[]): CustomLobby | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'lobby_update') return e.lobby;
  }
  return null;
};

/** Host + members, joined one second apart so the host line is well defined. */
async function setup(members: string[], settings: Record<string, unknown> = {}): Promise<string> {
  const code = (await call('POST', '/lobbies', 'host', { settings })).body.lobby.code;
  for (const m of members) {
    clock += 1000;
    expect((await call('POST', `/lobbies/${code}/join`, m, {})).status).toBe(200);
  }
  return code;
}

describe('host kicks', () => {
  it('removes the player for everyone, tells them, and bans them until unbanned', async () => {
    const code = await setup(['ann', 'bob']);
    const ann = await collect('ann');
    const bob = await collect('bob');
    expect((await call('POST', `/lobbies/${code}/kick`, 'bob', { userId: 'ann' })).body.error).toBe(
      'not_host',
    );
    const res = await call('POST', `/lobbies/${code}/kick`, 'host', { userId: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removedFromMatch: null });
    expect(ann.some((e) => e.type === 'lobby_kicked' && e.reason === 'kicked')).toBe(true);
    expect(lastLobby(bob)!.players.map((p) => p.userId)).toEqual(['host', 'bob']);
    expect(lastLobby(bob)!.banned).toEqual([{ userId: 'ann', name: 'ann#0001' }]);

    const again = await call('POST', `/lobbies/${code}/join`, 'ann', {});
    expect(again).toMatchObject({ status: 403, body: { error: 'banned' } });
    expect((await call('GET', '/lobbies/mine', 'ann')).body.lobby).toBeNull();

    expect((await call('POST', `/lobbies/${code}/unban`, 'bob', { userId: 'ann' })).status).toBe(403);
    await call('POST', `/lobbies/${code}/unban`, 'host', { userId: 'ann' });
    expect((await call('POST', `/lobbies/${code}/join`, 'ann', {})).status).toBe(200);
  });

  it('forwards a kick to the game server once the show started', async () => {
    const code = await setup(['ann', 'bob']);
    expect((await call('POST', `/lobbies/${code}/start`, 'host', { force: true })).status).toBe(200);
    const res = await call('POST', `/lobbies/${code}/kick`, 'host', { userId: 'bob' });
    expect(res.body).toMatchObject({ removedFromMatch: true });
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toMatchObject({ userId: 'bob', target: { serverUrl: 'ws://gs.test:7350/ws' } });
    expect(kicks[0]!.target.matchId).toBe(res.body.lobby.matchId);
    expect(controlBase(kicks[0]!.target)).toBe('http://gs.test:7350');
    // Settings and the rest stay frozen once the show is on the server.
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { bots: false })).body.error).toBe(
      'lobby_started',
    );
  });
});

describe('live settings', () => {
  it('lets only the host change validated settings and pushes them to members', async () => {
    const code = await setup(['ann', 'bob']);
    const bob = await collect('bob');
    expect((await call('PATCH', `/lobbies/${code}`, 'ann', { maxPlayers: 10 })).status).toBe(403);
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { maxPlayers: 2 })).body.error).toBe(
      'too_many_players',
    );
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { roundTimeScale: 9 })).status).toBe(400);
    // Exactly the cap is a legal lobby; one more is not.
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { maxPlayers: MAX_PLAYERS + 1 })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { minPlayers: MAX_PLAYERS + 1 })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { maxPlayers: MAX_PLAYERS })).status).toBe(200);
    expect(lastLobby(bob)!.settings.maxPlayers).toBe(MAX_PLAYERS);
    expect(
      (await call('PATCH', `/lobbies/${code}`, 'host', { minPlayers: 50, maxPlayers: 20 })).body.error,
    ).toBe('min_over_max');
    const ok = await call('PATCH', `/lobbies/${code}`, 'host', {
      maxPlayers: 20,
      bots: false,
      roundTimeScale: 1.5,
      lobbyCountdownSec: 30,
      spectatorSlots: 4,
      minPlayers: 3,
      rounds: ['gumdrop-gauntlet'],
    });
    expect(ok.status).toBe(200);
    expect(lastLobby(bob)!.settings).toMatchObject({
      maxPlayers: 20,
      bots: false,
      roundTimeScale: 1.5,
      lobbyCountdownSec: 30,
      spectatorSlots: 4,
      minPlayers: 3,
      rounds: ['gumdrop-gauntlet'],
    });
  });
});

describe('host tools', () => {
  it('transfers the crown, and the old host loses host rights', async () => {
    const code = await setup(['ann']);
    expect((await call('POST', `/lobbies/${code}/host`, 'ann', { userId: 'ann' })).status).toBe(403);
    const res = await call('POST', `/lobbies/${code}/host`, 'host', { userId: 'ann' });
    expect(res.body.lobby.hostId).toBe('ann');
    expect((await call('PATCH', `/lobbies/${code}`, 'host', { bots: false })).status).toBe(403);
    expect((await call('PATCH', `/lobbies/${code}`, 'ann', { bots: false })).status).toBe(200);
  });

  it('locks code joins but keeps members able to come back', async () => {
    const code = await setup(['ann']);
    expect((await call('POST', `/lobbies/${code}/lock`, 'ann', { locked: true })).status).toBe(403);
    expect((await call('POST', `/lobbies/${code}/lock`, 'host', { locked: true })).body.lobby.locked).toBe(
      true,
    );
    expect((await call('POST', `/lobbies/${code}/join`, 'cat', {})).body.error).toBe('lobby_locked');
    expect((await call('POST', `/lobbies/${code}/join`, 'ann', {})).status).toBe(200);
    await call('POST', `/lobbies/${code}/lock`, 'host', { locked: false });
    expect((await call('POST', `/lobbies/${code}/join`, 'cat', {})).status).toBe(200);
  });

  it('regenerates the invite code and retires the old one', async () => {
    const code = await setup(['ann']);
    const ann = await collect('ann');
    expect((await call('POST', `/lobbies/${code}/code`, 'ann')).status).toBe(403);
    const res = await call('POST', `/lobbies/${code}/code`, 'host');
    const next = res.body.lobby.code;
    expect(next).not.toBe(code);
    expect(lastLobby(ann)!.code).toBe(next);
    expect((await call('POST', `/lobbies/${code}/join`, 'cat', {})).status).toBe(404);
    expect((await call('POST', `/lobbies/${next}/join`, 'cat', {})).status).toBe(200);
    expect((await call('GET', '/lobbies/mine', 'ann')).body.lobby.code).toBe(next);
    await call('POST', `/lobbies/${next}/leave`, 'ann');
    expect((await call('GET', `/lobbies/${next}`, 'host')).body.lobby.players).toHaveLength(2);
  });

  it('gates the start on the minimum players and ready checks, with a force start', async () => {
    const code = await setup(['ann', 'bob'], { minPlayers: 4 });
    expect((await call('POST', `/lobbies/${code}/start`, 'host', { force: true })).body.error).toBe(
      'not_enough_players',
    );
    await call('PATCH', `/lobbies/${code}`, 'host', { minPlayers: 2 });
    await call('POST', `/lobbies/${code}/ready`, 'ann', { ready: true });
    const blocked = await call('POST', `/lobbies/${code}/start`, 'host', {});
    expect(blocked.body).toMatchObject({ error: 'not_ready' });
    expect((blocked.body as unknown as { message: string }).message).toContain('bob#0001');
    expect((await call('POST', `/lobbies/${code}/start`, 'ann', { force: true })).status).toBe(403);
    expect((await call('POST', `/lobbies/${code}/start`, 'host', { force: true })).status).toBe(200);
  });

  it('migrates hosting to the longest-present member when the host leaves', async () => {
    const code = await setup(['ann', 'bob']);
    await call('POST', `/lobbies/${code}/role`, 'ann', { spectator: true });
    await call('POST', `/lobbies/${code}/role`, 'ann', { spectator: false });
    // Switching roles keeps ann's place in line even though she re-entered the player list last.
    await call('POST', `/lobbies/${code}/leave`, 'host');
    const after = (await call('GET', `/lobbies/${code}`, 'bob')).body.lobby;
    expect(after.hostId).toBe('ann');
    expect(after.players.find((p) => p.userId === 'ann')!.ready).toBe(true);
  });
});

describe('spectator seats', () => {
  it('lets members switch roles within the slots', async () => {
    const code = await setup(['ann', 'bob'], { spectatorSlots: 1 });
    expect((await call('POST', `/lobbies/${code}/role`, 'host', { spectator: true })).body.error).toBe(
      'host_must_play',
    );
    const res = await call('POST', `/lobbies/${code}/role`, 'ann', { spectator: true });
    expect(res.body.lobby.spectators.map((s) => s.userId)).toEqual(['ann']);
    expect((await call('POST', `/lobbies/${code}/role`, 'bob', { spectator: true })).body.error).toBe(
      'spectators_full',
    );
    expect((await call('POST', `/lobbies/${code}/join`, 'cat', { spectator: true })).body.error).toBe(
      'spectators_full',
    );
    expect((await call('POST', `/lobbies/${code}/ready`, 'ann', { ready: true })).status).toBe(404);
    // A spectator's reload does not drag them back into the player list.
    expect((await call('POST', `/lobbies/${code}/join`, 'ann', {})).body.lobby.spectators).toHaveLength(1);
  });
});

describe('reloads and presence', () => {
  it('hands the lobby back on reconnect and drops members who never come back', async () => {
    const code = await setup(['ann']);
    await mmApp.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (mmApp.app.server.address() as AddressInfo).port;
    const open = async (user: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${await access(user)}`);
      const got: MMEvent[] = [];
      ws.on('message', (d) => got.push(JSON.parse(String(d)) as MMEvent));
      await new Promise((r) => ws.on('open', r));
      return { ws, got };
    };
    const wait = () => new Promise((r) => setTimeout(r, 60));

    const first = await open('ann');
    await wait();
    expect(lastLobby(first.got)!.code).toBe(code);
    first.ws.close();
    await wait();
    const away = (await call('GET', `/lobbies/${code}`, 'host')).body.lobby;
    expect(away.players.find((p) => p.userId === 'ann')!.awaySince).toBe(clock);

    // Reload: a new socket within the grace period restores the seat.
    const second = await open('ann');
    await wait();
    expect(lastLobby(second.got)!.players.find((p) => p.userId === 'ann')!.awaySince).toBeNull();
    second.ws.close();
    await wait();

    clock += LOBBY_AWAY_GRACE_MS;
    const host = await collect('host');
    await mmApp.mm.sweepLobbies();
    expect(lastLobby(host)!.players.map((p) => p.userId)).toEqual(['host']);
    expect((await call('GET', '/lobbies/mine', 'ann')).body.lobby).toBeNull();
  });
});
