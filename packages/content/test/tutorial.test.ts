/**
 * Validation for Practice Island (the tutorial round): registry isolation,
 * schema, obstacle params against the real module schemas (including keys zod
 * would silently strip), match sims for both tutorial phases without
 * warnings, spawn/respawn ground checks, the waypoint graph, bounds, and
 * physical checks with the real Tumbler controller: the dive gap needs a
 * dive, the pad reaches the shelf, a sharp bot clears every station, and
 * clumsy/average bots finish the mini race.
 */
import {
  RoundDefinitionSchema,
  RoundPhase,
  quatFromEulerYXZ,
  rotateVec,
  type RoundDefinition,
  type Vec3,
} from '@tumble/shared';
import { Button, CharacterState, loadRapier, type Rapier, type World } from '@tumble/sim';
import { createCharacterFullState, createTumblerController } from '@tumble/sim/character';
import {
  PlayerRoundStatus,
  createMatchSim,
  spawnSlots,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { OBSTACLE_REGISTRY, getObstacleModule } from '@tumble/sim/obstacles';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEV_ROUND_IDS, getRound, showRoundCatalog } from '../src/rounds/index.ts';
import {
  COACH_PODIUM,
  ISLAND,
  PRACTICE_STATIONS,
  RACE_SECONDS,
  RACE_SPAWN,
  TUTORIAL_ROUND,
  TUTORIAL_ROUND_INPUT,
} from '../src/rounds/practice-island/index.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const round = RoundDefinitionSchema.parse(TUTORIAL_ROUND_INPUT);
const raceRound: RoundDefinition = {
  ...round,
  spawn: { ...round.spawn, ...RACE_SPAWN, origin: { ...RACE_SPAWN.origin } },
  duration: { seconds: RACE_SECONDS, overtimeSeconds: 0 },
};
const deps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };

function inBounds(p: Vec3, pad = 0): boolean {
  const { min, max } = round.bounds;
  return (
    p.x - pad >= min.x &&
    p.x + pad <= max.x &&
    p.y - pad >= min.y &&
    p.y + pad <= max.y &&
    p.z - pad >= min.z &&
    p.z + pad <= max.z
  );
}

function pieceHalfExtents(shape: string, s: Vec3): Vec3 {
  switch (shape) {
    case 'cylinder':
    case 'hexPrism':
      return { x: s.x, y: s.y / 2, z: s.x };
    case 'sphere':
      return { x: s.x, y: s.x, z: s.x };
    case 'torus':
      return { x: s.x + s.y, y: s.y, z: s.x + s.y };
    default:
      return { x: s.x / 2, y: s.y / 2, z: s.z / 2 };
  }
}

function pieceInBounds(p: RoundDefinition['geometry'][number]): boolean {
  const h = pieceHalfExtents(p.shape, p.size);
  const D = Math.PI / 180;
  const q = quatFromEulerYXZ(
    (p.rotation?.yaw ?? 0) * D,
    (p.rotation?.pitch ?? 0) * D,
    (p.rotation?.roll ?? 0) * D,
  );
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const c = rotateVec(q, { x: sx * h.x, y: sy * h.y, z: sz * h.z });
        if (!inBounds({ x: p.position.x + c.x, y: p.position.y + c.y, z: p.position.z + c.z })) return false;
      }
  return true;
}

function groundBelow(world: World, p: Vec3, depth: number): boolean {
  const ray = new R.Ray({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, y: -1, z: 0 });
  return world.castRay(ray, depth + 1, true) !== null;
}

/** One human on the practice course, driven by explicit inputs. */
function soloSim(): MatchSimHandle {
  const sim = createMatchSim(
    { R, round, seed: 3, stage: 0, players: [{ id: 0, name: 'p', isBot: false, team: -1 }], mode: 'offline' },
    deps,
  );
  sim.setPhase(RoundPhase.Playing, 0);
  return sim;
}

