/**
 * OAuth 2.0 / OpenID Connect sign-in for Discord, Google, GitHub, Twitch and
 * Apple, all through the authorization-code flow.
 *
 * Flow:
 * 1. `start` creates a random `state` (plus a PKCE verifier where the provider
 *    supports PKCE, and a `nonce` for Apple's ID token), stores them in KV for
 *    10 minutes with the signed-in user id and intent when linking, and
 *    returns the provider's authorize URL.
 * 2. The provider returns to `/auth/<provider>/callback` with `code` and
 *    `state`: a GET query, or for Apple a cross-site form POST.
 * 3. `complete` consumes the state (one-time), exchanges the code, reads the
 *    provider's profile and returns a normalised identity.
 *
 * The provider's stable user id is the identity key. An email address is only
 * returned when the provider says it verified it, because a verified address
 * may sign in to (and link onto) the account that already uses it.
 */
import { createHash } from 'node:crypto';
import { createLocalJWKSet, importPKCS8, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import type { ApiConfig, AppleClientConfig, OAuthClientConfig } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { KV } from '../kv/index.ts';
import { randomToken } from './tokens.ts';

/** Supported OAuth providers, in display order. */
export const OAUTH_PROVIDERS = ['discord', 'google', 'github', 'twitch', 'apple'] as const;

/** A supported OAuth provider. */
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

/**
 * Why a signed-in player started a flow:
 * - `link`: add this login to the current account; a login another account
 *   owns is refused (`identity_in_use`);
 * - `signIn`: sign in, switching to the account that owns the login if it is
 *   not this one (a guest's way back to its Tumbler on a new device).
 */
export type OAuthIntent = 'link' | 'signIn';

/** What a provider tells us about the person. */
interface ProviderProfile {
  subject: string;
  /** Only an address the provider verified; null otherwise. */
  email: string | null;
  name: string | null;
}

/** Inputs to a provider's profile lookup after the code exchange. */
interface IdentifyInput {
  http: typeof fetch;
  token: Record<string, unknown>;
  clientId: string;
  saved: OAuthState;
  /** Apple's first-sign-in `user` form field (JSON), when present. */
  appleUser: string | undefined;
}

interface ProviderSpec {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  envHint: string;
  /** Send a PKCE S256 challenge (only where the provider documents support). */
  pkce: boolean;
  /** Extra authorize parameters. */
  authorizeParams?: Record<string, string>;
  identify(input: IdentifyInput): Promise<ProviderProfile>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Some providers send JSON booleans, Apple sometimes the strings "true"/"false". */
const truthy = (v: unknown): boolean => v === true || v === 'true';

async function getJson(
  http: typeof fetch,
  label: string,
  url: string,
  accessToken: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await http(url, { headers: { authorization: `Bearer ${accessToken}`, ...headers } });
  if (!res.ok) throw new ApiError(400, 'oauth_failed', `Could not read ${label} profile (${res.status})`);
  return res.json();
}

function accessTokenOf(label: string, token: Record<string, unknown>): string {
  if (typeof token.access_token !== 'string')
    throw new ApiError(400, 'oauth_failed', `${label} returned no access token`);
  return token.access_token;
}

/** GitHub's REST API refuses requests without a User-Agent. */
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'TumbleRoyale',
  'x-github-api-version': '2022-11-28',
};

const APPLE_ISSUER = 'https://appleid.apple.com';

const PROVIDERS: Record<OAuthProviderId, ProviderSpec> = {
  discord: {
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scope: 'identify email',
    envHint: 'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET',
    pkce: true,
    authorizeParams: { prompt: 'consent' },
    async identify({ http, token }) {
      const j = (await getJson(
        http,
        'Discord',
        'https://discord.com/api/users/@me',
        accessTokenOf('Discord', token),
      )) as Record<string, unknown>;
      return {
        subject: String(j.id ?? ''),
        // Discord only vouches for the address when `verified` is true.
        email: j.verified === true ? str(j.email) : null,
        name: str(j.global_name) ?? str(j.username),
      };
    },
  },
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    envHint: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    pkce: true,
    authorizeParams: { prompt: 'select_account' },
    async identify({ http, token }) {
      const j = (await getJson(
        http,
        'Google',
        'https://openidconnect.googleapis.com/v1/userinfo',
        accessTokenOf('Google', token),
      )) as Record<string, unknown>;
      return {
        subject: String(j.sub ?? ''),
        email: j.email_verified === true ? str(j.email) : null,
        name: str(j.given_name) ?? str(j.name),
      };
    },
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    envHint: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET',
    pkce: true,
    authorizeParams: { allow_signup: 'true' },
    async identify({ http, token }) {
      const access = accessTokenOf('GitHub', token);
      const user = (await getJson(
        http,
        'GitHub',
        'https://api.github.com/user',
        access,
        GITHUB_HEADERS,
      )) as Record<string, unknown>;
      // The public profile email may be unverified or absent; only the
      // primary address GitHub marks verified counts.
      const emails = await getJson(http, 'GitHub', 'https://api.github.com/user/emails', access, GITHUB_HEADERS);
      const primary = Array.isArray(emails)
        ? (emails as Record<string, unknown>[]).find((e) => e.primary === true && e.verified === true)
        : undefined;
      return {
        subject: typeof user.id === 'number' || typeof user.id === 'string' ? String(user.id) : '',
        email: primary ? str(primary.email) : null,
        name: str(user.name) ?? str(user.login),
      };
    },
  },
  twitch: {
    label: 'Twitch',
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'openid user:read:email',
    envHint: 'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET',
    // NOTE: Twitch does not document PKCE; `state` alone binds the callback.
    pkce: false,
    authorizeParams: {
      claims: JSON.stringify({ userinfo: { email: null, email_verified: null, preferred_username: null } }),
      force_verify: 'true',
    },
    async identify({ http, token }) {
      const j = (await getJson(
        http,
        'Twitch',
        'https://id.twitch.tv/oauth2/userinfo',
        accessTokenOf('Twitch', token),
      )) as Record<string, unknown>;
      return {
        subject: String(j.sub ?? ''),
        email: truthy(j.email_verified) ? str(j.email) : null,
        name: str(j.preferred_username),
      };
    },
  },
  apple: {
    label: 'Apple',
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    envHint: 'APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY',
    // NOTE: Apple does not document PKCE; the ID token's nonce binds the flow.
    pkce: false,
    // Apple only returns the requested name/email scopes to a form POST.
    authorizeParams: { response_mode: 'form_post' },
    async identify({ http, token, clientId, saved, appleUser }) {
      const idToken = str(token.id_token);
      if (!idToken) throw new ApiError(400, 'oauth_failed', 'Apple returned no ID token');
      const keysRes = await http('https://appleid.apple.com/auth/keys');
      if (!keysRes.ok) throw new ApiError(400, 'oauth_failed', `Could not read Apple keys (${keysRes.status})`);
      const jwks = createLocalJWKSet((await keysRes.json()) as JSONWebKeySet);
      let claims: Record<string, unknown>;
      try {
        // SECURITY: the token came straight from Apple over TLS, but checking
        // signature, issuer, audience and nonce also rejects a token minted
        // for another app or replayed from another sign-in.
        ({ payload: claims } = await jwtVerify(idToken, jwks, {
          issuer: APPLE_ISSUER,
          audience: clientId,
          algorithms: ['RS256'],
        }));
      } catch {
        throw new ApiError(400, 'oauth_failed', 'Apple ID token did not verify');
      }
      if (!saved.nonce || claims.nonce !== saved.nonce)
        throw new ApiError(400, 'invalid_state', 'Apple ID token nonce does not match');
      return {
        subject: str(claims.sub) ?? '',
        email: truthy(claims.email_verified) ? str(claims.email) : null,
        name: appleName(appleUser),
      };
    },
  },
};

