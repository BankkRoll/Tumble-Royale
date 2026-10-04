/**
 * Obstacle set D: Comet Field, Sunbeam Zones, Puzzle Floor and Throne Floor —
 * generic module checks (schema, run, determinism, net-state budget) plus each
 * mechanic's rules.
 */
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, Rng, SIM_DT, type Vec3 } from '@tumble/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventSink, type SimEvent } from '../src/events.ts';
import {
  CometFieldSchema,
  CometPhase,
  MIX_PARENTS,
  MixOp,
  PuzzleFloorSchema,
  SunbeamZonesSchema,
  ThroneFloorSchema,
  ThronePhase,
  buildPuzzleSchedule,
  cometActiveCount,
  cometHop,
  cometSpotIndex,
  mixOf,
  obstacleSetD,
  stepFrom,
  sunbeamActiveCount,
  sunbeamCentre,
  throneSeatsFor,
  throneTop,
  type CometFieldRuntime,
  type PuzzleFloorRuntime,
  type PuzzleRound,
  type SunbeamZonesRuntime,
  type ThroneFloorRuntime,
} from '../src/obstacles/set-d.ts';
import { patternTileAt, patternTileCenter } from '../src/obstacles/set-c.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
  ObstacleType,
} from '../src/obstacles/types.ts';
import { createWorld } from '../src/physics/world.ts';
import { loadRapier, type Rapier } from '../src/physics/rapier.ts';
import { SurfaceRegistry } from '../src/physics/surfaces.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

/** Floating capsule stand-in: gravity off, so it stays exactly where it is put. */
class FakeActor implements ObstacleActor {
  readonly body: RigidBody;
  readonly collider: Collider;
  isGhost = false;