/**
 * Runs straight along +Z from `from` and presses jump (and optionally dive
 * `diveAfter` ticks later) when the feet cross `takeoffZ`.
 *
 * @returns Final feet position and whether the player fell out.
 */
function runAndJump(
  from: Vec3,
  takeoffZ: number,
  diveAfter: number | null,
  ticks = 240,
): { pos: Vec3; fell: boolean; bounced: boolean } {
  const sim = soloSim();
  sim.controller(0)!.teleport(from, 0);
  const st = createCharacterFullState();
  let jumpTick = -1;
  let fell = false;
  let bounced = false;
  for (let i = 0; i < ticks; i++) {
    sim.getPlayerState(0, st);
    if (jumpTick < 0 && st.pos.z >= takeoffZ) jumpTick = i;
    let buttons = 0;
    if (jumpTick >= 0 && i - jumpTick < 14) buttons |= Button.Jump;
    if (diveAfter !== null && jumpTick >= 0 && i - jumpTick >= diveAfter && i - jumpTick < diveAfter + 3)
      buttons |= Button.Dive;
    sim.setInput(0, { moveX: 0, moveZ: 1, yaw: 0, buttons, emote: 0 });
    sim.step();
    for (const e of sim.events.drain()) {
      if (e.type === 'fellOut') fell = true;
      if (e.type === 'bounce') bounced = true;
    }
    if (fell) break;
  }
  sim.getPlayerState(0, st);
  const pos = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
  sim.dispose();
  return { pos, fell, bounced };
}

describe('tutorial registry', () => {
  it('registers Practice Island as a dev round outside the show catalog', () => {
    expect(TUTORIAL_ROUND.id).toBe('practice-island');
    expect(DEV_ROUND_IDS.has('practice-island')).toBe(true);
    expect(getRound('practice-island')).toBeUndefined();
    expect(showRoundCatalog().has('practice-island')).toBe(false);
  });

  it('lists every station in order with sane coach points', () => {
    expect(PRACTICE_STATIONS.map((s) => s.id)).toEqual([
      'move',
      'jump',
      'dive',
      'grab',
      'climb',
      'bounce',
      'tiles',
      'checkpoint',
      'race',
    ]);
    const navIds = new Set(round.botNav.map((w) => w.id));
    const cpIdx = new Set(round.triggers.filter((t) => t.kind === 'checkpoint').map((t) => t.index));
    for (const [i, s] of PRACTICE_STATIONS.entries()) {
      expect(navIds.has(s.navFrom), `${s.id} navFrom ${s.navFrom}`).toBe(true);
      expect(cpIdx.has(s.checkpoint), `${s.id} checkpoint ${s.checkpoint}`).toBe(true);
      expect(s.goal.min.z).toBeLessThan(s.goal.max.z);
      const next = PRACTICE_STATIONS[i + 1];
      if (next) expect(next.start).toEqual(s.end);
    }
  });
});

