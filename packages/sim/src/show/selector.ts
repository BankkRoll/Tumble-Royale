import type { Rng, RoundDefinition, RoundType } from '@tumble/shared';
import type { ShowPlaylist } from './schema/index.ts';

/** Inputs for one round pick. */
export interface RoundSelectContext {
  /** 0-based round index within the show. */
  roundIndex: number;
  /** Players entering the round. */
  players: number;
  /** Pick a final-type round. */
  isFinal: boolean;
  /** Type of the previous round, if any. */
  previousType: RoundType | null;
  /** Round ids already played this show. */
  used: ReadonlySet<string>;
}

/** One round the rules allow, with its selection weight. */
export interface RoundCandidate {
  round: RoundDefinition;
  /** Pool weight × type weight × player-count fit; bots vote by it. */
  weight: number;
}

interface Candidate {
  round: RoundDefinition;
  weight: number;
}

/**
 * How well a round fits a player count: 0 outside [min, max], peaking at 1
 * at `ideal`.
 */
export function playerFit(round: RoundDefinition, n: number): number {
  const { min, max, ideal } = round.players;
  if (n < min || n > max) return 0;
  return 1 / (1 + Math.abs(n - ideal) / Math.max(ideal, 1));
}

/**
 * The strictest constraint tier with any positive weight: every round the
 * show rules allow right now, with its selection weight (zero weights kept so
 * a draw over the list matches the original selector exactly).
 */
function eligibleTier(
  playlist: ShowPlaylist,
  catalog: ReadonlyMap<string, RoundDefinition>,
  ctx: RoundSelectContext,
): RoundCandidate[] {
  const pool: Candidate[] = [];
  for (const entry of playlist.pool) {
    const round = catalog.get(entry.roundId);
    if (round && entry.weight > 0)
      pool.push({ round, weight: entry.weight * (playlist.typeWeights[round.type] ?? 1) });
  }

  const isFinalType = (r: RoundDefinition): boolean => r.type === 'final';
  type Filter = (c: Candidate) => number;
  const fit: Filter = (c) => playerFit(c.round, ctx.players);
  const softFit: Filter = (c) => Math.max(fit(c), 0.05 / (1 + Math.abs(ctx.players - c.round.players.ideal)));
  const fresh = (c: Candidate): boolean => !ctx.used.has(c.round.id);
  const typeOk = (c: Candidate): boolean => c.round.type !== ctx.previousType;
  const firstOk = (c: Candidate): boolean => ctx.roundIndex !== 0 || c.round.type === playlist.firstRoundType;

  const tiers: { from: Candidate[]; keep: (c: Candidate) => boolean; score: Filter }[] = ctx.isFinal
    ? [
        { from: pool, keep: (c) => isFinalType(c.round) && fresh(c), score: fit },
        { from: pool, keep: (c) => isFinalType(c.round) && fresh(c), score: softFit },
        { from: catalogCandidates(catalog), keep: (c) => isFinalType(c.round) && fresh(c), score: softFit },
        { from: pool, keep: (c) => isFinalType(c.round), score: softFit },
        // No final anywhere: any round works; the director forces a single qualifier.
        { from: pool, keep: fresh, score: softFit },
        { from: catalogCandidates(catalog), keep: () => true, score: softFit },
      ]
    : [
        { from: pool, keep: (c) => !isFinalType(c.round) && fresh(c) && typeOk(c) && firstOk(c), score: fit },
        { from: pool, keep: (c) => !isFinalType(c.round) && fresh(c) && firstOk(c), score: fit },
        { from: pool, keep: (c) => !isFinalType(c.round) && fresh(c) && typeOk(c), score: fit },
        { from: pool, keep: (c) => !isFinalType(c.round) && fresh(c), score: softFit },
        { from: pool, keep: (c) => !isFinalType(c.round), score: softFit },
        { from: catalogCandidates(catalog), keep: (c) => !isFinalType(c.round), score: softFit },
        { from: catalogCandidates(catalog), keep: () => true, score: softFit },
      ];

  for (const tier of tiers) {
    const list = tier.from.filter(tier.keep);
    const weights = list.map((c) => c.weight * tier.score(c));
    if (!weights.some((w) => w > 0)) continue;
    return list.map((c, i) => ({ round: c.round, weight: weights[i] as number }));
  }
  return [];
}

/**
 * Picks the next round with the show rules from the spec:
 * round 1 is the playlist's first type (race), no type twice in a row, no
 * round twice per show, weighted by player-count fit, and a final-type round
 * for the final. Constraints relax in that order of importance when the pool
 * cannot satisfy them all, so a show never stalls on a thin catalogue.
 *
 * @param playlist - Validated playlist.
 * @param catalog - Every available round by id; pool ids missing here are skipped.
 * @param ctx - Show position.
 * @param rng - The show's selection generator.
 * @returns The chosen round, or null if the catalogue is empty.
 */
export function selectRound(
  playlist: ShowPlaylist,
  catalog: ReadonlyMap<string, RoundDefinition>,
  ctx: RoundSelectContext,
  rng: Rng,
): RoundDefinition | null {
  const tier = eligibleTier(playlist, catalog, ctx);
  if (tier.length === 0) return null;
  return (tier[rng.weightedIndex(tier.map((c) => c.weight))] as RoundCandidate).round;
}

/**
 * The ballot for a round vote: up to `count` distinct rounds drawn by weight
 * without replacement from the same constraint tier {@link selectRound}
 * would pick from, so a vote only ever chooses between rounds the director
 * could have picked itself. When the tier is thin the ballot is shorter; it
 * is never padded from a looser tier.
 *
 * @param playlist - Validated playlist.
 * @param catalog - Every available round by id.
 * @param ctx - Show position.
 * @param rng - The show's selection generator.
 * @param count - Ballot size.
 * @returns At most `count` candidates in draw order; empty only for an empty catalogue.
 * @example
 * const ballot = selectRoundCandidates(playlist, catalog, ctx, rng, 3);
 * if (ballot.length >= 2) openBallot(ballot);
 */
export function selectRoundCandidates(
  playlist: ShowPlaylist,
  catalog: ReadonlyMap<string, RoundDefinition>,
  ctx: RoundSelectContext,
  rng: Rng,
  count: number,
): RoundCandidate[] {
  const left = eligibleTier(playlist, catalog, ctx).filter((c) => c.weight > 0);
  const out: RoundCandidate[] = [];
  while (out.length < count && left.length > 0) {
    const i = rng.weightedIndex(left.map((c) => c.weight));
    out.push(left.splice(i, 1)[0] as RoundCandidate);
  }
  return out;
}

function catalogCandidates(catalog: ReadonlyMap<string, RoundDefinition>): Candidate[] {
  // Sorted by id so iteration order of the caller's map can never change the pick.
  return [...catalog.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((round) => ({ round, weight: 1 }));
}
