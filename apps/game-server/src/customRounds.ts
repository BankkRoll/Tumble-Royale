/**
 * Shared custom rounds on the game server.
 *
 * A private show's host can pick rounds by share code (`custom:<CODE>` in the
 * ticket's round list). Before such a show starts, the room asks the API for
 * the stored definitions over the signed internal channel, validates each one
 * again with the editor's rules and prepares it exactly as clients will
 * (`playableCustomRound`), then plays it like any built-in round. Codes that
 * are unknown, unpublished, taken down or fail validation are dropped; the
 * show falls back to its base playlist for the missing picks.
 */
import { isCustomRoundId, playableCustomRound, shareCodeOf } from '@tumble/content/custom';
import type { RoundDefinition } from '@tumble/shared';
import { signInternal } from './results.ts';
import type { MatchSettings } from './room/types.ts';

/** Fetches stored definitions by share code. */
export interface CustomRoundSource {
  /**
   * @param codes - Normalised share codes (at most 10).
   * @returns Raw (untrusted) definitions keyed by code; missing codes are absent.
   */
  fetch(codes: readonly string[]): Promise<Map<string, unknown>>;
}

/** Options for {@link HttpCustomRoundSource}. */
export interface HttpCustomRoundSourceOptions {
  apiUrl: string;
  /** `INTERNAL_HMAC_SECRET`. */
  secret: string;
  /** Request timeout (default 5 s): a show must not wait longer than its fill window. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Reads definitions from the API's `POST /internal/custom-rounds/resolve`.
 *
 * @example
 * const source = new HttpCustomRoundSource({ apiUrl, secret });
 */
export class HttpCustomRoundSource implements CustomRoundSource {
  constructor(private readonly opts: HttpCustomRoundSourceOptions) {}

  async fetch(codes: readonly string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (codes.length === 0) return out;
    const body = JSON.stringify({ codes: codes.slice(0, 10) });
    try {
      const res = await (this.opts.fetch ?? fetch)(
        `${this.opts.apiUrl.replace(/\/$/, '')}/internal/custom-rounds/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signInternal(this.opts.secret, body, Date.now()),
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        },
      );
      if (!res.ok) {
        this.opts.log?.(`[custom-rounds] resolve answered ${res.status}`);
        return out;
      }
      const json = (await res.json()) as { rounds?: { code?: unknown; definition?: unknown }[] };
      for (const r of json.rounds ?? []) if (typeof r.code === 'string') out.set(r.code, r.definition);
    } catch (err) {
      this.opts.log?.(`[custom-rounds] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }
}

/** Most custom rounds kept in memory across rooms. */
const CACHE_LIMIT = 256;

/**
 * The custom rounds this process can play, refreshed from the API for every
 * new show that picks one (so a takedown applies to every show created after
 * it).
 */
export class CustomRoundCatalog {
  private readonly rounds = new Map<string, RoundDefinition>();

  constructor(
    private readonly source: CustomRoundSource | null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** A loaded custom round by id (`custom:<CODE>`). */
  get(id: string): RoundDefinition | undefined {
    return this.rounds.get(id);
  }

  /**
   * Fetches, validates and prepares the custom rounds a match picked.
   *
   * @param match - Room match settings.
   * @returns Ids that loaded and ids that did not.
   */
  async load(match: MatchSettings): Promise<{ loaded: string[]; failed: string[] }> {
    const ids = customPicks(match);
    if (ids.length === 0) return { loaded: [], failed: [] };
    if (!this.source) {
      this.log('[custom-rounds] no API configured; custom picks skipped');
      return { loaded: [], failed: ids };
    }
    const byCode = await this.source.fetch(ids.map((id) => shareCodeOf(id)!));
    const loaded: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      const raw = byCode.get(shareCodeOf(id)!);
      // SECURITY: stored definitions were validated at publish time, but the
      // rules may have tightened since, and the API is a separate trust domain.
      const r = raw === undefined ? null : playableCustomRound(raw, id);
      if (!r?.ok) {
        this.rounds.delete(id);
        failed.push(id);
        if (r && !r.ok) this.log(`[custom-rounds] ${id} rejected: ${r.issues.map((i) => i.code).join(', ')}`);
        continue;
      }
      this.rounds.delete(id);
      this.rounds.set(id, r.round);
      loaded.push(id);
    }
    while (this.rounds.size > CACHE_LIMIT) this.rounds.delete(this.rounds.keys().next().value!);
    if (failed.length > 0)
      this.log(`[custom-rounds] match ${match.matchId}: unavailable ${failed.join(', ')}`);
    return { loaded, failed };
  }
}

/**
 * Custom round ids a match's host picked (deduplicated, in pick order).
 *
 * @param match - Room match settings, or null.
 */
export function customPicks(match: MatchSettings | null | undefined): string[] {
  return [...new Set((match?.custom?.rounds ?? []).filter(isCustomRoundId))].slice(0, 10);
}
