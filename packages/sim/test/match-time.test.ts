import { describe, expect, it } from 'vitest';
import { RoundPhase } from '@tumble/shared';
import { loadRapier } from '../src/index.ts';
import {
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
} from '../src/match/index.ts';

async function makeSim() {
  const R = await loadRapier();
  const sim = createMatchSim(
    {
      R,
      round: createTestArenaRound(),
      seed: 3,
      stage: 0,
      players: [{ id: 0, name: 'p', isBot: false, team: -1 }],
      mode: 'predict',
      localPlayerId: 0,
    },
    { createController: createSimpleController, obstacles: testObstacleModules() },
  );
  sim.setPhase(RoundPhase.Playing, 0);
  return sim;
}

function kinematicPoses(sim: Awaited<ReturnType<typeof makeSim>>): number[] {
  const out: number[] = [];
  sim.world.forEachRigidBody((b) => {
    if (!b.isKinematic()) return;
    const p = b.translation();
    const q = b.rotation();
    out.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
  });
  return out;
}

describe('MatchSim.setTime', () => {
  it('snaps kinematic obstacles to the pose a normally-stepped sim reaches', async () => {
    const stepped = await makeSim();
    // Obstacles pose themselves at the start of each step, so after N steps the
    // bodies sit at pose(t_N - dt); jump the other sim to that same time.
    for (let i = 0; i < 300; i++) stepped.step();
    const target = stepped.time - stepped.world.timestep;

    const jumped = await makeSim();
    jumped.setTime!(target);

    const a = kinematicPoses(stepped);
    const b = kinematicPoses(jumped);
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]!).toBeCloseTo(a[i]!, 3);
    stepped.dispose();
    jumped.dispose();
  });
});
