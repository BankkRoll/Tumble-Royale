/**
 * The admin console's API client.
 *
 * Responsibilities:
 * - trade the game's signed-in player session for a short-lived console
 *   session (`POST /admin/session`) and keep it in `sessionStorage` only, so
 *   it dies with the tab and never lands in the game's `localStorage`;
 * - send every admin request with that token as a bearer header (no cookies,
 *   so there is nothing for a cross-site request to ride on);
 * - drop the session on any 401 and tell the shell to show sign-in again.
 *
 * SECURITY: this is only a client. Every route re-checks the session, the
 * staff role and the account's ban state on the server.
 */
import type { StaffActorView } from './types.ts';

/** A console session as stored for the tab. */
export interface AdminSession {
  token: string;
  /** ISO time the server will stop accepting it. */
  expiresAt: string;
  actor: StaffActorView;
}

/** An admin API failure; `status` 0 means the API could not be reached. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/** Where the console keeps its session. */
export interface SessionStore {
  get(): AdminSession | null;
  set(session: AdminSession | null): void;
}

const SESSION_KEY = 'tumble.admin.session';

/**
 * A {@link SessionStore} over `sessionStorage` that never throws (storage can
 * be disabled); a missing store just means signing in on every load.
 *
 * @param storage - Usually `window.sessionStorage`.
 * @param now - Clock, so an expired session is never handed out.
 */
export function tabSessionStore(storage: Storage | undefined, now: () => number = Date.now): SessionStore {
  let memory: AdminSession | null = null;
  return {
    get() {
      let s = memory;
      if (!s) {
        try {
          const raw = storage?.getItem(SESSION_KEY);
          s = raw ? (JSON.parse(raw) as AdminSession) : null;
        } catch {
          s = null;
        }
      }
      if (s && !(Date.parse(s.expiresAt) > now())) s = null;
      memory = s;
      return s;
    },
    set(session) {
      memory = session;
      try {
        if (session) storage?.setItem(SESSION_KEY, JSON.stringify(session));
        else storage?.removeItem(SESSION_KEY);
      } catch {
        // The in-memory copy still works for this page.
      }
    },
  };
}

/** HTTP verbs the admin routes use. */
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Admin API client.
 *
 * @example
 * const api = new AdminApi('https://play.example.com/api', tabSessionStore(sessionStorage));
 * await api.signIn(await player.accessToken());
 * const queue = await api.request<ReportPage>('GET', '/internal/reports');
 */
export class AdminApi {
  private listeners = new Set<() => void>();

  constructor(
    readonly baseUrl: string,
    private readonly store: SessionStore,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** The current session, or null when signed out or expired. */
  get session(): AdminSession | null {
    return this.store.get();
  }

  /**
   * Calls `fn` whenever the session ends (sign-out, expiry, revoked role).
   *
   * @returns Unsubscribe.
   */
  onSignedOut(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Opens a console session for the signed-in player.
   *
   * @param playerAccessToken - The game's access token, or null when nobody is signed in.
   * @throws {AdminApiError} `not_signed_in`, `not_staff`, or whatever the API answers.
   */
  async signIn(playerAccessToken: string | null): Promise<AdminSession> {
    if (!playerAccessToken)
      throw new AdminApiError(401, 'not_signed_in', 'Sign in to the game with your staff account first.');
    const session = await this.send<AdminSession>('POST', '/admin/session', undefined, playerAccessToken);
    this.store.set(session);
    return session;
  }

  /** Ends the session on the server (best effort) and forgets it. */
  async signOut(): Promise<void> {
    const s = this.store.get();
    this.store.set(null);
    if (s) await this.send('DELETE', '/admin/session', undefined, s.token).catch(() => undefined);
    for (const fn of this.listeners) fn();
  }

  /**
   * An authenticated admin request.
   *
   * @param method - HTTP verb.
   * @param path - Route path with query string.
   * @param body - JSON body.
   * @returns The parsed response (undefined for 204).
   * @throws {AdminApiError} On any non-2xx answer; a 401 also ends the session.
   */
  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const s = this.store.get();
    if (!s) {
      for (const fn of this.listeners) fn();
      throw new AdminApiError(401, 'signed_out', 'Your console session ended. Sign in again.');
    }
    try {
      return await this.send<T>(method, path, body, s.token);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        this.store.set(null);
        for (const fn of this.listeners) fn();
      }
      throw err;
    }
  }

  private async send<T>(method: Method, path: string, body: unknown, token: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // SECURITY: the bearer header is the only credential; never send cookies.
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AdminApiError(0, 'network', 'The API could not be reached.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; message?: string; details?: unknown };
      throw new AdminApiError(
        res.status,
        e.error ?? 'http_error',
        e.message ?? `HTTP ${res.status}`,
        e.details,
      );
    }
    return json as T;
  }
}
