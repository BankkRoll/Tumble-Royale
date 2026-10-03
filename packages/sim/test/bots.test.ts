import { Rng, RoundPhase, type RoundDefinition, type RoundPhaseId } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  BOT_SKILLS,
  DefaultBotBrain,
  NavGraph,
  generateBotName,
  generateBotNames,
  pickSkill,
  type BotPeer,
  type BotSelfView,
  type BotWorldView,
} from '../src/bots/index.ts';
import { Button, CharacterState, emptyInput, type CharacterInput } from '../src/character/types.ts';
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
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Bot${i}`,
    isBot: true,
    team: -1,
    botSkill: skill,
  }));
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
        {
          R,
          round: createTestArenaRound(),
          seed: 5,
          stage: 0,
          players: bots(10, 'average'),
          mode: 'offline',
        },
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

/** A frozen bot on flat ground at y = 0, driven without physics so the brain alone is under test. */
function brainHarness(
  botNav: RoundDefinition['botNav'],
  start: { x: number; y: number; z: number },
  wallZ = Number.NaN,
) {
  const round = createTestArenaRound({ botNav });
  const brain = new DefaultBotBrain({ id: 0, skill: 'average', seed: 99, round });
  const view = {
    round,
    phase: RoundPhase.Playing as RoundPhaseId,
    time: 0,
    tick: 0,
    dt: 1 / 60,
    peers: [] as BotPeer[],
    obstacleClearance: () => Infinity,
    hazardDistance: () => Infinity,
    // Flat floor at y = 0, plus an optional 4 m wall (a solid door) across the course at `wallZ`.
    groundBelow: (p: { y: number; z: number }, depth: number) =>
      (Math.abs(p.z - wallZ) < 0.5 && p.y - depth <= 4) || (p.y >= 0 && p.y - depth <= 0),
    safeSpot: () => false,
    propCount: () => 0,
    propPosition: () => {},
  } satisfies BotWorldView;
  const self: BotSelfView = {
    pos: { ...start },
    vel: { x: 0, y: 0, z: 0 },
    grounded: true,
    state: CharacterState.Run,
    facing: 0,
    status: PlayerRoundStatus.Playing,
    team: -1,
    hasItem: false,
    checkpoint: 0,
  };
  const input = emptyInput();
  const step = (): CharacterInput => {
    brain.think(view, self, input);
    view.tick++;
    view.time = view.tick * view.dt;
    return input;
  };
  return { brain, view, self, step };
}

describe('bot recovery', () => {
  it('slides along a solid door, backs off and re-paths to a sibling branch', () => {
    const { brain, self, step } = brainHarness(
      [
        { id: 0, position: { x: 0, y: 0, z: 0 }, radius: 1.5, next: [1, 2], action: 'run' },
        { id: 1, position: { x: 3, y: 0, z: 20 }, radius: 1.5, next: [3], action: 'run' },
        { id: 2, position: { x: -3, y: 0, z: 20 }, radius: 1.5, next: [3], action: 'run' },
        { id: 3, position: { x: 0, y: 0, z: 40 }, radius: 1.5, next: [], action: 'run' },
      ],
      { x: 0, y: 0.9, z: 6 },
      6.75,
    );
    let strafed = false;
    let backed = false;
    let maxLevel = 0;
    const visited = new Set<number>();
    // Pinned in place (a solid door): nothing the bot does moves it.
    for (let i = 0; i < 60 * 30; i++) {
      const input = step();
      if (Math.abs(input.moveX) > 0.9) strafed = true;
      if (input.moveZ < -0.5) backed = true;
      maxLevel = Math.max(maxLevel, brain.stuckLevelNow);
      visited.add(brain.currentWaypointId);
      expect(self.pos.z).toBe(6);
    }
    expect(maxLevel).toBeGreaterThanOrEqual(5);
    expect(strafed && backed).toBe(true);
    expect(visited.has(1) && visited.has(2)).toBe(true);
  });

  it('on open ground keeps hopping and lunging, and the level holds while the route does not advance', () => {
    const { brain, self, step } = brainHarness(
      [
        { id: 0, position: { x: 0, y: 0, z: 0 }, radius: 1.5, next: [1], action: 'run' },
        { id: 1, position: { x: 0, y: 0, z: 30 }, radius: 1.5, next: [], action: 'run' },
      ],
      { x: 0, y: 0.9, z: 6 },
    );
    let level = 0;
    let jumped = false;
    let dived = false;
    for (let i = 0; i < 60 * 20; i++) {
      // Sideways jiggle of 0.5 m (a crowd, a counter-belt): movement, but no progress along the route.
      self.pos.x = Math.sin(i * 0.2) * 0.5;
      const input = step();
      if (input.buttons & Button.Jump) jumped = true;
      if (input.buttons & Button.Dive) dived = true;
      expect(brain.stuckLevelNow).toBeGreaterThanOrEqual(level);
      level = brain.stuckLevelNow;
    }
    expect(level).toBeGreaterThanOrEqual(3);
    expect(jumped && dived).toBe(true);
  });

  it('re-derives the route on respawn and goes back for a jump just behind the checkpoint', () => {
    const nav: RoundDefinition['botNav'] = [
      { id: 0, position: { x: 0, y: 0, z: 0 }, radius: 1.5, next: [1], action: 'run' },
      { id: 1, position: { x: 0, y: 0, z: 10 }, radius: 1.5, next: [2], action: 'jump' },
      { id: 2, position: { x: 0, y: 0, z: 15 }, radius: 1.5, next: [3], action: 'run' },
      { id: 3, position: { x: 0, y: 0, z: 30 }, radius: 1.5, next: [4], action: 'run' },
      { id: 4, position: { x: 0, y: 0, z: 45 }, radius: 1.5, next: [], action: 'run' },
    ];
    const { brain, self, step } = brainHarness(nav, { x: 0, y: 0.9, z: 29.5 });
    for (let i = 0; i < 30; i++) step();
    expect(brain.currentWaypointId).toBe(4);
    // Respawn behind the take-off: head back for it instead of skipping to the far side.
    self.pos.z = 8;
    brain.onRespawn();
    for (let i = 0; i < 6; i++) step();
    expect(brain.currentWaypointId).toBe(1);
    // Respawn just past the take-off line, still on the near side of the gap: jump straight away.
    self.pos.z = 11;
    brain.onRespawn();
    let jumped = false;
    for (let i = 0; i < 30; i++) if (step().buttons & Button.Jump) jumped = true;
    expect(jumped).toBe(true);
    expect(brain.currentWaypointId).toBe(2);

    const graph = new NavGraph(createTestArenaRound({ botNav: nav }));
    const id = (i: number) => graph.nodes[i]!.id;
    expect(id(graph.resume({ x: 0, y: 0.9, z: 8 }))).toBe(1);
    expect(id(graph.resume({ x: 0, y: 0.9, z: 11 }))).toBe(1);
    expect(id(graph.resume({ x: 0, y: 0.9, z: 14 }))).toBe(2);
    expect(id(graph.resume({ x: 0, y: 0.9, z: 20 }))).toBe(3);
  });

  it('waits for a moving platform to bridge the gap before boarding', () => {
    const { view, self, step } = brainHarness(
      [
        {
          id: 0,
          position: { x: 0, y: 0, z: 0 },
          radius: 1,
          next: [1],
          action: 'waitForPlatform',
          timeAgainst: 'lift',
        },
        { id: 1, position: { x: 0, y: 0, z: 5 }, radius: 1, next: [2], action: 'run' },
        { id: 2, position: { x: 0, y: 0, z: 30 }, radius: 1.5, next: [], action: 'run' },
      ],
      { x: 0, y: 0.9, z: 0 },
    );
    // A shuttle fills the gap 2 < z < 8 during [6, 10) of every 10 s cycle.
    const present = (t: number): boolean => t % 10 >= 6;
    const inGap = (z: number): boolean => z > 2 && z < 8;
    const world: BotWorldView = view;
    world.obstacleClearance = (_id, p, ahead) =>
      inGap(p.z) && present(view.time + Math.max(0, ahead)) ? Math.max(0, p.y - 0.4) : Infinity;
    world.groundBelow = (p, depth) => !inGap(p.z) && p.y >= 0 && p.y - depth <= 0;
    let setOff = -1;
    for (let i = 0; i < 60 * 12 && setOff < 0; i++) {
      if (step().moveZ > 0.3) setOff = view.time;
      expect(self.pos.z).toBe(0);
    }
    // It held through the first (absent) part of the cycle and left as the shuttle arrived.
    expect(setOff).toBeGreaterThan(4);
    expect(present(setOff + 1)).toBe(true);
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
    expect(generateBotNames(5, new Rng(1), [generateBotName(new Rng(1))])).not.toContain(
      generateBotName(new Rng(1)),
    );
  });
});
