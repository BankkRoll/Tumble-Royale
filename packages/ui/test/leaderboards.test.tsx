/**
 * Leaderboards, server-rendered: a failed load shows an error with Retry
 * instead of spinning forever, and an empty board says so honestly rather
 * than inventing the player as #1.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { LeaderboardsTab, emptyBoardText } from '../src/screens/menu/LeaderboardsTab.tsx';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

beforeEach(() => {
  ui.setState({ leaderboards: {}, leaderboardInfo: {} });
});

describe('leaderboard load states', () => {
  it('spins while the first load is on its way', () => {
    const html = renderToStaticMarkup(<LeaderboardsTab />);
    expect(html).toContain('Counting crowns');
    expect(html).not.toContain('lb-error');
  });

  it('shows the failure with a Retry instead of spinning forever', () => {
    ui.getState().setLeaderboardError('crowns', 'global', 'The server could not be reached.');
    const html = renderToStaticMarkup(<LeaderboardsTab />);
    expect(html).toContain('data-testid="lb-error"');
    expect(html).toContain('The server could not be reached.');
    expect(html).toContain('data-testid="lb-retry"');
    expect(html).not.toContain('Counting crowns');
  });

  it('keeps the error over stale rows from an earlier load, and clears it for the retry', () => {
    ui.getState().setLeaderboard('crowns', [], { scope: 'global', source: 'api', updatedAt: 1 });
    ui.getState().setLeaderboardError('crowns', 'global', 'Boom');
    expect(renderToStaticMarkup(<LeaderboardsTab />)).toContain('lb-error');
    ui.getState().setLeaderboardError('crowns', 'global', null);
    expect(ui.getState().leaderboardInfo.crowns).toEqual({ scope: 'global', source: 'api', updatedAt: 1 });
    expect(renderToStaticMarkup(<LeaderboardsTab />)).toContain('data-testid="lb-empty"');
  });

  it('a fresh successful load replaces the error', () => {
    ui.getState().setLeaderboardError('crowns', 'global', 'Boom');
    ui.getState().setLeaderboard('crowns', [], { scope: 'global', source: 'api', updatedAt: 2 });
    expect(ui.getState().leaderboardInfo.crowns?.error).toBeUndefined();
  });

  it('says an empty board is empty, without a placeholder row', () => {
    ui.getState().setLeaderboard('crowns', [], { scope: 'global', source: 'api', updatedAt: 1 });
    const html = renderToStaticMarkup(<LeaderboardsTab />);
    expect(html).toContain('Nobody here yet');
    expect(html).not.toContain('lb-list');
  });

  it('words the empty state for each scope', () => {
    expect(emptyBoardText('crowns', 'friends')).toBe('None of your friends are on this board yet.');
    expect(emptyBoardText('ranked', 'local')).toBe('Ranked boards need the online servers.');
    expect(emptyBoardText('crowns', 'local')).toBe('Play a show to start your Hall of Fame.');
    expect(emptyBoardText('weekly', 'regional')).toBe('Nobody here yet — be the first!');
  });
});