  constructor(
    world: World,
    readonly id: number,
    pos: Vec3,
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).lockRotations().setGravityScale(0),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(0.45, 0.45).setCollisionGroups(InteractionGroups.player),
      this.body,
    );
  }

  /** Puts the capsule so its feet stand at (x, y, z). */
  place(x: number, y: number, z: number): void {
    this.body.setTranslation({ x, y: y + 0.9, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  knock(impulse: Vec3): void {
    this.body.applyImpulse(impulse, true);
  }

  push(dv: Vec3): void {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
  }

  teleport(pos: Vec3): void {
    this.body.setTranslation(pos, true);
  }
}

interface Harness {
  world: World;
  ctx: ObstacleBuildContext;
  log: SimEvent[];
  /** Steps `rt` from time `t0` without moving actors (no world step); returns the time after. */
  run(rt: ObstacleRuntime, actors: FakeActor[], steps: number, t0?: number): number;
}

function harness(
  opts: { seed?: number; speedScale?: number; entrants?: number; authoritative?: boolean } = {},
): Harness {
  const world = createWorld(R);
  const events = new EventSink();
  const ctx: ObstacleBuildContext = {
    R,
    world,
    surfaces: new SurfaceRegistry(),
    events,
    rng: new Rng(opts.seed ?? 7),
    speedScale: opts.speedScale ?? 1,
    ...(opts.entrants !== undefined ? { entrants: opts.entrants } : {}),
    ...(opts.authoritative !== undefined ? { authoritative: opts.authoritative } : {}),
  };
  const log: SimEvent[] = [];
  let tick = 0;
  return {
    world,
    ctx,
    log,
    run(rt, actors, steps, t0 = 0) {
      for (let s = 0; s < steps; s++) {
        tick++;
        const t = t0 + s * SIM_DT;
        const sctx: ObstacleStepContext = { t, dt: SIM_DT, tick, events, actors };
        rt.update(sctx);
        log.push(...events.drain());
      }
      return t0 + steps * SIM_DT;
    },
  };
}

function inst<P>(type: ObstacleType, params: Partial<P> = {}, id = `${type}-1`): ObstacleInstance<P> {
  return { id, type, position: { x: 0, y: 0, z: 0 }, params: params as P };
}

function moduleOf(type: ObstacleType): ObstacleModule<Record<string, unknown>> {
  const m = obstacleSetD.find((x) => x.type === type);
  if (!m) throw new Error(`missing module ${type}`);
  return m as ObstacleModule<Record<string, unknown>>;
}

function create<T>(type: ObstacleType, h: Harness, params: Record<string, unknown> = {}): T {
  return moduleOf(type).create(inst(type, params), h.ctx) as unknown as T;
}

const scores = (log: readonly SimEvent[], player?: number) =>
  log.filter(
    (e): e is Extract<SimEvent, { type: 'score' }> =>
      e.type === 'score' && (player === undefined || e.player === player),
  );

const TYPES: ObstacleType[] = ['cometField', 'sunbeamZones', 'puzzleFloor', 'throneFloor'];

// -----------------------------------------------------------------------------
// Generic module checks
// -----------------------------------------------------------------------------

describe('obstacle set D registry', () => {
  it('contains the four set-D types once each', () => {
    expect(obstacleSetD.map((m) => m.type).sort()).toEqual([...TYPES].sort());
  });

  it.each(TYPES)('%s: schema defaults parse and are stable', (type) => {
    const m = moduleOf(type);
    const p = m.schema.parse({});
    expect(m.schema.parse(p)).toEqual(p);
    expect(m.displayName.length).toBeGreaterThan(0);
    expect(m.audioCues?.length).toBeGreaterThan(0);
  });

  it.each(TYPES)('%s: runs 20 s with actors, keeps its net state finite and in budget', (type) => {
    const h = harness({ entrants: 2 });
    const actors = [
      new FakeActor(h.world, 1, { x: 1, y: 1, z: 1 }),
      new FakeActor(h.world, 2, { x: -3, y: 1, z: 2 }),
    ];
    const rt = moduleOf(type).create(inst(type), h.ctx);
    expect(() => h.run(rt, actors, 1200)).not.toThrow();
    const state = rt.getNetState?.();
    expect(state?.every((n) => Number.isInteger(n))).toBe(true);
    // The netcode carries at most 64 values per obstacle, as varints below 2^30.
    expect(state!.length).toBeLessThanOrEqual(64);
    for (const n of state!) expect(Math.abs(n)).toBeLessThan(2 ** 30);
    for (const e of h.log) if (e.type === 'obstacleCue') expect(moduleOf(type).audioCues).toContain(e.cue);
    rt.dispose();
  });

  it.each(TYPES)('%s: identical seeds give identical runs', (type) => {
    const runs: unknown[] = [];
    for (let k = 0; k < 2; k++) {
      const h = harness({ seed: 99, entrants: 30 });
      const actors = [
        new FakeActor(h.world, 1, { x: 2, y: 1, z: -2 }),
        new FakeActor(h.world, 2, { x: 0, y: 1, z: 0 }),
      ];
      const rt = moduleOf(type).create(inst(type), h.ctx);
      h.run(rt, actors, 1500);
      runs.push({ state: rt.getNetState!(), events: h.log.map((e) => JSON.stringify(e)) });
      rt.dispose();
    }
    expect(runs[0]).toEqual(runs[1]);
  });
});

// -----------------------------------------------------------------------------
// Comet field
// -----------------------------------------------------------------------------

describe('cometField', () => {
  const params = CometFieldSchema.parse({});

  it('scales live comets with the field and never lands a comet where it just was', () => {
    expect(cometActiveCount(params, 2)).toBe(4);
    expect(cometActiveCount(params, 100)).toBe(params.slots);
    expect(cometActiveCount(CometFieldSchema.parse({ slots: 40 }), 100)).toBe(33);
    expect(cometActiveCount(params, 0)).toBe(params.base);
    for (let i = 0; i < params.slots; i++)
      for (let hop = -2; hop < 30; hop++)
        expect(cometSpotIndex(i, hop, params, 1234)).not.toBe(cometSpotIndex(i, hop - 1, params, 1234));
  });

  /** First slot resting at `t`, with its spot. */
  function resting(rt: CometFieldRuntime, t: number): { i: number; spot: Vec3 } {
    const spot = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < rt.activeCount; i++)
      if (rt.phaseAt(i, t, spot) === CometPhase.Resting) return { i, spot };
    throw new Error('no resting comet');
  }

  it('the first player to touch a resting comet catches it, once per hop', () => {
    const h = harness({ entrants: 2 });
    const rt = create<CometFieldRuntime>('cometField', h);
    const t = 2;
    const { i, spot } = resting(rt, t);
    const a = new FakeActor(h.world, 4, { x: 0, y: 1, z: 0 });
    const b = new FakeActor(h.world, 5, { x: 0, y: 1, z: 0 });
    a.place(spot.x, spot.y, spot.z);
    b.place(spot.x + 0.3, spot.y, spot.z);
    h.run(rt, [a, b], 30, t);
    const got = scores(h.log);
    // Two comets can share a landing spot; both go to whoever touched first.
    expect(got.length).toBeGreaterThanOrEqual(1);
    got.forEach((e, k) => expect(e).toMatchObject({ team: -1, player: 4, delta: 1, total: k + 1 }));
    expect(rt.phaseAt(i, t + 0.1, { x: 0, y: 0, z: 0 })).toBe(CometPhase.Caught);
    expect(rt.caughtHop(i)).toBe(cometHop(i, t, params, 1));
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'catch')).toBe(true);
    rt.dispose();
  });

  it('golden comets are worth their bonus; nothing is caught before PLAYING or out of reach', () => {
    const h = harness({ entrants: 2 });
    const rt = create<CometFieldRuntime>('cometField', h, { bonusSlots: 8, bonusPoints: 3, hop: 6 });
    const spot = { x: 0, y: 0, z: 0 };
    expect(rt.phaseAt(0, -2, spot)).not.toBe(CometPhase.Inactive);
    const a = new FakeActor(h.world, 1, { x: 0, y: 1, z: 0 });
    a.place(spot.x, spot.y, spot.z);
    h.run(rt, [a], 60, -2);
    expect(scores(h.log)).toHaveLength(0);
    const r = resting(rt, 3);
    a.place(r.spot.x, r.spot.y + 3, r.spot.z);
    h.run(rt, [a], 10, 3);
    expect(scores(h.log)).toHaveLength(0);
    a.place(r.spot.x, r.spot.y, r.spot.z);
    h.run(rt, [a], 10, 3.2);
    expect(scores(h.log)[0]?.delta).toBe(r.i < 8 ? 3 : 1);
    rt.dispose();
  });

  it('prediction sims never catch; the server state tells them what was caught', () => {
    const server = harness({ entrants: 2 });
    const client = harness({ entrants: 2, authoritative: false });
    const a = create<CometFieldRuntime>('cometField', server);
    const b = create<CometFieldRuntime>('cometField', client);
    const { i, spot } = resting(a, 2);
    const sa = new FakeActor(server.world, 1, { x: 0, y: 1, z: 0 });
    const ca = new FakeActor(client.world, 1, { x: 0, y: 1, z: 0 });
    sa.place(spot.x, spot.y, spot.z);
    ca.place(spot.x, spot.y, spot.z);
    server.run(a, [sa], 10, 2);
    client.run(b, [ca], 10, 2);
    expect(scores(client.log)).toHaveLength(0);
    expect(b.caughtHop(i)).not.toBe(a.caughtHop(i));
    b.setNetState(a.getNetState());
    expect(b.caughtHop(i)).toBe(a.caughtHop(i));
    expect(b.getNetState()).toEqual(a.getNetState());
    a.dispose();
    b.dispose();
  });

  it('botSafeSpot names the nearest comet that is resting or about to land', () => {
    const h = harness({ entrants: 20 });
    const rt = create<CometFieldRuntime>('cometField', h);
    const t = 4;
    const out = { x: 5, y: 0.9, z: -5 };
    expect(rt.botSafeSpot(t, out)).toBe(true);
    const spot = { x: 0, y: 0, z: 0 };
    let best = Infinity;
    for (let i = 0; i < rt.activeCount; i++) {
      if (rt.phaseAt(i, t, spot) !== CometPhase.Resting) continue;
      best = Math.min(best, Math.hypot(spot.x - 5, spot.z + 5));
    }
    expect(Math.hypot(out.x - 5, out.z + 5)).toBeLessThanOrEqual(best + 1e-9);
    expect(params.spots.some((s) => Math.abs(s.x - out.x) < 1e-9 && Math.abs(s.z - out.z) < 1e-9)).toBe(true);
    rt.dispose();
  });
});

