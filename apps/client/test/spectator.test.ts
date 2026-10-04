/**
 * The knocked-out flow: what the show does with a local player who is out
 * (sheet, the post-results "Keep watching / Leave show" choice, spectating to
 * the end), spectate target cycling, and an offline show that keeps running
 * with bots after the human is eliminated.
 */
import { MAX_ENTITIES } from '@tumble/netcode';
import { ShowPhase } from '@tumble/shared';
import { loadRapier } from '@tumble/sim';
import { createSimpleController, createTestArenaRound, testObstacleModules } from '@tumble/sim/match';
import { createOfflineShow } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import {
  AUTO_KEEP_WATCHING_S,
  ELIMINATED_SHEET_DELAY_S,
  SpectatePadCycler,
  afterRoundResults,
  autoKeepWatchingAfter,
  cycleSpectateIndex,
  isOutOfShow,
  isSpectatorId,
  planAfterEliminated,
  spectateCandidates,
  spectateDetail,
  type SpectateStatus,
} from '../src/game/show/spectator.ts';

describe('spectator seats', () => {
  it('are the ids above the player range', () => {
    expect(isSpectatorId(0)).toBe(false);
    expect(isSpectatorId(MAX_ENTITIES - 1)).toBe(false);
    expect(isSpectatorId(MAX_ENTITIES)).toBe(true);
    expect(isSpectatorId(254)).toBe(true);
  });
});

const AUTO = { autoSpectate: true, autoplay: false };
const MANUAL = { autoSpectate: false, autoplay: false };

describe('after the local player is knocked out of a round', () => {
  it('offers Keep watching / Leave show, auto-picking Keep watching with Auto-spectate', () => {
    expect(planAfterEliminated('undecided', AUTO)).toEqual({
      kind: 'sheet',
      afterS: ELIMINATED_SHEET_DELAY_S,
      autoAfterS: AUTO_KEEP_WATCHING_S,
    });
  });

  it('waits for the player when Auto-spectate is off', () => {
    expect(planAfterEliminated('undecided', MANUAL)).toMatchObject({ kind: 'sheet', autoAfterS: null });
  });

  it('never asks twice: a player who chose to keep watching just spectates', () => {
    expect(planAfterEliminated('watching', MANUAL)).toEqual({
      kind: 'spectate',
      afterS: ELIMINATED_SHEET_DELAY_S,
    });
  });

  it('never waits on a human under the autoplay pilot', () => {
    expect(autoKeepWatchingAfter({ autoSpectate: false, autoplay: true })).toBeGreaterThan(0);
  });
});

describe('after a results wall', () => {
  it('carries on as a player when the local player qualified', () => {
    expect(afterRoundResults({ inRound: true, qualified: true, isFinal: false }, 'undecided', AUTO)).toEqual({
      kind: 'stillIn',
    });
  });

  it('asks Keep watching / Leave show when just knocked out of the show', () => {
    expect(afterRoundResults({ inRound: true, qualified: false, isFinal: false }, 'undecided', AUTO)).toEqual(
      {
        kind: 'ask',
        autoAfterS: AUTO_KEEP_WATCHING_S,
      },
    );
    expect(
      afterRoundResults({ inRound: true, qualified: false, isFinal: false }, 'undecided', MANUAL),
    ).toEqual({ kind: 'ask', autoAfterS: null });
  });

  it('keeps spectating every later round once the player chose to watch', () => {
    expect(
      afterRoundResults({ inRound: true, qualified: false, isFinal: false }, 'watching', MANUAL),
    ).toEqual({
      kind: 'spectate',
    });
    expect(
      afterRoundResults({ inRound: false, qualified: false, isFinal: false }, 'watching', MANUAL),
    ).toEqual({ kind: 'spectate' });
  });

  it('a spectator in a round they never entered keeps watching without being asked again', () => {
    expect(
      afterRoundResults({ inRound: false, qualified: false, isFinal: false }, 'undecided', MANUAL),
    ).toEqual({ kind: 'spectate' });
  });

  it('after the final the show ends for everyone (winner, wall, rewards)', () => {
    for (const qualified of [true, false])
      expect(afterRoundResults({ inRound: true, qualified, isFinal: true }, 'undecided', MANUAL)).toEqual({
        kind: 'showOver',
      });
  });

  it('knows who is out of the show', () => {
    expect(isOutOfShow(null)).toBe(false);
    expect(isOutOfShow({ inRound: true, qualified: true })).toBe(false);
    expect(isOutOfShow({ inRound: true, qualified: false })).toBe(true);
    expect(isOutOfShow({ inRound: false, qualified: false })).toBe(true);
  });
});

