/**
 * Group-4 rounds (Egg Heist, Bounce Ball Blitz, Paint the Plaza, Tail Chase,
 * Pattern Panic): schema, obstacle params, sim build, full-length 40-bot runs,
 * scoring/qualification outcomes and team-layout symmetry.
 */
import { RoundDefinitionSchema, RoundPhase, type RoundDefinition, type Vec3 } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { PlayerRoundStatus, createMatchSim, createSimpleController, resolveObstacles, type MatchSimHandle } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_GROUP_4 } from '../src/rounds/group-4.ts';
import { getRound } from '../src/rounds/index.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const IDS = ['egg-heist', 'bounce-ball-blitz', 'paint-the-plaza', 'tail-chase', 'pattern-panic'];
const TEAM_ROUNDS = ['egg-heist', 'bounce-ball-blitz', 'paint-the-plaza'];

function round(id: string): RoundDefinition {
  const r = getRound(id);
  if (!r) throw new Error(`round ${id} not registered`);
  return r;
}

function players(n: number, def: RoundDefinition) {
  return Array.from({ length: n }, (_, id) => ({
    id,
    name: `bot-${id}`,
    isBot: true,
    team: def.qualification.teams > 0 ? id % def.qualification.teams : -1,
    botSkill: (['sharp', 'average', 'clumsy'] as const)[id % 3],
  }));
}

