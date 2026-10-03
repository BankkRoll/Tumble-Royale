import { RoundPhase, type RoundDefinition } from '@tumble/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, emptyInput, createTumblerController, type CharacterInput } from '../src/character/index.ts';
import { loadRapier } from '../src/index.ts';
import { createMatchSim, createTestArenaRound, type MatchSimHandle } from '../src/match/index.ts';
import { OBSTACLE_REGISTRY } from '../src/obstacles/index.ts';
import type { SimEvent } from '../src/events.ts';

const LAUNCH = { x: 0, y: 20.8, z: 3.2 };

/** One pad on the arena's start floor (top at y = 0), turned 90° so the authored +Z launch heads +X. */
async function padSim(height = 0.6): Promise<MatchSimHandle> {
  const R = await loadRapier();
  const pad: RoundDefinition['obstacles'][number] = {
    id: 'pad',
    type: 'bouncePad',
    position: { x: 0, y: 0, z: 2 },
    rotation: { yaw: 90 },
    params: { radius: 1.2, height, launch: LAUNCH, cooldown: 0.35 },
  };
  const sim = createMatchSim(
    {
      R,
      round: createTestArenaRound({ obstacles: [pad] }),
      seed: 3,
      stage: 0,
      players: [{ id: 0, name: 'P0', isBot: false, team: -1 }],
      mode: 'authority',
    },
    { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY },
  );
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
  return sim;
}

let sim: MatchSimHandle | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

describe('bounce pad', () => {
  it('landing on the top launches with exactly the authored (rotated) vector', async () => {
    sim = await padSim();
    const ctrl = sim.controller(0)!;
    ctrl.teleport({ x: 0.3, y: 2.5, z: 2.2 });
    let launched: { x: number; y: number; z: number } | undefined;
    for (let i = 0; i < 90 && !launched; i++) {
      sim.step();
      const evs = sim.events.drain() as SimEvent[];
      if (evs.some((e) => e.type === 'bounce' && e.player === 0)) launched = { ...ctrl.body.linvel() };
    }
    expect(launched).toBeDefined();
    // yaw 90° maps local +Z to world +X.
    expect(launched!.x).toBeCloseTo(LAUNCH.z, 3);
    expect(launched!.y).toBeCloseTo(LAUNCH.y, 3);
    expect(launched!.z).toBeCloseTo(0, 3);
  });

  it('a running jump onto the top keeps the authored vector, not run speed plus launch', async () => {
    sim = await padSim(0.3);
    const ctrl = sim.controller(0)!;
    ctrl.teleport({ x: -5, y: 0, z: 2 });
    const input: CharacterInput = { ...emptyInput(), moveZ: 1, yaw: Math.PI / 2 };
    let launched: { x: number; y: number; z: number } | undefined;
    for (let i = 0; i < 180 && !launched; i++) {
      input.buttons = i === 25 ? Button.Jump : 0;
      sim.setInput(0, input);
      sim.step();
      const evs = sim.events.drain() as SimEvent[];
      if (evs.some((e) => e.type === 'bounce' && e.player === 0 && ctrl.body.linvel().y > 15))
        launched = { ...ctrl.body.linvel() };
    }
    expect(launched).toBeDefined();
    expect(launched!.x).toBeCloseTo(LAUNCH.z, 3);
    expect(launched!.y).toBeCloseTo(LAUNCH.y, 3);
  });

  it('walking or jumping into the side never launches', async () => {
    sim = await padSim(0.6);
    const ctrl = sim.controller(0)!;
    // Approach from +X so the pad's launch heading (+X) points back at us: the worst case for a side kick.
    ctrl.teleport({ x: 5, y: 0, z: 2 });
    const input: CharacterInput = { ...emptyInput(), moveZ: 1, yaw: -Math.PI / 2 };
    let maxVy = -Infinity;
    let maxSpeed = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 240; i++) {
      // Hop against the side a few times like a climber trying to get up.
      input.buttons = i % 60 === 50 ? Button.Jump : 0;
      sim.setInput(0, input);
      sim.step();
      sim.events.drain();
      const v = ctrl.body.linvel();
      const p = ctrl.body.translation();
      maxVy = Math.max(maxVy, v.y);
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    // A jump rises at ~10 m/s; a launch would be ~21.
    expect(maxVy).toBeLessThan(14);
    expect(maxSpeed).toBeLessThan(14);
    // Stays pressed against the pad side rather than flung across (or off) the floor.
    expect(maxX).toBeLessThan(6);
    expect(minX).toBeGreaterThan(0.5);
  });
});
