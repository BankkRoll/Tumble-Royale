import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, Rng, SIM_DT, type Vec3 } from '@tumble/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { CharacterState } from '../src/character/types.ts';
import { EventSink, type SimEvent } from '../src/events.ts';
import type { GoalZoneRuntime, PaintGridRuntime, PatternBoardRuntime } from '../src/obstacles/set-c.ts';
import {
  PaintGridSchema,
  PatternBoardSchema,
  PatternKind,
  buildPatternSchedule,
  obstacleSetC,
  paintCellAt,
  paintRinseAngle,
  patternSeams,
  patternTileAt,
  patternTileCenter,
  type BoardRound,
} from '../src/obstacles/set-c.ts';
import { propSpawner } from '../src/obstacles/propSpawner.ts';
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

/** Capsule stand-in exposing the duck-typed extras the match sim's actors carry. */
class FakeActor implements ObstacleActor {
  readonly body: RigidBody;
  readonly collider: Collider;
  isGhost = false;
  state: number = CharacterState.Idle;
  grounded = true;

  constructor(
    world: World,
    readonly id: number,
    pos: Vec3,
    public team = 0,
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).lockRotations(),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(0.45, 0.45)
        .setCollisionGroups(InteractionGroups.player)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
  }

  /** Puts the capsule centre so its feet stand at `y`. */
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
  floor(y?: number, half?: number): void;
  /** Steps `rt` from time `t0`; returns the time after the last step. */
  run(rt: ObstacleRuntime, actors: FakeActor[], steps: number, t0?: number): number;
}

function harness(seed = 7, speedScale = 1): Harness {
  const world = createWorld(R);
  const events = new EventSink();
  const ctx: ObstacleBuildContext = {
    R,
    world,
    surfaces: new SurfaceRegistry(),
    events,
    rng: new Rng(seed),
    speedScale,
  };
  const queue = new R.EventQueue(true);
  const log: SimEvent[] = [];
  let tick = 0;
  return {
    world,
    ctx,
    log,
    floor(y = 0, half = 60) {
      const b = world.createRigidBody(R.RigidBodyDesc.fixed());
      world.createCollider(
        R.ColliderDesc.cuboid(half, 0.5, half)
          .setTranslation(0, y - 0.5, 0)
          .setCollisionGroups(InteractionGroups.static),
        b,
      );
    },
    run(rt, actors, steps, t0 = 0) {
      const mine = new Map<number, Collider>();
      for (const c of rt.colliders) mine.set(c.handle, c);
      const actorOf = new Map<number, FakeActor>();
      for (const a of actors) actorOf.set(a.collider.handle, a);
      let t = t0;
      for (let s = 0; s < steps; s++) {
        tick++;
        t = t0 + s * SIM_DT;
        const sctx: ObstacleStepContext = { t, dt: SIM_DT, tick, events, actors };
        rt.update(sctx);
        world.step(queue);
        queue.drainCollisionEvents((h1, h2, started) => {
          const own = mine.get(h1) ?? mine.get(h2);
          const actor = actorOf.get(h1) ?? actorOf.get(h2);
          if (!own || !actor || !started) return;
          rt.onContact?.(actor, own, sctx);
        });
        log.push(...events.drain());
      }
      return t + SIM_DT;
    },
  };
}

function inst<P>(
  type: ObstacleType,
  params: Partial<P> = {},
  id = `${type}-1`,
  position: Vec3 = { x: 0, y: 0, z: 0 },
): ObstacleInstance<P> {
  return { id, type, position, params: params as P };
}

function moduleOf(type: ObstacleType): ObstacleModule<Record<string, unknown>> {
  const m = obstacleSetC.find((x) => x.type === type);
  if (!m) throw new Error(`missing module ${type}`);
  return m as ObstacleModule<Record<string, unknown>>;
}

const TYPES: ObstacleType[] = ['paintGrid', 'patternBoard', 'goalZone'];
const props = propSpawner as unknown as ObstacleModule<Record<string, unknown>>;

// -----------------------------------------------------------------------------
// Generic module checks
// -----------------------------------------------------------------------------

