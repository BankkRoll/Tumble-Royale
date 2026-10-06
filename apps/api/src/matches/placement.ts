/**
 * Checks reported show results against the matchmaker's placement before
 * anything is granted.
 *
 * Responsibilities:
 * - Fetch the placement (`GET {MATCHMAKER_URL}/internal/matches/:id/placement`,
 *   HMAC-signed with `INTERNAL_HMAC_SECRET`): the server the match was placed
 *   on and the accounts sent there.
 * - Refuse results from another server, for another queue, or naming an
 *   account the matchmaker never sent to that match.
 *
 * SECURITY: a signed report alone only proves the caller holds a game-server
 * key. Without this check a compromised or rogue game server could invent a
 * match and hand out XP, currency and Crowns to any account.
 *
 * Without `MATCHMAKER_URL` (local development, tests) there is nothing to ask
 * and results are accepted as before.
 */
import { signInternal } from '@tumble/shared/liveops-client';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import type { MatchResult } from './schema.ts';

/** The matchmaker's answer (`MatchPlacement` in apps/matchmaker). */
export interface MatchPlacement {
  matchId: string;
  serverId: string;
  queue: string;
  playlistId: string;
  players: string[];
  spectators: string[];
}

/** The matchmaker's development fallback server; it has no registered id to compare. */
const DEFAULT_SERVER_ID = 'default';

/**
 * Fetches the placement of a match.
 *
 * @returns The placement, or null when the matchmaker does not know the match.
 * @throws {ApiError} 503 `placement_unavailable` when the matchmaker cannot be asked
 *   (the game server keeps the results and retries).
 */
export async function fetchPlacement(
  ctx: AppContext,
  mmUrl: string,
  matchId: string,
): Promise<MatchPlacement | null> {
  const path = `/internal/matches/${encodeURIComponent(matchId)}/placement`;
  let res: Response;
  try {
    res = await ctx.fetch(`${mmUrl}${path}`, {
      headers: signInternal(ctx.config.internalHmacSecret, '', ctx.now().getTime(), { method: 'GET', path }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw new ApiError(
      503,
      'placement_unavailable',
      `Could not ask the matchmaker about this match: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(503, 'placement_unavailable', `The matchmaker answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as Partial<MatchPlacement> | null;
  if (!body || typeof body.serverId !== 'string' || !Array.isArray(body.players))
    throw new ApiError(503, 'placement_unavailable', 'The matchmaker sent a malformed placement');
  return {
    matchId,
    serverId: body.serverId,
    queue: String(body.queue),
    playlistId: String(body.playlistId),
    players: body.players.filter((p): p is string => typeof p === 'string'),
    spectators: Array.isArray(body.spectators)
      ? body.spectators.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

/**
 * Refuses results the matchmaker did not place. Status 422 tells the game
 * server not to retry the same report.
 *
 * @param ctx - Shared services.
 * @param m - Schema-validated results.
 * @throws {ApiError} 422 `unknown_match` / `wrong_server` / `wrong_queue` /
 *   `not_placed`; 503 `placement_unavailable`.
 */
export async function verifyPlacement(ctx: AppContext, m: MatchResult): Promise<void> {
  const mmUrl = ctx.config.ops.status.matchmakerUrl;
  if (!mmUrl) return;
  const placement = await fetchPlacement(ctx, mmUrl, m.matchId);
  if (!placement) throw new ApiError(422, 'unknown_match', 'The matchmaker placed no match with this id');
  if (placement.serverId !== DEFAULT_SERVER_ID && m.serverId !== placement.serverId)
    throw new ApiError(422, 'wrong_server', 'This match was placed on another game server');
  if (placement.queue !== m.queue)
    throw new ApiError(422, 'wrong_queue', 'This match was placed in another queue');
  const placed = new Set(placement.players);
  const strangers = m.participants.filter((p) => !p.isBot && p.userId && !placed.has(p.userId));
  if (strangers.length > 0)
    throw new ApiError(422, 'not_placed', 'Results name accounts the matchmaker did not send to this match', {
      userIds: strangers.map((p) => p.userId),
    });
}