function build(def: RoundDefinition, opts: { seed?: number; variationId?: string; bots?: number } = {}): MatchSimHandle {
  return createMatchSim(
    {
      R,
      round: def,
      seed: opts.seed ?? 11,
      stage: 0,
      players: players(opts.bots ?? 40, def),
      mode: 'offline',
      ...(opts.variationId ? { variationId: opts.variationId } : {}),
    },
    { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
  );
}

/** Runs countdown + the whole round (incl. overtime) or until every fate is decided. */
function runFull(sim: MatchSimHandle): void {
  sim.setPhase(RoundPhase.Countdown);
  const d = sim.round.duration;
  const maxSteps = Math.ceil((3 + d.seconds + d.overtimeSeconds + 2) * 60);
  for (let i = 0; i < maxSteps; i++) {
    if (sim.phase === RoundPhase.Countdown && sim.time >= 0) sim.setPhase(RoundPhase.Playing, 0);
    sim.step();
    sim.events.drain();
    if (sim.getStatus().finished) break;
  }
}

describe('group-4 registry', () => {
  it('registers all five rounds with valid definitions', () => {
    expect(ROUNDS_GROUP_4.map((r) => r.id)).toEqual(IDS);
    for (const r of ROUNDS_GROUP_4) expect(() => RoundDefinitionSchema.parse(r)).not.toThrow();
  });

  it('has ≥ 3 variations, tips, flyover, music and bot hints per round', () => {
    for (const id of IDS) {
      const r = round(id);
      expect(r.variations.length, id).toBeGreaterThanOrEqual(3);
      expect(r.tips.length, id).toBe(3);
      expect(r.music, id).toMatch(/^mus_/);
      expect(r.botNav.length, id).toBeGreaterThan(0);
      expect(r.flyover.path.length, id).toBeGreaterThanOrEqual(2);
      expect(r.objective.length, id).toBeLessThanOrEqual(48);
    }
  });
});

describe.each(IDS)('%s', (id) => {
  it('obstacle params parse with no stripped keys (every variation)', () => {
    const r = round(id);
    for (const variation of [null, ...r.variations]) {
      for (const inst of resolveObstacles(r, variation)) {
        const mod = OBSTACLE_REGISTRY.get(inst.type);
        expect(mod, `${id}/${inst.id}: unknown type ${inst.type}`).toBeDefined();
        const parsed = mod!.schema.parse(inst.params) as Record<string, unknown>;
        for (const key of Object.keys(inst.params)) {
          expect(parsed, `${id}/${variation?.id ?? 'base'}/${inst.id}: param "${key}" stripped`).toHaveProperty(key);
        }
      }
    }
  });

  it('builds with zero warnings in every variation', () => {
    const r = round(id);
    for (const variation of [undefined, ...r.variations.map((v) => v.id)]) {
      const sim = build(r, { variationId: variation, bots: 12 });
      expect(sim.warnings, `${id}/${variation}`).toEqual([]);
      sim.dispose();
    }
  });
});

describe('full-length 40-bot runs', () => {
  const results = new Map<string, { scores: number[]; qualified: number; eliminated: number; finished: boolean; holders: boolean }>();

  beforeAll(() => {
    for (const id of IDS) {
      const sim = build(round(id), { seed: 21 });
      runFull(sim);
      const st = sim.getStatus();
      let holders = true;
      for (const [, p] of st.players) if (p.status === PlayerRoundStatus.Qualified && !p.hasItem) holders = false;
      results.set(id, {
        scores: [...st.teamScores],
        qualified: st.qualifiedCount,
        eliminated: st.eliminatedCount,
        finished: st.finished,
        holders,
      });
      console.log(`[group-4] ${id}`, JSON.stringify(results.get(id)));
      sim.dispose();
    }
  }, 600_000);

  it.each(IDS)('%s decides every fate', (id) => {
    const r = results.get(id)!;
    expect(r.finished).toBe(true);
    expect(r.qualified + r.eliminated).toBe(40);
    expect(r.qualified).toBeGreaterThan(0);
  });

  it('paint and ball rounds produce non-zero team scores from bot play', () => {
    for (const id of ['bounce-ball-blitz', 'paint-the-plaza']) {
      const s = results.get(id)!.scores;
      expect(s.some((x) => x > 0), `${id}: ${s.join(',')}`).toBe(true);
    }
    // Paint: every team paints.
    expect(results.get('paint-the-plaza')!.scores.every((x) => x > 0)).toBe(true);
  });

  it('team rounds eliminate exactly the lowest team', () => {
    expect(results.get('egg-heist')!.qualified).toBeGreaterThanOrEqual(26);
    expect(results.get('bounce-ball-blitz')!.qualified).toBe(20);
    expect(results.get('paint-the-plaza')!.qualified).toBe(30);
  });

  it('hunt round qualifies exactly the tail holders', () => {
    const r = results.get('tail-chase')!;
    expect(r.qualified).toBe(20);
    expect(r.holders).toBe(true);
  });

  it('logic round ends at or above the survivor quota', () => {
    const r = results.get('pattern-panic')!;
    expect(r.qualified).toBeGreaterThanOrEqual(24);
  });
});

describe('egg heist scoring', () => {
  it('scores a nest egg (+1) and a golden egg (+5) for the owning team', () => {
    const sim = build(round('egg-heist'), { bots: 6 });
    sim.setPhase(RoundPhase.Playing, 0);
    sim.step();
    const eggs = sim.obstacle('eggs') as unknown as { getTransform(i: number, p: Vec3, q: unknown): void };
    const gold = sim.obstacle('eggs-gold');
    expect(eggs && gold).toBeTruthy();
    // Drop one egg and one golden egg into team 1's nest (−22.52, ·, −13).
    const world = sim.world;
    const dropInto = (owner: string, index: number, pos: Vec3): void => {
      world.forEachRigidBody((b) => {
        for (let c = 0; c < b.numColliders(); c++) {
          const col = b.collider(c);
          if (sim.surfaces.get(col.handle)?.ownerId === owner && b.isDynamic()) {
            if (index-- === 0) {
              b.setTranslation(pos, true);
              b.setLinvel({ x: 0, y: 0, z: 0 }, true);
            }
          }
        }
      });
    };
    dropInto('eggs', 0, { x: -22.5, y: 1.4, z: -13 });
    dropInto('eggs-gold', 0, { x: -21.5, y: 1.6, z: -13.5 });
    for (let i = 0; i < 90; i++) {
      sim.step();
      sim.events.drain();
    }
    expect(sim.getStatus().teamScores[1]).toBe(6);
    sim.dispose();
  });
});

describe('bounce ball blitz scoring', () => {
  it('a ball in the −Z goal scores for team 1 and is sent back to the centre', () => {
    const sim = build(round('bounce-ball-blitz'), { bots: 4 });
    sim.setPhase(RoundPhase.Playing, 0);
    sim.step();
    let ball: ReturnType<MatchSimHandle['world']['getRigidBody']> | null = null;
    sim.world.forEachRigidBody((b) => {
      if (b.isDynamic() && b.numColliders() > 0 && sim.surfaces.get(b.collider(0).handle)?.ownerId === 'ball') ball = b;
    });
    expect(ball).not.toBeNull();
    ball!.setTranslation({ x: 0, y: 2, z: -34.5 }, true);
    ball!.setLinvel({ x: 0, y: 0, z: -2 }, true);
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.getStatus().teamScores).toEqual([0, 1]);
    for (let i = 0; i < 60 * 3.5; i++) sim.step();
    const p = ball!.translation();
    expect(Math.hypot(p.x, p.z)).toBeLessThan(3);
    expect(p.y).toBeGreaterThan(1);
    sim.dispose();
  });
});

