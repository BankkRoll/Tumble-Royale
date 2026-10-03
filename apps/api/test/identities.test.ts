/**
 * Linking, cross-device sign-in outcomes and unlinking: email magic links,
 * Discord OAuth against a stubbed provider, and `DELETE /me/identities/:provider`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { MemoryMailer } from '../src/auth/mailer.ts';
import { loadConfig } from '../src/config.ts';

let built: BuiltApp;
const mailer = new MemoryMailer();
/** Discord user id the stubbed provider reports for the next callback. */
let discordSubject = 'discord-1';

const stubFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/oauth2/token')) return Response.json({ access_token: 'provider-token' });
  if (url.includes('/users/@me'))
    return Response.json({ id: discordSubject, username: 'Pal', verified: false });
  return new Response('not stubbed', { status: 500 });
}) as typeof fetch;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '100000',
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    PUBLIC_WEB_URL: 'https://play.example.com',
  });
  built = await buildApp(config, { mailer, fetch: stubFetch, logger: false });
});
afterAll(async () => {
  await built.close();
});

function req(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  opts: { token?: string; body?: unknown; ip?: string } = {},
) {
  return built.app.inject({
    method,
    url,
    // A fresh address per call keeps the 20/min auth limiter out of the way.
    remoteAddress: opts.ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
}

async function guest(): Promise<{ id: string; token: string }> {
  const j = (await req('POST', '/auth/guest', { body: {} })).json();
  return { id: j.user.id, token: j.accessToken };
}

async function emailLink(address: string, token?: string) {
  expect((await req('POST', '/auth/email/start', { token, body: { email: address } })).statusCode).toBe(202);
  const magic = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;
  return req('POST', '/auth/email/verify', { body: { token: magic } });
}

async function discordFlow(subject: string, token?: string) {
  discordSubject = subject;
  const start = await req('POST', '/auth/discord/start', { token });
  const state = new URL(start.json().url).searchParams.get('state')!;
  const cb = await req('GET', `/auth/discord/callback?code=provider-code&state=${state}`);
  expect(cb.statusCode).toBe(302);
  return new URL(cb.headers.location as string);
}

describe('sign-in outcomes', () => {
  it('links an email to a guest, then reports it as already linked', async () => {
    const u = await guest();
    const first = (await emailLink('one@example.com', u.token)).json();
    expect(first).toMatchObject({ outcome: 'linked', provider: 'email', user: { id: u.id, isGuest: false } });
    const again = (await emailLink('one@example.com', u.token)).json();
    expect(again).toMatchObject({ outcome: 'alreadyLinked', user: { id: u.id } });
  });

  it('switches to the owning account when a guest links an identity someone else has', async () => {
    const owner = await guest();
    await emailLink('owner@example.com', owner.token);
    const other = await guest();
    const res = (await emailLink('owner@example.com', other.token)).json();
    expect(res).toMatchObject({ outcome: 'switched', user: { id: owner.id } });
  });

  it('signs in without a session, or creates an account for an unknown identity', async () => {
    const owner = await guest();
    await emailLink('signin@example.com', owner.token);
    expect((await emailLink('signin@example.com')).json()).toMatchObject({
      outcome: 'signedIn',
      user: { id: owner.id },
    });
    const fresh = (await emailLink('nobody@example.com')).json();
    expect(fresh.outcome).toBe('created');
    expect(fresh.user.id).not.toBe(owner.id);
  });

  it('returns to /auth/complete with the provider and a one-time code carrying the outcome', async () => {
    const u = await guest();
    const back = await discordFlow('discord-link', u.token);
    expect(back.origin + back.pathname).toBe('https://play.example.com/auth/complete');
    expect(back.searchParams.get('provider')).toBe('discord');
    const code = back.searchParams.get('code')!;
    const ex = await req('POST', '/auth/exchange', { body: { code } });
    expect(ex.json()).toMatchObject({ outcome: 'linked', provider: 'discord', user: { id: u.id } });
    expect((await req('POST', '/auth/exchange', { body: { code } })).statusCode).toBe(400);

    const other = await guest();
    const code2 = (await discordFlow('discord-link', other.token)).searchParams.get('code')!;
    expect((await req('POST', '/auth/exchange', { body: { code: code2 } })).json()).toMatchObject({
      outcome: 'switched',
      user: { id: u.id },
    });
  });

  it('names the provider on errors such as a cancelled consent screen', async () => {
    const cb = await req('GET', '/auth/discord/callback?error=access_denied');
    const back = new URL(cb.headers.location as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('provider')).toBe('discord');
  });
});

describe('unlinking', () => {
  it('refuses to remove the last portable sign-in method', async () => {
    const u = await guest();
    await emailLink('solo@example.com', u.token);
    const res = await req('DELETE', '/me/identities/email', { token: u.token });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_login_method');
  });

  it('removes one method while another remains, and the address stops finding the account', async () => {
    const u = await guest();
    await emailLink('two@example.com', u.token);
    const code = (await discordFlow('discord-two', u.token)).searchParams.get('code')!;
    await req('POST', '/auth/exchange', { body: { code } });
    expect((await req('GET', '/me', { token: u.token })).json().linkedProviders).toEqual(
      expect.arrayContaining(['device', 'email', 'discord']),
    );

    const res = await req('DELETE', '/me/identities/email', { token: u.token });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkedProviders).toEqual(['discord']);
    const me = (await req('GET', '/me', { token: u.token })).json();
    expect(me.linkedProviders).not.toContain('email');
    expect(me.email).toBeNull();
    expect((await emailLink('two@example.com')).json().user.id).not.toBe(u.id);

    expect((await req('DELETE', '/me/identities/discord', { token: u.token })).statusCode).toBe(409);
  });

  it('404s for a method that is not linked and rejects unknown providers', async () => {
    const u = await guest();
    expect((await req('DELETE', '/me/identities/google', { token: u.token })).statusCode).toBe(404);
    expect((await req('DELETE', '/me/identities/device', { token: u.token })).statusCode).toBe(400);
    expect((await req('DELETE', '/me/identities/google')).statusCode).toBe(401);
  });
});

describe('rename availability', () => {
  it('reports when the next rename is allowed', async () => {
    const u = await guest();
    expect((await req('GET', '/me', { token: u.token })).json().nameChangeAvailableAt).toBeNull();
    expect(
      (await req('PATCH', '/me', { token: u.token, body: { displayName: 'Fresh Name' } })).statusCode,
    ).toBe(200);
    const at = (await req('GET', '/me', { token: u.token })).json().nameChangeAvailableAt as string;
    expect(Date.parse(at) - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });
});
