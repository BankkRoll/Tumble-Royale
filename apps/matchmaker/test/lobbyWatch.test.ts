/**
 * Watching a private show that already started: spectator (broadcast) seats
 * taken by code mid-show, the host's seat limit, bans, lock and removals,
 * a returning watcher keeping their seat, and the "Spectators can chat"
 * setting reaching the join ticket. Runs on the memory store and, in CI, on
 * Redis.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { CustomLobby, MatchFoundEvent } from '../src/matchmaker.ts';
import { verifyJoinTicket } from '../src/tickets.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe.each(BACKENDS)('watching a running private show ($name)', (backend) => {
  let mmApp: MatchmakerApp;
  const clock = Date.parse('2026-10-06T12:00:00Z');

  beforeEach(async () => {
    const cfg = loadConfig(testEnv({ DEFAULT_GAME_SERVER_URL: 'ws://gs.test:7350/ws', ...backend.env }));
    mmApp = await buildMatchmaker(cfg, { now: () => clock, logger: false });
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

  async function call(url: string, user: string, body: unknown = {}, method: 'POST' | 'PATCH' = 'POST') {
    const res = await mmApp.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await access(user)}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    return {
      status: res.statusCode,
      body: res.json() as { lobby: CustomLobby; error?: string } & Partial<MatchFoundEvent>,
    };
  }

  /** A host, a guest and the host's settings; started unless `start` is false. */
  async function show(settings: Record<string, unknown> = {}, start = true) {
    const host = `host-${randomUUID()}`;
    const guest = `guest-${randomUUID()}`;
    const created = await call('/lobbies', host, { settings: { maxPlayers: 6, bots: true, ...settings } });
    const code = created.body.lobby.code;
    await call(`/lobbies/${code}/join`, guest);
    if (start) expect((await call(`/lobbies/${code}/start`, host, { force: true })).status).toBe(200);
    return { host, guest, code };
  }

  const ticketOf = (e: Partial<MatchFoundEvent>) =>
    verifyJoinTicket(TEST_SECRETS.GAME_TICKET_SECRET, e.ticket ?? '', new Date(clock));

  it('hands a stranger a spectator ticket for the running match', async () => {
    const { code } = await show({ spectatorSlots: 2 });
    const res = await call(`/lobbies/${code}/watch`, 'viewer-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'match_found', role: 'spectator', queue: 'custom' });
    const claims = await ticketOf(res.body);
    expect(claims).toMatchObject({ sub: 'viewer-1', role: 'spectator', rejoin: true, mid: res.body.matchId });
    expect(claims?.custom?.spectatorSlots).toBe(2);
    expect(claims?.custom?.spectatorChat).toBe(false);
  });

  it('says to join instead while the lobby is still open', async () => {
    const { code } = await show({}, false);
    const res = await call(`/lobbies/${code}/watch`, 'viewer-1');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('lobby_open');
  });

  it('counts the spectators the show started with against the host limit', async () => {
    const host = `host-${randomUUID()}`;
    const created = await call('/lobbies', host, { settings: { maxPlayers: 6, spectatorSlots: 2 } });
    const code = created.body.lobby.code;
    expect((await call(`/lobbies/${code}/join`, 'early-spec', { spectator: true })).status).toBe(200);
    await call(`/lobbies/${code}/start`, host, { force: true });
    expect((await call(`/lobbies/${code}/watch`, 'viewer-1')).status).toBe(200);
    const full = await call(`/lobbies/${code}/watch`, 'viewer-2');
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('spectators_full');
    // A watcher who reloads or comes back keeps the seat they took.
    const back = await call(`/lobbies/${code}/watch`, 'viewer-1');
    expect(back.status).toBe(200);
    expect(back.body.role).toBe('spectator');
  });

  it('refuses when spectating is off, and gives members their own seat back', async () => {
    const { code, guest } = await show({ spectatorSlots: 0 });
    const res = await call(`/lobbies/${code}/watch`, 'viewer-1');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_spectators');
    const member = await call(`/lobbies/${code}/watch`, guest);
    expect(member.status).toBe(200);
    expect(member.body.role).toBe('player');
  });

  it("applies the host's lock, bans and in-show removals", async () => {
    const { code, host, guest } = await show({ spectatorSlots: 4 });
    await call(`/lobbies/${code}/kick`, host, { userId: guest });
    const removed = await call(`/lobbies/${code}/watch`, guest);
    expect(removed.status).toBe(403);
    expect(removed.body.error).toBe('removed_by_host');
    const locked = await show({ spectatorSlots: 4 }, false);
    await call(`/lobbies/${locked.code}/lock`, locked.host, { locked: true });
    await call(`/lobbies/${locked.code}/start`, locked.host, { force: true });
    const res = await call(`/lobbies/${locked.code}/watch`, 'viewer-1');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('lobby_locked');
  });

  it('lists a mid-show watcher with the spectators so the host can remove them', async () => {
    const { code, host } = await show({ spectatorSlots: 2 });
    await call(`/lobbies/${code}/watch`, 'viewer-1');
    const lobby = await mmApp.app.inject({
      method: 'GET',
      url: `/lobbies/${code}`,
      headers: { authorization: `Bearer ${await access(host)}` },
    });
    expect((lobby.json() as { lobby: CustomLobby }).lobby.spectators.map((s) => s.userId)).toContain(
      'viewer-1',
    );
    expect((await call(`/lobbies/${code}/kick`, host, { userId: 'viewer-1' })).status).toBe(200);
    expect((await call(`/lobbies/${code}/watch`, 'viewer-1')).body.error).toBe('removed_by_host');
    // The removed watcher's seat is free again.
    expect((await call(`/lobbies/${code}/watch`, 'viewer-2')).status).toBe(200);
    expect((await call(`/lobbies/${code}/watch`, 'viewer-3')).status).toBe(200);
    expect((await call(`/lobbies/${code}/watch`, 'viewer-4')).body.error).toBe('spectators_full');
  });

  it('carries "Spectators can chat" to the ticket', async () => {
    const { code } = await show({ spectatorSlots: 2, spectatorChat: true });
    const claims = await ticketOf((await call(`/lobbies/${code}/watch`, 'viewer-1')).body);
    expect(claims?.custom?.spectatorChat).toBe(true);
  });
});