describe('spectate targets', () => {
  const status = new Map<number, SpectateStatus>([
    [1, 'playing'],
    [2, 'eliminated'],
    [3, 'qualified'],
    [4, 'playing'],
  ]);

  it('lists still-playing Tumblers in standings order, never the local player', () => {
    expect(spectateCandidates([4, 0, 3, 1, 2], 0, (id) => status.get(id))).toEqual([4, 1]);
  });

  it('falls back to everyone else once nobody is still playing', () => {
    const done = (id: number): SpectateStatus => (id === 3 ? 'qualified' : 'eliminated');
    expect(spectateCandidates([3, 0, 2], 0, done)).toEqual([3, 2]);
  });

  it('treats unknown status as playing (online, before the first snapshot)', () => {
    expect(spectateCandidates([5, 6], 0, () => undefined)).toEqual([5, 6]);
  });

  it('cycles both ways and wraps', () => {
    const list = [10, 11, 12];
    expect(cycleSpectateIndex(list, 10, 1)).toBe(1);
    expect(cycleSpectateIndex(list, 12, 1)).toBe(0);
    expect(cycleSpectateIndex(list, 10, -1)).toBe(2);
    expect(cycleSpectateIndex(list, 99, 1)).toBe(0);
    expect(cycleSpectateIndex(list, 99, -1)).toBe(2);
    expect(cycleSpectateIndex([], 10, 1)).toBe(-1);
  });

  it('describes the watched player', () => {
    expect(spectateDetail(0, false)).toBe('In the lead');
    expect(spectateDetail(1, false)).toBe('2nd place');
    expect(spectateDetail(2, false)).toBe('3rd place');
    expect(spectateDetail(3, false)).toBe('4th place');
    expect(spectateDetail(10, false)).toBe('11th place');
    expect(spectateDetail(20, false)).toBe('21st place');
    expect(spectateDetail(5, true)).toBe('Qualified!');
  });

  it('turns shoulder-button presses into single cycle steps', () => {
    const pad = new SpectatePadCycler();
    expect(pad.update(false, true)).toBe(1);
    expect(pad.update(false, true)).toBe(0);
    expect(pad.update(false, false)).toBe(0);
    expect(pad.update(true, false)).toBe(-1);
    pad.reset(true, true);
    expect(pad.update(true, true)).toBe(0);
  });
});

describe('offline show after the human is knocked out', () => {
  it('keeps running every remaining round with bots to a winner', async () => {
    const R = await loadRapier();
    const rounds = [
      createTestArenaRound({ id: 'gumdrop-gauntlet', duration: { seconds: 30, overtimeSeconds: 0 } }),
      createTestArenaRound({ id: 'conveyor-chaos', duration: { seconds: 30, overtimeSeconds: 0 } }),
      createTestArenaRound({ id: 'tilt-town', duration: { seconds: 30, overtimeSeconds: 0 } }),
    ];
    const show = createOfflineShow({
      R,
      deps: { createController: createSimpleController, obstacles: testObstacleModules() },
      playlist: {
        id: 'test',
        name: 'Test',
        minRounds: 3,
        maxRounds: 3,
        finalAtOrBelow: 2,
        pool: rounds.map((r) => ({ roundId: r.id })),
      },
      rounds,
      seed: 21,
      humanName: 'You',
      players: 12,
      timings: {
        preShow: 0.2,
        introFlyover: 0.2,
        rulesCard: 0.2,
        results: 0.2,
        transition: 0.2,
        victory: 0.2,
      },
    });
    const entrants: number[][] = [];
    let forfeited = false;
    show.director.on((e) => {
      if (e.type === 'roundSelected')
        entrants.push(show.match ? [...show.match.getStatus().players.keys()] : []);
    });
    for (let i = 0; i < 60 * 60 * 6 && show.director.current().showPhase !== ShowPhase.Ended; i++) {
      // Knock the human out as soon as the first round is live.
      if (!forfeited && show.match && entrants.length === 1) {
        show.match.forfeit(show.humanId);
        forfeited = true;
      }
      show.advance(1 / 60);
    }
    const summary = show.director.summary();
    expect(forfeited).toBe(true);
    expect(show.director.current().showPhase).toBe(ShowPhase.Ended);
    expect(summary?.rounds.length).toBeGreaterThanOrEqual(2);
    expect(summary?.rounds[0]?.eliminated).toContain(show.humanId);
    for (const later of entrants.slice(1)) expect(later).not.toContain(show.humanId);
    expect(summary?.winner).not.toBe(show.humanId);
    expect(summary?.winner).not.toBeNull();
    show.dispose();
  }, 60_000);
});
