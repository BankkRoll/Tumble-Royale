/**
 * Bans outliving account deletion, re-applied by OAuth subject, email address
 * and guest device secret; and the ban cache being invalidated on every API
 * instance through KV pub/sub.
 */
import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteAccount } from '../src/accounts/erase.ts';
import { sha256 } from '../src/auth/tokens.ts';
import { openDatabase } from '../src/db/client.ts';
import { authIdentities, banEvasionMarks, bans, users } from '../src/db/schema.ts';
import { MemoryKV } from '../src/kv/index.ts';
import { identifierHash } from '../src/moderation/ban-evasion.ts';
import {
  ADMIN_TOKEN,
  createTestApi,
  TEST_BINDING,
  TEST_NONCE,
  TEST_SECRETS,
  type TestApi,
} from './helpers.ts';

/** What the stubbed OAuth providers report for the next callback. */
const nextProfile = {
  discord: { id: 'd-0', email: null as string | null },
  google: { sub: 'g-0', email: null as string | null },
};

const stubFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/oauth2/token') || url.includes('oauth2.googleapis.com/token'))
    return Response.json({ access_token: 'provider-token' });
  if (url.includes('discord.com/api/users/@me')) {
    const p = nextProfile.discord;
    return Response.json({ id: p.id, username: 'Pal', email: p.email, verified: p.email !== null });
  }
  if (url.includes('openidconnect.googleapis.com')) {
    const p = nextProfile.google;
    return Response.json({ sub: p.sub, given_name: 'Pal', email: p.email, email_verified: p.email !== null });
  }
  return new Response('not stubbed', { status: 500 });
}) as typeof fetch;

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(
    undefined,
    {
      DISCORD_CLIENT_ID: 'discord-client',
      DISCORD_CLIENT_SECRET: 'discord-secret',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
    },
    { fetch: stubFetch },
  );
});
afterAll(async () => {
  await api.close();
});

