/**
 * Whispers between friends over HTTP and the realtime gateway: filtering,
 * friends-only, blocks, rate limit and chat bans.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WHISPER_MAX } from '../src/social/whisper.ts';
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
  await next('presence_snapshot');
  return { ws, next, send: (m: Msg) => ws.send(JSON.stringify(m)) };
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await api.req('POST', '/friends/request', { token: a.accessToken, body: { userId: b.id } });
  await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
}

describe('whispers', () => {
  it('delivers filtered whispers to both friends, live and over HTTP', async () => {
    const a = await api.guest('Whisper_A');
    const b = await api.guest('Whisper_B');
    const stranger = await api.guest('Whisper_C');
    await befriend(a, b);
    const [ca, cb] = await Promise.all([connect(a), connect(b)]);

    ca.send({ type: 'whisper', to: b.id, text: 'gg you absolute shit' });
    const got = await cb.next('whisper');
    expect(got).toMatchObject({
      from: { userId: a.id, name: a.displayName },
      to: { userId: b.id },
      text: 'gg you absolute shit',
      masked: 'gg you absolute ****',
    });
    expect(await ca.next('whisper')).toMatchObject({ id: got.id });

    const http = await api.req('POST', '/whisper', {
      token: b.accessToken,
      body: { userId: a.id, text: 'back atcha' },
    });
    expect(http.statusCode).toBe(200);
    expect(await ca.next('whisper', (m) => m.text === 'back atcha')).toBeTruthy();

    const notFriend = await api.req('POST', '/whisper', {
      token: stranger.accessToken,
      body: { userId: a.id, text: 'hey' },
    });
    expect(notFriend.json().error).toBe('not_friends');
    ca.send({ type: 'whisper', to: stranger.id, text: 'hello?' });
    expect(await ca.next('error')).toMatchObject({ code: 'not_friends' });
    ca.ws.close();
    cb.ws.close();
  });

  it('stops after a block and enforces the rate limit and chat bans', async () => {
    const a = await api.guest('Whisper_D');
    const b = await api.guest('Whisper_E');
    await befriend(a, b);
    const say = (text: string) =>
      api.req('POST', '/whisper', { token: a.accessToken, body: { userId: b.id, text } });
    expect((await say('  ')).json().error).toBe('empty_message');
    for (let i = 0; i < WHISPER_MAX; i++) expect((await say(`w${i}`)).statusCode).toBe(200);
    expect((await say('one more')).json().error).toBe('chat_rate');
    api.clock.advance(30_000);

    await api.req('POST', '/friends/block', { token: b.accessToken, body: { userId: a.id } });
    expect((await say('still there?')).json().error).toBe('not_friends');
    await api.req('DELETE', `/friends/block/${a.id}`, { token: b.accessToken });
    await befriend(a, b);
    expect((await say('friends again')).statusCode).toBe(200);
    await api.req('POST', '/internal/bans', {
      headers: { authorization: 'Bearer test-admin-token-0123456789-abcdefghij' },
      body: { userId: a.id, scope: 'chat', reason: 'abusive whispers', durationHours: 1 },
    });
    expect((await say('hello')).json().error).toBe('chat_banned');
  });
});
