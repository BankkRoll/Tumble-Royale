import { getRound } from '@tumble/content/rounds';
import { describe, expect, it } from 'vitest';
import { acceptsLocalVote, roundVoteState, voteOption, type SessionVote } from '../src/game/show/vote.ts';

const BALLOT: SessionVote = {
  roundIndex: 2,
  isFinal: false,
  options: ['tile-panic', 'egg-heist', 'tail-chase'],
  counts: [1, 0, 2],
  voted: 3,
  eligible: 20,
  closesIn: 8,
  canVote: true,
  myVote: -1,
  botsDiscounted: true,
};

describe('round vote cards', () => {
  it('describes each candidate from content, with its theme colours', () => {
    const card = voteOption('tile-panic', false);
    const round = getRound('tile-panic')!;
    expect(card).toMatchObject({ roundId: 'tile-panic', name: round.name, type: round.type });
    expect(card.objective).toBe(round.objective);
    expect(card.colors).toHaveLength(2);
    for (const c of card.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    // Final ballots badge every card as a final; unknown ids still render.
    expect(voteOption('crown-climb', true).type).toBe('final');
    expect(voteOption('not-in-this-build', false)).toMatchObject({
      name: 'not-in-this-build',
      objective: '',
    });
  });

  it('turns show seconds into a wall-clock deadline (offline time scale included)', () => {
    const now = 1_000_000;
    expect(roundVoteState(BALLOT, now, 1).closesAt).toBe(now + 8000);
    expect(roundVoteState(BALLOT, now, 2).closesAt).toBe(now + 4000);
    const state = roundVoteState(BALLOT, now, 1);
    expect(state.options.map((o) => o.roundId)).toEqual(BALLOT.options);
    expect(state.result).toBeNull();
    expect(state.counts).not.toBe(BALLOT.counts);
  });
});

describe('local ballots', () => {
  const state = roundVoteState(BALLOT, 0, 1);

  it('sends a pick or a change while the ballot is open', () => {
    expect(acceptsLocalVote(state, 2, 0)).toBe(true);
    expect(acceptsLocalVote({ ...state, myVote: 0 }, 2, 1)).toBe(true);
  });

  it('drops repeats, stale rounds, bad options, closed ballots and non-voters', () => {
    expect(acceptsLocalVote(null, 2, 0)).toBe(false);
    expect(acceptsLocalVote({ ...state, myVote: 1 }, 2, 1)).toBe(false);
    expect(acceptsLocalVote(state, 1, 0)).toBe(false);
    expect(acceptsLocalVote(state, 2, 3)).toBe(false);
    expect(acceptsLocalVote(state, 2, -1)).toBe(false);
    expect(acceptsLocalVote(state, 2, 1.5)).toBe(false);
    expect(acceptsLocalVote({ ...state, result: { winner: 0, reason: 'votes' } }, 2, 1)).toBe(false);
    expect(acceptsLocalVote({ ...state, canVote: false }, 2, 0)).toBe(false);
  });
});
