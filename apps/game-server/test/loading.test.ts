/**
 * Round LOADING over the wire: the room holds a round until every connected
 * human acked `loaded`, keeps waiting on clients that report `loadProgress`,
 * forfeits ones that go quiet, and broadcasts the `loadingStatus` roster.
 * Fake clients + the real ShowDirector (through its room adapter) + the fake
 * MatchSim.
 */
import { describe, expect, it } from 'vitest';
import { RoundPhase } from '@tumble/shared';
import type { LowFreqMessage } from '@tumble/netcode';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { FakeConnection, TestClient, testDeps, testRound, type FakeMatchSim } from './helpers.ts';

const TICK_MS = 1000 / 30;

function setup() {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const round = testRound();
  const deps = testDeps(clock, sims);
  deps.createShowController = () =>
    new ShowDirectorController({
      rounds: [round],
      playlist: {
        id: 'load-test',
        name: 'Load test',
        maxPlayers: 40,
        minRounds: 1,
        maxRounds: 1,
        pool: [{ roundId: round.id, weight: 1 }],
      },
      timings: { preShow: 0.2, loadingStall: 15, loadingHardCap: 60 },
    });
  const manager = new RoomManager(deps, new ServerMetrics(), null, {
    config: { capacity: 6, fillWaitMs: 10_000, startAtHumans: 2, resumeWindowMs: 30_000 },
    profileLogMs: 0,
  });
  const connect = (name: string): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(name);
    c.pump(clock.now);
    return c;
  };
  const a = connect('fast');
  const b = connect('slow');
  const clients = [a, b];
  const tick = (each?: () => void): void => {
    each?.();
    clock.now += TICK_MS;
    manager.tick();
    for (const c of clients) c.pump(clock.now);
  };
  // Show starts (2 humans + 4 bots) and the round's joinRound goes out.
  for (let i = 0; i < 30 && a.lowFreq('joinRound').length === 0; i++) tick();
  const join = a.lowFreq('joinRound')[0];
  if (join?.t !== 'joinRound') throw new Error('no joinRound');
  return { clock, sims, a, b, tick, roundId: join.roundId };
}

const phases = (c: TestClient): number[] =>
  c.lowFreq('roundPhase').flatMap((m) => (m.t === 'roundPhase' ? [m.phase] : []));

const statuses = (c: TestClient): Extract<LowFreqMessage, { t: 'loadingStatus' }>[] =>
  c.lowFreq('loadingStatus').flatMap((m) => (m.t === 'loadingStatus' ? [m] : []));

describe('Room round loading', () => {
  it('keeps a slow but progressing loader in the round and starts everyone together', () => {
    const { sims, a, b, tick, roundId } = setup();
    a.send({ t: 'loaded', roundId });
    // 30 s of the slow client building, reporting progress every 500 ms.
    for (let i = 0; i < 30 * 30; i++) {
      tick(() => {
        if (i % 15 === 0) b.send({ t: 'loadProgress', roundId, pct: i / 900 });
      });
    }
    expect(phases(a)).not.toContain(RoundPhase.IntroFlyover);
    expect(phases(b)).not.toContain(RoundPhase.IntroFlyover);

    // Both clients see who the round is waiting on, at most 2 Hz.
    const seen = statuses(a);
    expect(seen.length).toBeGreaterThanOrEqual(25);
    expect(seen.length).toBeLessThanOrEqual(61);
    const bId = b.welcome!.playerId;
    expect(seen.at(-1)).toEqual({ t: 'loadingStatus', roundId, loaded: 1, total: 2, waitingOn: [bId] });
    expect(statuses(b).at(-1)?.waitingOn).toEqual([bId]);

    b.send({ t: 'loaded', roundId });
    tick();
    tick();
    expect(phases(a)).toContain(RoundPhase.IntroFlyover);
    expect(phases(b)).toContain(RoundPhase.IntroFlyover);
    // One broadcast on one server tick: both clients get the identical phase message.
    const intro = (c: TestClient) =>
      c.lowFreq('roundPhase').find((m) => m.t === 'roundPhase' && m.phase === RoundPhase.IntroFlyover);
    expect(intro(a)).toBeDefined();
    expect(intro(a)).toEqual(intro(b));
    expect(sims[0]!.forfeited).not.toContain(bId);
    const n = statuses(a).length;
    for (let i = 0; i < 60; i++) tick();
    // No roster chatter once the round left LOADING.
    expect(statuses(a).length).toBe(n);
  });

  it('forfeits a loader whose progress stalls', () => {
    const { sims, a, b, tick, roundId } = setup();
    a.send({ t: 'loaded', roundId });
    for (let i = 0; i < 60; i++) {
      tick(() => {
        if (i % 15 === 0) b.send({ t: 'loadProgress', roundId, pct: 0.1 });
      });
    }
    // Silence from here: 14 s in, still waiting.
    for (let i = 0; i < 14 * 30; i++) tick();
    expect(phases(a)).not.toContain(RoundPhase.IntroFlyover);
    for (let i = 0; i < 2 * 30; i++) tick();
    expect(phases(a)).toContain(RoundPhase.IntroFlyover);
    expect(sims[0]!.forfeited).toContain(b.welcome!.playerId);
  });

  it('does not wait on a player who disconnected', () => {
    const { a, b, tick, roundId } = setup();
    b.conn.close();
    a.send({ t: 'loaded', roundId });
    tick();
    tick();
    expect(phases(a)).toContain(RoundPhase.IntroFlyover);
  });

  it('ignores progress for another round and malformed percentages', () => {
    const { a, b, tick, roundId } = setup();
    a.send({ t: 'loaded', roundId });
    for (let i = 0; i < 16 * 30; i++) {
      tick(() => {
        if (i % 15 === 0) {
          b.send({ t: 'loadProgress', roundId: 'some-other-round', pct: 0.5 });
          b.send({ t: 'loadProgress', roundId, pct: Number.NaN });
        }
      });
    }
    expect(phases(a)).toContain(RoundPhase.IntroFlyover);
    expect(b.kicked).toBe(false);
  });
});
