/**
 * Show session flow that needs no 3D: a round that cannot be built is
 * retried once, then the held loading wipe lets go behind an error that
 * leads back to the menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ui, uiEvents } from '@tumble/ui';
import type { GameContext, RoundStart, SessionEnd } from '../src/game/show/context.ts';
import { ShowSession } from '../src/game/show/session.ts';
import type { RoundSource } from '../src/game/round/source.ts';
import { installFakeDom } from './fakeDom.ts';

class BrokenRoundSession extends ShowSession {
  sources = 0;

  start(): void {}
  protected advance(): void {}
  protected liveStatus(): null {
    return null;
  }
  protected createSource(_rs: RoundStart): RoundSource | null {
    this.sources++;
    return {} as RoundSource;
  }

  /** Puts a round under the held loading wipe and asks for its build. */
  load(): void {
    this.round = {
      start: {
        index: 0,
        isFinal: false,
        round: { id: 'broken' },
        players: [],
        seed: 1,
        stage: 0,
        qualifyTarget: 1,
      },
      source: null,
      view: null,
      hud: null,
      fate: 'playing',
      inRound: true,
      loadRequested: true,
      building: false,
      buildRetried: false,
      loadPct: 0,
      waited: false,
      everyoneIn: false,
      introShown: true,
      loadMinDone: false,
      outcome: null,
      resultsShown: false,
      countdown: null,
      spectateId: -1,
      playingSince: 0,
    } as unknown as NonNullable<ShowSession['round']>;
    this.requestRoundBuild();
  }
}

function fakeContext(ends: SessionEnd[]): GameContext {
  return {
    cfg: { timeScale: 1 },
    tumblers: { create: () => ({}) },
    input: { touch: null, settings: {} },
    director: { deferUntilSwap: () => undefined },
    settings: () => {
      throw new Error('the round could not be built');
    },
    onEnd: (reason: SessionEnd) => ends.push(reason),
  } as unknown as GameContext;
}

describe('show session: a round that cannot be built', () => {
  let ends: SessionEnd[];
  let session: BrokenRoundSession;

  beforeEach(() => {
    installFakeDom();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ends = [];
    ui.getState().closeDialog();
    ui.getState().setScreen('roundLoading', { transition: 'wipe', hold: true });
    ui.getState()._wipeCovered();
    expect(ui.getState().wipe.phase).toBe('covered');
    session = new BrokenRoundSession(fakeContext(ends));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries once, then lifts the wipe behind an error that leads back to the menu', async () => {
    session.load();
    await vi.waitFor(() => expect(ui.getState().dialog?.id).toBe('round-load-failed'));
    expect(session.sources).toBe(2);
    expect(ui.getState().wipe.phase).toBe('revealing');
    uiEvents.emit('dialogResult', { dialogId: 'round-load-failed', buttonId: 'menu' });
    expect(ends).toEqual(['failed']);
    session.dispose();
  });
});

class LateRewardSession extends BrokenRoundSession {
  protected override rewardsPending(): boolean {
    return true;
  }

  /** Puts the show on the player wall with its recap in. */
  onWall(): void {
    Object.assign(this, { awaiting: 'wall', summary: { rounds: [], placements: new Map() } });
  }
}

describe('show session: Continue while the online reward is late', () => {
  beforeEach(() => installFakeDom());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps one wait going however often Continue is pressed', () => {
    const session = new LateRewardSession(fakeContext([]));
    const waits = vi.spyOn(session as unknown as { after: (s: number, fn: () => void) => void }, 'after');
    session.onWall();
    uiEvents.emit('continue', { from: 'playerWall' });
    uiEvents.emit('continue', { from: 'playerWall' });
    uiEvents.emit('continue', { from: 'playerWall' });
    expect(waits).toHaveBeenCalledTimes(1);
    session.dispose();
  });
});
