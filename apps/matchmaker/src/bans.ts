/**
 * Ban lookups against the account API.
 *
 * Access tokens are verified statelessly here, so a player suspended after
 * their token was minted would otherwise keep queueing until it expired. The
 * matchmaker asks the API (`POST /internal/bans/lookup`, HMAC-signed with
 * `INTERNAL_HMAC_SECRET`) which players are suspended and caches each answer
 * briefly.
 *
 * Fails open: when the API is unreachable players can still queue, because
 * the API already refuses suspended accounts when it issues queue tickets and
 * mints tokens. The outage is logged.
 */
import { signInternal } from '@tumble/shared/liveops-client';
import { requestIdHeaders } from '@tumble/shared/request-id';

/** Signs a body the way the API's `requireInternalSignature` expects. */
export { signInternal };

/** Ban scopes the API issues: `all` (every service), `ranked` (ranked queue), `chat` (in-game chat). */
export type BanScope = 'all' | 'ranked' | 'chat';

/** Answers "which bans does each of these players have right now?". */
export interface BanLookup {
  /**
   * @param userIds - Account ids.
   * @returns Active ban scopes per id (an empty set for players in good standing).
   */
  scopes(userIds: readonly string[]): Promise<Map<string, ReadonlySet<string>>>;
}

/** A lookup that never finds a ban (tests, and deployments without `API_URL`). */
export const NO_BANS: BanLookup = {
  scopes: async (userIds) => new Map(userIds.map((id) => [id, new Set<string>()])),
};

/** How long a failed ban lookup keeps players being let through without asking the API again. */
export const FAILURE_BACKOFF_MS = 5000;

/** Options for {@link ApiBanLookup}. */
export interface ApiBanLookupOptions {
  /** API base URL, e.g. `http://localhost:7360`. */
  apiUrl: string;
  /** `INTERNAL_HMAC_SECRET`, shared with the API. */
  secret: string;
  /** How long one answer is trusted (default 15 s, matching the API's own ban cache). */
  cacheMs?: number;
  fetch?: typeof fetch;
  /** Clock for the cache (ms). Signatures always use the wall clock the API checks against. */
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Cached ban lookups over HTTP.
 *
 * @example
 * const bans = new ApiBanLookup({ apiUrl: 'http://localhost:7360', secret });
 * const scopes = await bans.scopes(['user-1']);
 */
export class ApiBanLookup implements BanLookup {
  private readonly cache = new Map<string, { at: number; scopes: ReadonlySet<string> }>();
  private readonly cacheMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  /** After a failed lookup, the API is not asked again before this (epoch ms). */
  private retryAt = 0;

  constructor(private readonly opts: ApiBanLookupOptions) {
    this.cacheMs = opts.cacheMs ?? 15_000;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async scopes(userIds: readonly string[]): Promise<Map<string, ReadonlySet<string>>> {
    const t = this.now();
    const out = new Map<string, ReadonlySet<string>>();
    const missing: string[] = [];
    for (const id of new Set(userIds)) {
      const hit = this.cache.get(id);
      if (hit && t - hit.at < this.cacheMs) out.set(id, hit.scopes);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    // PERF: during an outage every chat line and queue request would otherwise wait out a timeout.
    const fetched = t < this.retryAt ? null : await this.fetchScopes(missing);
    if (!fetched && t >= this.retryAt) this.retryAt = t + FAILURE_BACKOFF_MS;
    if (this.cache.size > 50_000) this.cache.clear();
    for (const id of missing) {
      const scopes = fetched?.get(id) ?? new Set<string>();
      out.set(id, scopes);
      // An outage is not cached, so bans apply again as soon as the API answers.
      if (fetched) this.cache.set(id, { at: t, scopes });
    }
    return out;
  }

  private async fetchScopes(userIds: string[]): Promise<Map<string, Set<string>> | null> {
    const out = new Map<string, Set<string>>();
    try {
      for (let i = 0; i < userIds.length; i += 64) {
        const body = JSON.stringify({ userIds: userIds.slice(i, i + 64) });
        const res = await this.fetchFn(`${this.opts.apiUrl}/internal/bans/lookup`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signInternal(this.opts.secret, body, Date.now(), {
              method: 'POST',
              path: '/internal/bans/lookup',
            }),
            ...requestIdHeaders(),
          },
          body,
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`API answered ${res.status}`);
        const json = (await res.json()) as { bans?: Record<string, { scope: string }[]> };
        for (const [id, bans] of Object.entries(json.bans ?? {})) {
          out.set(id, new Set(bans.map((b) => b.scope)));
        }
      }
      return out;
    } catch (err) {
      this.opts.log?.(
        `[bans] lookup failed, allowing players through: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
