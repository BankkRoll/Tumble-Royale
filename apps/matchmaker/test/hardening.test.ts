import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const JWT_SECRET = TEST_SECRETS.JWT_SECRET;
const SERVER_SECRET = TEST_SECRETS.GAME_SERVER_SECRET;
const clock = Date.parse('2026-10-02T12:00:00Z');
let mm: MatchmakerApp | undefined;

afterEach(async () => {
  await mm?.close();
  mm = undefined;
});

async function build(env: Record<string, string> = {}): Promise<MatchmakerApp> {
  mm = await buildMatchmaker(loadConfig(testEnv(env)), { now: () => clock, logger: false });
  return mm;
}

function access(userId: string): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ sid: 's', name: `${userId}#0001`, region: 'na', guest: true, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe('CORS', () => {
  it('only answers configured origins', async () => {
    const app = (await build({ ALLOWED_ORIGINS: 'https://play.example.com, https://beta.example.com/' })).app;
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/queue',
      headers: { origin: 'https://beta.example.com' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://beta.example.com');

    const evilPreflight = await app.inject({
      method: 'OPTIONS',
      url: '/queue',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evilPreflight.statusCode).toBe(403);
    const evilGet = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evilGet.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('limits requests per IP', async () => {
    const app = (await build({ RATE_LIMIT_MAX: '3' })).app;
    const token = await access('alice');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (
          await app.inject({
            method: 'GET',
            url: '/queue/status',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // Game servers are authenticated by secret and not throttled per IP.
    const hb = await app.inject({
      method: 'POST',
      url: '/servers/register',
      headers: { authorization: `Bearer ${SERVER_SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ serverId: 'gs', url: 'wss://gs.test', region: 'na', capacity: 40 }),
    });
    expect(hb.statusCode).toBe(200);
  });

  it('limits queue and lobby mutations per player', async () => {
    const app = (await build({ USER_RATE_LIMIT_MAX: '2' })).app;
    const post = async (user: string, ip: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/lobbies',
          remoteAddress: ip,
          headers: { authorization: `Bearer ${await access(user)}`, 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode;
    expect([await post('alice', '10.0.0.1'), await post('alice', '10.0.0.2')]).toEqual([200, 200]);
    // A new address does not reset the player's budget.
    expect(await post('alice', '10.0.0.3')).toBe(429);
    expect(await post('bob', '10.0.0.3')).toBe(200);
  });
});
