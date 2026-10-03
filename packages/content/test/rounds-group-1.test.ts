/**
 * Validation for the group-1 rounds (Gumdrop Gauntlet, Conveyor Chaos, Tilt
 * Town, Slip 'n' Spiral, Crown Climb): schema, obstacle params against the
 * real module schemas (including keys zod would silently strip), a full match
 * sim build with bots, spawn/respawn ground checks, waypoint graph integrity
 * and bounds containment.
 */
import {
  RoundDefinitionSchema,
  RoundPhase,
  quatFromEulerYXZ,
  rotateVec,
  type RoundDefinition,
  type Vec3,
} from '@tumble/shared';
import { createMatchSim, createSimpleController, spawnSlots } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY, getObstacleModule } from '@tumble/sim/obstacles';
import { loadRapier, type Rapier, type World } from '@tumble/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_GROUP_1 } from '../src/rounds/group-1.ts';
import { getRound } from '../src/rounds/index.ts';

const EXPECTED_IDS = ['gumdrop-gauntlet', 'conveyor-chaos', 'tilt-town', 'slip-n-spiral', 'crown-climb'];

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

type ObstacleLike = { id: string; type: string; position: Vec3; params?: Record<string, unknown> };

/** Every obstacle instance a round can field: base, variation additions, and base + variation overrides. */
function obstacleVariants(round: RoundDefinition): { label: string; o: ObstacleLike }[] {
  const out: { label: string; o: ObstacleLike }[] = round.obstacles.map((o) => ({ label: o.id, o }));
  for (const v of round.variations) {
    for (const o of v.addObstacles) out.push({ label: `${v.id}:+${o.id}`, o });
    for (const [id, over] of Object.entries(v.obstacleParams)) {
      const base = round.obstacles.find((o) => o.id === id) ?? v.addObstacles.find((o) => o.id === id);
      expect(base, `variation ${v.id} overrides unknown obstacle ${id}`).toBeDefined();
      if (base) out.push({ label: `${v.id}:${id}`, o: { ...base, params: { ...base.params, ...over } } });
    }
  }
  return out;
}

function inBounds(round: RoundDefinition, p: Vec3, pad = 0): boolean {
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

/** Local half extents of a static piece's bounding box (see the size conventions in the round schema). */
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

/** World AABB corners check: every rotated corner of the piece's box lies inside the bounds. */
function pieceInBounds(round: RoundDefinition, p: RoundDefinition['geometry'][number]): boolean {
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
        if (!inBounds(round, { x: p.position.x + c.x, y: p.position.y + c.y, z: p.position.z + c.z }))
          return false;
      }
  return true;
}

/** True when a ray from 1 m above `p` hits a collider within `depth` m below it. */
function groundBelow(world: World, p: Vec3, depth: number): boolean {
  const ray = new R.Ray({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, y: -1, z: 0 });
  return world.castRay(ray, depth + 1, true) !== null;
}

describe('group-1 registry', () => {
  it('registers all five rounds with the expected ids', () => {
    expect(ROUNDS_GROUP_1.map((r) => r.id)).toEqual(EXPECTED_IDS);
    for (const id of EXPECTED_IDS) expect(getRound(id)).toBeDefined();
  });
});

