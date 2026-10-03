import { RoundDefinitionSchema, RoundPhase, type RoundDefinition, type StaticPiece } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { emptyInput, Button, type CharacterFullState } from '../src/character/types.ts';
import { hashFloats, loadRapier, type Rapier } from '../src/index.ts';
import {
  PlayerRoundStatus,
  chooseVariation,
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  pieceParts,
  resolveObstacles,
  spawnSlots,
  testObstacleModules,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '../src/match/index.ts';
import type { SimEvent } from '../src/events.ts';

const deps = () => ({ createController: createSimpleController, obstacles: testObstacleModules() });

function players(n: number, bots: 'none' | 'all' | 'half' = 'none'): MatchPlayerInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `P${i}`,
    isBot: bots === 'all' || (bots === 'half' && i % 2 === 1),
    team: -1,
    botSkill: (['clumsy', 'average', 'sharp'] as const)[i % 3],
  }));
}

function fullState(): CharacterFullState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 0,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
}

function startPlaying(sim: MatchSimHandle): void {
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
}

/** Deterministic scripted inputs: forward with weaving and periodic jumps. */
function scriptedInput(sim: MatchSimHandle, ids: readonly number[], step: number): void {
  const input = emptyInput();
  for (const id of ids) {
    input.moveZ = 1;
    input.moveX = Math.sin(step * 0.05 + id) * 0.4;
    input.yaw = 0;
    input.buttons = (step + id * 7) % 50 < 12 ? Button.Jump : 0;
    sim.setInput(id, input);
  }
}

function stateHash(sim: MatchSimHandle, ids: readonly number[]): string {
  const s = fullState();
  const values: number[] = [];
  for (const id of ids) {
    sim.getPlayerState(id, s);
    values.push(s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.state);
  }
  return hashFloats(values);
}