// -----------------------------------------------------------------------------
// Sunbeam zones
// -----------------------------------------------------------------------------

describe('sunbeamZones', () => {
  const params = SunbeamZonesSchema.parse({});

  it('beams drift inside their area and scale with the field', () => {
    expect(sunbeamActiveCount(params, 2)).toBe(1);
    expect(sunbeamActiveCount(params, 30)).toBe(4);
    expect(sunbeamActiveCount(SunbeamZonesSchema.parse({ beams: 12 }), 100)).toBe(12);
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < params.beams; i++)
      for (let t = 0; t < 120; t += 0.37) {
        sunbeamCentre(i, t, params, 1.2, c);
        expect(Math.abs(c.x)).toBeLessThanOrEqual(params.areaX + 1e-9);
        expect(Math.abs(c.z)).toBeLessThanOrEqual(params.areaZ + 1e-9);
      }
  });

  /** Keeps actors glued to beam 0's centre (offset per actor) while stepping. */
  function soak(
    h: Harness,
    rt: SunbeamZonesRuntime,
    actors: FakeActor[],
    seconds: number,
    offsets: number[],
  ): void {
    const c = { x: 0, y: 0, z: 0 };
    let t = 0;
    for (let s = 0; s < Math.round(seconds / SIM_DT); s++) {
      sunbeamCentre(0, t, params, 1, c);
      actors.forEach((a, k) => a.place(c.x + offsets[k]!, 0, c.z));
      t = h.run(rt, actors, 1, t);
    }
  }

  it('a lone player banks rate × time; two in one beam share it', () => {
    const h = harness({ entrants: 2 });
    const rt = create<SunbeamZonesRuntime>('sunbeamZones', h);
    const a = new FakeActor(h.world, 1, { x: 0, y: 1, z: 0 });
    soak(h, rt, [a], 4.05, [0]);
    expect(scores(h.log, 1).map((e) => e.total)).toEqual([1, 2, 3, 4]);
    const h2 = harness({ entrants: 2 });
    const rt2 = create<SunbeamZonesRuntime>('sunbeamZones', h2);
    const b = new FakeActor(h2.world, 2, { x: 0, y: 1, z: 0 });
    const c = new FakeActor(h2.world, 3, { x: 0, y: 1, z: 0 });
    soak(h2, rt2, [b, c], 4.05, [-0.6, 0.6]);
    expect(scores(h2.log, 2)).toHaveLength(2);
    expect(scores(h2.log, 3)).toHaveLength(2);
    expect(rt2.occupants(0)).toBe(2);
    rt.dispose();
    rt2.dispose();
  });

  it('flares multiply the rate; ghosts, the countdown and far players score nothing', () => {
    const h = harness({ entrants: 2 });
    const rt = create<SunbeamZonesRuntime>('sunbeamZones', h, {
      flareEvery: 10,
      flareTime: 10,
      flareMult: 2,
    });
    const a = new FakeActor(h.world, 1, { x: 0, y: 1, z: 0 });
    soak(h, rt, [a], 2.05, [0]);
    expect(scores(h.log, 1)).toHaveLength(4);
    expect(h.log.filter((e) => e.type === 'obstacleCue' && e.cue === 'flare').length).toBeLessThanOrEqual(1);
    const h2 = harness({ entrants: 2 });
    const rt2 = create<SunbeamZonesRuntime>('sunbeamZones', h2);
    const ghost = new FakeActor(h2.world, 1, { x: 0, y: 1, z: 0 });
    ghost.isGhost = true;
    const far = new FakeActor(h2.world, 2, { x: 0, y: 1, z: 0 });
    soak(h2, rt2, [ghost, far], 3, [0, params.radius + 1]);
    const c = { x: 0, y: 0, z: 0 };
    sunbeamCentre(0, -1, params, 1, c);
    const early = new FakeActor(h2.world, 3, { x: c.x, y: 1, z: c.z });
    early.place(c.x, 0, c.z);
    h2.run(rt2, [early], 30, -1);
    expect(scores(h2.log)).toHaveLength(0);
    rt.dispose();
    rt2.dispose();
  });

  it('prediction sims hand out nothing; occupancy round-trips through the net state', () => {
    const client = harness({ entrants: 2, authoritative: false });
    const rt = create<SunbeamZonesRuntime>('sunbeamZones', client);
    const a = new FakeActor(client.world, 1, { x: 0, y: 1, z: 0 });
    soak(client, rt, [a], 3, [0]);
    expect(scores(client.log)).toHaveLength(0);
    rt.setNetState([3, 0, 1]);
    expect(rt.occupants(0)).toBe(3);
    expect(rt.getNetState().slice(0, 3)).toEqual([3, 0, 1]);
    rt.dispose();
  });

  it('botSafeSpot steers to an empty beam over a crowded one nearby', () => {
    const h = harness({ entrants: 30 });
    const rt = create<SunbeamZonesRuntime>('sunbeamZones', h, { areaX: 0, areaZ: 0 });
    const out = { x: 0, y: 1, z: 0 };
    expect(rt.botSafeSpot(1, out)).toBe(true);
    expect(Math.hypot(out.x, out.z)).toBeLessThan(1e-9);
    rt.dispose();
  });
});

