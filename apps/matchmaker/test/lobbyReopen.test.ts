/**
 * "Play again" after a private online show: the host reopens the finished
 * lobby under the same code and everyone else rejoins with it.
 * Runs on the memory store and, in CI, on Redis.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { CustomLobby } from '../src/matchmaker.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe.each(BACKENDS)('reopening a private show ($name)', (backend) => {
  let mmApp: MatchmakerApp;
  const clock = Date.parse('2026-10-02T12:00:00Z');

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

  async function call(url: string, user: string, body: unknown = {}) {
    const res = await mmApp.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${await access(user)}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.json() as { lobby: CustomLobby; error?: string } };
  }

  /** A host and one guest whose show already started. */
  async function startedShow(): Promise<{ host: string; guest: string; code: string }> {
    const host = `host-${randomUUID()}`;
    const guest = `guest-${randomUUID()}`;
    const created = await call('/lobbies', host, { settings: { maxPlayers: 6, bots: true } });
    const code = created.body.lobby.code;
    await call(`/lobbies/${code}/join`, guest);
    expect((await call(`/lobbies/${code}/start`, host, { force: true })).status).toBe(200);
    return { host, guest, code };
  }

  it('reopens the same code with the host seated and the old match cleared', async () => {
    const { host, guest, code } = await startedShow();
    expect((await call(`/lobbies/${code}/join`, guest)).body.error).toBe('lobby_started');

    const reopened = await call(`/lobbies/${code}/reopen`, host);
    expect(reopened.status).toBe(200);
    expect(reopened.body.lobby).toMatchObject({ code, status: 'open', matchId: null, hostId: host });
    expect(reopened.body.lobby.players.map((p) => p.userId)).toEqual([host]);
    expect(reopened.body.lobby.settings.maxPlayers).toBe(6);

    const back = await call(`/lobbies/${code}/join`, guest);
    expect(back.status).toBe(200);
    expect(back.body.lobby.players.map((p) => p.userId)).toEqual([host, guest]);
  });

  it('is harmless when the host presses it twice', async () => {
    const { host, code } = await startedShow();
    await call(`/lobbies/${code}/reopen`, host);
    const again = await call(`/lobbies/${code}/reopen`, host);
    expect(again.status).toBe(200);
    expect(again.body.lobby.players.map((p) => p.userId)).toEqual([host]);
  });

  it('keeps the host bans of the last show', async () => {
    const { host, guest, code } = await startedShow();
    await call(`/lobbies/${code}/kick`, host, { userId: guest });
    await call(`/lobbies/${code}/reopen`, host);
    expect((await call(`/lobbies/${code}/join`, guest)).body.error).toBe('banned');
  });

  it('refuses everyone but the host and unknown codes', async () => {
    const { guest, code } = await startedShow();
    const res = await call(`/lobbies/${code}/reopen`, guest);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_host');
    expect((await call('/lobbies/ZZZZZZ/reopen', guest)).body.error).toBe('lobby_not_found');
  });
});
