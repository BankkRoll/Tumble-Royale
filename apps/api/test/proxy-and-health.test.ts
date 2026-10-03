import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDatabase } from '../src/db/client.ts';
import { MemoryKV } from '../src/kv/index.ts';
import { createTestApi, type TestApi } from './helpers.ts';

let apis: TestApi[] = [];
afterEach(async () => {
  for (const a of apis) await a.close();
  apis = [];
});

async function api(...args: Parameters<typeof createTestApi>): Promise<TestApi> {
  const a = await createTestApi(...args);
  apis.push(a);
  return a;
}

const flags = (a: TestApi, ip: string, xff?: string) =>
  a
    .req('GET', '/flags', { ip, ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}) })
    .then((r) => r.statusCode);

describe('TRUST_PROXY', () => {
  it('ignores X-Forwarded-For by default', async () => {
    const a = await api(undefined, { RATE_LIMIT_MAX: '2' });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await flags(a, '203.0.113.5', `198.51.100.${i}`));
    expect(codes[2]).toBe(429);
  });

  it('keys on the entry appended by the trusted hops, IPv6 included', async () => {
    const a = await api(undefined, { RATE_LIMIT_MAX: '2', TRUST_PROXY: '2' });
    const codes = [];
    // Client forges the left-most entry; CDN appends the client, ingress appends the CDN.
    for (let i = 0; i < 3; i++) codes.push(await flags(a, '10.0.0.2', `6.6.6.${i}, 2001:db8::7, 172.16.0.9`));
    expect(codes[2]).toBe(429);
    expect(await flags(a, '10.0.0.2', '2001:db8::8, 172.16.0.9')).not.toBe(429);
  });

  it('refuses TRUST_PROXY=true at boot', async () => {
    await expect(createTestApi(undefined, { TRUST_PROXY: 'true' })).rejects.toThrow(/TRUST_PROXY/);
  });
});

describe('shared rate limits', () => {
  it('counts one window across instances sharing the KV', async () => {
    class SharedKV extends MemoryKV {
      override async close(): Promise<void> {}
    }
    const kv = new SharedKV();
    const real = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    const database = { ...real, close: async () => undefined };
    try {
      const a = await api(undefined, { RATE_LIMIT_MAX: '3' }, { kv, database, sharedRateLimit: true });
      const b = await api(undefined, { RATE_LIMIT_MAX: '3' }, { kv, database, sharedRateLimit: true });
      const codes = [];
      for (const x of [a, b, a, b]) codes.push(await flags(x, '203.0.113.5'));
      expect(codes[3]).toBe(429);
      expect(codes.slice(0, 3)).not.toContain(429);
    } finally {
      for (const x of apis) await x.close();
      apis = [];
      await real.close();
    }
  });

  it('fails open when the shared store errors', async () => {
    class BrokenKV extends MemoryKV {
      override async incr(): Promise<number> {
        throw new Error('redis down');
      }
    }
    const a = await api(undefined, { RATE_LIMIT_MAX: '1' }, { kv: new BrokenKV(), sharedRateLimit: true });
    expect(await flags(a, '203.0.113.5')).not.toBe(500);
  });
});

describe('/health', () => {
  it('reports 503 when the KV does not answer', async () => {
    let down = false;
    class FlakyKV extends MemoryKV {
      override async ping(): Promise<void> {
        if (down) throw new Error('ECONNREFUSED');
      }
    }
    const a = await api(undefined, {}, { kv: new FlakyKV() });
    const ok = await a.req('GET', '/health');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, dbOk: true, kvOk: true });
    down = true;
    const bad = await a.req('GET', '/health');
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ ok: false, dbOk: true, kvOk: false });
  });
});

describe('realtime gateway origin', () => {
  it('refuses upgrades from origins outside CORS_ORIGINS', async () => {
    const a = await api(undefined, { CORS_ORIGINS: 'https://play.example' });
    const u = await a.guest();
    await a.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (a.app.server.address() as AddressInfo).port;
    const open = (origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${u.accessToken}`, {
          ...(origin ? { headers: { origin } } : {}),
        });
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
    expect(await open('https://evil.example')).toBe(403);
    expect(await open('https://play.example/')).toBe(101);
    expect(await open()).toBe(101);
  });
});
