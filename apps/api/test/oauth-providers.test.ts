/**
 * Every OAuth provider (Discord, Google, GitHub, Twitch, Apple) against a
 * stubbed provider: the authorize URL, account creation and sign-in, state
 * replay and mismatch, verified versus unverified email, linking conflicts and
 * removing the last sign-in method. Apple also checks the ES256 client secret,
 * the ID token signature, audience and nonce, and the first-sign-in name.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { exportJWK, jwtVerify, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { MemoryMailer } from '../src/auth/mailer.ts';
import { OAUTH_PROVIDERS, type OAuthProviderId } from '../src/auth/oauth.ts';
import { loadConfig } from '../src/config.ts';
import { testEnv } from './helpers.ts';

/** What the stubbed provider says about the person signing in. */
interface FakePerson {
  sub: string;
  email?: string;
  verified?: boolean;
  name?: string;
}

const appleSigning = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const appleIdTokenKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APPLE_KID = 'apple-test-kid';
const APPLE_CLIENT_ID = 'com.example.tumble.web';

let person: FakePerson = { sub: 'x' };
/** Nonce the stubbed Apple puts in its ID token (normally echoed from the authorize URL). */
let appleNonce = '';
let appleAudience = APPLE_CLIENT_ID;
/** Next token response override (GitHub reports a bad code with HTTP 200). */
let tokenOverride: Record<string, unknown> | null = null;
const tokenRequests: { url: string; body: URLSearchParams }[] = [];
const TOKEN_URLS = [
  'https://discord.com/api/oauth2/token',
  'https://oauth2.googleapis.com/token',
  'https://github.com/login/oauth/access_token',
  'https://id.twitch.tv/oauth2/token',
  'https://appleid.apple.com/auth/token',
];

async function appleIdToken(): Promise<string> {
  return new SignJWT({
    email: person.email,
    // Apple sends these as strings.
    email_verified: person.verified ? 'true' : 'false',
    nonce: appleNonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: APPLE_KID })
    .setIssuer('https://appleid.apple.com')
    .setAudience(appleAudience)
    .setSubject(person.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(appleIdTokenKeys.privateKey);
}

const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const p = person;
  if (TOKEN_URLS.includes(url)) {
    tokenRequests.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
    if (tokenOverride) {
      const t = tokenOverride;
      tokenOverride = null;
      return Response.json(t);
    }
    if (url.startsWith('https://appleid.apple.com'))
      return Response.json({ access_token: 'apple-at', id_token: await appleIdToken() });
    return Response.json({ access_token: 'provider-token', token_type: 'bearer' });
  }
  switch (url) {
    case 'https://discord.com/api/users/@me':
      return Response.json({ id: p.sub, username: p.name, email: p.email, verified: p.verified === true });
    case 'https://openidconnect.googleapis.com/v1/userinfo':
      return Response.json({ sub: p.sub, given_name: p.name, email: p.email, email_verified: p.verified });
    case 'https://api.github.com/user':
      return Response.json({ id: Number(p.sub.replace(/\D/g, '')) || 7, login: p.name ?? 'octo', name: null });
    case 'https://api.github.com/user/emails':
      return Response.json(
        p.email
          ? [
              { email: 'secondary@example.com', primary: false, verified: true },
              { email: p.email, primary: true, verified: p.verified === true },
            ]
          : [],
      );
    case 'https://id.twitch.tv/oauth2/userinfo':
      return Response.json({
        sub: p.sub,
        preferred_username: p.name,
        email: p.email,
        email_verified: p.verified === true,
      });
    case 'https://appleid.apple.com/auth/keys':
      return Response.json({
        keys: [{ ...(await exportJWK(appleIdTokenKeys.publicKey)), kid: APPLE_KID, alg: 'RS256', use: 'sig' }],
      });
    default:
      return new Response(`not stubbed: ${url}`, { status: 500 });
  }
}) as typeof fetch;

let built: BuiltApp;
const mailer = new MemoryMailer();

function pem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}

