import { loadRapier } from '@tumble/sim';
import {
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
  type MatchSimOptions,
} from '@tumble/sim/match';
import { pickMutator } from '@tumble/sim/mutators';
import { describe, expect, it } from 'vitest';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { FakeConnection, TestClient } from './helpers.ts';

const round = createTestArenaRound();
const MUTATORS = [
  { id: 'moon-bounce', weight: 1 },
  { id: 'gusty', weight: 1 },
  { id: 'speed-demons', weight: 1 },
];
const playlist = {
  id: 'chaos-test',
  name: 'Chaos test',
  maxPlayers: 40,
  minRounds: 1,
  maxRounds: 2,
  finalAtOrBelow: 2,
  pool: [{ roundId: round.id, weight: 1 }],
  mutators: MUTATORS,
};

describe('show mutators and round time scale online', () => {
  it('the director controller puts both on every round plan', () => {
    const show = new ShowDirectorController({
      rounds: [round],
      playlist,
      roundTimeScale: 1.5,
      timings: { preShow: 1 },
    });
    show.start(
      Array.from({ length: 10 }, (_, i) => ({ id: i, name: `P${i}`, isBot: true, team: -1 })),
      1234,
    );
    for (let i = 0; i < 5; i++) show.onTick(0.5, { status: null, presentPlayers: new Set() });
    const start = show.drainEvents().find((e) => e.type === 'roundStart');
    expect(start?.type).toBe('roundStart');
    if (start?.type !== 'roundStart') return;
    expect(start.plan.mutatorId).toBe(pickMutator(1234, MUTATORS));
    expect(start.plan.roundTimeScale).toBe(1.5);
  });

  it('the room builds its sim with them and tells clients in joinRound', async () => {
    const R = await loadRapier();
    const clock = { now: 0 };
    const simOpts: MatchSimOptions[] = [];
    const manager = new RoomManager(
      {
        R,
        createMatchSim: (o) => {
          simOpts.push(o);
          return createMatchSim(o, {
            createController: createSimpleController,
            obstacles: testObstacleModules(),
          });
        },
        loadRound: () => round,
        createShowController: () =>
          new ShowDirectorController({
            rounds: [round],
            playlist,
            roundTimeScale: 0.5,
            timings: { preShow: 1, loadingMax: 1 },
          }),
        createBot: null,
        now: () => clock.now,
        randomSeed: () => 42,
      },
      new ServerMetrics(),
      null,
      { config: { capacity: 4, fillWaitMs: 100, startAtHumans: 4 }, profileLogMs: 0 },
    );
    const c = new TestClient(new FakeConnection());
    manager.accept(c.conn);
    c.hello('human');
    for (let i = 0; i < 30 * 5 && c.lowFreq('joinRound').length === 0; i++) {
      clock.now += 1000 / 30;
      manager.tick();
      c.pump(clock.now);
    }
    const join = c.lowFreq('joinRound')[0] as
      { mutatorId?: string | null; roundTimeScale?: number } | undefined;
    expect(join).toBeDefined();
    expect(join?.mutatorId).toBeTruthy();
    expect(join?.roundTimeScale).toBe(0.5);
    expect(simOpts[0]?.mutatorId).toBe(join?.mutatorId);
    expect(simOpts[0]?.roundTimeScale).toBe(0.5);
    manager.stop();
  });
});