/**
 * Apple sends the person's name only on their very first authorization, as a
 * JSON `user` form field next to the code. It is not signed, so it is used
 * only as a display-name suggestion, never as identity.
 */
function appleName(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    return str(user.name?.firstName) ?? str(user.name?.lastName);
  } catch {
    return null;
  }
}

/** What `start` remembers until the callback. */
interface OAuthState {
  provider: OAuthProviderId;
  /** PKCE verifier; null for providers without PKCE. */
  verifier: string | null;
  /** Expected ID token nonce (Apple). */
  nonce: string | null;
  /** Signed-in user linking or switching, if any. */
  linkUserId: string | null;
  intent: OAuthIntent;
}

/** Normalised identity returned by a completed flow. */
export interface OAuthIdentity {
  provider: OAuthProviderId;
  subject: string;
  email: string | null;
  name: string | null;
  linkUserId: string | null;
  intent: OAuthIntent;
}

const STATE_TTL_MS = 10 * 60 * 1000;
/** Apple accepts client secrets valid for up to six months; a short one limits a leak. */
const APPLE_SECRET_TTL_SEC = 5 * 60;

/** Display name of a provider. */
export function providerLabel(provider: OAuthProviderId): string {
  return PROVIDERS[provider].label;
}

/**
 * Whether a provider has credentials on this server.
 *
 * @param config - API configuration.
 * @param provider - Provider to check.
 */
export function providerEnabled(config: ApiConfig, provider: OAuthProviderId): boolean {
  return config[provider] !== undefined;
}

function disabled(provider: OAuthProviderId): ApiError {
  const spec = PROVIDERS[provider];
  return new ApiError(
    503,
    'provider_disabled',
    `${spec.label} sign-in is not configured on this server (set ${spec.envHint})`,
  );
}

function clientIdFor(config: ApiConfig, provider: OAuthProviderId): string {
  const client = config[provider];
  if (!client) throw disabled(provider);
  return client.clientId;
}

