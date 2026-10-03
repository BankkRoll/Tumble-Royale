/**
 * Global chat over the realtime gateway: broadcast to every connection, the
 * shared filter, the rate limit, chat bans and history on connect.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GLOBAL_CHAT_HISTORY, GLOBAL_CHAT_MAX } from '../src/social/globalChat.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

type Msg = Record<string, unknown>;

let api: TestApi;
let base: string;
beforeAll(async () => {
  api = await createTestApi();
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await api.close();
});

async function connect(user: TestUser) {
  const ws = new WebSocket(`${base}/ws?token=${user.accessToken}`);
  const got: Msg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as Msg));
  await new Promise((r) => ws.once('open', r));
  const next = (type: string, pred: (m: Msg) => boolean = () => true) =>
    new Promise<Msg>((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const i = got.findIndex((m) => m.type === type && pred(m));
        if (i >= 0) return resolve(got.splice(i, 1)[0]!);
        if (Date.now() - started > 3000) return reject(new Error(`timed out waiting for ${type}`));
        setTimeout(check, 10);
      };
      check();
    });
  const history = await next('global_chat_history');
  await next('presence_snapshot');
  return { ws, next, history, send: (m: Msg) => ws.send(JSON.stringify(m)) };
}

describe('global chat', () => {
  it('broadcasts filtered lines to every connected player, strangers included', async () => {
    const a = await api.guest('Global_A');
    const b = await api.guest('Global_B');
    const c = await api.guest('Global_C');
    const [ca, cb, cc] = await Promise.all([connect(a), connect(b), connect(c)]);

    ca.send({ type: 'global_chat', text: 'gg you absolute shit' });
    const seen = await Promise.all([ca, cb, cc].map((x) => x.next('global_chat')));
    for (const m of seen)
      expect(m).toMatchObject({
        from: { userId: a.id, name: a.displayName },
        text: 'gg you absolute shit',
        masked: 'gg you absolute ****',
      });
    expect(new Set(seen.map((m) => m.id)).size).toBe(1);
    for (const x of [ca, cb, cc]) x.ws.close();
  });

  it('replays recent lines to a new connection', async () => {
    const a = await api.guest('Global_D');
    const ca = await connect(a);
    ca.send({ type: 'global_chat', text: 'anyone here?' });
    await ca.next('global_chat', (m) => m.text === 'anyone here?');

    const late = await connect(await api.guest('Global_E'));
    const lines = late.history.lines as Msg[];
    expect(lines.length).toBeLessThanOrEqual(GLOBAL_CHAT_HISTORY);
    expect(lines.at(-1)).toMatchObject({ text: 'anyone here?', from: { userId: a.id } });
    ca.ws.close();
    late.ws.close();
  });

  it('rate limits each player and refuses chat-banned accounts', async () => {
    const a = await api.guest('Global_F');
    const ca = await connect(a);
    for (let i = 0; i < GLOBAL_CHAT_MAX; i++) ca.send({ type: 'global_chat', text: `line ${i}` });
    for (let i = 0; i < GLOBAL_CHAT_MAX; i++) await ca.next('global_chat', (m) => m.text === `line ${i}`);
    ca.send({ type: 'global_chat', text: 'one too many' });
    expect(await ca.next('error')).toMatchObject({ code: 'chat_rate' });

    ca.send({ type: 'global_chat', text: '   ' });
    expect(await ca.next('error')).toMatchObject({ code: 'empty_message' });

    api.clock.advance(30_000);
    await api.ban(a.id, 'chat');
    ca.send({ type: 'global_chat', text: 'let me talk' });
    expect(await ca.next('error')).toMatchObject({ code: 'chat_banned' });
    ca.ws.close();
  });
});