// -----------------------------------------------------------------------------
// Puzzle floor
// -----------------------------------------------------------------------------

describe('puzzleFloor', () => {
  const mix = PuzzleFloorSchema.parse({ puzzle: 'mix' });
  const trail = PuzzleFloorSchema.parse({ puzzle: 'trail' });
  const safeTiles = (r: PuzzleRound): number[] => [...r.safe.keys()].filter((i) => r.safe[i] === 1);

  it('mix: the safe tiles are exactly the answer colour, which the sum or difference makes', () => {
    for (let seed = 1; seed < 25; seed++) {
      const s = buildPuzzleSchedule(mix, 1, new Rng(seed));
      expect(s[0]!.teach).toBe(true);
      expect(s[2]!.op).toBe(MixOp.Subtract);
      for (const r of s.slice(0, 14)) {
        const want = r.op === MixOp.Add ? mixOf(r.a, r.b) : MIX_PARENTS[r.a]!.find((c) => c !== r.b);
        expect(r.answer, `seed ${seed} round ${r.number}`).toBe(want);
        if (r.op === MixOp.Add) expect(r.a).not.toBe(r.b);
        else expect(MIX_PARENTS[r.a]).toContain(r.b);
        const safe = safeTiles(r);
        for (let i = 0; i < r.tiles.length; i++) expect(r.safe[i] === 1).toBe(r.tiles[i] === r.answer);
        expect(safe.length).toBeGreaterThanOrEqual(2);
        const oneRow = safe.every((i) => Math.floor(i / 5) === Math.floor(safe[0]! / 5));
        const oneCol = safe.every((i) => i % 5 === safe[0]! % 5);
        expect(oneRow || oneCol, `seed ${seed} round ${r.number} answers in one line`).toBe(false);
        for (let c = 0; c < 6; c++)
          if (c !== r.answer) expect(r.tiles.filter((x) => x === c).length).toBeGreaterThanOrEqual(2);
      }
      for (let k = 1; k < s.length; k++) {
        expect(s[k]!.answer).not.toBe(s[k - 1]!.answer);
        expect(s[k]!.start).toBeCloseTo(s[k - 1]!.end, 6);
      }
    }
  });

  it('trail: walking each flag’s arrows for the step count lands on its own safe tile', () => {
    for (let seed = 1; seed < 25; seed++) {
      const s = buildPuzzleSchedule(trail, 1, new Rng(seed));
      for (const r of s.slice(0, 14)) {
        const where = `seed ${seed} round ${r.number}`;
        expect(r.trails.length, where).toBe(r.number <= 6 ? 3 : 2);
        const landings = new Set<number>();
        const starts = new Set(r.trails.map((p) => p[0]!));
        for (const path of r.trails) {
          expect(path, where).toHaveLength(r.steps + 1);
          expect(new Set(path).size, `${where} revisits`).toBe(path.length);
          let at = path[0]!;
          for (let k = 0; k < r.steps; k++) at = stepFrom(at, r.tiles[at]!, trail);
          expect(at, where).toBe(path[path.length - 1]);
          expect(starts.has(at), `${where} lands on a flag`).toBe(false);
          landings.add(at);
        }
        expect(landings.size, where).toBe(r.trails.length);
        expect(safeTiles(r).sort(), where).toEqual([...landings].sort());
      }
    }
  });

  it('memory rounds blank the floor part-way; the stage speed shortens reading down to its floor', () => {
    const slow = buildPuzzleSchedule(mix, 1, new Rng(3));
    const fast = buildPuzzleSchedule(mix, 1.4, new Rng(3));
    expect(slow[2]!.memory).toBe(false);
    expect(slow[3]!.memory).toBe(true);
    expect(slow[3]!.hideAt - slow[3]!.start).toBeCloseTo(
      (slow[3]!.dropAt - slow[3]!.start) * mix.memoryShown,
    );
    expect(slow[2]!.hideAt).toBe(slow[2]!.dropAt);
    expect(fast[0]!.dropAt - fast[0]!.start).toBeCloseTo(9 / 1.4);
    for (const r of fast.slice(0, 20)) expect(r.dropAt - r.start).toBeGreaterThanOrEqual(mix.minThink - 1e-9);
    expect(fast[0]!.tiles).toEqual(slow[0]!.tiles);
  });

  function onTile(h: Harness, tile: number, id = 1): FakeActor {
    const c = patternTileCenter(tile, mix, { x: 0, y: 0, z: 0 });
    const a = new FakeActor(h.world, id, { x: c.x, y: 1, z: c.z });
    a.place(c.x, 0.05, c.z);
    return a;
  }

  it('drops every wrong tile at the reveal and restores them afterwards', () => {
    const h = harness();
    const rt = create<PuzzleFloorRuntime>('puzzleFloor', h, { puzzle: 'mix' });
    const r = rt.schedule[0]!;
    const a = onTile(h, safeTiles(r)[0]!);
    const t = h.run(rt, [a], Math.ceil((r.fallAt + 0.1) / SIM_DT));
    expect(rt.isJudged(0)).toBe(true);
    expect(rt.isVoided(0)).toBe(false);
    for (let i = 0; i < 25; i++) expect(rt.colliders[i]!.isEnabled(), `tile ${i}`).toBe(r.safe[i] === 1);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'reveal')).toBe(true);
    h.run(rt, [a], Math.ceil((r.end - t + 0.05) / SIM_DT), t);
    for (const c of rt.colliders) expect(c.isEnabled()).toBe(true);
    rt.dispose();
  });

  it('voids a board round that would drop everyone (servers only)', () => {
    for (const authoritative of [true, false]) {
      const h = harness({ authoritative });
      const rt = create<PuzzleFloorRuntime>('puzzleFloor', h, { puzzle: 'trail' });
      const r = rt.schedule[0]!;
      const wrong = [...r.safe.keys()].find((i) => r.safe[i] === 0)!;
      const a = onTile(h, wrong);
      h.run(rt, [a], Math.ceil((r.fallAt + 0.1) / SIM_DT));
      expect(rt.isVoided(0)).toBe(authoritative);
      expect(rt.colliders[wrong]!.isEnabled()).toBe(authoritative);
      rt.dispose();
    }
  });

  it('botSafeSpot waits on some tile, then names a safe tile once the bots have solved it', () => {
    const h = harness();
    const rt = create<PuzzleFloorRuntime>('puzzleFloor', h, { puzzle: 'trail' });
    for (const r of rt.schedule.slice(0, 8)) {
      const solved = r.start + (r.dropAt - r.start) * trail.botSolveAt;
      for (let k = 0; k < 6; k++) {
        const out = { x: (k - 3) * 4, y: 1, z: 20 };
        expect(rt.botSafeSpot(r.start + 0.1 + k * SIM_DT, out)).toBe(true);
        expect(patternTileAt(out.x, out.z, trail)).toBeGreaterThanOrEqual(0);
        const hint = { x: (k - 3) * 4, y: 1, z: -20 };
        expect(rt.botSafeSpot(solved + 0.05 + k * SIM_DT, hint)).toBe(true);
        const tile = patternTileAt(hint.x, hint.z, trail);
        expect(r.safe[tile], `round ${r.number}`).toBe(1);
      }
    }
    rt.dispose();
  });

  it('net state round-trips the voided/judged bits', () => {
    const h = harness();
    const a = create<PuzzleFloorRuntime>('puzzleFloor', h, { puzzle: 'mix' });
    const b = create<PuzzleFloorRuntime>('puzzleFloor', harness(), { puzzle: 'mix' });
    const r = a.schedule[0]!;
    const actor = onTile(
      h,
      [...r.safe.keys()].find((i) => r.safe[i] === 0)!,
    );
    h.run(a, [actor], Math.ceil((r.fallAt + 0.1) / SIM_DT));
    b.setNetState(a.getNetState());
    expect(b.isVoided(0)).toBe(true);
    expect(b.isJudged(0)).toBe(true);
    expect(b.getNetState()).toEqual(a.getNetState());
    a.dispose();
    b.dispose();
  });
});