describe('obstacle set C registry', () => {
  it('contains the three set-C types once each', () => {
    expect(obstacleSetC.map((m) => m.type).sort()).toEqual([...TYPES].sort());
  });

  it.each(TYPES)('%s: schema defaults parse and are stable', (type) => {
    const m = moduleOf(type);
    const p = m.schema.parse({});
    expect(m.schema.parse(p)).toEqual(p);
    expect(m.displayName.length).toBeGreaterThan(0);
  });

  it.each(TYPES)('%s: creates and runs 300 steps with actors, then disposes', (type) => {
    const h = harness();
    h.floor();
    const actors = [
      new FakeActor(h.world, 1, { x: 1, y: 1, z: 1 }, 0),
      new FakeActor(h.world, 2, { x: -3, y: 1, z: 2 }, 1),
    ];
    const rt = moduleOf(type).create(inst(type), h.ctx);
    expect(() => h.run(rt, actors, 300)).not.toThrow();
    const state = rt.getNetState?.();
    expect(state?.every((n) => Number.isFinite(n))).toBe(true);
    // The netcode carries at most 64 values per obstacle.
    expect(state!.length).toBeLessThanOrEqual(64);
    rt.dispose();
  });

  it.each(TYPES)('%s: identical seeds give identical runs', (type) => {
    const states: number[][] = [];
    for (let k = 0; k < 2; k++) {
      const h = harness(99);
      h.floor();
      const actors = [new FakeActor(h.world, 1, { x: 2, y: 1, z: -2 }, 2)];
      const rt = moduleOf(type).create(inst(type), h.ctx);
      h.run(rt, actors, 240);
      states.push(rt.getNetState!());
      rt.dispose();
    }
    expect(states[0]).toEqual(states[1]);
  });
});

// -----------------------------------------------------------------------------
// Paint grid
// -----------------------------------------------------------------------------

