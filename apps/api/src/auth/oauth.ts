/**
 * OAuth 2.0 authorization-code + PKCE for Discord and Google.
 *
 * Flow:
 * 1. `start` creates a random `state` and PKCE verifier, stores them in KV for
 *    10 minutes (plus the user id when a signed-in guest is upgrading) and
 *    returns the provider's authorize URL.
 * 2. The provider redirects to `/auth/<provider>/callback?code&state`.
 * 3. `complete` consumes the state (one-time), exchanges the code with the
 *    verifier, fetches the provider profile and returns a normalised identity.
 */
import { createHash } from 'node:crypto';
import type { ApiConfig, OAuthClientConfig } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { KV } from '../kv/index.ts';
import { randomToken } from './tokens.ts';

/** Supported OAuth providers. */
export type OAuthProviderId = 'discord' | 'google';

interface ProviderSpec {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  envHint: string;
  /** Extracts subject/email/name from the provider's user payload. */
  profile(json: Record<string, unknown>): { subject: string; email: string | null; name: string | null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const PROVIDERS: Record<OAuthProviderId, ProviderSpec> = {
  discord: {
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userUrl: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    envHint: 'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET',
    profile: (j) => ({
      subject: String(j.id ?? ''),
      // Discord only vouches for the address when `verified` is true.
      email: j.verified === true ? str(j.email) : null,
      name: str(j.global_name) ?? str(j.username),
    }),
  },
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    envHint: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    profile: (j) => ({
      subject: String(j.sub ?? ''),
      email: j.email_verified === true ? str(j.email) : null,
      name: str(j.given_name) ?? str(j.name),
    }),
  },
};

/** What `start` remembers until the callback. */
interface OAuthState {
  provider: OAuthProviderId;
  verifier: string;
  /** Signed-in user upgrading a guest account, if any. */
  linkUserId: string | null;
}

/** Normalised identity returned by a completed flow. */
export interface OAuthIdentity {
  provider: OAuthProviderId;
  subject: string;
  email: string | null;
  name: string | null;
  linkUserId: string | null;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function clientFor(config: ApiConfig, provider: OAuthProviderId): OAuthClientConfig {
  const client = config[provider];
  if (!client) {
    throw new ApiError(
      503,
      'provider_disabled',
      `${PROVIDERS[provider].label} sign-in is not configured on this server (set ${PROVIDERS[provider].envHint})`,
    );
  }
  return client;
}

/** Redirect URI registered with the provider. */
export function redirectUri(config: ApiConfig, provider: OAuthProviderId): string {
  return `${config.publicApiUrl}/auth/${provider}/callback`;
}

/**
 * Begins an OAuth flow.
 *
 * @returns The provider authorize URL to send the browser to.
 * @throws {ApiError} 503 `provider_disabled` when credentials are missing.
 */
export async function startOAuth(
  config: ApiConfig,
  kv: KV,
  provider: OAuthProviderId,
  linkUserId: string | null,
): Promise<string> {
  const client = clientFor(config, provider);
  const spec = PROVIDERS[provider];
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const saved: OAuthState = { provider, verifier, linkUserId };
  await kv.set(`oauth:${state}`, JSON.stringify(saved), STATE_TTL_MS);
  const url = new URL(spec.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri(config, provider),
    scope: spec.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: provider === 'google' ? 'select_account' : 'consent',
  }).toString();
  return url.toString();
}

/**
 * Finishes an OAuth flow from the callback query.
 *
 * @throws {ApiError} 400 `invalid_state` / `oauth_failed`, 503 when disabled.
 */
export async function completeOAuth(
  config: ApiConfig,
  kv: KV,
  http: typeof fetch,
  provider: OAuthProviderId,
  code: string,
  state: string,
): Promise<OAuthIdentity> {
  const client = clientFor(config, provider);
  const raw = await kv.getDel(`oauth:${state}`);
  if (!raw) throw new ApiError(400, 'invalid_state', 'Sign-in link expired; please try again');
  const saved = JSON.parse(raw) as OAuthState;
  if (saved.provider !== provider) throw new ApiError(400, 'invalid_state', 'State does not match provider');
  const spec = PROVIDERS[provider];

  const tokenRes = await http(spec.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(config, provider),
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: saved.verifier,
    }),
  });
  if (!tokenRes.ok) throw new ApiError(400, 'oauth_failed', `${spec.label} rejected the sign-in (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: unknown };
  if (typeof token.access_token !== 'string') throw new ApiError(400, 'oauth_failed', `${spec.label} returned no access token`);

  const userRes = await http(spec.userUrl, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!userRes.ok) throw new ApiError(400, 'oauth_failed', `Could not read ${spec.label} profile (${userRes.status})`);
  const profile = spec.profile((await userRes.json()) as Record<string, unknown>);
  if (!profile.subject) throw new ApiError(400, 'oauth_failed', `${spec.label} profile had no id`);
  return { provider, ...profile, linkUserId: saved.linkUserId };
}