for (const input of ROUNDS_GROUP_1) {
  describe(`round ${input.id}`, () => {
    const round = RoundDefinitionSchema.parse(input);

    it('passes the round schema with a sane header', () => {
      expect(round.variations.length).toBeGreaterThanOrEqual(3);
      expect(round.tips.length).toBeGreaterThanOrEqual(3);
      expect(round.music.startsWith('mus_')).toBe(true);
      expect(round.speedScaleByStage).toHaveLength(5);
      expect(round.designNotes.length).toBeGreaterThan(40);
      expect(new Set(round.obstacles.map((o) => o.id)).size).toBe(round.obstacles.length);
    });

    it('obstacle params parse with their module schemas and lose no keys', () => {
      for (const { label, o } of obstacleVariants(round)) {
        const mod = getObstacleModule(o.type);
        expect(mod, `${label}: unknown obstacle type ${o.type}`).toBeDefined();
        const raw = o.params ?? {};
        const parsed = mod!.schema.parse(raw) as Record<string, unknown>;
        const stripped = Object.keys(raw).filter((k) => !(k in parsed));
        expect(stripped, `${label} (${o.type}) has keys its schema strips`).toEqual([]);
      }
    });

    it('builds a match sim without warnings and survives 40 bots for 1800+ steps', () => {
      const players = Array.from({ length: 40 }, (_, i) => ({
        id: i,
        name: `B${i}`,
        isBot: true,
        team: -1,
        botSkill: (['clumsy', 'average', 'sharp'] as const)[i % 3],
      }));
      const sim = createMatchSim(
        { R, round, seed: 11, stage: 2, players, mode: 'offline' },
        { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
      );
      expect(sim.warnings).toEqual([]);
      sim.setPhase(RoundPhase.Countdown);
      for (let i = 0; i < 60; i++) sim.step();
      sim.setPhase(RoundPhase.Playing, 0);
      expect(() => {
        for (let i = 0; i < 1900; i++) sim.step();
      }).not.toThrow();
      expect(sim.getStatus().time).toBeGreaterThan(30);
      sim.dispose();
    });

    it('builds every variation without warnings', () => {
      for (const v of round.variations) {
        const sim = createMatchSim(
          {
            R,
            round,
            seed: 3,
            stage: 0,
            players: [{ id: 0, name: 'p', isBot: true, team: -1 }],
            mode: 'offline',
            variationId: v.id,
          },
          { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
        );
        expect(sim.variationId).toBe(v.id);
        expect(sim.warnings, v.id).toEqual([]);
        sim.setPhase(RoundPhase.Playing, 0);
        for (let i = 0; i < 30; i++) sim.step();
        sim.dispose();
      }
    });

    it('spawns and respawns above solid ground; every checkpoint has respawn points', () => {
      const sim = createMatchSim(
        {
          R,
          round,
          seed: 5,
          stage: 0,
          players: [{ id: 0, name: 'p', isBot: true, team: -1 }],
          mode: 'offline',
        },
        { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
      );
      sim.step();
      const slots = spawnSlots(
        round,
        5,
        Array.from({ length: round.players.max }, () => -1),
      );
      for (const s of slots)
        expect(groundBelow(sim.world, s.pos, 2), `spawn ${JSON.stringify(s.pos)}`).toBe(true);
      const checkpoints = round.triggers.filter((t) => t.kind === 'checkpoint');
      expect(checkpoints.length).toBeGreaterThanOrEqual(3);
      for (const cp of checkpoints) {
        expect(cp.respawn.length, cp.id).toBeGreaterThan(0);
        for (const p of cp.respawn)
          expect(groundBelow(sim.world, p, 2), `${cp.id} respawn ${JSON.stringify(p)}`).toBe(true);
      }
      expect(new Set(checkpoints.map((c) => c.index)).size).toBe(checkpoints.length);
      sim.dispose();
    });

    it('has a connected waypoint graph from start to goal', () => {
      const nodes = round.botNav;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      expect(byId.size).toBe(nodes.length);
      const obstacleIds = new Set(
        [...round.obstacles, ...round.variations.flatMap((v) => v.addObstacles)].map((o) => o.id),
      );
      for (const n of nodes) {
        for (const next of n.next) expect(byId.has(next), `waypoint ${n.id} → missing ${next}`).toBe(true);
        if (n.timeAgainst)
          expect(obstacleIds.has(n.timeAgainst), `waypoint ${n.id} times against ${n.timeAgainst}`).toBe(
            true,
          );
      }
      const sinks = nodes.filter((n) => n.next.length === 0);
      expect(sinks).toHaveLength(1);
      const goal = sinks[0]!;
      const startNode = nodes.find((n) => n.id === 0) ?? nodes[0]!;
      // Forward: everything reachable from the start; backward: everything reaches the goal.
      const seen = new Set<number>([startNode.id]);
      const queue = [startNode.id];
      while (queue.length) {
        for (const nx of byId.get(queue.shift()!)!.next) {
          if (seen.has(nx)) continue;
          seen.add(nx);
          queue.push(nx);
        }
      }
      expect(seen.has(goal.id)).toBe(true);
      expect(nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)).toEqual([]);
      const preds = new Map<number, number[]>();
      for (const n of nodes) for (const nx of n.next) preds.set(nx, [...(preds.get(nx) ?? []), n.id]);
      const reach = new Set<number>([goal.id]);
      const back = [goal.id];
      while (back.length) {
        for (const p of preds.get(back.shift()!) ?? []) {
          if (reach.has(p)) continue;
          reach.add(p);
          back.push(p);
        }
      }
      expect(nodes.filter((n) => !reach.has(n.id)).map((n) => n.id)).toEqual([]);
      // The goal sits on the finish line / crown.
      const goalTrigger = round.triggers.find((t) => t.kind === 'finish' || t.kind === 'crown')!;
      expect(
        Math.hypot(goal.position.x - goalTrigger.position.x, goal.position.z - goalTrigger.position.z),
      ).toBeLessThan(4);
    });

    it('keeps all geometry, obstacles, triggers, waypoints and spawns inside bounds', () => {
      for (const [i, p] of round.geometry.entries()) {
        expect(pieceInBounds(round, p), `piece ${i} (${p.shape}) at ${JSON.stringify(p.position)}`).toBe(
          true,
        );
      }
      for (const { label, o } of obstacleVariants(round)) {
        expect(inBounds(round, o.position), `${label} at ${JSON.stringify(o.position)}`).toBe(true);
      }
      for (const t of round.triggers) expect(inBounds(round, t.position), t.id).toBe(true);
      for (const w of round.botNav) expect(inBounds(round, w.position), `waypoint ${w.id}`).toBe(true);
      expect(inBounds(round, round.spawn.origin, 6)).toBe(true);
      expect(round.killY).toBeGreaterThan(round.bounds.min.y);
    });
  });
}
