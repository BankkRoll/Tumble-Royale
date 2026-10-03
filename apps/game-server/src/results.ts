/**
 * Show results → account API (`POST {API_URL}/internal/match-results`).
 *
 * Responsibilities:
 * - the wire contract (mirrors `MatchResult` in apps/api `src/matches/schema.ts`);
 * - placements from the show summary (1 = Crown, players knocked out in the
 *   same round share a value);
 * - HMAC signing (`hex(HMAC_SHA256(secret, "<ts>.<nonce>.<rawBody>"))`) and a
 *   few retries with fresh nonces; the API keys every grant by `matchId`, so a
 *   retry after a lost response replays the stored summaries.
 *
 * Reporting is optional: without `API_URL` and `INTERNAL_HMAC_SECRET` the
 * server never posts anything.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { RoundType } from '@tumble/shared';

/** Per-show action counters for challenges. */
export interface PlayerStatsCounters {
  jumps: number;
  dives: number;
  grabs: number;
  checkpoints: number;
  bounces: number;
  emotes: number;
}

/** One participant (`MatchParticipantSchema`). */
export interface ResultParticipant {
  key: string;
  userId: string | null;
  isBot: boolean;
  name: string;
  team?: number | null;
  quit?: boolean;
  stats?: Partial<PlayerStatsCounters>;
}

/** One participant's outcome in one round. */
export interface ResultRoundEntry {
  key: string;
  qualified: boolean;
  position?: number | null;
  score?: number | null;
  timeMs?: number | null;
}

/** A played round. */
export interface ResultRound {
  roundId: string;
  roundType: RoundType;
  durationMs: number;
  results: ResultRoundEntry[];
}

/** The posted body (`MatchResultSchema`). */
export interface MatchResultPayload {
  matchId: string;
  queue: 'casual' | 'ranked' | 'custom';
  playlistId: string;
  region: string;
  startedAt: string;
  endedAt: string;
  participants: ResultParticipant[];
  rounds: ResultRound[];
  placements: { key: string; placement: number; crowned: boolean }[];
}

/** One player's grant (subset of the API's `PlayerRewardSummary`). */
export interface ApiPlayerReward {
  userId: string;
  participantKey: string;
  [k: string]: unknown;
}

/** The API's answer. */
export interface IngestResponse {
  matchId: string;
  alreadyProcessed: boolean;
  rewards: ApiPlayerReward[];
}

/** Posts results; injected so rooms are testable without HTTP. */
export interface ResultsSink {
  post(payload: MatchResultPayload): Promise<IngestResponse | null>;
}

/**
 * Computes placements from the show summary.
 *
 * @param entrants - Every participant key in the first round (join order).
 * @param rounds - Per round: entrants and qualified keys, in show order.
 * @param winners - Crown winners (usually one).
 * @returns One placement per entrant; 1 = Crown, ties share a value.
 */
export function computePlacements(
  entrants: readonly string[],
  rounds: readonly { entrants: readonly string[]; qualified: readonly string[] }[],
  winners: readonly string[],
): { key: string; placement: number; crowned: boolean }[] {
  const out: { key: string; placement: number; crowned: boolean }[] = [];
  const placed = new Set<string>();
  const winnerSet = new Set(winners);
  for (const w of winners) {
    if (placed.has(w)) continue;
    placed.add(w);
    out.push({ key: w, placement: 1, crowned: true });
  }
  let better = placed.size;
  // The final's survivors outrank its eliminations, which outrank the previous round's, and so on.
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!;
    const q = new Set(r.qualified);
    const groups = [r.qualified.filter((k) => !placed.has(k) && !winnerSet.has(k)), r.entrants.filter((k) => !q.has(k) && !placed.has(k))];
    for (const group of groups) {
      if (group.length === 0) continue;
      const placement = better + 1;
      for (const k of group) {
        placed.add(k);
        out.push({ key: k, placement, crowned: false });
      }
      better += group.length;
    }
  }
  const rest = entrants.filter((k) => !placed.has(k));
  if (rest.length > 0) for (const k of rest) out.push({ key: k, placement: better + 1, crowned: false });
  return out;
}

/** Signing headers for an internal API call. */
export function signInternal(secret: string, body: string, nowMs: number): Record<string, string> {
  const timestamp = String(nowMs);
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  return { 'x-tumble-timestamp': timestamp, 'x-tumble-nonce': nonce, 'x-tumble-signature': signature };
}

/** Options for {@link HttpResultsSink}. */
export interface HttpResultsSinkOptions {
  apiUrl: string;
  secret: string;
  /** Attempts before giving up (default 3). */
  attempts?: number;
  log?: (msg: string) => void;
}

/**
 * Posts results to the API over HTTP with HMAC signing.
 *
 * @example
 * const sink = new HttpResultsSink({ apiUrl: 'http://localhost:7360', secret });
 * const res = await sink.post(payload);
 */
export class HttpResultsSink implements ResultsSink {
  constructor(private readonly opts: HttpResultsSinkOptions) {}

  async post(payload: MatchResultPayload): Promise<IngestResponse | null> {
    const body = JSON.stringify(payload);
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}/internal/match-results`;
    const attempts = this.opts.attempts ?? 3;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signInternal(this.opts.secret, body, Date.now()) },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return (await res.json()) as IngestResponse;
        const text = await res.text().catch(() => '');
        this.opts.log?.(`[results] ${payload.matchId}: API answered ${res.status} ${text.slice(0, 300)}`);
        // 4xx (bad payload/signature) will not get better by retrying.
        if (res.status < 500) return null;
      } catch (err) {
        this.opts.log?.(`[results] ${payload.matchId}: post failed (${err instanceof Error ? err.message : String(err)})`);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
    return null;
  }
}
