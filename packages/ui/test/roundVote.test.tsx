/**
 * The between-rounds vote card: who can vote, what a voter sees selected,
 * the winner reveal, and what screen readers hear.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RoundVoteLayer, voteAnnouncement, voteFooter } from '../src/screens/RoundVote.tsx';
import { ui } from '../src/store/uiStore.ts';
import type { RoundVoteState } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const VOTE: RoundVoteState = {
  roundIndex: 2,
  isFinal: false,
  options: [
    {
      roundId: 'tile-panic',
      name: 'Tile Panic',
      type: 'survival',
      objective: 'Stay on the tiles',
      colors: ['#ff4f9a', '#ffd23f'],
    },
    {
      roundId: 'egg-heist',
      name: 'Egg Heist',
      type: 'team',
      objective: 'Grab the eggs',
      colors: ['#3fa9ff', '#3ee6b4'],
    },
    {
      roundId: 'tail-chase',
      name: 'Tail Chase',
      type: 'hunt',
      objective: 'Hold a tail',
      colors: ['#8a5cff', '#ff8a3d'],
    },
  ],
  counts: [4, 1, 0],
  voted: 5,
  eligible: 30,
  closesAt: Date.now() + 6000,
  canVote: true,
  myVote: -1,
  botsDiscounted: true,
  result: null,
};

function render(vote: Partial<RoundVoteState> | null, screen = 'roundResults'): string {
  ui.setState({ screen: screen as never, roundVote: vote ? { ...VOTE, ...vote } : null });
  return renderToStaticMarkup(<RoundVoteLayer />);
}

afterEach(() => {
  ui.setState({ roundVote: null });
});

describe('round vote card', () => {
  it('shows nothing without a ballot or away from the results wall', () => {
    expect(render(null)).toBe('');
    expect(render({}, 'betweenRounds')).toBe('');
    expect(render({}, 'round')).toBe('');
  });

  it('lets a voter pick with focus on the ballot, number-key hints and live counts', () => {
    const html = render({});
    expect(html).toContain('Vote for the next round');
    expect(html).toContain('data-nav-scope="7"');
    expect(html.match(/data-autofocus/g)).toHaveLength(1);
    expect(html.match(/class="tr-vote-key"/g)).toHaveLength(3);
    expect(html).not.toContain('disabled');
    expect(html).toContain('4 votes');
    expect(html).toContain('1 vote<');
    expect(html).toContain('5 of 30 voted · bot votes count for less than yours');
    expect(html).toMatch(/aria-label="Tile Panic, survival round\. Stay on the tiles\. 4 votes\."/);
    expect(html).toContain('6s');
  });

  it('highlights the local pick', () => {
    const html = render({ myVote: 1, counts: [4, 2, 0] });
    expect(html).toMatch(/class="tr-vote-card is-mine"[^>]*data-testid="round-vote-option-1"/);
    expect(html).toContain('Your pick');
    expect(html).toMatch(/aria-pressed="true"[^>]*Egg Heist/);
  });

  it('is read-only for knocked-out players and spectators, without trapping focus', () => {
    const html = render({ canVote: false });
    expect(html).not.toContain('data-nav-scope');
    expect(html).not.toContain('data-autofocus');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('only players still in the show can vote');
  });

  it('reveals the winner and stops taking votes once closed', () => {
    const html = render({ myVote: 0, result: { winner: 1, reason: 'votes' } });
    expect(html).toContain('Next up!');
    expect(html).not.toContain('round-vote-timer');
    expect(html).toMatch(/class="tr-vote-card is-winner"[^>]*data-testid="round-vote-option-1"/);
    expect(html).toMatch(/class="tr-vote-card is-mine is-out"/);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('Next round: Egg Heist.');
  });

  it('works on a two-option ballot for the final', () => {
    const html = render({ isFinal: true, options: VOTE.options.slice(0, 2), counts: [0, 0], voted: 0 });
    expect(html).toContain('Vote for the final');
    expect(html.match(/data-testid="round-vote-option-/g)).toHaveLength(2);
  });
});

describe('vote copy', () => {
  it('announces the ballot and its winner, not every tally', () => {
    expect(voteAnnouncement(VOTE)).toBe('Vote for the next round: Tile Panic, Egg Heist or Tail Chase.');
    expect(voteAnnouncement({ ...VOTE, counts: [9, 9, 9] })).toBe(voteAnnouncement(VOTE));
    expect(voteAnnouncement({ ...VOTE, result: { winner: 2, reason: 'tie' } })).toBe(
      'Next round: Tail Chase (tie broken at random).',
    );
  });

  it('explains how the winner was decided', () => {
    expect(voteFooter({ ...VOTE, result: { winner: 0, reason: 'votes' } })).toBe(
      'Player votes outweigh bot votes.',
    );
    expect(voteFooter({ ...VOTE, botsDiscounted: false, result: { winner: 0, reason: 'votes' } })).toBe(
      'Most votes wins.',
    );
    expect(voteFooter({ ...VOTE, result: { winner: 0, reason: 'tie' } })).toMatch(/tie/i);
    expect(voteFooter({ ...VOTE, result: { winner: 0, reason: 'noVotes' } })).toMatch(/Nobody voted/);
    expect(voteFooter({ ...VOTE, botsDiscounted: false })).toBe('5 of 30 voted');
  });
});
