import { roundCatalog } from '@tumble/content/rounds';
import { minimumShowSeats } from '@tumble/sim/show';
import { MAX_PLAYERS } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  FIRST_SHOW_COUNT,
  isNewcomer,
  playlistIdForPlay,
  privateShow,
  resolvePlaylist,
} from '../src/game/playlists.ts';

describe('First Show selection', () => {
  it('swaps the default Main Show for the First Show during the first three shows', () => {
    expect(FIRST_SHOW_COUNT).toBe(3);
    for (let shows = 0; shows < 3; shows++) {
      expect(isNewcomer(shows)).toBe(true);
      expect(playlistIdForPlay('main-show', shows)).toBe('first-show');
      expect(playlistIdForPlay(null, shows)).toBe('first-show');
      expect(playlistIdForPlay('', shows)).toBe('first-show');
    }
    expect(playlistIdForPlay('main-show', 3)).toBe('main-show');
    expect(playlistIdForPlay(null, 10)).toBe('main-show');
  });

  it('respects an explicit non-default pick, a forced playlist and an unknown count', () => {
    expect(playlistIdForPlay('duos', 0)).toBe('duos');
    expect(playlistIdForPlay('chaos-mode', 1)).toBe('chaos-mode');
    expect(playlistIdForPlay('main-show', 0, 'squads')).toBe('squads');
    expect(isNewcomer(null)).toBe(false);
    expect(playlistIdForPlay('main-show', null)).toBe('main-show');
  });

  it('resolves offline playlists, with ranked and unknown ids falling back to the Main Show', () => {
    expect(resolvePlaylist('main-show', 0).id).toBe('first-show');
    expect(resolvePlaylist('main-show', 5).id).toBe('main-show');
    expect(resolvePlaylist('ranked', 0).id).toBe('main-show');
    expect(resolvePlaylist('nope', 5).id).toBe('main-show');
    expect(resolvePlaylist(null, 5, 'duos').id).toBe('duos');
  });
});

describe('private show options', () => {
  it('keeps the timer scale (clamped) and the seat count', () => {
    const show = privateShow({
      rounds: ['gumdrop-gauntlet', 'crown-climb'],
      bots: true,
      maxPlayers: 24,
      timerScale: 1.5,
    });
    expect(show.roundTimeScale).toBe(1.5);
    expect(show.playlist.maxPlayers).toBe(24);
    expect(show.playlist.botsAllowed).toBe(true);
    expect(show.playlist.pool.map((p) => p.roundId)).toEqual(['gumdrop-gauntlet', 'crown-climb']);
    expect(
      privateShow({ rounds: ['crown-climb'], bots: true, maxPlayers: MAX_PLAYERS + 1, timerScale: 9 }),
    ).toMatchObject({
      roundTimeScale: 2,
      playlist: { maxPlayers: MAX_PLAYERS },
    });
    expect(
      privateShow({ rounds: ['crown-climb'], bots: true, maxPlayers: 8, timerScale: 0.1 }).roundTimeScale,
    ).toBe(0.5);
  });

  it('with bots off, only the seats the picked rounds need are filled', () => {
    const rounds = roundCatalog();
    const finalOnly = privateShow({ rounds: ['crown-climb'], bots: false, maxPlayers: 40, timerScale: 1 });
    expect(finalOnly.playlist.botsAllowed).toBe(false);
    expect(minimumShowSeats(finalOnly.playlist, rounds)).toBe(
      Math.max(2, rounds.get('crown-climb')?.players.min ?? 2),
    );
    const withTeam = privateShow({
      rounds: ['crown-climb', 'egg-heist'],
      bots: false,
      maxPlayers: 40,
      timerScale: 1,
    });
    const egg = rounds.get('egg-heist');
    if (egg) expect(minimumShowSeats(withTeam.playlist, rounds)).toBe(Math.max(2, egg.players.min));
  });
});