/**
 * The client secret Apple expects: an ES256 JWT from the team, about the
 * Services ID, signed with the Sign in with Apple key.
 *
 * @param apple - Apple credentials.
 * @param nowSec - Issued-at in seconds.
 * @returns A compact JWT.
 */
export async function appleClientSecret(apple: AppleClientConfig, nowSec: number): Promise<string> {
  const key = await importPKCS8(apple.privateKey, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setSubject(apple.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + APPLE_SECRET_TTL_SEC)
    .sign(key);
}

async function clientSecretFor(config: ApiConfig, provider: OAuthProviderId, now: Date): Promise<string> {
  if (provider === 'apple') {
    if (!config.apple) throw disabled(provider);
    return appleClientSecret(config.apple, Math.floor(now.getTime() / 1000));
  }
  const client: OAuthClientConfig | undefined = config[provider];
  if (!client) throw disabled(provider);
  return client.clientSecret;
}

/**
 * Redirect URI registered with the provider.
 *
 * @param config - API configuration.
 * @param provider - Provider.
 * @returns `<PUBLIC_API_URL>/auth/<provider>/callback`.
 */
export function redirectUri(config: ApiConfig, provider: OAuthProviderId): string {
  return `${config.publicApiUrl}/auth/${provider}/callback`;
}

/**
 * Begins an OAuth flow.
 *
 * @param config - API configuration.
 * @param kv - Where the one-time state lives.
 * @param provider - Provider to sign in with.
 * @param linkUserId - The signed-in account, when linking or switching from one.
 * @param intent - What a signed-in player asked for (ignored without `linkUserId`).
 * @returns The provider authorize URL to send the browser to.
 * @throws {ApiError} 503 `provider_disabled` when credentials are missing.
 */
export async function startOAuth(
  config: ApiConfig,
  kv: KV,
  provider: OAuthProviderId,
  linkUserId: string | null,
  intent: OAuthIntent = 'signIn',
): Promise<string> {
  const clientId = clientIdFor(config, provider);
  const spec = PROVIDERS[provider];
  const state = randomToken(24);
  const verifier = spec.pkce ? randomToken(48) : null;
  const nonce = provider === 'apple' ? randomToken(24) : null;
  const saved: OAuthState = { provider, verifier, nonce, linkUserId, intent };
  await kv.set(`oauth:${state}`, JSON.stringify(saved), STATE_TTL_MS);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(config, provider),
    scope: spec.scope,
    state,
    ...spec.authorizeParams,
  });
  if (verifier) {
    params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    params.set('code_challenge_method', 'S256');
  }
  if (nonce) params.set('nonce', nonce);
  const url = new URL(spec.authorizeUrl);
  url.search = params.toString();
  return url.toString();
}

/**
 * Finishes an OAuth flow from the callback.
 *
 * @param config - API configuration.
 * @param kv - Where `start` stored the state.
 * @param http - `fetch` (tests inject a stub).
 * @param provider - Provider in the callback path.
 * @param code - Authorization code.
 * @param state - The state `start` issued; consumed here, so a replay fails.
 * @param now - Clock, for Apple's client secret.
 * @param appleUser - Apple's first-sign-in `user` form field.
 * @returns The provider identity and the stored linking context.
 * @throws {ApiError} 400 `invalid_state` / `oauth_failed`, 503 when disabled.
 */
export async function completeOAuth(
  config: ApiConfig,
  kv: KV,
  http: typeof fetch,
  provider: OAuthProviderId,
  code: string,
  state: string,
  now: Date = new Date(),
  appleUser?: string,
): Promise<OAuthIdentity> {
  const clientId = clientIdFor(config, provider);
  const raw = await kv.getDel(`oauth:${state}`);
  if (!raw) throw new ApiError(400, 'invalid_state', 'Sign-in link expired; please try again');
  const saved = JSON.parse(raw) as OAuthState;
  if (saved.provider !== provider) throw new ApiError(400, 'invalid_state', 'State does not match provider');
  const spec = PROVIDERS[provider];

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(config, provider),
    client_id: clientId,
    client_secret: await clientSecretFor(config, provider, now),
  });
  if (saved.verifier) body.set('code_verifier', saved.verifier);
  const tokenRes = await http(spec.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!tokenRes.ok)
    throw new ApiError(400, 'oauth_failed', `${spec.label} rejected the sign-in (${tokenRes.status})`);
  const token = (await tokenRes.json()) as Record<string, unknown>;
  // GitHub answers a bad code with 200 and an `error` field.
  if (typeof token.error === 'string')
    throw new ApiError(400, 'oauth_failed', `${spec.label} rejected the sign-in (${token.error})`);

  const profile = await spec.identify({ http, token, clientId, saved, appleUser });
  if (!profile.subject) throw new ApiError(400, 'oauth_failed', `${spec.label} profile had no id`);
  return { provider, ...profile, linkUserId: saved.linkUserId, intent: saved.intent ?? 'signIn' };
}
