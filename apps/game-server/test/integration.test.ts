/**
 * Seam check against the match team's real `createMatchSim` (with its public
 * test kit controller/obstacles and built-in bots), driven by the room and the
 * ShowDirector adapter. Catches contract drift between the room and the sim.
 */
import { describe, expect, it } from 'vitest';
import { loadRapier } from '@tumble/sim';
import {
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
} from '@tumble/sim/match';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { FakeConnection, TestClient } from './helpers.ts';

describe('Room + real MatchSim + ShowDirector', () => {
  it('plays a two-round show with 39 sim-driven bots and one networked human', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound();
    const clock = { now: 0 };
    const metrics = new ServerMetrics();
    const manager = new RoomManager(
      {
        R,
        createMatchSim: (o) =>
          createMatchSim(o, { createController: createSimpleController, obstacles: testObstacleModules() }),
        loadRound: () => round,
        createShowController: () =>
          new ShowDirectorController({
            rounds: [round],
            playlist: {
              id: 'net-test',
              name: 'Net test',
              description: 'two quick rounds',
              maxPlayers: 40,
              minRounds: 1,
              maxRounds: 2,
              finalAtOrBelow: 2,
              qualifyCurve: [0.65],
              pool: [{ roundId: round.id, weight: 1 }],
            },
            timings: {
              preShow: 1,
              loadingStall: 1,
              introFlyover: 1,
              rulesCard: 1,
              results: 2,
              transition: 1,
            },
          }),
        createBot: null,
        now: () => clock.now,
        randomSeed: () => 42,
      },
      metrics,
      null,
      { config: { capacity: 40, fillWaitMs: 100, startAtHumans: 40 }, profileLogMs: 0 },
    );
    const c = new TestClient(new FakeConnection());
    manager.accept(c.conn);
    c.hello('human');
    for (let i = 0; i < 30 * 60; i++) {
      c.input({ moveX: 0, moveZ: 1, yaw: 0, buttons: i % 40 < 5 ? 1 : 0, emote: 0 });
      c.input({ moveX: 0, moveZ: 1, yaw: 0, buttons: 0, emote: 0 });
      clock.now += 1000 / 30;
      manager.tick();
      c.pump(clock.now);
    }
    const count = (pred: (m: (typeof c.messages)[number]) => boolean): number =>
      c.messages.filter(pred).length;
    expect(c.lowFreq('joinRound').length).toBe(2);
    expect(c.lowFreq('roundResults').length).toBeGreaterThanOrEqual(1);
    expect(count((m) => m.kind === 'sim' && m.event.type === 'qualified')).toBeGreaterThan(10);
    expect(count((m) => m.kind === 'sim' && m.event.type === 'jump')).toBeGreaterThan(50);
    expect(c.snapshots.length).toBeGreaterThan(1000);
    expect(Math.max(...c.snapshots.map((s) => s.bytes))).toBeLessThanOrEqual(1200);
    expect(metrics.roomCrashes).toBe(0);
  }, 120_000);
});
