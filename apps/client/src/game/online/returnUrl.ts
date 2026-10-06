/**
 * Pure helpers for the URLs the game is opened on after leaving the page:
 * OAuth returns (`/auth/complete?code|error&provider`), email magic links
 * (`/auth/email?token`), staff sign-in links (`/auth/staff?token`) and Stripe
 * Checkout returns (`/store?checkout=success|cancel&purchase`). Kept free of
 * DOM and network access so they are unit tested directly.
 */

/** OAuth providers (`OAUTH_PROVIDERS` in apps/api). */
export type OAuthProvider = 'discord' | 'google' | 'github' | 'twitch' | 'apple';

/** Sign-in methods with a redirect or email flow. */
export type LoginProvider = OAuthProvider | 'email';

/** What the server did with a completed sign-in (`AuthResult.outcome` in apps/api). */
export type AuthOutcome = 'linked' | 'alreadyLinked' | 'switched' | 'signedIn' | 'created';

/** A return the client has to finish on boot. */
export type BootReturn =
  | { kind: 'oauth'; code: string; provider: LoginProvider | null }
  | { kind: 'oauthError'; error: string; provider: LoginProvider | null }
  | { kind: 'email'; token: string }
  | { kind: 'staffLink'; token: string }
  | { kind: 'checkout'; status: 'success' | 'cancel'; purchaseId: string | null };

/** Query parameters that belong to a return and must not survive a reload. */
const RETURN_PARAMS = ['code', 'error', 'provider', 'token', 'checkout', 'purchase', 'state'];

/** Display names for sign-in methods. */
export const PROVIDER_LABELS: Record<LoginProvider, string> = {
  discord: 'Discord',
  google: 'Google',
  github: 'GitHub',
  twitch: 'Twitch',
  apple: 'Apple',
  email: 'Email',
};

function provider(v: string | null): LoginProvider | null {
  return v !== null && Object.hasOwn(PROVIDER_LABELS, v) ? (v as LoginProvider) : null;
}

/**
 * Recognises a return URL.
 *
 * @param pathname - `location.pathname`.
 * @param search - `location.search`.
 * @returns The return to finish, or null for an ordinary launch.
 * @example
 * parseBootReturn('/auth/complete', '?provider=discord&code=abc')
 * // → { kind: 'oauth', code: 'abc', provider: 'discord' }
 */
export function parseBootReturn(pathname: string, search: string): BootReturn | null {
  const path = pathname.replace(/\/+$/, '');
  const q = new URLSearchParams(search);
  if (path === '/auth/complete') {
    const code = q.get('code');
    if (code) return { kind: 'oauth', code, provider: provider(q.get('provider')) };
    return {
      kind: 'oauthError',
      error: q.get('error') || 'missing_code',
      provider: provider(q.get('provider')),
    };
  }
  if (path === '/auth/email') {
    const token = q.get('token');
    return token
      ? { kind: 'email', token }
      : { kind: 'oauthError', error: 'invalid_token', provider: 'email' };
  }
  if (path === '/auth/staff') {
    const token = q.get('token');
    return token
      ? { kind: 'staffLink', token }
      : { kind: 'oauthError', error: 'invalid_link', provider: null };
  }
  if (path === '/store') {
    const status = q.get('checkout');
    if (status === 'success' || status === 'cancel')
      return { kind: 'checkout', status, purchaseId: q.get('purchase') };
  }
  return null;
}

/**
 * The root URL to replace a return URL with: the return's own parameters are
 * dropped (a reload must not replay a one-time code) while dev flags such as
 * `?apiUrl=` stay.
 *
 * @param search - `location.search`.
 */
export function cleanReturnUrl(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of RETURN_PARAMS) q.delete(k);
  const rest = q.toString();
  return rest ? `/?${rest}` : '/';
}

/** Title and body for a toast or dialog. */
export interface Message {
  title: string;
  body: string;
}

/**
 * Explains a failed sign-in (OAuth `error=` codes and API error codes).
 *
 * @param error - Error code.
 * @param p - Provider, when known.
 */
export function authErrorMessage(error: string, p: LoginProvider | null): Message {
  const label = p ? PROVIDER_LABELS[p] : 'That';
  switch (error) {
    case 'access_denied':
    case 'cancelled':
      return { title: 'Sign-in cancelled', body: 'Nothing changed. Your Tumbler is just as you left it.' };
    case 'provider_disabled':
      return {
        title: `${p ? PROVIDER_LABELS[p] : 'That'} sign-in isn't set up here`,
        body: "This server doesn't offer it right now. Your Tumbler keeps saving as before.",
      };
    case 'invalid_state':
    case 'invalid_code':
    case 'missing_code':
      return {
        title: 'Sign-in timed out',
        body: 'That sign-in took too long or was already used. Please try again.',
      };
    case 'invalid_token':
      return {
        title: 'That email link has expired',
        body: 'Sign-in links work once, for 15 minutes. Ask for a new one in Settings.',
      };
    case 'browser_mismatch':
      return {
        title: 'Finish signing in where you started',
        body: 'For your safety, a sign-in only completes in the browser that started it. Start it again here.',
      };
    case 'invalid_link':
      return {
        title: 'That sign-in link has expired',
        body: 'Staff sign-in links work once, for 15 minutes. Ask your server operator for a new one.',
      };
    case 'identity_in_use':
      return {
        title: `That ${label} login belongs to another Tumbler`,
        body: 'Use "Sign in to an existing Tumbler" to switch to it.',
      };
    case 'oauth_failed':
      return {
        title: `${label} didn't let us in`,
        body: 'Something went wrong on their side. Please try again.',
      };
    case 'network':
      return {
        title: "Couldn't finish signing in",
        body: "The game servers can't be reached right now. Your Tumbler on this device is unchanged.",
      };
    default:
      return { title: "Couldn't finish signing in", body: `Please try again. (${error})` };
  }
}

/**
 * Toast for a completed sign-in.
 *
 * @param outcome - What the server did.
 * @param p - Provider used.
 * @param name - Display name of the account the device is now on.
 */
export function outcomeMessage(outcome: AuthOutcome, p: LoginProvider, name: string): Message {
  const label = PROVIDER_LABELS[p];
  switch (outcome) {
    case 'linked':
      return {
        title: `${label} linked`,
        body: `Sign in with ${label} to play ${name} on any device.`,
      };
    case 'alreadyLinked':
      return { title: `${label} was already linked`, body: `${name} already signs in with ${label}.` };
    case 'switched':
    case 'signedIn':
      return { title: `Signed in as ${name}`, body: 'Welcome back! Your Tumbler is on this device now.' };
    case 'created':
      return {
        title: `Welcome, ${name}!`,
        body: `No Tumbler used that ${label} login yet, so we made a new one for you.`,
      };
  }
}

/**
 * The account id inside an access token (`sub`), without verifying it: the
 * client only uses it to tell whether a sign-in landed on the same account.
 *
 * @param jwt - Access token.
 * @returns The user id, or null when unreadable.
 */
export function tokenSubject(jwt: string | null | undefined): string | null {
  if (!jwt) return null;
  try {
    const part = jwt.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