describe('createMatchSim', () => {
  let R: Rapier;

  it('builds the test arena and steps 40 players for 600 steps', async () => {
    R = await loadRapier();
    const round = createTestArenaRound();
    const ids = Array.from({ length: 40 }, (_, i) => i);
    const sim = createMatchSim({ R, round, seed: 7, stage: 0, players: players(40), mode: 'authority' }, deps());
    expect(sim.warnings).toEqual([]);
    expect(sim.obstacleRuntimes).toHaveLength(2);
    expect(sim.phase).toBe(RoundPhase.Loading);
    startPlaying(sim);
    for (let i = 0; i < 600; i++) {
      scriptedInput(sim, ids, i);
      sim.step();
    }
    const s = fullState();
    for (const id of ids) {
      expect(sim.getPlayerState(id, s)).toBe(true);
      expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
    }
    const st = sim.getStatus();
    expect(st.players.size).toBe(40);
    expect(st.qualifyTarget).toBe(26);
    expect(sim.getStandings()).toHaveLength(40);
    expect(sim.time).toBeCloseTo(10, 5);
    sim.dispose();
  });

  it('is deterministic for the same seed and inputs (humans and bots)', async () => {
    R = await loadRapier();
    const run = (): string => {
      const sim = createMatchSim(
        { R, round: createTestArenaRound(), seed: 99, stage: 1, players: players(24, 'half'), mode: 'authority' },
        deps(),
      );
      const humans = Array.from({ length: 12 }, (_, i) => i * 2);
      startPlaying(sim);
      for (let i = 0; i < 600; i++) {
        scriptedInput(sim, humans, i);
        sim.step();
      }
      const h = stateHash(sim, Array.from({ length: 24 }, (_, i) => i));
      sim.dispose();
      return h;
    };
    expect(run()).toBe(run());
  });

  it('keeps players frozen on the start grid during the countdown', async () => {
    R = await loadRapier();
    const sim = createMatchSim({ R, round: createTestArenaRound(), seed: 1, stage: 0, players: players(4), mode: 'offline' }, deps());
    const s = fullState();
    sim.getPlayerState(0, s);
    const z0 = s.pos.z;
    sim.setPhase(RoundPhase.Countdown);
    expect(sim.time).toBe(-3);
    for (let i = 0; i < 120; i++) {
      scriptedInput(sim, [0, 1, 2, 3], i);
      sim.step();
    }
    sim.getPlayerState(0, s);
    expect(Math.abs(s.pos.z - z0)).toBeLessThan(0.05);
    expect(sim.time).toBeLessThan(0);
    sim.dispose();
  });

  it('respawns fallers at their checkpoint after the delay, with ghosting', async () => {
    R = await loadRapier();
    const sim = createMatchSim({ R, round: createTestArenaRound(), seed: 3, stage: 0, players: players(2), mode: 'authority' }, deps());
    startPlaying(sim);
    const ctrl = sim.controller(0)!;
    ctrl.teleport({ x: 0, y: 3.2, z: 30 });
    for (let i = 0; i < 5; i++) sim.step();
    ctrl.teleport({ x: 30, y: -15, z: 30 });
    const seen: SimEvent[] = [];
    for (let i = 0; i < 100; i++) {
      sim.step();
      seen.push(...sim.events.drain());
    }
    const fell = seen.find((e) => e.type === 'fellOut');
    const respawn = seen.find((e) => e.type === 'respawn');
    expect(fell).toBeDefined();
    expect(respawn).toBeDefined();
    if (respawn?.type === 'respawn') {
      expect(respawn.pos.z).toBeGreaterThan(28);
      expect(respawn.pos.z).toBeLessThan(32);
    }
    expect(seen.some((e) => e.type === 'checkpoint')).toBe(true);
    expect(sim.getStatus().players.get(0)?.status).toBe(PlayerRoundStatus.Playing);
    sim.dispose();
  });

  it('eliminates fallers when the round says so', async () => {
    R = await loadRapier();
    const round = createTestArenaRound({ fallBehavior: 'eliminate' });
    const sim = createMatchSim({ R, round, seed: 3, stage: 0, players: players(3), mode: 'authority' }, deps());
    startPlaying(sim);
    sim.controller(1)!.teleport({ x: 0, y: -30, z: 0 });
    sim.step();
    const st = sim.getStatus();
    expect(st.players.get(1)?.status).toBe(PlayerRoundStatus.Eliminated);
    expect(st.players.get(1)?.place).toBe(3);
    expect(st.eliminatedCount).toBe(1);
    sim.dispose();
  });

  it('routes obstacle sensors and replicates obstacle net state', async () => {
    R = await loadRapier();
    const sim = createMatchSim({ R, round: createTestArenaRound(), seed: 5, stage: 0, players: players(1), mode: 'authority' }, deps());
    startPlaying(sim);
    sim.controller(0)!.teleport({ x: 3.5, y: 2.5, z: 16 });
    const seen: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      sim.step();
      seen.push(...sim.events.drain());
    }
    expect(seen.some((e) => e.type === 'bounce')).toBe(true);
    const net = sim.getObstacleNetStates();
    expect(net.get('pad-1')?.[0]).toBeGreaterThan(0);
    sim.setObstacleNetState('pad-1', [0]);
    expect(sim.getObstacleNetStates().get('pad-1')).toEqual([0]);
    sim.dispose();
  });

  it('predict mode simulates only the local player; remote players are kinematic proxies', async () => {
    R = await loadRapier();
    const sim = createMatchSim(
      { R, round: createTestArenaRound(), seed: 5, stage: 0, players: players(3), mode: 'predict', localPlayerId: 1 },
      deps(),
    );
    expect(sim.rules).toBeNull();
    startPlaying(sim);
    sim.setRemoteProxy(0, { x: 4, y: 1, z: 2 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 1 }, 1);
    sim.step();
    const s = fullState();
    sim.getPlayerState(0, s);
    expect(s.pos).toEqual({ x: 4, y: 1, z: 2 });
    expect(s.state).toBe(1);
    expect(sim.controller(0)!.body.isKinematic()).toBe(true);
    expect(sim.controller(1)!.body.isDynamic()).toBe(true);
    sim.dispose();
  });

  it('predicts obstacle clearance from pose(t) for bots (waitForGap)', async () => {
    R = await loadRapier();
    const round = createTestArenaRound({
      obstacles: [{ id: 'sweep-off', type: 'sweeperArm', position: { x: 6, y: 2, z: 36 }, params: { length: 14, speed: 1.3 } }],
    });
    const sim = createMatchSim({ R, round, seed: 4, stage: 2, players: players(1), mode: 'authority' }, deps());
    startPlaying(sim);
    for (let i = 0; i < 10; i++) sim.step();
    const view = sim.botView;
    const P = { x: 0, y: 2.3, z: 36 };
    let checked = 0;
    for (let trial = 0; trial < 8; trial++) {
      const ahead = 0.25 + trial * 0.2;
      const predicted = view.obstacleClearance('sweep-off', P, ahead);
      const steps = Math.round(ahead * 60);
      for (let i = 0; i < steps; i++) sim.step();
      const actual = view.obstacleClearance('sweep-off', P, 0);
      expect(Math.abs(predicted - actual)).toBeLessThan(0.15);
      if (actual < 1) checked++;
    }
    expect(view.obstacleClearance('nope', P, 0)).toBe(Infinity);
    expect(view.hazardDistance({ x: 6, y: 2.3, z: 36 }, 5, 0)).toBeLessThan(0.5);
    expect(view.groundBelow({ x: 0, y: 3, z: 36 }, 5)).toBe(true);
    expect(view.groundBelow({ x: 30, y: 3, z: 36 }, 5)).toBe(false);
    expect(checked).toBeGreaterThan(0);
    sim.dispose();
  });

  it('reports unknown obstacle types as warnings instead of failing', async () => {
    R = await loadRapier();
    const round = createTestArenaRound({
      obstacles: [{ id: 'mystery', type: 'cannon', position: { x: 0, y: 0, z: 10 }, params: {} }],
    });
    const sim = createMatchSim({ R, round, seed: 1, stage: 0, players: players(2), mode: 'offline' }, deps());
    expect(sim.warnings[0]).toMatch(/mystery/);
    sim.dispose();
  });
});

