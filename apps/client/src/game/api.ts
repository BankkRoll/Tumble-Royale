/**
 * Optional account API client (apps/api). The game is fully playable offline;
 * when the API answers, the guest signs in so the account exists server-side
 * and the tokens are kept for later meta calls.
 */
import { loadJson, saveJson } from './storage.ts';

/** Tokens returned by `/auth/guest` and `/auth/refresh`. */
interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  deviceToken: string;
}

const PROBE_TIMEOUT_MS = 900;

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Minimal API client: health probe and guest sign-in with token persistence.
 *
 * @example
 * const api = new ApiClient('http://localhost:7360');
 * if (await api.probe()) await api.signInGuest('Sprinkles');
 */
export class ApiClient {
  /** True after a successful health probe. */
  online = false;
  private tokens: AuthTokens | null = loadJson<AuthTokens>('auth');

  constructor(private readonly baseUrl: string) {}

  /** Whether a guest session exists (tokens stored). */
  get signedIn(): boolean {
    return this.tokens !== null;
  }

  /**
   * Checks that the API answers.
   *
   * @returns True when reachable.
   */
  async probe(): Promise<boolean> {
    const r = await fetchJson<{ ok?: boolean }>(`${this.baseUrl}/health`, { method: 'GET' }, PROBE_TIMEOUT_MS);
    this.online = r !== null;
    return this.online;
  }

  /**
   * Signs in (or back in) as a guest, keeping the device token so the same
   * account comes back on later launches.
   *
   * @param displayName - Name chosen on the welcome screen.
   * @returns True when tokens were obtained.
   */
  async signInGuest(displayName: string): Promise<boolean> {
    if (!this.online) return false;
    const body = { displayName, ...(this.tokens?.deviceToken ? { deviceToken: this.tokens.deviceToken } : {}) };
    const r = await fetchJson<AuthTokens>(
      `${this.baseUrl}/auth/guest`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      4000,
    );
    if (!r?.accessToken) return false;
    this.tokens = { accessToken: r.accessToken, refreshToken: r.refreshToken, deviceToken: r.deviceToken };
    saveJson('auth', this.tokens);
    return true;
  }

  /**
   * Rotates the refresh token at launch (falls back to device sign-in).
   *
   * @param displayName - Current display name for the fallback.
   */
  async resume(displayName: string): Promise<boolean> {
    if (!this.online || !this.tokens) return false;
    const r = await fetchJson<{ accessToken: string; refreshToken: string }>(
      `${this.baseUrl}/auth/refresh`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: this.tokens.refreshToken }) },
      4000,
    );
    if (r?.accessToken) {
      this.tokens = { ...this.tokens, accessToken: r.accessToken, refreshToken: r.refreshToken };
      saveJson('auth', this.tokens);
      return true;
    }
    return this.signInGuest(displayName);
  }
}
