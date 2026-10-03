import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const forged = (i: number) => `forged-token-${i}-${'x'.repeat(24 + (i % 7))}${i}`;

describe('rate limiting', () => {
  it('puts forged bearer tokens in the caller IP bucket on auth routes', async () => {
    api = await createTestApi();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await api.req('POST', '/auth/guest', { token: forged(i), body: {} });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });

  it('limits auth routes per IP even for verified tokens', async () => {
    api = await createTestApi();
    const u = await api.guest();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await api.req('POST', '/auth/email/start', { token: u.accessToken, body: { email: `a${i}@x.io` } })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it('shares one IP bucket across forged tokens on global routes', async () => {
    api = await createTestApi(undefined, { RATE_LIMIT_MAX: '5' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await api.req('GET', '/flags', { token: forged(i) })).statusCode);
    // Forged tokens 401 from the handler until the shared bucket runs dry.
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('gives verified players their own bucket', async () => {
    api = await createTestApi(undefined, { RATE_LIMIT_MAX: '5' });
    const a = await api.guest();
    const b = await api.guest();
    for (let i = 0; i < 5; i++)
      expect((await api.req('GET', '/me', { token: a.accessToken })).statusCode).toBe(200);
    expect((await api.req('GET', '/me', { token: a.accessToken })).statusCode).toBe(429);
    expect((await api.req('GET', '/me', { token: b.accessToken })).statusCode).toBe(200);
    // Anonymous calls from the same address are counted separately from signed-in players.
    expect((await api.req('GET', '/auth/providers')).statusCode).toBe(200);
  });
});