beforeAll(async () => {
  const config = loadConfig(
    testEnv({
      RATE_LIMIT_MAX: '100000',
      PUBLIC_WEB_URL: 'https://play.example.com',
      PUBLIC_API_URL: 'https://play.example.com/api',
      DISCORD_CLIENT_ID: 'discord-id',
      DISCORD_CLIENT_SECRET: 'discord-secret',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      TWITCH_CLIENT_ID: 'twitch-id',
      TWITCH_CLIENT_SECRET: 'twitch-secret',
      APPLE_CLIENT_ID,
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      // One line with \n escapes, as it would sit in a .env file.
      APPLE_PRIVATE_KEY: pem(appleSigning.privateKey).trim().replace(/\n/g, '\\n'),
    }),
  );
  built = await buildApp(config, { mailer, fetch: stubFetch, logger: false });
});
afterAll(async () => {
  await built.close();
});

const freshIp = () => `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

function req(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { token?: string; body?: unknown; form?: Record<string, string> } = {},
) {
  return built.app.inject({
    method,
    url,
    remoteAddress: freshIp(),
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
  });
}

async function guest(): Promise<{ id: string; token: string }> {
  const j = (await req('POST', '/auth/guest', { body: {} })).json();
  return { id: j.user.id, token: j.accessToken };
}

async function emailAccount(address: string): Promise<{ id: string; token: string }> {
  expect((await req('POST', '/auth/email/start', { body: { email: address } })).statusCode).toBe(202);
  const magic = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;
  const j = (await req('POST', '/auth/email/verify', { body: { token: magic } })).json();
  return { id: j.user.id, token: j.accessToken };
}

/** Starts a flow and returns the authorize URL and its state. */
async function start(provider: OAuthProviderId, opts: { token?: string; intent?: 'link' | 'signIn' } = {}) {
  const res = await req('POST', `/auth/${provider}/start`, {
    token: opts.token,
    ...(opts.intent ? { body: { intent: opts.intent } } : {}),
  });
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().url);
  return { url, state: url.searchParams.get('state')! };
}

/** Delivers the provider's redirect back to the API; returns where the API sends the browser. */
async function callback(
  provider: OAuthProviderId,
  params: { code?: string; state?: string; error?: string; user?: string },
): Promise<URL> {
  const res =
    provider === 'apple'
      ? await req('POST', '/auth/apple/callback', {
          form: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<
            string,
            string
          >,
        })
      : await req('GET', `/auth/${provider}/callback?${new URLSearchParams(params as Record<string, string>)}`);
  expect(res.statusCode).toBe(302);
  return new URL(res.headers.location as string);
}

/** A whole sign-in as `who`; returns the exchanged result or the error code. */
async function signIn(
  provider: OAuthProviderId,
  who: FakePerson,
  opts: { token?: string; intent?: 'link' | 'signIn'; appleUser?: string } = {},
) {
  person = who;
  const { url, state } = await start(provider, opts);
  appleNonce = url.searchParams.get('nonce') ?? '';
  const back = await callback(provider, {
    code: 'provider-code',
    state,
    ...(opts.appleUser ? { user: opts.appleUser } : {}),
  });
  const error = back.searchParams.get('error');
  if (error) return { error, back };
  const ex = await req('POST', '/auth/exchange', { body: { code: back.searchParams.get('code') } });
  expect(ex.statusCode).toBe(200);
  return { result: ex.json(), back };
}

let seq = 0;
const unique = (provider: string) => `${provider}-${++seq}-${Math.floor(Math.random() * 1e9)}`;

describe('GET /auth/providers', () => {
  it('reports every configured provider so the client shows exactly those', async () => {
    const res = await req('GET', '/auth/providers');
    expect(res.json()).toMatchObject({
      discord: true,
      google: true,
      github: true,
      twitch: true,
      apple: true,
      guest: true,
    });
  });
});

describe('authorize URLs', () => {
  it('use the strict redirect URI, PKCE where supported and a nonce with form_post for Apple', async () => {
    const pkce: Record<OAuthProviderId, boolean> = {
      discord: true,
      google: true,
      github: true,
      twitch: false,
      apple: false,
    };
    for (const provider of OAUTH_PROVIDERS) {
      const { url } = await start(provider);
      expect(url.searchParams.get('redirect_uri')).toBe(`https://play.example.com/api/auth/${provider}/callback`);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{32}$/);
      expect(url.searchParams.get('code_challenge_method') === 'S256').toBe(pkce[provider]);
    }
    const apple = (await start('apple')).url;
    expect(apple.origin).toBe('https://appleid.apple.com');
    expect(apple.searchParams.get('response_mode')).toBe('form_post');
    expect(apple.searchParams.get('nonce')).toMatch(/^[\w-]{32}$/);
    const twitch = (await start('twitch')).url;
    expect(JSON.parse(twitch.searchParams.get('claims')!).userinfo).toHaveProperty('email_verified');
  });
});

