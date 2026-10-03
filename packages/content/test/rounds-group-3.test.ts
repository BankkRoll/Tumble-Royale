/**
 * Group-3 rounds (Tile Panic, Rising Goo Tower, Jump Rope Royale, Last
 * Tumbler Standing, Goo Peak Final): schema validity, obstacle params that
 * the module schemas accept without stripping, match-sim builds for every
 * variation, safe spawns, bounds, and full-length bot runs.
 */
import { RoundDefinitionSchema, RoundPhase, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import {
  PlayerRoundStatus,
  createMatchSim,
  createSimpleController,
  spawnSlots,
  type MatchPlayerInfo,
} from '@tumble/sim/match';
import { OBSTACLE_REGISTRY, fallingTileCenter, fallingTilesSchema } from '@tumble/sim/obstacles';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_GROUP_3 } from '../src/rounds/group-3.ts';
import { roundCatalog } from '../src/rounds/index.ts';
import { gooPeakParts } from '../src/rounds/goo-peak-final/index.ts';
import { risingGooParts } from '../src/rounds/rising-goo-tower/index.ts';
import { tilePanicParts } from '../src/rounds/tile-panic/index.ts';

const IDS = [
  'tile-panic',
  'rising-goo-tower',
  'jump-rope-royale',
  'last-tumbler-standing',
  'goo-peak-final',
] as const;
const deps = { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY };

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const rounds = (): RoundDefinition[] => ROUNDS_GROUP_3.map((r) => RoundDefinitionSchema.parse(r));