const ip = () => `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** Runs an OAuth round trip; returns the exchanged session, or the error code from the redirect. */
async function oauth(
  provider: 'discord' | 'google',
  profile: { subject: string; email?: string },
  token?: string,
): Promise<{ error: string } | { userId: string; outcome: string; accessToken: string }> {
  if (provider === 'discord') nextProfile.discord = { id: profile.subject, email: profile.email ?? null };
  else nextProfile.google = { sub: profile.subject, email: profile.email ?? null };
  const start = await api.req('POST', `/auth/${provider}/start`, {
    token,
    body: { binding: TEST_BINDING },
    ip: ip(),
  });
  const state = new URL(start.json().url).searchParams.get('state')!;
  const cb = await api.req('GET', `/auth/${provider}/callback?code=c&state=${state}`, { ip: ip() });
  const back = new URL(cb.headers.location as string);
  const error = back.searchParams.get('error');
  if (error) return { error };
  const ex = await api.req('POST', '/auth/exchange', {
    token,
    body: { code: back.searchParams.get('code'), nonce: TEST_NONCE },
    ip: ip(),
  });
  const j = ex.json();
  if (ex.statusCode !== 200) return { error: j.error };
  return { userId: j.user.id, outcome: j.outcome, accessToken: j.accessToken };
}

async function banVia(userId: string, scope: 'all' | 'chat' | 'ranked', durationHours?: number) {
  const res = await api.req('POST', '/internal/bans', {
    headers: admin,
    body: { userId, scope, reason: `evasion test ${scope}`, ...(durationHours ? { durationHours } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function bansOf(userId: string) {
  return api.ctx.db.select().from(bans).where(eq(bans.userId, userId));
}

async function userCount(): Promise<number> {
  const [row] = await api.ctx.db.select({ n: count() }).from(users);
  return row!.n;
}

const erase = (userId: string) => deleteAccount(api.ctx, userId, { ip: '127.0.0.1' });

describe('bans that survive account deletion', () => {
  it('keeps only keyed hashes of the identifiers, never the raw values', async () => {
    const u = await api.account('hash-check@example.com');
    await banVia(u.id, 'chat');
    await erase(u.id);
    const marks = await api.ctx.db.select().from(banEvasionMarks);
    const hashes = marks.map((m) => m.identifierHash);
    expect(hashes).toContain(
      identifierHash(TEST_SECRETS.INTERNAL_HMAC_SECRET, { kind: 'email', email: 'Hash-Check@example.com' }),
    );
    expect(hashes).toContain(
      identifierHash(TEST_SECRETS.INTERNAL_HMAC_SECRET, {
        kind: 'identity',
        provider: 'device',
        subject: sha256(u.deviceToken),
      }),
    );
    expect(JSON.stringify(marks)).not.toContain('hash-check');
    expect(JSON.stringify(marks)).not.toContain(u.id);
  });

  it('re-applies a chat ban with its scope when the same email signs in again after DELETE /me', async () => {
    const u = await api.account('chatty@example.com');
    await banVia(u.id, 'chat');
    const del = await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode).toBe(204);

    const again = await api.emailSignIn('chatty@example.com');
    expect(again.statusCode).toBe(200);
    const j = again.json();
    expect(j.outcome).toBe('created');
    expect(j.user.id).not.toBe(u.id);
    const lookup = await api.internal('/internal/bans/lookup', { userIds: [j.user.id] });
    expect(lookup.json().bans[j.user.id]).toEqual([
      expect.objectContaining({ scope: 'chat', reason: 'evasion test chat' }),
    ]);
    // Chat-banned players may still play.
    expect((await api.req('GET', '/me', { token: j.accessToken })).statusCode).toBe(200);
  });

  it('bans every identifier of a deleted account individually: Discord, Google, email and each device', async () => {
    const main = await api.account('multi@example.com');
    const d = await oauth('discord', { subject: 'discord-multi' }, main.accessToken);
    expect(d).toMatchObject({ outcome: 'linked', userId: main.id });
    const g = await oauth(
      'google',
      { subject: 'google-multi', email: 'multi-google@example.com' },
      main.accessToken,
    );
    expect(g).toMatchObject({ outcome: 'linked', userId: main.id });
    // NOTE: the auth model gives each account one device identity; a second
    // one is inserted to prove every device secret is marked on its own.
    const secondDevice = `second-device-${randomUUID()}`;
    await api.ctx.db
      .insert(authIdentities)
      .values({ userId: main.id, provider: 'device', subject: sha256(secondDevice) });

    const ban = await banVia(main.id, 'all');
    // A suspended player cannot call DELETE /me; support erasure (or a ban that
    // lands mid-deletion) takes the same path.
    await erase(main.id);
    const marks = await api.ctx.db.select().from(banEvasionMarks).where(eq(banEvasionMarks.banId, ban.id));
    // device ×2, discord, google, email identity + users.email (same hash), google address.
    expect(new Set(marks.map((m) => m.identifierHash)).size).toBe(6);

    expect(await oauth('discord', { subject: 'discord-multi' })).toEqual({ error: 'banned' });
    expect(await oauth('google', { subject: 'google-multi' })).toEqual({ error: 'banned' });
    // A different Discord account carrying the Google-verified address.
    expect(await oauth('discord', { subject: 'discord-other', email: 'multi-google@example.com' })).toEqual({
      error: 'banned',
    });
    const byEmail = await api.emailSignIn('MULTI@example.com');
    expect(byEmail.statusCode).toBe(403);
    expect(byEmail.json()).toMatchObject({ error: 'banned', details: { reason: 'evasion test all' } });

    for (const deviceToken of [main.deviceToken, secondDevice]) {
      const before = await userCount();
      const first = await api.req('POST', '/auth/guest', { body: { deviceToken }, ip: ip() });
      expect(first.statusCode).toBe(403);
      // The retry lands on the same suspended guest instead of creating another.
      const retry = await api.req('POST', '/auth/guest', { body: { deviceToken }, ip: ip() });
      expect(retry.statusCode).toBe(403);
      expect(await userCount()).toBe(before + 1);
    }

    const stranger = await api.req('POST', '/auth/guest', { body: {}, ip: ip() });
    expect(stranger.statusCode).toBe(200);
  });

  it('bans a guest that links an identity of a deleted banned account', async () => {
    const old = await api.account();
    const discord = await oauth('discord', { subject: 'discord-relink' }, old.accessToken);
    expect(discord).toMatchObject({ outcome: 'linked' });
    await banVia(old.id, 'ranked');
    await erase(old.id);

    const fresh = await api.guest();
    expect(await bansOf(fresh.id)).toHaveLength(0);
    const linked = await oauth('discord', { subject: 'discord-relink' }, fresh.accessToken);
    expect(linked).toMatchObject({ outcome: 'linked', userId: fresh.id });
    const applied = await bansOf(fresh.id);
    expect(applied).toEqual([expect.objectContaining({ scope: 'ranked', reason: 'evasion test ranked' })]);
    // Signing in again does not stack a second copy.
    await oauth('discord', { subject: 'discord-relink' });
    expect(await bansOf(fresh.id)).toHaveLength(1);
  });

  it('lets a retained ban lapse at its original expiry', async () => {
    const u = await api.account('temporary@example.com');
    await banVia(u.id, 'all', 2);
    await erase(u.id);
    expect((await api.emailSignIn('temporary@example.com')).statusCode).toBe(403);
    api.clock.advance(3 * 3_600_000);
    expect((await api.emailSignIn('temporary@example.com')).statusCode).toBe(200);
  });

  it('treats lifting a re-applied ban as a pardon for later accounts too', async () => {
    const u = await api.account('pardoned@example.com');
    await banVia(u.id, 'chat');
    await erase(u.id);
    const second = (await api.emailSignIn('pardoned@example.com')).json();
    const [reapplied] = await bansOf(second.user.id);
    expect(reapplied?.evasionOf).toBeTruthy();
    const lift = await api.req('DELETE', `/internal/bans/${reapplied!.id}`, { headers: admin });
    expect(lift.statusCode).toBe(204);

    await erase(second.user.id);
    const third = (await api.emailSignIn('pardoned@example.com')).json();
    expect(await bansOf(third.user.id)).toHaveLength(0);
  });
});

describe('ban cache across instances', () => {
  it('drops cached ban state on every instance sharing the KV', async () => {
    // Shared stores whose close() is a no-op, so each app's close() leaves them for the other.
    class SharedKV extends MemoryKV {
      override async close(): Promise<void> {}
    }
    const kv = new SharedKV();
    const real = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    const database = { ...real, close: async () => undefined };
    const a = await createTestApi(undefined, {}, { kv, database });
    const b = await createTestApi(undefined, {}, { kv, database });
    try {
      const u = await a.guest();
      expect((await b.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(200);
      await a.ban(u.id);
      // B cached "no bans" a moment ago; the invalidation must reach it now, not in 15 s.
      expect((await b.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(403);

      const [row] = await a.ctx.db.select({ id: bans.id }).from(bans).where(eq(bans.userId, u.id));
      expect((await a.req('DELETE', `/internal/bans/${row!.id}`, { headers: admin })).statusCode).toBe(204);
      expect((await b.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(200);
    } finally {
      await a.close();
      await b.close();
      await real.close();
    }
  });
});
