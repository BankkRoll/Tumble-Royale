/**
 * Who shares the Crown. In duos and squads the whole winning party wins, not
 * just the Tumbler who grabbed it: every teammate gets the victory screen,
 * the Crown, the stats and the rewards.
 */
import type { ShowSummary } from '@tumble/sim/show';
import type { RoundOutcomeInfo, SessionSummary } from './context.ts';

/**
 * Every winner of a show, the headline winner first.
 *
 * @param summary - The recap (older producers may only set `winnerId`).
 */
export function crownedIds(summary: Pick<SessionSummary, 'winnerId' | 'winnerIds'>): readonly number[] {
  if (summary.winnerIds.length > 0) return summary.winnerIds;
  return summary.winnerId !== null ? [summary.winnerId] : [];
}

/**
 * Whether a player shares the Crown.
 *
 * @example
 * wonShow({ winnerId: 4, winnerIds: [4, 5], ... }, 5); // true: 5 is 4's duo partner
 */
export function wonShow(summary: Pick<SessionSummary, 'winnerId' | 'winnerIds'>, playerId: number): boolean {
  return crownedIds(summary).includes(playerId);
}

/**
 * The simulation's end-of-show summary as the session recap: carried
 * players count as qualified, and every party winner is kept.
 *
 * @param summary - `ShowDirector` summary.
 */
export function sessionSummaryFromShow(summary: ShowSummary): SessionSummary {
  const placements = new Map<number, number>();
  for (const p of summary.placements) placements.set(p.playerId, p.place);
  return {
    winnerId: summary.winner,
    winnerIds:
      summary.winners.length > 0 ? [...summary.winners] : summary.winner !== null ? [summary.winner] : [],
    placements,
    rounds: summary.rounds.map((o): RoundOutcomeInfo => {
      const carried = new Set(o.carried);
      return {
        roundId: o.roundId,
        name: o.name,
        type: o.type,
        isFinal: o.isFinal,
        qualified: [...o.qualified, ...o.carried],
        eliminated: o.eliminated.filter((id) => !carried.has(id)),
      };
    }),
  };
}
