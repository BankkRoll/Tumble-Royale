/** Real player counts on the Play Online tile and the queue screen's show size. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHOW_SIZE,
  onlineCounts,
  parseMatchmakerStats,
  queueTarget,
} from '../src/game/online/playerCounts.ts';

describe('online counts', () => {
  it('counts everyone in a show or in the queue as online', () => {
    expect(onlineCounts({ queued: 3, inGame: 37 }, 99)).toEqual({ playersOnline: 40, inQueue: 3 });
  });

  it('falls back to the queue size alone when /stats is unavailable', () => {
    expect(onlineCounts(null, 5)).toEqual({ inQueue: 5 });
    expect(onlineCounts(null, 0)).toEqual({ inQueue: 0 });
  });

  it('reports nothing it does not know', () => {
    expect(onlineCounts(null, null)).toEqual({});
  });

  it('parses /stats defensively', () => {
    expect(parseMatchmakerStats({ queued: 2, inGame: 10, servers: 1 })).toEqual({ queued: 2, inGame: 10 });
    expect(parseMatchmakerStats({ queued: '2', inGame: 10 })).toBeNull();
    expect(parseMatchmakerStats({ queued: -1, inGame: 10 })).toBeNull();
    expect(parseMatchmakerStats(null)).toBeNull();
  });
});

describe('queue target', () => {
  const playlists = [
    { id: 'main-show', players: 40 },
    { id: 'duos', players: 20 },
  ];

  it("uses the queued playlist's player count", () => {
    expect(queueTarget(playlists, 'duos')).toBe(20);
  });

  it('falls back to the main show size', () => {
    expect(queueTarget(playlists, 'unknown')).toBe(DEFAULT_SHOW_SIZE);
    expect(queueTarget([], null)).toBe(DEFAULT_SHOW_SIZE);
  });
});