function bots(n: number): MatchPlayerInfo[] {
  const skills = ['clumsy', 'average', 'sharp'] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Bot${i}`,
    isBot: true,
    team: -1,
    botSkill: skills[i % 3],
  }));
}

/** Top-level keys an obstacle module's schema would silently drop. */
function strippedKeys(type: string, params: Record<string, unknown>): string[] {
  const mod = OBSTACLE_REGISTRY.get(type);
  if (!mod) return [`<unknown type ${type}>`];
  const parsed = mod.schema.parse(params) as Record<string, unknown>;
  return Object.keys(params).filter((k) => !(k in parsed));
}

function insideBounds(round: RoundDefinition, p: { x: number; y: number; z: number }, margin = 0): boolean {
  const { min, max } = round.bounds;
  return (
    p.x >= min.x - margin &&
    p.x <= max.x + margin &&
    p.y >= min.y - margin &&
    p.y <= max.y + margin &&
    p.z >= min.z - margin &&
    p.z <= max.z + margin
  );
}

describe('group-3 rounds: data', () => {
  it('registers all five rounds in the catalog', () => {
    expect(ROUNDS_GROUP_3.map((r) => r.id)).toEqual([...IDS]);
    for (const id of IDS) expect(roundCatalog().get(id)).toBeDefined();
  });

  for (const id of IDS) {
    describe(id, () => {
      const round = (): RoundDefinition => rounds().find((r) => r.id === id)!;

      it('parses and carries the authoring essentials', () => {
        const r = round();
        expect(r.variations.length).toBeGreaterThanOrEqual(3);
        expect(r.tips.length).toBeGreaterThanOrEqual(3);
        expect(r.objective.length).toBeLessThanOrEqual(44);
        expect(r.speedScaleByStage).toHaveLength(5);
        expect(r.fallBehavior).toBe('eliminate');
        expect(r.music.startsWith('mus_')).toBe(true);
        expect(r.flyover.path.length).toBeGreaterThanOrEqual(2);
        expect([1, r.flyover.path.length]).toContain(r.flyover.lookAt.length);
        const ids = r.obstacles.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        const nav = r.botNav.map((w) => w.id);
        expect(new Set(nav).size).toBe(nav.length);
        for (const w of r.botNav) for (const n of w.next) expect(nav).toContain(n);
      });

      it('every obstacle param parses with its module schema and nothing is stripped', () => {
        const r = round();
        const base = new Map(r.obstacles.map((o) => [o.id, o]));
        const check = (type: string, params: Record<string, unknown>, where: string): void => {
          expect(strippedKeys(type, params), where).toEqual([]);
        };
        for (const o of r.obstacles) check(o.type, o.params, o.id);
        for (const v of r.variations) {
          for (const o of v.addObstacles) check(o.type, o.params, `${v.id}/${o.id}`);
          for (const [oid, over] of Object.entries(v.obstacleParams)) {
            const target = base.get(oid) ?? v.addObstacles.find((o) => o.id === oid);
            expect(target, `${v.id} overrides unknown obstacle ${oid}`).toBeDefined();
            check(target!.type, { ...target!.params, ...over }, `${v.id}/${oid}`);
          }
          for (const rid of v.removeObstacles)
            expect(base.has(rid), `${v.id} removes unknown ${rid}`).toBe(true);
        }
      });

      it('keeps solid geometry and obstacles inside the bounds', () => {
        const r = round();
        for (const g of r.geometry) {
          if (g.decorative) continue;
          expect(insideBounds(r, g.position), `${g.shape} @ ${JSON.stringify(g.position)}`).toBe(true);
        }
        for (const o of r.obstacles) expect(insideBounds(r, o.position), o.id).toBe(true);
        expect(r.killY).toBeGreaterThan(r.bounds.min.y);
        expect(insideBounds(r, r.spawn.origin)).toBe(true);
      });

      it('builds a match sim with no warnings for every variation, and spawns stand on ground', () => {
        const r = round();
        const n = Math.min(40, r.players.max);
        for (const v of r.variations) {
          const sim = createMatchSim(
            { R, round: r, seed: 3, stage: 0, players: bots(n), mode: 'offline', variationId: v.id },
            deps,
          );
          expect(sim.warnings, `${v.id}: ${sim.warnings.join('; ')}`).toEqual([]);
          sim.dispose();
        }
        // An empty match so the ray can only hit level colliders, not the spawned capsules.
        const empty = createMatchSim({ R, round: r, seed: 3, stage: 0, players: [], mode: 'offline' }, deps);
        // Scene queries need one step to see the colliders (the sim is still frozen in LOADING).
        empty.step();
        for (const s of spawnSlots(
          r,
          3,
          bots(n).map(() => -1),
        )) {
          // Centre plus eight probes inside the capsule footprint (a ray can slip down a tile gap).
          const offsets = [
            [0, 0],
            ...Array.from({ length: 8 }, (_, k) => [
              0.3 * Math.cos((k * Math.PI) / 4),
              0.3 * Math.sin((k * Math.PI) / 4),
            ]),
          ] as const;
          const hits = offsets.filter(([dx = 0, dz = 0]) => {
            const ray = new R.Ray(
              { x: s.pos.x + dx, y: s.pos.y + 0.5, z: s.pos.z + dz },
              { x: 0, y: -1, z: 0 },
            );
            return empty.world.castRay(ray, 1.2, true) !== null;
          });
          expect(hits.length, `no ground under spawn ${JSON.stringify(s.pos)}`).toBeGreaterThanOrEqual(5);
        }
        empty.dispose();
      });
    });
  }
});

/** Lattice key at 5 cm resolution (positions are authored to the millimetre). */
const key = (x: number, y: number, z: number): string =>
  [x, y, z].map((v) => Math.round(v * 20) + 0).join(',');

describe('group-3 rounds: generated layouts', () => {
  it('tile blocks sit exactly on their shared lattice (no overlaps, no holes)', () => {
    const fields = [
      tilePanicParts.layer1,
      tilePanicParts.layer2,
      tilePanicParts.layer3,
      tilePanicParts.layer2Hex,
      ...gooPeakParts.ringFields,
      gooPeakParts.summit,
    ];
    for (const f of fields) {
      const want = new Set(f.cells.map((c) => key(c.x, c.y, c.z)));
      const got: string[] = [];
      const c = { x: 0, y: 0, z: 0 };
      for (const inst of f.instances) {
        const p = fallingTilesSchema.parse(inst.params);
        for (let i = 0; i < p.cols * p.rows; i++) {
          fallingTileCenter(i, p, c);
          got.push(key(inst.position.x + c.x, inst.position.y, inst.position.z + c.z));
        }
      }
      expect(new Set(got).size).toBe(got.length);
      expect(new Set(got)).toEqual(want);
    }
    expect(tilePanicParts.layer1.cells).toHaveLength(157);
  });

  it('Rising Goo Tower: stairs rise 1.4 m per step to the next tier and pads clear the staircases', () => {
    const { stairs, pads, TOP } = risingGooParts;
    expect(stairs).toHaveLength(10);
    for (const s of stairs) {
      const last = s.steps[s.steps.length - 1]!;
      expect(last.height).toBeCloseTo(TOP[s.transition + 1]! - TOP[s.transition]!, 5);
    }
    expect(pads).toHaveLength(11);
  });

  it('Goo Peak: rings step up 1.5 m inward', () => {
    const { ringIn, ringOut, ringY } = gooPeakParts;
    for (let k = 0; k < 7; k++) {
      expect(ringOut(k + 1)).toBeCloseTo(ringIn(k), 5);
      expect(ringY(k + 1) - ringY(k)).toBeCloseTo(1.5, 5);
    }
  });
});

describe('group-3 rounds: bot runs', () => {
  for (const id of IDS) {
    it(`${id}: bots play the full round, eliminations happen over time`, () => {
      const r = rounds().find((x) => x.id === id)!;
      const n = Math.min(40, r.players.max);
      const sim = createMatchSim(
        { R, round: r, seed: 11, stage: 0, players: bots(n), mode: 'offline' },
        deps,
      );
      sim.setPhase(RoundPhase.Countdown);
      for (let i = 0; i < 180; i++) sim.step();
      sim.setPhase(RoundPhase.Playing, 0);
      const alive = (): number =>
        [...sim.getStatus().players.values()].filter((p) => p.status === PlayerRoundStatus.Playing).length;
      const timeline: string[] = [];
      let aliveAt15 = n;
      const total = Math.round(r.duration.seconds * 60);
      for (let i = 1; i <= total && !sim.getStatus().finished; i++) {
        sim.step();
        if (i % 600 === 0) timeline.push(`${i / 60}s:${alive()}`);
        if (i === 15 * 60) aliveAt15 = alive();
      }
      const st = sim.getStatus();
      console.log(
        `[group-3] ${id} (${n} bots, variation ${sim.variationId}) ${timeline.join(' ')} → finished ${st.finished} at ${st.time.toFixed(1)} s, qualified ${st.qualifiedCount}, eliminated ${st.eliminatedCount}`,
      );
      expect(st.eliminatedCount).toBeGreaterThan(0);
      expect(aliveAt15).toBeGreaterThan(0);
      if (r.type === 'final') {
        // The final's hard cap always crowns at most one player.
        if (!st.finished) {
          for (let i = 0; i < 120 && !sim.getStatus().finished; i++) sim.step();
        }
        expect(sim.getStatus().finished).toBe(true);
        expect(sim.getStatus().qualifiedCount).toBeLessThanOrEqual(1);
      }
      sim.dispose();
    }, 600_000);
  }
});
