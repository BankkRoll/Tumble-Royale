/**
 * Binds a sign-in to the browser that started it.
 *
 * Before leaving for a provider or sending a magic link, the client makes a
 * random nonce, keeps it in `localStorage` (so a magic link opened in another
 * tab of the same browser still works) and sends only its SHA-256 to the API.
 * Redeeming the code or link requires the nonce itself, so a code, magic link
 * or authorize URL forwarded to someone else's browser is useless there.
 */
import { loadJson, removeKey, saveJson } from '../storage.ts';

/** How long a started sign-in may take; matches the magic link lifetime. */
export const BINDING_TTL_MS = 20 * 60_000;

interface StoredBinding {
  nonce: string;
  /** Epoch ms when the flow started. */
  at: number;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Hex SHA-256 of a nonce, as the API stores it.
 *
 * @param nonce - The nonce.
 * @returns 64 hex characters.
 */
export async function bindingOf(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Starts a sign-in from this browser: makes and keeps a fresh nonce.
 *
 * @param now - Clock (tests inject one).
 * @returns The binding to send to `/auth/:provider/start` or `/auth/email/start`.
 */
export async function beginBinding(now: number = Date.now()): Promise<string> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  saveJson('authBinding', { nonce, at: now } satisfies StoredBinding);
  return bindingOf(nonce);
}

/**
 * The nonce of the sign-in this browser started, if one is still pending.
 *
 * @param now - Clock (tests inject one).
 */
export function pendingNonce(now: number = Date.now()): string | null {
  const stored = loadJson<StoredBinding>('authBinding');
  if (!stored || typeof stored.nonce !== 'string' || !(now - stored.at < BINDING_TTL_MS)) return null;
  return stored.nonce;
}

/** Forgets the pending sign-in once it is redeemed. */
export function clearBinding(): void {
  removeKey('authBinding');
}
