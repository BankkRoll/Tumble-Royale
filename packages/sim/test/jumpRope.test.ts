import { RoundPhase, type RoundDefinition } from '@tumble/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterState, createTumblerController, emptyInput, type CharacterInput } from '../src/character/index.ts';
import { loadRapier } from '../src/index.ts';
import { createMatchSim, createTestArenaRound, type MatchSimHandle } from '../src/match/index.ts';
import { OBSTACLE_REGISTRY } from '../src/obstacles/index.ts';

const ARENA_R = 12;

/** A round sandbar (top at y = 0, radius 12) with one low rope arm sweeping CCW from +X. */
async function ropeSim(params: Record<string, unknown>): Promise<MatchSimHandle> {
  const R = await loadRapier();
  const rope: RoundDefinition['obstacles'][number] = {
    id: 'rope',
    type: 'jumpRopeBeam',
    position: { x: 0, y: 0, z: 0 },
    params: {
      mode: 'arm',
      layers: 'low',
      radius: ARENA_R,
      hubRadius: 1.5,
      direction: 1,
      startSpeed: 70,
      acceleration: 0,
      maxSpeed: 70,
      knockImpulse: 10,
      ...params,
    },
  };
  const sim = createMatchSim(
    {
      R,
      round: createTestArenaRound({
        // Input shape: createTestArenaRound parses it, filling the piece defaults.
        geometry: [{ shape: 'cylinder', position: { x: 0, y: -0.5, z: 0 }, size: { x: ARENA_R, y: 1, z: 0 } }] as RoundDefinition['geometry'],
        obstacles: [rope],
      }),
      seed: 9,
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

/** Polar angle (degrees, CCW seen from above in the rope's yaw convention) of a point around the hub. */
const ropeAngle = (x: number, z: number): number => (Math.atan2(-z, x) * 180) / Math.PI;

describe('jumpRopeBeam with the real controller', () => {
  it('trips a player who does not jump: stunned, stays on the sandbar, ends up behind the rope', async () => {
    sim = await ropeSim({});
    const ctrl = sim.controller(0)!;
    // Near the rim, a quarter turn ahead of the rope: the case that used to end in the lagoon.
    const r = ARENA_R - 1.5;
    const a0 = 90;
    ctrl.teleport({ x: r * Math.cos((a0 * Math.PI) / 180), y: 0, z: -r * Math.sin((a0 * Math.PI) / 180) });
    let stunned = false;
    let maxSpeed = 0;
    let maxR = 0;
    let lowest = Infinity;
    // 70°/s reaches the player after ~1.3 s; watch until the rope is well past.
    for (let i = 0; i < 60 * 3; i++) {
      sim.step();
      sim.events.drain();
      if (ctrl.state === CharacterState.Stunned) stunned = true;
      const v = ctrl.body.linvel();
      const p = ctrl.body.translation();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      maxR = Math.max(maxR, Math.hypot(p.x, p.z));
      lowest = Math.min(lowest, p.y);
    }
    expect(stunned).toBe(true);
    expect(maxSpeed).toBeLessThan(9);
    expect(maxR).toBeLessThan(ARENA_R);
    expect(lowest).toBeGreaterThan(0);
    expect(sim.getStatus().players.get(0)?.status).toBe(0);
    // Not carried along the sweep: still within a few degrees of (or behind) where it stood.
    const p = ctrl.body.translation();
    expect(ropeAngle(p.x, p.z)).toBeLessThan(a0 + 5);
  });

  it('a rope waiting on startDelay does not launch a player pressed against it, then only trips them', async () => {
    sim = await ropeSim({ startDelay: 3 });
    const ctrl = sim.controller(0)!;
    // The still rope lies along +X at 0.55 m; stand beside it and walk into it.
    ctrl.teleport({ x: 6, y: 0, z: 1.2 });
    const input: CharacterInput = { ...emptyInput(), moveZ: 1, yaw: Math.PI };
    let maxVyBefore = -Infinity;
    let stunnedBefore = false;
    for (let i = 0; i < 60 * 2.5; i++) {
      sim.setInput(0, input);
      sim.step();
      sim.events.drain();
      maxVyBefore = Math.max(maxVyBefore, ctrl.body.linvel().y);
      if (ctrl.state === CharacterState.Stunned) stunnedBefore = true;
    }
    expect(maxVyBefore).toBeLessThan(1);
    expect(stunnedBefore).toBe(false);

    // Stand inside the rope's footprint as it starts moving.
    sim.setInput(0, emptyInput());
    ctrl.teleport({ x: 6, y: 0, z: 0 });
    let maxVy = -Infinity;
    let stunned = false;
    for (let i = 0; i < 60 * 2; i++) {
      sim.step();
      sim.events.drain();
      maxVy = Math.max(maxVy, ctrl.body.linvel().y);
      if (ctrl.state === CharacterState.Stunned) stunned = true;
    }
    expect(stunned).toBe(true);
    expect(maxVy).toBeLessThan(7);
    const p = ctrl.body.translation();
    expect(Math.hypot(p.x, p.z)).toBeLessThan(ARENA_R);
    expect(p.y).toBeGreaterThan(0);
  });
});