describe('round practice-island', { timeout: 30_000 }, () => {
  it('passes the round schema with a sane header', () => {
    expect(round.type).toBe('race');
    expect(round.tips.length).toBeGreaterThanOrEqual(3);
    expect(round.music.startsWith('mus_')).toBe(true);
    expect(round.designNotes.length).toBeGreaterThan(40);
    expect(new Set(round.obstacles.map((o) => o.id)).size).toBe(round.obstacles.length);
  });

  it('obstacle params parse with their module schemas and lose no keys', () => {
    for (const o of round.obstacles) {
      const mod = getObstacleModule(o.type);
      expect(mod, `${o.id}: unknown obstacle type ${o.type}`).toBeDefined();
      const raw = o.params ?? {};
      const parsed = mod!.schema.parse(raw) as Record<string, unknown>;
      const stripped = Object.keys(raw).filter((k) => !(k in parsed));
      expect(stripped, `${o.id} (${o.type}) has keys its schema strips`).toEqual([]);
    }
  });

  it('builds the practice sim (human + coach) and the race sim (8 racers + coach) without warnings', () => {
    const practice = createMatchSim(
      {
        R,
        round,
        seed: 1,
        stage: 0,
        players: [
          { id: 0, name: 'you', isBot: false, team: -1 },
          { id: 1, name: 'Coach', isBot: false, team: -1 },
        ],
        mode: 'offline',
      },
      deps,
    );
    expect(practice.warnings).toEqual([]);
    practice.setPhase(RoundPhase.Playing, 0);
    for (let i = 0; i < 120; i++) practice.step();
    practice.dispose();

    const racers: MatchPlayerInfo[] = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      name: `R${i}`,
      isBot: i > 0,
      team: -1,
      ...(i > 0 ? { botSkill: i % 2 ? ('clumsy' as const) : ('average' as const) } : {}),
    }));
    const race = createMatchSim(
      {
        R,
        round: raceRound,
        seed: 2,
        stage: 0,
        players: [...racers, { id: 8, name: 'Coach', isBot: false, team: -1 }],
        mode: 'offline',
        qualifyTarget: 8,
      },
      deps,
    );
    expect(race.warnings).toEqual([]);
    race.dispose();
  });

  it('spawns and respawns above solid ground', () => {
    const sim = soloSim();
    sim.step();
    for (const r of [round, raceRound]) {
      for (const s of spawnSlots(
        r,
        5,
        Array.from({ length: 8 }, () => -1),
      ))
        expect(
          groundBelow(sim.world, s.pos, 2),
          `${r === round ? 'practice' : 'race'} spawn ${JSON.stringify(s.pos)}`,
        ).toBe(true);
    }
    const checkpoints = round.triggers.filter((t) => t.kind === 'checkpoint');
    expect(checkpoints.length).toBe(8);
    for (const c of checkpoints) {
      expect(c.respawn.length, c.id).toBeGreaterThan(0);
      for (const p of c.respawn)
        expect(groundBelow(sim.world, p, 2), `${c.id} respawn ${JSON.stringify(p)}`).toBe(true);
    }
    for (const s of PRACTICE_STATIONS) {
      expect(groundBelow(sim.world, s.start, 2), `${s.id} start`).toBe(true);
      expect(groundBelow(sim.world, s.end, 2), `${s.id} end`).toBe(true);
    }
    expect(groundBelow(sim.world, COACH_PODIUM, 2), 'coach podium').toBe(true);
    expect(new Set(checkpoints.map((c) => c.index)).size).toBe(checkpoints.length);
    sim.dispose();
  });

  it('has a connected waypoint graph from start to the finish line', () => {
    const nodes = round.botNav;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(nodes.length);
    for (const n of nodes)
      for (const nx of n.next) expect(byId.has(nx), `waypoint ${n.id} → missing ${nx}`).toBe(true);
    const sinks = nodes.filter((n) => n.next.length === 0);
    expect(sinks).toHaveLength(1);
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      for (const nx of byId.get(queue.shift()!)!.next) {
        if (seen.has(nx)) continue;
        seen.add(nx);
        queue.push(nx);
      }
    }
    expect(nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)).toEqual([]);
    const finish = round.triggers.find((t) => t.kind === 'finish')!;
    expect(
      Math.hypot(sinks[0]!.position.x - finish.position.x, sinks[0]!.position.z - finish.position.z),
    ).toBeLessThan(4);
  });

  it('keeps all geometry, obstacles, triggers, waypoints and spawns inside bounds', () => {
    for (const [i, p] of round.geometry.entries())
      expect(pieceInBounds(p), `piece ${i} (${p.shape}) at ${JSON.stringify(p.position)}`).toBe(true);
    for (const o of round.obstacles) expect(inBounds(o.position), o.id).toBe(true);
    for (const t of round.triggers) expect(inBounds(t.position), t.id).toBe(true);
    for (const w of round.botNav) expect(inBounds(w.position), `waypoint ${w.id}`).toBe(true);
    expect(inBounds(round.spawn.origin, 4)).toBe(true);
    expect(round.killY).toBeGreaterThan(round.bounds.min.y);
  });
});