describe('level building', () => {
  it('creates colliders for every static shape', async () => {
    const R = await loadRapier();
    const shapes: StaticPiece['shape'][] = ['box', 'cylinder', 'ramp', 'wedge', 'sphere', 'hexPrism', 'torus', 'arch'];
    for (const shape of shapes) {
      const piece = RoundDefinitionSchema.shape.geometry.element.parse({
        shape,
        position: { x: 1, y: 2, z: 3 },
        rotation: { yaw: 30, pitch: 10 },
        size: { x: 3, y: 1, z: 2 },
      });
      const parts = pieceParts(R, piece);
      expect(parts.length, shape).toBeGreaterThan(0);
    }
  });

  it('picks variations by seed and applies overrides, removals and additions', () => {
    const base = createTestArenaRound();
    const round: RoundDefinition = RoundDefinitionSchema.parse({
      ...base,
      variations: [
        { id: 'calm', weight: 1, description: 'slow', obstacleParams: { 'sweep-1': { speed: 0.5 } } },
        {
          id: 'chaos',
          weight: 3,
          description: 'more',
          removeObstacles: ['pad-1'],
          addObstacles: [{ id: 'sweep-2', type: 'sweeperArm', position: { x: 0, y: 2, z: 50 }, params: {} }],
        },
      ],
    });
    const picks = new Map<string, number>();
    for (let seed = 0; seed < 200; seed++) {
      const v = chooseVariation(round, seed);
      picks.set(v!.id, (picks.get(v!.id) ?? 0) + 1);
      expect(chooseVariation(round, seed)!.id).toBe(v!.id);
    }
    expect(picks.get('chaos')!).toBeGreaterThan(picks.get('calm')!);
    const calm = resolveObstacles(round, chooseVariation(round, 0, 'calm'));
    expect(calm.find((o) => o.id === 'sweep-1')?.params).toMatchObject({ length: 9, speed: 0.5 });
    const chaos = resolveObstacles(round, chooseVariation(round, 0, 'chaos'));
    expect(chaos.map((o) => o.id).sort()).toEqual(['sweep-1', 'sweep-2']);
  });

  it('lays out spawn grids per team without overlaps', () => {
    const round = createTestArenaRound({
      spawn: {
        origin: { x: 0, y: 0, z: 0 },
        yaw: 90,
        cols: 4,
        spacing: 1.5,
        teamOrigins: [
          { x: -10, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
      },
    });
    const teams = Array.from({ length: 16 }, (_, i) => i % 2);
    const slots = spawnSlots(round, 1, teams);
    for (let i = 0; i < slots.length; i++) {
      expect(Math.sign(slots[i]!.pos.x)).toBe(teams[i] === 0 ? -1 : 1);
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i]!.pos.x - slots[j]!.pos.x, slots[i]!.pos.z - slots[j]!.pos.z);
        expect(d).toBeGreaterThan(1.4);
      }
    }
  });
});
