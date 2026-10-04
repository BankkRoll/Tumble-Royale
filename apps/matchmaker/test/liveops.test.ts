/**
 * Maintenance and scheduled playlists at the matchmaker: new queues and
 * lobbies are refused during maintenance (queued players are sent back to
 * the menu), and a ticket for a playlist outside its window is refused even
 * when the API issued it moments before the window closed.
 */
import { fixedLiveOps } from '@tumble/shared/liveops-client';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { userChannel, type MMEvent } from '../src/matchmaker.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const T = Date.parse('2026-10-04T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

let clock = T;
let mmApp: MatchmakerApp;
const liveOps = fixedLiveOps({});

beforeEach(async () => {
  clock = T;
  liveOps.set({});
  mmApp = await buildMatchmaker(loadConfig(testEnv()), { now: () => clock, logger: false, liveOps });
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
    .sign(enc(TEST_SECRETS.JWT_SECRET));
}

function queueTicket(leader: string, playlistId = 'main-show'): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({
    typ: 'queue',
    pid: `solo:${leader}`,
    leaderId: leader,
    playlistId,
    queue: 'casual',
    teamSize: 1,
    maxPlayers: 40,
    region: 'na',
    members: [{ userId: leader, name: `${leader}#0001`, mu: 25, sigma: 8.3, ordinal: 0 }],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(leader)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 120)
    .sign(enc(TEST_SECRETS.JWT_SECRET));
}

async function call(method: 'POST' | 'GET', url: string, token: string, body?: unknown) {
  return mmApp.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

const queue = async (user: string, playlistId?: string) =>
  call('POST', '/queue', await access(user), { ticket: await queueTicket(user, playlistId) });

const maintenance = (startsAt: number | null, endsAt: number | null = null) =>
  liveOps.set({
    maintenance: {
      enabled: true,
      message: 'Back after the slime refill',
      startsAt: startsAt === null ? null : iso(startsAt),
      endsAt: endsAt === null ? null : iso(endsAt),
    },
  });

describe('maintenance', () => {
  it('refuses new queues with 503 maintenance and the operator message', async () => {
    maintenance(null);
    const res = await queue('alice');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'maintenance', message: 'Back after the slime refill' });
  });

  it('refuses creating, reopening and starting private lobbies', async () => {
    const token = await access('host');
    const created = await call('POST', '/lobbies', token, {});
    expect(created.statusCode).toBe(200);
    const code = created.json().lobby.code as string;
    maintenance(null);
    expect((await call('POST', '/lobbies', token, {})).json().error).toBe('maintenance');
    expect((await call('POST', `/lobbies/${code}/start`, token, { force: true })).json().error).toBe(
      'maintenance',
    );
    expect((await call('POST', `/lobbies/${code}/reopen`, token, {})).json().error).toBe('maintenance');
  });

  it('lets queues through while maintenance is only scheduled, and flips exactly at the start', async () => {
    maintenance(T + 600_000, T + 1_200_000);
    expect((await queue('early')).statusCode).toBe(200);
    clock = T + 600_000;
    expect((await queue('late')).statusCode).toBe(503);
    clock = T + 1_200_000;
    expect((await queue('after')).statusCode).toBe(200);
  });

  it('sends players already queued back to the menu when the window opens', async () => {
    const seen: MMEvent[] = [];
    await mmApp.store.subscribe(userChannel('queued'), (m) => void seen.push(JSON.parse(m) as MMEvent));
    expect((await queue('queued')).statusCode).toBe(200);
    maintenance(null);
    expect(await mmApp.mm.tick()).toEqual([]);
    expect(seen.at(-1)).toEqual({ type: 'queue_cancelled', reason: 'maintenance' });
    expect(await mmApp.mm.status('queued')).toBeNull();
  });
});

describe('scheduled playlists', () => {
  it('refuses a playlist before its start and from exactly its end', async () => {
    liveOps.set({
      playlists: [
        { id: 'chaos-mode', startsAt: iso(T + 1000), endsAt: iso(T + 2000), featured: true, hidden: false },
      ],
    });
    const early = await queue('a', 'chaos-mode');
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      error: 'playlist_unavailable',
      message: expect.stringContaining('not started'),
    });
    clock = T + 1000;
    expect((await queue('b', 'chaos-mode')).statusCode).toBe(200);
    clock = T + 2000;
    expect((await queue('c', 'chaos-mode')).json()).toMatchObject({
      error: 'playlist_unavailable',
      message: expect.stringContaining('ended'),
    });
    expect((await queue('d', 'main-show')).statusCode).toBe(200);
  });

  it('refuses a hidden playlist and keeps unknown ones open', async () => {
    liveOps.set({
      playlists: [{ id: 'duos', startsAt: null, endsAt: null, featured: false, hidden: true }],
    });
    expect((await queue('a', 'duos')).json().error).toBe('playlist_unavailable');
    expect((await queue('b', 'brand-new-playlist')).statusCode).toBe(200);
  });
});
