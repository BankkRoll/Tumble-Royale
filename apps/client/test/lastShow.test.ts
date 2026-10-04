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

describe('play again after a private online show', () => {
  it('reopens the same lobby for its host instead of queueing public matchmaking', () => {
    const next = playAgainAction({ kind: 'custom', options, lobby: { code: 'QWE234', host: true } });
    expect(next).toEqual({ action: 'reopenLobby', code: 'QWE234', options });
    if (next.action === 'reopenLobby') expect(next.options?.rounds).not.toBe(options.rounds);
  });

  it('takes a member back into the lobby with its code', () => {
    expect(playAgainAction({ kind: 'custom', options, lobby: { code: 'QWE234', host: false } })).toEqual({
      action: 'rejoinLobby',
      code: 'QWE234',
    });
  });

  it('goes back to the menu when the lobby is unknown (show rejoined after a reload)', () => {
    const next = playAgainAction({ kind: 'custom', options: null, lobby: { code: null, host: false } });
    expect(next.action).toBe('menu');
  });

  it('never turns a private show into a public queue, even for a party member', () => {
    const next = playAgainAction(
      { kind: 'custom', options, lobby: { code: 'QWE234', host: false } },
      { partyMember: true },
    );
    expect(next.action).toBe('rejoinLobby');
  });
});

describe('play again as a party member', () => {
  it('leaves the next online show to the leader', () => {
    for (const last of [{ kind: 'matchmade', playlistId: 'main-show' } as const, null]) {
      expect(playAgainAction(last, { partyMember: true })).toEqual({
        action: 'menu',
        title: 'The leader starts the next show',
        body: 'Hit Ready in the menu and hang tight.',
      });
    }
  });

  it('still replays a solo Vs Bots show', () => {
    expect(playAgainAction({ kind: 'offline', playlistId: 'main-show' }, { partyMember: true })).toEqual({
      action: 'offline',
      playlistId: 'main-show',
    });
  });
});
