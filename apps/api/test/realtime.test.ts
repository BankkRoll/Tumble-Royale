import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestApi, type TestApi } from './helpers.ts';

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

function connect(token: string): Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; next(type: string): Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${token}`);
    const messages: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(msg);
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    });
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((res) => {
        const seen = messages.findIndex((m) => m.type === type);
        if (seen >= 0) res(messages.splice(seen, 1)[0]!);
        else waiters.push({ type, resolve: res });
      });
    ws.on('open', () => resolve({ ws, messages, next }));
    ws.on('error', reject);
  });
}

describe('realtime gateway', () => {
  it('rejects connections without a valid token', async () => {
    await expect(connect('bogus')).rejects.toThrow(/401/);
  });

  it('delivers friend requests and party updates to connected users', async () => {
    const a = await api.guest('Gateway_A');
    const b = await api.guest('Gateway_B');
    const conn = await connect(b.accessToken);
    expect((await conn.next('hello')).userId).toBe(b.id);

    await api.req('POST', '/friends/request', { token: a.accessToken, body: { nameTag: `${b.displayName}#${b.tag}` } });
    expect(await conn.next('friend_request')).toMatchObject({ from: { userId: a.id } });

    await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
    await api.req('POST', '/party/invite', { token: a.accessToken, body: { userId: b.id } });
    const invite = await conn.next('party_invite');
    expect(invite).toMatchObject({ from: { userId: a.id } });

    await api.req('POST', '/party/join', { token: b.accessToken, body: { code: invite.code } });
    const update = await conn.next('party_update');
    expect((update.party as { members: unknown[] }).members).toHaveLength(2);

    const presence = (await api.req('GET', '/friends', { token: a.accessToken })).json().friends[0];
    expect(presence).toMatchObject({ userId: b.id, presence: 'online' });
    conn.ws.close();
  });
});
