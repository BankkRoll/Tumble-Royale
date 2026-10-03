import { Rng, RoundPhase } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { BOT_SKILLS, NavGraph, generateBotName, generateBotNames, pickSkill } from '../src/bots/index.ts';
import { loadRapier } from '../src/index.ts';
import {
  PlayerRoundStatus,
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '../src/match/index.ts';
import { CourseMetric } from '../src/rounds/index.ts';

function bots(n: number, skill: 'clumsy' | 'average' | 'sharp'): MatchPlayerInfo[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `Bot${i}`, isBot: true, team: -1, botSkill: skill }));
}

function runRace(sim: MatchSimHandle, maxSeconds: number): void {
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
  const steps = Math.round(maxSeconds * 60);
  for (let i = 0; i < steps && !sim.getStatus().finished; i++) sim.step();
}

describe('bots', () => {
  it('sharp bots follow the waypoint graph to the finish within the time limit', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound();
    const sim = createMatchSim(
      { R, round, seed: 2024, stage: 0, players: bots(12, 'sharp'), mode: 'offline', qualifyTarget: 11 },
      { createController: createSimpleController, obstacles: testObstacleModules() },
    );
    runRace(sim, round.duration.seconds);
    const st = sim.getStatus();
    expect(st.finished).toBe(true);
    expect(st.qualifiedCount).toBe(11);
    expect(st.time).toBeLessThan(round.duration.seconds);
    sim.dispose();
  });

  it('clumsy bots are measurably slower than sharp bots', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound();
    const finishTime = (skill: 'clumsy' | 'sharp'): number => {
      const sim = createMatchSim(
        { R, round, seed: 77, stage: 0, players: bots(8, skill), mode: 'offline', qualifyTarget: 4 },
        { createController: createSimpleController, obstacles: testObstacleModules() },
      );
      runRace(sim, round.duration.seconds);
      const t = sim.getStatus().finished ? sim.time : Infinity;
      sim.dispose();
      return t;
    };
    expect(finishTime('sharp')).toBeLessThan(finishTime('clumsy'));
  });

  it('bot behaviour is deterministic per seed', async () => {
    const R = await loadRapier();
    const run = (): number[] => {
      const sim = createMatchSim(
        { R, round: createTestArenaRound(), seed: 5, stage: 0, players: bots(10, 'average'), mode: 'offline' },
        { createController: createSimpleController, obstacles: testObstacleModules() },
      );
      runRace(sim, 20);
      const order = [...sim.getStandings()];
      const st = sim.getStatus();
      const progress = order.map((id) => Math.round((st.players.get(id)?.progress ?? 0) * 1e6));
      sim.dispose();
      return [...order, ...progress];
    };
    expect(run()).toEqual(run());
  });

  it('builds nav graphs with ranks and goal distances', () => {
    const round = createTestArenaRound();
    const nav = new NavGraph(round);
    const idx = (id: number) => nav.nodes.findIndex((w) => w.id === id);
    expect(nav.rank[idx(0)]).toBe(0);
    expect(nav.rank[idx(6)]).toBeGreaterThan(nav.rank[idx(3)]!);
    expect(nav.goalDist[idx(6)]).toBe(0);
    expect(nav.goalDist[idx(0)]).toBeGreaterThan(nav.goalDist[idx(4)]!);
    expect(nav.nearest({ x: 0, y: 2, z: 44 })).toBe(idx(4));
    const course = new CourseMetric(round, round.spawn.origin);
    expect(course.measure({ x: 0, y: 2, z: 56 })).toBeCloseTo(1, 2);
    expect(course.measure({ x: 0, y: 2, z: 36 })).toBeGreaterThan(course.measure({ x: 0, y: 0, z: 14 }));
  });

  it('tiers are ordered from clumsy to sharp', () => {
    expect(BOT_SKILLS.clumsy.reactionMin).toBeGreaterThan(BOT_SKILLS.sharp.reactionMin);
    expect(BOT_SKILLS.clumsy.mistakeChance).toBeGreaterThan(BOT_SKILLS.average.mistakeChance);
    expect(BOT_SKILLS.sharp.speed).toBeGreaterThanOrEqual(BOT_SKILLS.average.speed);
    expect(pickSkill(0, { clumsy: 1, average: 1, sharp: 1 })).toBe('clumsy');
    expect(pickSkill(0.99, { clumsy: 1, average: 1, sharp: 1 })).toBe('sharp');
  });

  it('eliminated bots stop moving and stay out', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound({ fallBehavior: 'eliminate' });
    const sim = createMatchSim(
      { R, round, seed: 1, stage: 0, players: bots(3, 'average'), mode: 'offline' },
      { createController: createSimpleController, obstacles: testObstacleModules() },
    );
    sim.setPhase(RoundPhase.Playing, 0);
    sim.controller(0)!.teleport({ x: 0, y: -40, z: 0 });
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.getStatus().players.get(0)?.status).toBe(PlayerRoundStatus.Eliminated);
    expect(sim.controller(0)!.body.isEnabled()).toBe(false);
    sim.dispose();
  });
});

describe('bot names', () => {
  it('are deterministic, unique and short', () => {
    const a = generateBotNames(60, new Rng(3));
    const b = generateBotNames(60, new Rng(3));
    expect(a).toEqual(b);
    expect(new Set(a.map((n) => n.toLowerCase())).size).toBe(60);
    for (const n of a) {
      expect(n.length).toBeLessThanOrEqual(20);
      expect(n).toMatch(/^[A-Za-z]+\d*$/);
    }
    expect(generateBotNames(5, new Rng(1), [generateBotName(new Rng(1))])).not.toContain(generateBotName(new Rng(1)));
  });
});