// Physics checks step real controllers for up to 200 s of sim time; give them room on a busy machine.
describe('practice-island physics (real controller)', { timeout: 60_000 }, () => {
  const lip = ISLAND.jumpC.z1;
  const runUp = { x: 0, y: ISLAND.jumpC.top + 0.05, z: ISLAND.jumpC.z0 + 0.5 };

  it('the dive gap cannot be jumped without a dive', () => {
    const r = runAndJump(runUp, lip - 0.3, null);
    expect(r.fell).toBe(true);
  });

  it('a jump + dive clears the dive gap', () => {
    for (const diveAfter of [10, 16, 24]) {
      const r = runAndJump(runUp, lip - 0.4, diveAfter);
      expect(r.fell, `dive after ${diveAfter} ticks`).toBe(false);
      expect(r.pos.z).toBeGreaterThan(ISLAND.grabZ0 + 0.5);
    }
  });

  it('the bounce pad launches onto the high shelf', () => {
    const r = runAndJump({ x: 0, y: ISLAND.ledgeTop + 0.05, z: 68.5 }, 1e9, null, 300);
    expect(r.bounced).toBe(true);
    expect(r.fell).toBe(false);
    expect(r.pos.y).toBeGreaterThan(ISLAND.shelfTop);
  });

  it('a sharp bot clears every station and finishes', () => {
    const players: MatchPlayerInfo[] = Array.from({ length: 3 }, (_, i) => ({
      id: i,
      name: `S${i}`,
      isBot: true,
      team: -1,
      botSkill: 'sharp' as const,
    }));
    const sim = createMatchSim(
      { R, round, seed: 7, stage: 0, players, mode: 'offline', qualifyTarget: 3 },
      deps,
    );
    sim.setPhase(RoundPhase.Playing, 0);
    const st = createCharacterFullState();
    const climbed = new Set<number>();
    const bounced = new Set<number>();
    for (let i = 0; i < 60 * 200; i++) {
      sim.step();
      for (const e of sim.events.drain()) if (e.type === 'bounce') bounced.add(e.player);
      for (const p of players)
        if (sim.getPlayerState(p.id, st) && st.state === CharacterState.LedgeClimb) climbed.add(p.id);
      if (sim.getStatus().qualifiedCount === players.length) break;
    }
    const status = sim.getStatus();
    const done = [...status.players.values()].filter((p) => p.status === PlayerRoundStatus.Qualified).length;
    expect(done, `finished after ${sim.time.toFixed(1)} s`).toBeGreaterThanOrEqual(2);
    expect(climbed.size).toBeGreaterThanOrEqual(2);
    expect(bounced.size).toBeGreaterThanOrEqual(2);
    sim.dispose();
  });

  it('clumsy and average bots finish the mini race', () => {
    const players: MatchPlayerInfo[] = Array.from({ length: 7 }, (_, i) => ({
      id: i,
      name: `R${i}`,
      isBot: true,
      team: -1,
      botSkill: i % 2 ? ('clumsy' as const) : ('average' as const),
    }));
    const sim = createMatchSim(
      { R, round: raceRound, seed: 9, stage: 0, players, mode: 'offline', qualifyTarget: 7 },
      deps,
    );
    sim.setPhase(RoundPhase.Countdown);
    for (let i = 0; i < 180; i++) sim.step();
    sim.setPhase(RoundPhase.Playing, 0);
    for (let i = 0; i < 60 * RACE_SECONDS && !sim.getStatus().finished; i++) sim.step();
    expect(sim.getStatus().qualifiedCount, `qualified by ${sim.time.toFixed(1)} s`).toBeGreaterThanOrEqual(5);
    sim.dispose();
  });
});