describe('team layouts are symmetric', () => {
  type Item = { kind: string; x: number; z: number; key: string };

  const items = (r: RoundDefinition): Item[] => [
    ...r.geometry
      .filter((g) => !g.decorative)
      .map((g) => ({ kind: 'g', x: g.position.x, z: g.position.z, key: `${g.shape}|${g.position.y}|${g.size.x},${g.size.y},${g.size.z}|${g.surface}` })),
    ...resolveObstacles(r, null)
      .filter((o) => o.type !== 'propSpawner' && o.type !== 'startGate' && o.type !== 'paintGrid')
      .map((o) => ({ kind: 'o', x: o.position.x, z: o.position.z, key: `${o.type}|${o.position.y}|${JSON.stringify({ ...o.params, team: 0 })}` })),
    ...r.triggers.map((t) => ({ kind: 't', x: t.position.x, z: t.position.z, key: `${t.kind}|${t.position.y}|${t.size.x * t.size.z}` })),
  ];

  const invariant = (r: RoundDefinition, deg: number): string[] => {
    const a = (deg * Math.PI) / 180;
    const list = items(r);
    const missing: string[] = [];
    for (const it of list) {
      const x = it.x * Math.cos(a) + it.z * Math.sin(a);
      const z = -it.x * Math.sin(a) + it.z * Math.cos(a);
      const twin = list.find((o) => o.kind === it.kind && o.key === it.key && Math.abs(o.x - x) < 0.02 && Math.abs(o.z - z) < 0.02);
      if (!twin) missing.push(`${it.kind} ${it.key} @(${it.x},${it.z})`);
    }
    return missing;
  };

  it('egg heist is 3-fold rotationally symmetric', () => {
    expect(invariant(round('egg-heist'), 120)).toEqual([]);
  });

  it('bounce ball blitz is point-symmetric through the centre spot', () => {
    expect(invariant(round('bounce-ball-blitz'), 180)).toEqual([]);
  });

  it('paint the plaza is 4-fold rotationally symmetric', () => {
    expect(invariant(round('paint-the-plaza'), 90)).toEqual([]);
  });

  it('team spawns are equidistant from the arena centre', () => {
    for (const id of TEAM_ROUNDS) {
      const o = round(id).spawn.teamOrigins;
      expect(o.length, id).toBe(round(id).qualification.teams);
      const d = o.map((p) => Math.hypot(p.x, p.z));
      for (const x of d) expect(x, id).toBeCloseTo(d[0]!, 1);
    }
  });
});