// -----------------------------------------------------------------------------
// Throne floor
// -----------------------------------------------------------------------------

describe('throneFloor', () => {
  const params = ThroneFloorSchema.parse({});

  it('leaves a quarter of the field (at least one) without a throne', () => {
    expect([15, 12, 9, 7, 6, 5, 4, 3, 2, 1].map((n) => throneSeatsFor(params, n))).toEqual([
      12, 9, 7, 6, 5, 4, 3, 2, 1, 1,
    ]);
    expect(throneSeatsFor(params, 40)).toBe(params.spots.length);
  });

  /** Seat top position (world feet) of throne `j` in cycle `c` once raised. */
  function seat(rt: ThroneFloorRuntime, c: number, j: number): Vec3 {
    const s = params.spots[rt.schedule[c]!.order[j]!]!;
    return { x: s.x, y: s.y + params.seatHeight, z: s.z };
  }

  it('raises thrones, first sitter owns one, bounces a second sitter, then opens the floor', () => {
    const h = harness();
    const rt = create<ThroneFloorRuntime>('throneFloor', h);
    const actors = [0, 1, 2, 3].map((id) => new FakeActor(h.world, id, { x: 0, y: 1, z: 0 }));
    actors.forEach((a, k) => a.place(-6 + k * 4, 0, -10));
    const c = rt.schedule[0]!;
    let t = h.run(rt, actors, Math.ceil((c.upAt + 0.05) / SIM_DT));
    expect(rt.seatsIn(0)).toBe(throneSeatsFor(params, 4));
    expect(throneTop(c, t, params)).toBeCloseTo(params.seatHeight);
    const top = seat(rt, 0, 0);
    actors[0]!.place(top.x, top.y, top.z);
    t = h.run(rt, actors, 2, t);
    expect(rt.ownerOf(0)).toBe(0);
    actors[1]!.place(top.x + 0.3, top.y, top.z);
    t = h.run(rt, actors, 2, t);
    expect(rt.ownerOf(0)).toBe(0);
    const v = actors[1]!.body.linvel();
    expect(v.y).toBeGreaterThan(1);
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(1);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'bounce')).toBe(true);
    actors[1]!.place(-10, 0, -10);
    t = h.run(rt, actors, Math.ceil((c.fallAt + 0.05 - t) / SIM_DT), t);
    expect(rt.colliders[0]!.isEnabled()).toBe(false);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'drop')).toBe(true);
    // The owner's throne still stands while the floor is open.
    expect(throneTop(c, t, params)).toBeCloseTo(params.seatHeight);
    h.run(rt, actors, Math.ceil((c.end - t + 0.05) / SIM_DT), t);
    expect(rt.colliders[0]!.isEnabled()).toBe(true);
    rt.dispose();
  });

  it('an owner knocked off frees the throne; nobody seated voids the drop', () => {
    const h = harness();
    const rt = create<ThroneFloorRuntime>('throneFloor', h);
    const a = new FakeActor(h.world, 7, { x: 0, y: 1, z: 0 });
    const b = new FakeActor(h.world, 8, { x: 0, y: 1, z: 0 });
    a.place(-11, 0, -2);
    b.place(-11, 0, 2);
    const c = rt.schedule[0]!;
    let t = h.run(rt, [a, b], Math.ceil((c.upAt + 0.05) / SIM_DT));
    const top = seat(rt, 0, 0);
    a.place(top.x, top.y, top.z);
    t = h.run(rt, [a, b], 2, t);
    expect(rt.ownerOf(0)).toBe(7);
    a.place(-11, 0, -2);
    t = h.run(rt, [a, b], 2, t);
    expect(rt.ownerOf(0)).toBe(-1);
    h.run(rt, [a, b], Math.ceil((c.fallAt + 0.05 - t) / SIM_DT), t);
    expect(rt.isVoided(0)).toBe(true);
    expect(rt.colliders[0]!.isEnabled()).toBe(true);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'void')).toBe(true);
    rt.dispose();
  });

  it('botSafeSpot names a free throne from the telegraph on, and nothing while roaming', () => {
    const h = harness();
    const rt = create<ThroneFloorRuntime>('throneFloor', h);
    const actors = [0, 1, 2].map((id) => new FakeActor(h.world, id, { x: -11, y: 1, z: id }));
    const c = rt.schedule[0]!;
    const out = { x: 0, y: 1, z: 0 };
    expect(rt.botSafeSpot((c.start + c.teleAt) / 2, out)).toBe(false);
    const t = h.run(rt, actors, Math.ceil((c.upAt + 0.1) / SIM_DT));
    expect(rt.botSafeSpot(t, out)).toBe(true);
    const seats = Array.from({ length: rt.seatsIn(0) }, (_, j) => seat(rt, 0, j));
    expect(
      seats.some((s) => Math.hypot(s.x - out.x, s.z - out.z) < 1e-9 && Math.abs(s.y - out.y) < 1e-9),
    ).toBe(true);
    rt.dispose();
  });

  it('prediction sims take seats and owners from the server; phases follow the schedule', () => {
    const server = harness();
    const client = harness({ authoritative: false });
    const a = create<ThroneFloorRuntime>('throneFloor', server);
    const b = create<ThroneFloorRuntime>('throneFloor', client);
    const c = a.schedule[0]!;
    expect(b.schedule[0]).toEqual(c);
    const actors = [0, 1, 2, 3, 4].map((id) => new FakeActor(server.world, id, { x: -11, y: 1, z: id }));
    const t = server.run(a, actors, Math.ceil((c.upAt + 0.05) / SIM_DT));
    const top = seat(a, 0, 1);
    actors[3]!.place(top.x, top.y, top.z);
    server.run(a, actors, 2, t);
    client.run(b, [], Math.ceil((c.upAt + 0.05) / SIM_DT));
    expect(b.seatsIn(0)).toBe(0);
    b.setNetState(a.getNetState());
    expect(b.seatsIn(0)).toBe(4);
    expect(b.ownerOf(1)).toBe(3);
    expect(b.getNetState()).toEqual(a.getNetState());
    expect(ThronePhase.Scramble).toBeGreaterThan(ThronePhase.Rise);
    a.dispose();
    b.dispose();
  });
});