describe('paintGrid', () => {
  const params = PaintGridSchema.parse({
    cols: 10,
    rows: 10,
    cellSize: 2,
    rinseArms: 0,
    stages: [{ x: 5, z: 5, sizeX: 4, sizeZ: 4, height: 1, mult: 2 }],
  });

  it('paints the cell under a grounded actor in its team colour, then lets another team take it', () => {
    const h = harness();
    h.floor();
    const rt = moduleOf('paintGrid').create(inst('paintGrid', params), h.ctx) as unknown as PaintGridRuntime;
    const a = new FakeActor(h.world, 1, { x: 0, y: 0, z: 0 }, 2);
    a.place(-3, 0, -3);
    h.run(rt, [a], 1);
    const cell = paintCellAt(-3, -3, params);
    expect(rt.cellOwner[cell]).toBe(2);
    const out = [0, 0, 0, 0];
    rt.addTeamScores(out);
    expect(out).toEqual([0, 0, 1, 0]);
    // Team 0 walks over it: ownership flips and the books follow.
    const b = new FakeActor(h.world, 2, { x: 0, y: 0, z: 0 }, 0);
    a.place(9, 0, -9);
    b.place(-3, 0, -3);
    h.run(rt, [a, b], 1, 1);
    expect(rt.cellOwner[cell]).toBe(0);
    out.fill(0);
    rt.addTeamScores(out);
    expect(out[0]).toBe(1);
    expect(out[2]).toBe(1);
    rt.dispose();
  });

  it('ignores airborne, ghost and team-less actors; stage cells count double', () => {
    const h = harness();
    const rt = moduleOf('paintGrid').create(inst('paintGrid', params), h.ctx) as unknown as PaintGridRuntime;
    const air = new FakeActor(h.world, 1, { x: 0, y: 0, z: 0 }, 1);
    air.grounded = false;
    air.place(-7, 0, -7);
    const ghost = new FakeActor(h.world, 2, { x: 0, y: 0, z: 0 }, 1);
    ghost.isGhost = true;
    ghost.place(-5, 0, -5);
    const stage = new FakeActor(h.world, 3, { x: 0, y: 0, z: 0 }, 3);
    stage.place(5, 1, 5);
    const lost = new FakeActor(h.world, 4, { x: 0, y: 0, z: 0 }, -1);
    lost.place(1, 0, 1);
    h.run(rt, [air, ghost, stage, lost], 1);
    expect(rt.cellOwner[paintCellAt(-7, -7, params)]).toBe(-1);
    expect(rt.cellOwner[paintCellAt(-5, -5, params)]).toBe(-1);
    expect(rt.cellOwner[paintCellAt(1, 1, params)]).toBe(-1);
    const out = [0, 0, 0, 0];
    rt.addTeamScores(out);
    expect(out[3]).toBe(2);
    rt.dispose();
  });

  it('a dive landing splashes a 3 × 3 block once per dive', () => {
    const h = harness();
    const rt = moduleOf('paintGrid').create(inst('paintGrid', params), h.ctx) as unknown as PaintGridRuntime;
    const a = new FakeActor(h.world, 1, { x: 0, y: 0, z: 0 }, 1);
    a.state = CharacterState.Dive;
    a.place(-1, 0, -1);
    h.run(rt, [a], 1);
    let painted = 0;
    for (let i = 0; i < rt.cellCount; i++) if (rt.cellOwner[i] === 1) painted++;
    expect(painted).toBe(9);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'splash')).toBe(true);
    rt.dispose();
  });

  it('rinse arms wash cells under them back to neutral', () => {
    const h = harness();
    const p = PaintGridSchema.parse({
      cols: 20,
      rows: 20,
      rinseArms: 1,
      rinseHubRadius: 1,
      rinseLength: 18,
      rinseSpeed: 0,
      rinseWidth: 2.5,
    });
    const rt = moduleOf('paintGrid').create(inst('paintGrid', p), h.ctx) as unknown as PaintGridRuntime;
    // Arm 0 at angle 0 points along +X: paint a cell on +X and one on −X.
    const a = new FakeActor(h.world, 1, { x: 0, y: 0, z: 0 }, 0);
    a.place(9, 0, 1);
    const b = new FakeActor(h.world, 2, { x: 0, y: 0, z: 0 }, 0);
    b.place(-9, 0, 1);
    h.run(rt, [a, b], 1);
    a.place(30, 0, 30);
    h.run(rt, [a], 1, 0.1);
    expect(rt.cellOwner[paintCellAt(9, 1, p)]).toBe(-1);
    expect(rt.cellOwner[paintCellAt(-9, 1, p)]).toBe(0);
    rt.dispose();
  });

  it('rinse angle integrates the speed schedule continuously', () => {
    const p = PaintGridSchema.parse({ rinseSpeed: 0.5, rinseSchedule: [{ t: 10, speed: 1.5 }] });
    expect(paintRinseAngle(10, p, 1)).toBeCloseTo(10, 6);
    expect(paintRinseAngle(20, p, 1)).toBeCloseTo(25, 6);
    expect(paintRinseAngle(5, p, 2)).toBeCloseTo(2 * (0.5 * 5 + 0.05 * 5 * 5), 6);
  });

  it('buckets grant a three-wide swath and come back later', () => {
    const h = harness();
    const p = PaintGridSchema.parse({
      cols: 20,
      rows: 20,
      rinseArms: 0,
      buckets: [{ x: 0, z: 0 }],
      bucketDuration: 2,
      bucketRespawn: 3,
    });
    const rt = moduleOf('paintGrid').create(inst('paintGrid', p), h.ctx) as unknown as PaintGridRuntime;
    const a = new FakeActor(h.world, 1, { x: 0, y: 0, z: 0 }, 1);
    a.place(0.5, 0, 0.5);
    h.run(rt, [a], 1);
    expect(rt.bucketReadyAt[0]).toBeCloseTo(5, 3);
    a.place(9, 0, 9);
    a.body.setLinvel({ x: 0, y: 0, z: 6 }, true);
    h.run(rt, [a], 1, 0.5);
    expect(rt.cellOwner[paintCellAt(7, 9, p)]).toBe(1);
    expect(rt.cellOwner[paintCellAt(11, 9, p)]).toBe(1);
    rt.dispose();
  });

  it('net state round-trips cells and bucket timers', () => {
    const h = harness();
    const p = PaintGridSchema.parse({
      rinseArms: 0,
      buckets: [
        { x: 4, z: 4 },
        { x: -4, z: -4 },
        { x: 8, z: 0 },
      ],
    });
    const a = moduleOf('paintGrid').create(inst('paintGrid', p), h.ctx) as unknown as PaintGridRuntime;
    const actors = [0, 1, 2, 3].map((t) => {
      const f = new FakeActor(h.world, t + 1, { x: 0, y: 0, z: 0 }, t);
      f.place(-10 + t * 6, 0, 3);
      return f;
    });
    actors[0]!.place(4, 0, 4);
    h.run(a, actors, 1, 2);
    const state = a.getNetState();
    const h2 = harness();
    const b = moduleOf('paintGrid').create(inst('paintGrid', p), h2.ctx) as unknown as PaintGridRuntime;
    b.setNetState(state);
    expect(Array.from(b.cellOwner)).toEqual(Array.from(a.cellOwner));
    expect(Array.from(b.bucketReadyAt)).toEqual(Array.from(a.bucketReadyAt));
    expect(b.getNetState()).toEqual(state);
    a.dispose();
    b.dispose();
  });

  it('botSafeSpot names a point on the grid', () => {
    const h = harness();
    const rt = moduleOf('paintGrid').create(inst('paintGrid', params), h.ctx) as unknown as PaintGridRuntime;
    const out = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 12; k++) {
      expect(rt.botSafeSpot(3 + k * SIM_DT, out)).toBe(true);
      expect(paintCellAt(out.x, out.z, params)).toBeGreaterThanOrEqual(0);
    }
    rt.dispose();
  });
});

