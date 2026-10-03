/**
 * Ranked rating update for one show. Pure and deterministic: same input, same output.
 *
 * Model
 * - Hidden skill is an OpenSkill (Weng-Lin) Plackett-Luce rating `(mu, sigma)`.
 *   The whole lobby is rated as one free-for-all where every participant is a
 *   one-player team ranked by final placement (1 = Crown winner; equal
 *   placements tie, e.g. everyone eliminated in the same round of a survival).
 * - Bots: they are part of the finishing order, so beating a bot still counts
 *   as beating an opponent, but bots have no stored rating and are never
 *   updated. Each bot enters the rate() call with a proxy rating equal to the
 *   mean (mu, sigma) of the humans in the lobby — i.e. "an average opponent of
 *   this lobby" — and its output is discarded. This keeps human-vs-human
 *   comparisons exact while stopping bots from inflating or deflating ratings.
 * - Visible RP sits on top of the hidden rating:
 *   `delta = placementBase × lobbyStrength + convergence (+ winner bonus)`.
 *   - placementBase is linear in placement percentile: +RP_SWING for the
 *     winner, −RP_SWING for last, 0 at the median.
 *   - lobbyStrength scales gains up and losses down when the other humans'
 *     mean mu exceeds the player's (and vice versa), clamped to [0.5, 1.5].
 *   - convergence nudges RP toward the RP implied by the hidden rating so the
 *     ladder tracks true skill over time.
 * - Placements: the first {@link PLACEMENT_MATCHES} ranked shows only move the
 *   hidden rating; after the last one, RP is seeded from it.
 */
import { ordinal, rate, rating, type Rating } from 'openskill';
import { tierForRp, type TierInfo } from './tiers.ts';

/** Ranked placement matches before RP is shown. */
export const PLACEMENT_MATCHES = 5;
/** Maximum RP change from placement alone (winner +, last −). */
export const RP_SWING = 30;
/** Extra RP for taking the Crown. */
export const RP_WIN_BONUS = 15;
/** RP per point of conservative skill (mu − 2·sigma) when seeding/converging. */
export const RP_PER_SKILL = 120;
/** Cap on the seeded RP: placements can land at most in Diamond. */
export const RP_SEED_MAX = 5999;

/** Default hidden rating for a new player (mu 25, sigma 25/3). */
export const DEFAULT_RATING: Readonly<Rating> = rating();

/** Stored ranked state of a human before the show. */
export interface RankedPrior {
  mu: number;
  sigma: number;
  rp: number;
  placementsLeft: number;
}

/** One participant of the show. */
export interface RankedEntrant {
  /** Participant key within the match (stable, unique). */
  key: string;
  isBot: boolean;
  /** 1 = winner; ties share a value. */
  placement: number;
  /** Stored state for humans; omitted for first-time humans and for bots. */
  prior?: RankedPrior;
}

/** Ranked result for one human. */
export interface RankedOutcome {
  key: string;
  placement: number;
  muBefore: number;
  muAfter: number;
  sigmaBefore: number;
  sigmaAfter: number;
  rpBefore: number;
  rpAfter: number;
  rpDelta: number;
  placementsLeft: number;
  tierBefore: TierInfo;
  tierAfter: TierInfo;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** RP implied by a hidden rating (used for seeding and convergence). */
export function rpFromRating(mu: number, sigma: number): number {
  return Math.round(clamp((mu - 2 * sigma) * RP_PER_SKILL, 0, RP_SEED_MAX));
}

/**
 * Rates one show.
 *
 * @param entrants - Every participant including bots, any order.
 * @returns One outcome per human, in placement order (ties by key).
 * @example
 * computeRankedUpdate([
 *   { key: 'a', isBot: false, placement: 1 },
 *   { key: 'b', isBot: true, placement: 2 },
 *   { key: 'c', isBot: false, placement: 3 },
 * ]);
 */
export function computeRankedUpdate(entrants: readonly RankedEntrant[]): RankedOutcome[] {
  if (entrants.length === 0) return [];
  const ordered = [...entrants].sort(
    (a, b) => a.placement - b.placement || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const humans = ordered.filter((e) => !e.isBot);
  if (humans.length === 0) return [];

  const prior = (e: RankedEntrant): RankedPrior =>
    e.prior ?? {
      mu: DEFAULT_RATING.mu,
      sigma: DEFAULT_RATING.sigma,
      rp: 0,
      placementsLeft: PLACEMENT_MATCHES,
    };
  const meanMu = humans.reduce((s, h) => s + prior(h).mu, 0) / humans.length;
  const meanSigma = humans.reduce((s, h) => s + prior(h).sigma, 0) / humans.length;
  const botProxy: Rating = { mu: meanMu, sigma: meanSigma };

  // Rating a lone human against nothing would be meaningless; with only bots
  // the proxy ratings still provide the opposition.
  const teams = ordered.map((e) => [e.isBot ? botProxy : { mu: prior(e).mu, sigma: prior(e).sigma }]);
  const rated = ordered.length >= 2 ? rate(teams, { rank: ordered.map((e) => e.placement) }) : teams;

  const n = ordered.length;
  const sumMu = humans.reduce((s, h) => s + prior(h).mu, 0);
  const out: RankedOutcome[] = [];
  ordered.forEach((e, i) => {
    if (e.isBot) return;
    const p = prior(e);
    const after = rated[i]![0]!;
    const percentile = n > 1 ? (n - e.placement) / (n - 1) : 1;
    let base = RP_SWING * (2 * clamp(percentile, 0, 1) - 1);
    const others = humans.length - 1;
    const lobbyMu = others > 0 ? (sumMu - p.mu) / others : p.mu;
    const strength = clamp(1 + (lobbyMu - p.mu) / 25, 0.5, 1.5);
    base = base >= 0 ? base * strength : base * (2 - strength);
    if (e.placement === 1) base += RP_WIN_BONUS;
    const placementsLeft = Math.max(0, p.placementsLeft - 1);
    let rpAfter: number;
    if (p.placementsLeft > 0) {
      rpAfter = placementsLeft === 0 ? rpFromRating(after.mu, after.sigma) : p.rp;
    } else {
      const convergence = clamp((rpFromRating(after.mu, after.sigma) - p.rp) * 0.04, -10, 10);
      rpAfter = Math.max(0, Math.round(p.rp + base + convergence));
    }
    out.push({
      key: e.key,
      placement: e.placement,
      muBefore: p.mu,
      muAfter: after.mu,
      sigmaBefore: p.sigma,
      sigmaAfter: after.sigma,
      rpBefore: p.rp,
      rpAfter,
      rpDelta: rpAfter - p.rp,
      placementsLeft,
      tierBefore: tierForRp(p.rp, p.placementsLeft),
      tierAfter: tierForRp(rpAfter, placementsLeft),
    });
  });
  return out;
}

/** Conservative skill estimate (mu − 3·sigma), used for matchmaking bands. */
export function skillOrdinal(mu: number, sigma: number): number {
  return ordinal({ mu, sigma });
}
