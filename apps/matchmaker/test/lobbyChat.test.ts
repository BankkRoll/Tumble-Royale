/**
 * Private-show lobby chat: members only, shared filter, per-member rate limit,
 * chat bans, and delivery over the matchmaker WebSocket.
 */
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import type { BanLookup } from '../src/bans.ts';
import { loadConfig } from '../src/config.ts';
import { LOBBY_CHAT_MAX, LOBBY_CHAT_WINDOW_MS, userChannel, type MMEvent } from '../src/matchmaker.ts';

const JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijkl';
const enc = (s: string) => new TextEncoder().encode(s);

let clock = 0;
let mmApp: MatchmakerApp;
const banned = new Map<string, string[]>();
const bans: BanLookup = {
  scopes: async (ids) => new Map(ids.map((id) => [id, new Set(banned.get(id) ?? [])])),
};

beforeEach(async () => {
  clock = Date.parse('2026-10-02T12:00:00Z');
  banned.clear();
  mmApp = await buildMatchmaker(
    loadConfig({
      NODE_ENV: 'test',
      JWT_SECRET,
      GAME_TICKET_SECRET: 'test-ticket-secret-0123456789',
      GAME_SERVER_SECRET: 'test-server-secret-0123456789',
      DEFAULT_GAME_SERVER_URL: 'ws://gs.test:7350/ws',
      LOG_LEVEL: 'silent',
    }),
    { now: () => clock, logger: false, bans },
  );
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

async function call(method: 'POST', url: string, user: string, body: unknown = {}) {
  const res = await mmApp.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await access(user)}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as { lobby: { code: string } } };
}

async function collect(userId: string): Promise<MMEvent[]> {
  const events: MMEvent[] = [];
  await mmApp.store.subscribe(userChannel(userId), (m) => events.push(JSON.parse(m) as MMEvent));
  return events;
}

const chats = (events: MMEvent[]) => events.filter((e) => e.type === 'lobby_chat');

async function lobby(): Promise<string> {
  const code = (await call('POST', '/lobbies', 'host')).body.lobby.code;
  expect((await call('POST', `/lobbies/${code}/join`, 'ann')).status).toBe(200);
  return code;
}

describe('lobby chat', () => {
  it('relays filtered lines to every member, with a masked copy', async () => {
    const code = await lobby();
    const host = await collect('host');
    const ann = await collect('ann');
    const line = await mmApp.mm.lobbyChat('ann', 'well shit, ready?');
    expect(line).toMatchObject({
      code,
      from: { userId: 'ann', name: 'ann#0001' },
      text: 'well shit, ready?',
      masked: 'well ***** ready?',
    });
    expect(chats(host)).toHaveLength(1);
    expect(chats(ann)).toHaveLength(1);
    const slur = await mmApp.mm.lobbyChat('host', 'n1gg3r');
    expect(slur.text).toBe('******');
  });

  it('refuses non-members, empty lines and chat-banned accounts', async () => {
    await lobby();
    await expect(mmApp.mm.lobbyChat('stranger', 'hi')).rejects.toMatchObject({ code: 'no_lobby' });
    await expect(mmApp.mm.lobbyChat('ann', '   ')).rejects.toMatchObject({ code: 'empty_message' });
    banned.set('ann', ['chat']);
    await expect(mmApp.mm.lobbyChat('ann', 'hello')).rejects.toMatchObject({ code: 'chat_banned' });
  });

  it('rate-limits each member', async () => {
    await lobby();
    for (let i = 0; i < LOBBY_CHAT_MAX; i++) await mmApp.mm.lobbyChat('ann', `line ${i}`);
    await expect(mmApp.mm.lobbyChat('ann', 'too many')).rejects.toMatchObject({ code: 'chat_rate' });
    await mmApp.mm.lobbyChat('host', 'host is unaffected');
    clock += LOBBY_CHAT_WINDOW_MS;
    await mmApp.mm.lobbyChat('ann', 'back again');
  });

  it('accepts lobby_chat over the WebSocket and reports errors there', async () => {
    await lobby();
    await mmApp.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (mmApp.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${await access('ann')}`);
    const got: Record<string, unknown>[] = [];
    const waitFor = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const check = () => {
          const hit = got.find((m) => m.type === type);
          if (hit) resolve(hit);
          else setTimeout(check, 10);
        };
        check();
      });
    ws.on('message', (d) => got.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise((r) => ws.once('open', r));
    await waitFor('lobby_update');
    ws.send(JSON.stringify({ type: 'lobby_chat', text: 'hi all' }));
    expect(await waitFor('lobby_chat')).toMatchObject({ text: 'hi all', from: { userId: 'ann' } });
    ws.send(JSON.stringify({ type: 'lobby_chat', text: '' }));
    expect(await waitFor('error')).toMatchObject({ code: 'empty_message' });
    ws.close();
  });
});