// -----------------------------------------------------------------------------
// Pattern board
// -----------------------------------------------------------------------------

describe('patternBoard', () => {
  const params = PatternBoardSchema.parse({});

  const tilesOf = (r: BoardRound, symbol: number): number[] =>
    [...r.symbols.keys()].filter((i) => r.symbols[i] === symbol);
  const safeTiles = (r: BoardRound): number[] =>
    [...r.symbols.keys()].filter((i) => (r.safeMask & (1 << i)) !== 0);

  it('follows the rules table: teach, memory, two-tile targets, double, NOT, sweeper', () => {
    const s = buildPatternSchedule(params, 1, new Rng(5));
    expect(s[0]!.litDecide).toBe(true);
    expect(new Set(s[0]!.symbols).size).toBe(4);
    expect(safeTiles(s[0]!)).toHaveLength(4);
    expect(s[1]!.hideAt - s[1]!.start).toBeCloseTo(5);
    expect(safeTiles(s[1]!)).toHaveLength(4);
    expect(new Set(s[2]!.symbols).size).toBe(6);
    expect(new Set(s[3]!.symbols).size).toBe(8);
    expect(safeTiles(s[3]!)).toHaveLength(2);
    expect(s[4]!.kind).toBe(PatternKind.Double);
    expect(safeTiles(s[4]!)).toHaveLength(4);
    expect(s[5]!.kind).toBe(PatternKind.Not);
    expect(safeTiles(s[5]!)).toHaveLength(14);
    expect(tilesOf(s[5]!, s[5]!.targets[0]).some((i) => [5, 6, 9, 10].includes(i))).toBe(true);
    expect(s[5]!.sweeper).toBe(false);
    expect(s[6]!.sweeper).toBe(true);
    for (let k = 1; k < s.length; k++) {
      // Never the same target twice in a row; rounds chain back to back.
      expect(s[k]!.targets[0]).not.toBe(s[k - 1]!.targets[0]);
      expect(s[k]!.start).toBeCloseTo(s[k - 1]!.end, 6);
    }
  });

  it('never puts identical symbols side by side from round 2, nor a target in one line from round 4', () => {
    for (let seed = 1; seed < 30; seed++) {
      const s = buildPatternSchedule(params, 1, new Rng(seed));
      for (const r of s.slice(1, 12)) {
        for (let i = 0; i < 16; i++) {
          if (i % 4 < 3) expect(r.shown[i] === r.shown[i + 1], `seed ${seed} round ${r.number}`).toBe(false);
          if (i < 12) expect(r.shown[i] === r.shown[i + 4], `seed ${seed} round ${r.number}`).toBe(false);
        }
        if (r.number >= 4 && r.kind !== PatternKind.Not) {
          for (const t of r.targets) {
            if (t < 0) continue;
            const tiles = tilesOf(r, t);
            const oneRow = tiles.every((i) => Math.floor(i / 4) === Math.floor(tiles[0]! / 4));
            const oneCol = tiles.every((i) => i % 4 === tiles[0]! % 4);
            expect(oneRow || oneCol, `seed ${seed} round ${r.number}`).toBe(false);
          }
        }
      }
    }
  });

  it('stage speed scale shortens phases down to their floors', () => {
    const slow = buildPatternSchedule(params, 1, new Rng(3));
    const fast = buildPatternSchedule(params, 1.2, new Rng(3));
    expect(fast[1]!.hideAt - fast[1]!.start).toBeCloseTo(5 / 1.2);
    for (const r of fast.slice(0, 15)) {
      expect(r.hideAt - r.start).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(r.dropAt - r.decideAt).toBeGreaterThanOrEqual(3 - 1e-9);
    }
    expect(fast[0]!.symbols).toEqual(slow[0]!.symbols);
  });

  /** Runs the board until just after round `r`'s tiles fall, with `actor` parked on `tile`. */
  function toFall(rt: PatternBoardRuntime, h: Harness, actors: FakeActor[], r: BoardRound): number {
    const steps = Math.ceil((r.fallAt + 0.1) / SIM_DT);
    return h.run(rt, actors, steps, 0);
  }

  it('drops every wrong tile at the reveal and restores them afterwards', () => {
    const h = harness();
    const rt = moduleOf('patternBoard').create(
      inst('patternBoard', params),
      h.ctx,
    ) as unknown as PatternBoardRuntime;
    const r = rt.schedule[0]!;
    const safe = safeTiles(r)[0]!;
    const c = patternTileCenter(safe, params, { x: 0, y: 0, z: 0 });
    const a = new FakeActor(h.world, 1, { x: c.x, y: 1, z: c.z });
    a.body.setGravityScale(0, true);
    a.place(c.x, 0.05, c.z);
    const t = toFall(rt, h, [a], r);
    expect(rt.isJudged(0)).toBe(true);
    expect(rt.isVoided(0)).toBe(false);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'reveal')).toBe(true);
    const tiles = rt.colliders.slice(0, 16);
    for (let i = 0; i < 16; i++)
      expect(tiles[i]!.isEnabled(), `tile ${i}`).toBe((r.safeMask & (1 << i)) !== 0);
    // Seams between tiles stand only while every tile they join stands.
    const seams = patternSeams(params);
    seams.forEach((s, k) =>
      expect(rt.colliders[16 + k]!.isEnabled(), `seam ${k}`).toBe(
        s.tiles.every((i) => (r.safeMask & (1 << i)) !== 0),
      ),
    );
    h.run(rt, [a], Math.ceil((r.end - t + 0.05) / SIM_DT), t);
    for (const tile of tiles) expect(tile.isEnabled()).toBe(true);
    rt.dispose();
  });

  it('voids a board round that would eliminate everyone', () => {
    const h = harness();
    const rt = moduleOf('patternBoard').create(
      inst('patternBoard', params),
      h.ctx,
    ) as unknown as PatternBoardRuntime;
    const r = rt.schedule[0]!;
    const wrong = [...Array(16).keys()].find((i) => (r.safeMask & (1 << i)) === 0)!;
    const c = patternTileCenter(wrong, params, { x: 0, y: 0, z: 0 });
    const a = new FakeActor(h.world, 1, { x: c.x, y: 1, z: c.z });
    a.body.setGravityScale(0, true);
    a.place(c.x, 0.05, c.z);
    toFall(rt, h, [a], r);
    expect(rt.isVoided(0)).toBe(true);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'void')).toBe(true);
    for (const tile of rt.colliders.slice(0, 16)) expect(tile.isEnabled()).toBe(true);
    rt.dispose();
  });

  it('botSafeSpot names a correct tile once the target is shown', () => {
    const h = harness();
    const rt = moduleOf('patternBoard').create(
      inst('patternBoard', params),
      h.ctx,
    ) as unknown as PatternBoardRuntime;
    const out = { x: 0, y: 0, z: 0 };
    for (const r of rt.schedule.slice(0, 8)) {
      for (let k = 0; k < 6; k++) {
        const t = r.decideAt + 0.5 + k * SIM_DT;
        expect(rt.botSafeSpot(t, out)).toBe(true);
        const tile = patternTileAt(out.x, out.z, params);
        expect(tile).toBeGreaterThanOrEqual(0);
        expect(r.safeMask & (1 << tile), `round ${r.number}`).not.toBe(0);
      }
      // Keyed bots: a correct tile each, split over at least two answers when there are two.
      const used = new Set<number>();
      for (let key = 0; key < 40; key++) {
        expect(rt.botSafeSpot(r.decideAt + 0.5, out, key)).toBe(true);
        const tile = patternTileAt(out.x, out.z, params);
        expect(r.safeMask & (1 << tile), `round ${r.number} key ${key}`).not.toBe(0);
        used.add(tile);
      }
      expect(used.size).toBeGreaterThanOrEqual(Math.min(2, safeTiles(r).length));
    }
    expect(rt.botDifficulty(rt.schedule[0]!.start + 0.1)).toBeLessThan(0.1);
    expect(rt.botDifficulty(rt.schedule[5]!.start + 0.1)).toBeGreaterThan(
      rt.botDifficulty(rt.schedule[1]!.start + 0.1),
    );
    rt.dispose();
  });

  it('the sweeper bar parks high outside DECIDE and sweeps low during it', () => {
    const s = buildPatternSchedule(params, 1, new Rng(1));
    const out = [{ pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } }];
    const r7 = s.find((r) => r.sweeper)!;
    moduleOf('patternBoard').pose!(r7.start + 0.1, params, out, 1);
    expect(out[0]!.pos.y).toBeCloseTo(params.sweeperParkHeight);
    moduleOf('patternBoard').pose!((r7.decideAt + r7.dropAt) / 2, params, out, 1);
    expect(out[0]!.pos.y).toBeCloseTo(params.sweeperHeight);
    moduleOf('patternBoard').pose!((s[2]!.decideAt + s[2]!.dropAt) / 2, params, out, 1);
    expect(out[0]!.pos.y).toBeCloseTo(params.sweeperParkHeight);
  });

  it('net state round-trips the voided/judged bits', () => {
    const h = harness();
    const a = moduleOf('patternBoard').create(
      inst('patternBoard', params),
      h.ctx,
    ) as unknown as PatternBoardRuntime;
    const b = moduleOf('patternBoard').create(
      inst('patternBoard', params),
      harness().ctx,
    ) as unknown as PatternBoardRuntime;
    const r = a.schedule[0]!;
    const wrong = [...Array(16).keys()].find((i) => (r.safeMask & (1 << i)) === 0)!;
    const c = patternTileCenter(wrong, params, { x: 0, y: 0, z: 0 });
    const actor = new FakeActor(h.world, 1, { x: c.x, y: 1, z: c.z });
    actor.body.setGravityScale(0, true);
    actor.place(c.x, 0.05, c.z);
    toFall(a, h, [actor], r);
    b.setNetState(a.getNetState());
    expect(b.isVoided(0)).toBe(true);
    expect(b.isJudged(0)).toBe(true);
    expect(b.getNetState()).toEqual(a.getNetState());
    a.dispose();
    b.dispose();
  });
});

