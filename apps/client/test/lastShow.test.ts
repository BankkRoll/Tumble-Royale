/** Play again replays exactly the last show: mode, playlist and private-show options. */
import { describe, expect, it } from 'vitest';
import type { CustomLobbyOptions } from '@tumble/ui';
import { playAgainAction } from '../src/game/lastShow.ts';

const options: CustomLobbyOptions = {
  rounds: ['gumdrop-gauntlet', 'tilt-town'],
  bots: true,
  maxPlayers: 20,
  timerScale: 1.5,
  spectators: false,
  isPrivate: true,
};

describe('play again', () => {
  it('replays a Vs Bots show offline even when online play is reachable', () => {
    expect(playAgainAction({ kind: 'offline', playlistId: 'squads-show' })).toEqual({
      action: 'offline',
      playlistId: 'squads-show',
    });
  });

  it('replays an offline private show with the same rounds and options', () => {
    const next = playAgainAction({ kind: 'custom', options });
    expect(next).toEqual({ action: 'custom', options });
    if (next.action !== 'custom') throw new Error('expected a custom show');
    expect(next.options.rounds).not.toBe(options.rounds);
  });

  it('queues a matchmade show again on its playlist', () => {
    expect(playAgainAction({ kind: 'matchmade', playlistId: 'main-show' })).toEqual({
      action: 'play',
      playlistId: 'main-show',
    });
  });

  it('keeps the default routing for a show started with plain Play', () => {
    expect(playAgainAction({ kind: 'auto', playlistId: 'main-show' })).toEqual({
      action: 'play',
      playlistId: 'main-show',
    });
  });

  it('falls back to a normal Play with no last show (right after the tutorial)', () => {
    expect(playAgainAction(null)).toEqual({ action: 'play', playlistId: null });
  });
});
