/**
 * Round votes as the show sessions see them: one normalised shape for the
 * offline director's events and the server's v6 messages, turned into the
 * UI's vote card state. Pure (content lookups only) so the rules the card
 * relies on are unit-tested without a browser.
 */
import { getRound } from '@tumble/content/rounds';
import { getTheme } from '@tumble/content/themes';
import type { RoundVoteOption, RoundVoteReason, RoundVoteState } from '@tumble/ui';

/** A ballot from the director (offline) or `voteOptions` (online). */
export interface SessionVote {
  roundIndex: number;
  isFinal: boolean;
  /** Candidate round ids in display order. */
  options: readonly string[];
  counts: readonly number[];
  voted: number;
  eligible: number;
  /** Seconds of show time until the ballot closes at the latest. */
  closesIn: number;
  canVote: boolean;
  /** The local player's ballot, or -1. */
  myVote: number;
  botsDiscounted: boolean;
}

/** A closed ballot (null result: called off). */
export interface SessionVoteResult {
  roundIndex: number;
  winner: number;
  counts: readonly number[];
  reason: RoundVoteReason;
}

const FALLBACK_COLORS: [string, string] = ['#5aa9ff', '#ff4f9a'];

/**
 * The card for one candidate: name, type, objective and its theme's colours.
 * Ids this build does not know still get a readable card.
 *
 * @param roundId - Candidate round id.
 * @param isFinal - The ballot is for the final (every card is a final).
 * @returns The card.
 */
export function voteOption(roundId: string, isFinal: boolean): RoundVoteOption {
  const r = getRound(roundId);
  if (!r)
    return {
      roundId,
      name: roundId,
      type: isFinal ? 'final' : 'race',
      objective: '',
      colors: FALLBACK_COLORS,
    };
  const theme = getTheme(r.theme);
  return {
    roundId,
    name: r.name,
    type: isFinal ? 'final' : r.type,
    objective: r.objective,
    colors: [theme.sky.top, theme.palette.primary],
  };
}

/**
 * The UI's vote card state for a ballot.
 *
 * @param v - The ballot.
 * @param nowMs - Wall clock (ms).
 * @param clockScale - Show seconds per real second (offline time scale; 1 online).
 * @returns The card state.
 * @example
 * ui.getState().setRoundVote(roundVoteState(ballot, Date.now(), 1));
 */
export function roundVoteState(v: SessionVote, nowMs: number, clockScale: number): RoundVoteState {
  return {
    roundIndex: v.roundIndex,
    isFinal: v.isFinal,
    options: v.options.map((id) => voteOption(id, v.isFinal)),
    counts: [...v.counts],
    voted: v.voted,
    eligible: v.eligible,
    closesAt: nowMs + (Math.max(0, v.closesIn) / Math.max(0.01, clockScale)) * 1000,
    canVote: v.canVote,
    myVote: v.myVote,
    botsDiscounted: v.botsDiscounted,
    result: null,
  };
}

/**
 * Whether the local player's click may become a ballot: the card is for this
 * round, still open, they may vote, the option exists and it changes their
 * pick.
 *
 * @param state - The card.
 * @param roundIndex - Round the click was for.
 * @param option - Option clicked.
 * @returns True if the ballot should be sent.
 */
export function acceptsLocalVote(state: RoundVoteState | null, roundIndex: number, option: number): boolean {
  return (
    !!state &&
    state.roundIndex === roundIndex &&
    state.result === null &&
    state.canVote &&
    Number.isInteger(option) &&
    option >= 0 &&
    option < state.options.length &&
    state.myVote !== option
  );
}