// -----------------------------------------------------------------------------
// Goal zone
// -----------------------------------------------------------------------------

describe('goalZone', () => {
  it('goal mode celebrates and sends a ball that stays inside back to its spawner', () => {
    const h = harness();
    h.floor();
    const balls = props.create(
      inst('propSpawner', { kind: 'ball', respawnDelay: 1 }, 'ball', { x: 0, y: 4, z: 0 }),
      h.ctx,
    );
    const goal = moduleOf('goalZone').create(
      inst('goalZone', { mode: 'goal', team: 1, sizeX: 6, sizeY: 4, sizeZ: 3, spawners: ['ball'] }, 'goal', {
        x: 0,
        y: 0,
        z: 10,
      }),
      h.ctx,
    ) as unknown as GoalZoneRuntime;
    const body = balls.colliders[0]!.parent()!;
    body.setTranslation({ x: 0, y: 1.7, z: 10 }, true);
    const t = h.run(goal, [], 3, 0);
    expect(goal.goals).toBe(1);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'goal')).toBe(true);
    expect(body.translation().y).toBeLessThan(-100);
    // The spawner notices, hides it and re-drops it at home after its delay.
    h.run(balls, [], Math.ceil(1.3 / SIM_DT), t);
    expect(body.translation().y).toBeGreaterThan(0);
    expect(Math.hypot(body.translation().x, body.translation().z - 10)).toBeGreaterThan(5);
    goal.dispose();
    balls.dispose();
  });

  it('nest mode holds the bonus of special props resting inside for its team', () => {
    const h = harness();
    h.floor();
    const gold = props.create(inst('propSpawner', { kind: 'egg' }, 'eggs-gold', { x: 0, y: 0, z: 0 }), h.ctx);
    const plain = props.create(
      inst('propSpawner', { kind: 'egg', idBase: 1100 }, 'eggs', { x: 3, y: 0, z: 0 }),
      h.ctx,
    );
    const nest = moduleOf('goalZone').create(
      inst(
        'goalZone',
        { mode: 'nest', team: 2, sizeX: 8, sizeY: 3, sizeZ: 8, bonus: { 'eggs-gold': 4 } },
        'nest',
        { x: 0, y: 0, z: 0 },
      ),
      h.ctx,
    ) as unknown as GoalZoneRuntime;
    h.run(nest, [], 2);
    expect(nest.inside).toBe(2);
    const out = [0, 0, 0, 0];
    nest.addTeamScores(out);
    expect(out).toEqual([0, 0, 4, 0]);
    plain.dispose();
    gold.dispose();
    nest.dispose();
  });
});