describe.each(OAUTH_PROVIDERS)('%s', (provider) => {
  it('creates an account on first sign-in and signs the same account in again', async () => {
    const sub = unique(provider);
    const first = await signIn(provider, { sub, name: 'Pal' });
    expect(first.result).toMatchObject({ outcome: 'created', provider, user: { isGuest: false } });
    expect(first.back.origin + first.back.pathname).toBe('https://play.example.com/auth/complete');
    expect(first.back.searchParams.get('provider')).toBe(provider);
    const again = await signIn(provider, { sub });
    expect(again.result).toMatchObject({ outcome: 'signedIn', user: { id: first.result.user.id } });
  });

  it('sends the PKCE verifier only to providers that took a challenge', async () => {
    tokenRequests.length = 0;
    await signIn(provider, { sub: unique(provider) });
    const body = tokenRequests.at(-1)!.body;
    expect(body.get('redirect_uri')).toBe(`https://play.example.com/api/auth/${provider}/callback`);
    expect(body.has('code_verifier')).toBe(provider !== 'twitch' && provider !== 'apple');
  });

  it('refuses an unknown state, a replayed state and a state from another provider', async () => {
    person = { sub: unique(provider) };
    expect((await callback(provider, { code: 'c', state: 'not-a-real-state' })).searchParams.get('error')).toBe(
      'invalid_state',
    );
    const { url, state } = await start(provider);
    appleNonce = url.searchParams.get('nonce') ?? '';
    expect((await callback(provider, { code: 'c', state })).searchParams.get('code')).toBeTruthy();
    expect((await callback(provider, { code: 'c', state })).searchParams.get('error')).toBe('invalid_state');
    const other = provider === 'discord' ? 'google' : 'discord';
    const foreign = await start(other);
    expect((await callback(provider, { code: 'c', state: foreign.state })).searchParams.get('error')).toBe(
      'invalid_state',
    );
  });

  it('reports a cancelled consent screen and a missing code', async () => {
    const denied = provider === 'apple' ? 'user_cancelled_authorize' : 'access_denied';
    expect((await callback(provider, { error: denied })).searchParams.get('error')).toBe('access_denied');
    expect((await callback(provider, { state: 'x' })).searchParams.get('error')).toBe('missing_code');
  });

  it('never signs in to an account through an unverified email', async () => {
    const address = `${unique(provider)}@example.com`;
    const owner = await emailAccount(address);
    const res = await signIn(provider, { sub: unique(provider), email: address, verified: false });
    expect(res.result.outcome).toBe('created');
    expect(res.result.user.id).not.toBe(owner.id);
  });

  it('links a verified email to the account that already uses it', async () => {
    const address = `${unique(provider)}@example.com`;
    const owner = await emailAccount(address);
    const res = await signIn(provider, { sub: unique(provider), email: address, verified: true });
    expect(res.result).toMatchObject({ outcome: 'signedIn', user: { id: owner.id } });
    const me = (await req('GET', '/me', { token: res.result.accessToken })).json();
    expect(me.linkedProviders).toEqual(expect.arrayContaining(['email', provider]));
  });

  it('links to a guest, refuses "connect" when another account owns the login, and switches on sign-in', async () => {
    const sub = unique(provider);
    const a = await guest();
    expect((await signIn(provider, { sub }, { token: a.token, intent: 'link' })).result).toMatchObject({
      outcome: 'linked',
      user: { id: a.id, isGuest: false },
    });
    const b = await emailAccount(`${unique(provider)}@example.com`);
    const conflict = await signIn(provider, { sub }, { token: b.token, intent: 'link' });
    expect(conflict.error).toBe('identity_in_use');
    const meB = (await req('GET', '/me', { token: b.token })).json();
    expect(meB.linkedProviders).not.toContain(provider);
    const switched = await signIn(provider, { sub }, { token: (await guest()).token, intent: 'signIn' });
    expect(switched.result).toMatchObject({ outcome: 'switched', user: { id: a.id } });
  });

  it('refuses to disconnect the last way to sign in, and allows it once another is linked', async () => {
    const res = await signIn(provider, { sub: unique(provider) });
    const token = res.result.accessToken as string;
    const last = await req('DELETE', `/me/identities/${provider}`, { token });
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe('last_login_method');
    const other: OAuthProviderId = provider === 'github' ? 'twitch' : 'github';
    await signIn(other, { sub: unique(other) }, { token, intent: 'link' });
    const ok = await req('DELETE', `/me/identities/${provider}`, { token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().linkedProviders).toEqual([other]);
  });
});

describe('provider specifics', () => {
  it('GitHub: an error in a 200 token response fails the sign-in', async () => {
    tokenOverride = { error: 'bad_verification_code' };
    expect((await signIn('github', { sub: unique('github') })).error).toBe('oauth_failed');
  });

  it('GitHub: only the verified primary address counts', async () => {
    const address = `${unique('gh')}@example.com`;
    const owner = await emailAccount(address);
    // The verified secondary address must not be used either.
    const res = await signIn('github', { sub: unique('github'), email: address, verified: false });
    expect(res.result.user.id).not.toBe(owner.id);
  });

  it('Apple: signs the client secret with the .p8 key for the team and Services ID', async () => {
    tokenRequests.length = 0;
    await signIn('apple', { sub: unique('apple') });
    const secret = tokenRequests.at(-1)!.body.get('client_secret')!;
    const { payload, protectedHeader } = await jwtVerify(secret, appleSigning.publicKey, {
      issuer: 'TEAM123456',
      audience: 'https://appleid.apple.com',
      subject: APPLE_CLIENT_ID,
    });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
  });

  it('Apple: uses the name sent on the first authorization only as a display-name suggestion', async () => {
    const res = await signIn(
      'apple',
      { sub: unique('apple') },
      { appleUser: JSON.stringify({ name: { firstName: 'Ada', lastName: 'L' }, email: 'spoof@example.com' }) },
    );
    expect(res.result).toMatchObject({ outcome: 'created', user: { displayName: 'Ada' } });
  });

  it('Apple: rejects an ID token with the wrong nonce or audience', async () => {
    person = { sub: unique('apple') };
    const { state } = await start('apple');
    appleNonce = 'someone-elses-nonce';
    expect((await callback('apple', { code: 'c', state })).searchParams.get('error')).toBe('invalid_state');

    const second = await start('apple');
    appleNonce = second.url.searchParams.get('nonce')!;
    appleAudience = 'com.attacker.app';
    try {
      expect((await callback('apple', { code: 'c', state: second.state })).searchParams.get('error')).toBe(
        'oauth_failed',
      );
    } finally {
      appleAudience = APPLE_CLIENT_ID;
    }
  });
});

describe('disabled providers', () => {
  it('answer 503 provider_disabled', async () => {
    const config = loadConfig(testEnv({ RATE_LIMIT_MAX: '100000' }));
    const bare = await buildApp(config, { mailer: new MemoryMailer(), fetch: stubFetch, logger: false });
    try {
      for (const provider of OAUTH_PROVIDERS) {
        const res = await bare.app.inject({ method: 'POST', url: `/auth/${provider}/start` });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('provider_disabled');
      }
      const listed = (await bare.app.inject({ method: 'GET', url: '/auth/providers' })).json();
      for (const provider of OAUTH_PROVIDERS) expect(listed[provider]).toBe(false);
    } finally {
      await bare.close();
    }
  });
});
