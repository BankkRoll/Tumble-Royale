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
    return (list[rng.weightedIndex(weights)] as Candidate).round;
  }
  return null;
}

function catalogCandidates(catalog: ReadonlyMap<string, RoundDefinition>): Candidate[] {
  // Sorted by id so iteration order of the caller's map can never change the pick.
  return [...catalog.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((round) => ({ round, weight: 1 }));
}
