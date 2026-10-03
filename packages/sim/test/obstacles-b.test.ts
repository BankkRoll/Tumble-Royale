import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, Rng, SIM_DT, type Vec3 } from '@tumble/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventSink, type SimEvent } from '../src/events.ts';
import { PARK_Y, poseSample } from '../src/obstacles/helpers-b.ts';
import {
  CannonSchema,
  JumpRopeBeamSchema,
  PROP_NET_STRIDE,
  PropMode,
  cannonBallAt,
  cannonLaneX,
  cannonPose,
  drumAngularVelocity,
  finishSubTick,
  jumpRopeSweptDegrees,
  obstacleSetB,
  RollingDrumSchema,
  type PropSpawnerRuntime,
} from '../src/obstacles/set-b.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
  ObstacleType,
  PoseSample,
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

/** Minimal Tumbler stand-in: a capsule body recording what obstacles did to it. */
class FakeActor implements ObstacleActor {
  readonly body: RigidBody;
  readonly collider: Collider;
  isGhost = false;
  readonly knocks: { impulse: Vec3; stun: boolean }[] = [];
  readonly teleports: Vec3[] = [];

  constructor(
    world: World,
    readonly id: number,
    pos: Vec3,
    gravity = true,
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .lockRotations()
        .setGravityScale(gravity ? 1 : 0),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(0.45, 0.45)
        .setCollisionGroups(InteractionGroups.player)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
  }

  knock(impulse: Vec3, stun: boolean): void {
    this.knocks.push({ impulse: { ...impulse }, stun });
    this.body.applyImpulse(impulse, true);
  }

  push(dv: Vec3): void {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
  }

  teleport(pos: Vec3): void {
    this.teleports.push({ ...pos });
    this.body.setTranslation(pos, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }
}

interface Harness {
  world: World;
  events: EventSink;
  ctx: ObstacleBuildContext;
  log: SimEvent[];
  floor(y?: number, half?: number): void;
  run(rt: ObstacleRuntime, actors: FakeActor[], steps: number, t0?: number): void;
}

function harness(speedScale = 1): Harness {
  const world = createWorld(R);
  const events = new EventSink();
  const ctx: ObstacleBuildContext = {
    R,
    world,
    surfaces: new SurfaceRegistry(),
    events,
    rng: new Rng(7),
    speedScale,
  };
  const queue = new R.EventQueue(true);
  const log: SimEvent[] = [];
  let tick = 0;
  return {
    world,
    events,
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
      for (let s = 0; s < steps; s++) {
        tick++;
        const sctx: ObstacleStepContext = { t: t0 + (s + 1) * SIM_DT, dt: SIM_DT, tick, events, actors };
        rt.update(sctx);
        world.step(queue);
        queue.drainCollisionEvents((h1, h2, started) => {
          const own = mine.get(h1) ?? mine.get(h2);
          const actor = actorOf.get(h1) ?? actorOf.get(h2);
          if (!own || !actor) return;
          if (own.isSensor()) rt.onTrigger?.(actor, own, started, sctx);
          else if (started) rt.onContact?.(actor, own, sctx);
        });
        log.push(...events.drain());
      }
    },
  };
}

function inst<P>(
  type: ObstacleType,
  params: Partial<P> = {},
  position: Vec3 = { x: 0, y: 0, z: 0 },
): ObstacleInstance<P> {
  return { id: `${type}-1`, type, position, params: params as P };
}

function moduleOf(type: ObstacleType): ObstacleModule<Record<string, unknown>> {
  const m = obstacleSetB.find((x) => x.type === type);
  if (!m) throw new Error(`missing module ${type}`);
  return m as ObstacleModule<Record<string, unknown>>;
}

const ALL_TYPES: ObstacleType[] = [
  'slideRamp',
  'iceFloor',
  'stickyGoo',
  'popupBlocks',
  'laserSweep',
  'cannon',
  'bumperCar',
  'rollingDrum',
  'collapsingBridge',
  'jumpRopeBeam',
  'teleporterPair',
  'climbWall',
  'checkpointGate',
  'finishLine',
  'startGate',
  'voidTrigger',
  'propSpawner',
];

// -----------------------------------------------------------------------------
// Generic module checks
// -----------------------------------------------------------------------------

describe('obstacle set B registry', () => {
  it('contains exactly the 17 set-B types, once each', () => {
    expect(obstacleSetB.map((m) => m.type).sort()).toEqual([...ALL_TYPES].sort());
  });

  it.each(ALL_TYPES)('%s: schema defaults parse', (type) => {
    const m = moduleOf(type);
    const p = m.schema.parse({});
    expect(p).toBeTypeOf('object');
    expect(m.displayName.length).toBeGreaterThan(0);
    // Defaults are stable: parsing the parsed output is a no-op.
    expect(m.schema.parse(p)).toEqual(p);
  });
});

describe('pure poses', () => {
  const posed = ALL_TYPES.filter((t) => moduleOf(t).pose);

  it('every kinematic set-B type exposes pose()', () => {
    expect(posed.sort()).toEqual(
      [
        'bumperCar',
        'cannon',
        'collapsingBridge',
        'jumpRopeBeam',
        'laserSweep',
        'popupBlocks',
        'propSpawner',
        'rollingDrum',
        'startGate',
      ].sort(),
    );
  });

  it.each(posed)('%s: deterministic and continuous', (type) => {
    const m = moduleOf(type);
    const p = m.schema.parse({});
    const a: PoseSample[] = [];
    const b: PoseSample[] = [];
    const prev: PoseSample[] = [];
    let first = true;
    // Accumulate and assert once: per-sample expect() calls dominate runtime for 36-block grids.
    let mismatches = 0;
    let nonFinite = 0;
    let badQuat = 0;
    let maxStep = 0;
    for (let i = -120; i < 60 * 25; i++) {
      const t = i * SIM_DT;
      m.pose!(t, p, a, 1.2);
      m.pose!(t, p, b, 1.2);
      expect(a.length).toBeGreaterThan(0);
      for (let k = 0; k < a.length; k++) {
        const sa = a[k]!;
        const sb = b[k]!;
        if (
          sa.pos.x !== sb.pos.x ||
          sa.pos.y !== sb.pos.y ||
          sa.pos.z !== sb.pos.z ||
          sa.rot.w !== sb.rot.w ||
          sa.rot.y !== sb.rot.y
        )
          mismatches++;
        for (const v of [sa.pos.x, sa.pos.y, sa.pos.z, sa.rot.x, sa.rot.y, sa.rot.z, sa.rot.w])
          if (!Number.isFinite(v)) nonFinite++;
        if (Math.abs(Math.hypot(sa.rot.x, sa.rot.y, sa.rot.z, sa.rot.w) - 1) > 1e-6) badQuat++;
        if (!first) {
          const pp = prev[k]!;
          // Parking (spent balls, fallen segments) is a deliberate teleport.
          const parked = sa.pos.y < PARK_Y / 2 || pp.pos.y < PARK_Y / 2;
          if (!parked)
            maxStep = Math.max(
              maxStep,
              Math.hypot(sa.pos.x - pp.pos.x, sa.pos.y - pp.pos.y, sa.pos.z - pp.pos.z),
            );
        }
      }
      for (let k = 0; k < a.length; k++) {
        prev[k] ??= poseSample();
        const s = a[k]!;
        prev[k]!.pos.x = s.pos.x;
        prev[k]!.pos.y = s.pos.y;
        prev[k]!.pos.z = s.pos.z;
      }
      first = false;
    }
    expect(mismatches).toBe(0);
    expect(nonFinite).toBe(0);
    expect(badQuat).toBe(0);
    expect(maxStep).toBeLessThan(1.0);
  });

  it('pose does not allocate new samples once the output array is sized', () => {
    const m = moduleOf('cannon');
    const p = m.schema.parse({});
    const out: PoseSample[] = [];
    m.pose!(0, p, out, 1);
    const refs = out.slice();
    m.pose!(5.3, p, out, 1);
    expect(out.length).toBe(refs.length);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(refs[i]);
  });
});

describe('runtimes in a real Rapier world', () => {
  it.each(ALL_TYPES)('%s: builds, runs 300 steps, disposes cleanly', (type) => {
    const h = harness(1.1);
    h.floor(-2);
    const baseColliders = h.world.colliders.len();
    const baseBodies = h.world.bodies.len();
    const m = moduleOf(type);
    const rt = m.create(inst(type, {}, { x: 0, y: 0, z: 0 }), h.ctx);
    expect(rt.colliders.length).toBeGreaterThan(0);
    for (const c of rt.colliders) expect(h.world.getCollider(c.handle)).toBeTruthy();
    const actor = new FakeActor(h.world, 1, { x: 0.5, y: 3, z: -1 });
    h.run(rt, [actor], 300, -1);
    const p = actor.body.translation();
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    for (const c of rt.colliders) {
      const t = c.translation();
      expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)).toBe(true);
    }
    const tg = rt.telegraph?.(2.5);
    if (tg !== undefined) expect(tg).toBeGreaterThanOrEqual(0);
    for (const e of h.log) if (e.type === 'obstacleCue') expect(m.audioCues).toContain(e.cue);
    rt.dispose();
    h.world.removeCollider(actor.collider, false);
    h.world.removeRigidBody(actor.body);
    expect(h.world.colliders.len()).toBe(baseColliders);
    expect(h.world.bodies.len()).toBe(baseBodies);
    h.world.free();
  });

  it('kinematic parts track pose(t) composed with the instance transform', () => {
    const h = harness(1);
    const m = moduleOf('bumperCar');
    const rt = m.create(
      { id: 'bc', type: 'bumperCar', position: { x: 5, y: 1, z: -3 }, rotation: { yaw: 90 }, params: {} },
      h.ctx,
    );
    h.run(rt, [], 120);
    const out: PoseSample[] = [];
    m.pose!(120 * SIM_DT, m.schema.parse({}), out, 1);
    const local = out[0]!.pos;
    // yaw 90°: local +X → world −Z, local +Z → world +X.
    const body = rt.colliders[0]!.parent()!;
    const t = body.translation();
    expect(t.x).toBeCloseTo(5 + local.z, 3);
    expect(t.y).toBeCloseTo(1 + local.y, 3);
    expect(t.z).toBeCloseTo(-3 - local.x, 3);
    h.world.free();
  });
});

// -----------------------------------------------------------------------------
// Behaviour
// -----------------------------------------------------------------------------

describe('teleporterPair', () => {
  it('zaps an actor standing on the entrance to the exit and emits teleport', () => {
    const h = harness();
    h.floor();
    const rt = moduleOf('teleporterPair').create(
      inst('teleporterPair', { exits: [{ x: 0, y: 0, z: 14 }] }),
      h.ctx,
    );
    const actor = new FakeActor(h.world, 4, { x: 0, y: 1.2, z: 0 });
    h.run(rt, [actor], 30);
    expect(actor.teleports.length).toBe(1);
    const p = actor.body.translation();
    expect(p.z).toBeGreaterThan(12);
    const ev = h.log.find((e) => e.type === 'teleport');
    expect(ev).toMatchObject({ type: 'teleport', player: 4 });
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'teleportZap')).toBe(true);
    h.world.free();
  });

  it('two-way pads do not ping-pong while the player stands on the arrival pad', () => {
    const h = harness();
    h.floor();
    const rt = moduleOf('teleporterPair').create(
      inst('teleporterPair', { twoWay: true, cooldown: 0.2 }),
      h.ctx,
    );
    const actor = new FakeActor(h.world, 2, { x: 0, y: 1.2, z: 0 });
    h.run(rt, [actor], 180);
    expect(actor.teleports.length).toBe(1);
    h.world.free();
  });
});

describe('finishLine', () => {
  it('emits finish with a sub-tick fraction in [0, 1)', () => {
    const h = harness();
    const rt = moduleOf('finishLine').create(inst('finishLine'), h.ctx);
    const actor = new FakeActor(h.world, 9, { x: 0, y: 1.5, z: -4 }, false);
    actor.body.setLinvel({ x: 0, y: 0, z: 7.3 }, true);
    h.run(rt, [actor], 120);
    const fin = h.log.filter((e) => e.type === 'finish');
    expect(fin.length).toBe(1);
    const e = fin[0]!;
    if (e.type !== 'finish') throw new Error('unreachable');
    expect(e.player).toBe(9);
    expect(e.subTick).toBeGreaterThanOrEqual(0);
    expect(e.subTick).toBeLessThan(1);
    expect(h.log.some((x) => x.type === 'obstacleCue' && x.cue === 'finishFanfare')).toBe(true);
    h.world.free();
  });

  it('finishSubTick back-solves the crossing moment', () => {
    // Crossed 0.25 of a step ago at 6 m/s → crossing at 75% through the step.
    expect(finishSubTick(6 * SIM_DT * 0.25, 6, SIM_DT)).toBeCloseTo(0.75, 9);
    expect(finishSubTick(0, 6, SIM_DT)).toBeLessThan(1);
    expect(finishSubTick(1, 0, SIM_DT)).toBe(0);
    expect(finishSubTick(5, 6, SIM_DT)).toBe(0);
  });
});

describe('checkpointGate', () => {
  it('emits checkpoint with its index once per player', () => {
    const h = harness();
    const rt = moduleOf('checkpointGate').create(inst('checkpointGate', { index: 3 }), h.ctx);
    const actor = new FakeActor(h.world, 5, { x: 0, y: 1.5, z: -3 }, false);
    actor.body.setLinvel({ x: 0, y: 0, z: 6 }, true);
    h.run(rt, [actor], 90);
    // Walk back through: still only one event.
    actor.body.setLinvel({ x: 0, y: 0, z: -6 }, true);
    h.run(rt, [actor], 90, 1.5);
    const cps = h.log.filter((e) => e.type === 'checkpoint');
    expect(cps).toEqual([{ type: 'checkpoint', player: 5, index: 3 }]);
    const rtc = rt as ObstacleRuntime & { respawnPoint(id: number, out: Vec3): Vec3 };
    const sp = rtc.respawnPoint(5, { x: 0, y: 0, z: 0 });
    expect(sp.z).toBeGreaterThan(0);
    h.world.free();
  });
});

describe('voidTrigger', () => {
  it('emits fellOut when a player drops into it', () => {
    const h = harness();
    const rt = moduleOf('voidTrigger').create(inst('voidTrigger', {}, { x: 0, y: -30, z: 0 }), h.ctx);
    const actor = new FakeActor(h.world, 11, { x: 3, y: -5, z: 2 });
    h.run(rt, [actor], 120);
    const fo = h.log.filter((e) => e.type === 'fellOut');
    expect(fo.length).toBe(1);
    expect(fo[0]).toMatchObject({ type: 'fellOut', player: 11 });
    h.world.free();
  });
});

describe('laserSweep', () => {
  it('stuns a player the beam sweeps through', () => {
    const h = harness();
    h.floor();
    const rt = moduleOf('laserSweep').create(inst('laserSweep', { speed: 90, height: 1.2 }), h.ctx);
    const actor = new FakeActor(h.world, 3, { x: 0, y: 0.95, z: 4 });
    h.run(rt, [actor], 300);
    expect(actor.knocks.length).toBeGreaterThan(0);
    expect(actor.knocks.every((k) => k.stun)).toBe(true);
    h.world.free();
  });
});

describe('cannon', () => {
  const p = CannonSchema.parse({});

  it('ball trajectory is deterministic and lands on its lane', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const qa = { x: 0, y: 0, z: 0, w: 1 };
    const qb = { x: 0, y: 0, z: 0, w: 1 };
    for (let lane = 0; lane < p.laneCount; lane++) {
      cannonBallAt(p, lane, 0.7, a, qa);
      cannonBallAt(p, lane, 0.7, b, qb);
      expect(b).toEqual(a);
      expect(qb).toEqual(qa);
      cannonBallAt(p, lane, 0, a, qa);
      expect(a.y).toBeCloseTo(p.pivotHeight, 9);
      cannonBallAt(p, lane, p.flightTime, a, qa);
      expect(a.x).toBeCloseTo(cannonLaneX(p, lane), 6);
      expect(a.y).toBeCloseTo(p.landingHeight + p.ballRadius, 6);
      expect(a.z).toBeCloseTo(p.range, 6);
    }
  });

  it('the whole barrage replays identically from the same params', () => {
    const o1: PoseSample[] = [];
    const o2: PoseSample[] = [];
    for (let i = 0; i < 600; i += 7) {
      cannonPose(i * SIM_DT, p, o1, 1);
      cannonPose(i * SIM_DT, CannonSchema.parse({}), o2, 1);
      expect(o2.map((s) => s.pos)).toEqual(o1.map((s) => s.pos));
    }
  });

  it('fires on schedule and emits thumps', () => {
    const h = harness();
    const rt = moduleOf('cannon').create(inst('cannon', { period: 1, startDelay: 0.5 }), h.ctx);
    h.run(rt, [], 60 * 4);
    const thumps = h.log.filter((e) => e.type === 'obstacleCue' && e.cue === 'cannonThump');
    // Shots at 0.5, 1.5, 2.5, 3.5 s.
    expect(thumps.length).toBe(4);
    h.world.free();
  });
});

describe('rollingDrum', () => {
  it('kinematic angular velocity matches the analytic spin so riders get surface speed', () => {
    const h = harness();
    const rt = moduleOf('rollingDrum').create(inst('rollingDrum', { spinSpeed: 60 }), h.ctx);
    h.run(rt, [], 30);
    const body = rt.colliders[0]!.parent()!;
    const p = RollingDrumSchema.parse({ spinSpeed: 60 });
    expect(body.angvel().x).toBeCloseTo(drumAngularVelocity(30 * SIM_DT, p, 1), 2);
    h.world.free();
  });
});

describe('jumpRopeBeam', () => {
  it('angle is the exact integral of the capped linear speed ramp', () => {
    const p = JumpRopeBeamSchema.parse({ startSpeed: 10, acceleration: 4, maxSpeed: 30 });
    // Ramp lasts (30-10)/4 = 5 s: 10·5 + ½·4·25 = 100°, then 30°/s.
    expect(jumpRopeSweptDegrees(5, p)).toBeCloseTo(100, 9);
    expect(jumpRopeSweptDegrees(7, p)).toBeCloseTo(160, 9);
    // Numerical integration agrees.
    let acc = 0;
    const dt = 1e-4;
    for (let t = 0; t < 7; t += dt) acc += Math.min(30, 10 + 4 * (t + dt / 2)) * dt;
    expect(acc).toBeCloseTo(jumpRopeSweptDegrees(7, p), 2);
  });
});

describe('collapsingBridge', () => {
  it('warns then drops segments with tileWarn / tileFell events', () => {
    const h = harness();
    const rt = moduleOf('collapsingBridge').create(
      inst('collapsingBridge', { segments: 4, startDelay: 0.5, interval: 0.5 }),
      h.ctx,
    );
    h.run(rt, [], 60 * 6);
    const warns = h.log
      .filter((e) => e.type === 'tileWarn')
      .map((e) => (e.type === 'tileWarn' ? e.tile : -1));
    const fells = h.log
      .filter((e) => e.type === 'tileFell')
      .map((e) => (e.type === 'tileFell' ? e.tile : -1));
    expect(warns).toEqual([0, 1, 2, 3]);
    expect(fells).toEqual([0, 1, 2, 3]);
    h.world.free();
  });
});

describe('propSpawner', () => {
  it('net state round-trips between two worlds', () => {
    const params = {
      kind: 'egg',
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
      ],
      perPoint: 3,
    };
    const h1 = harness();
    h1.floor();
    const a = moduleOf('propSpawner').create(inst('propSpawner', params), h1.ctx) as PropSpawnerRuntime;
    const actor = new FakeActor(h1.world, 7, { x: -3, y: 1, z: 0 });
    h1.run(a, [actor], 60);
    expect(a.pickup(2, actor, h1.events)).toBe(true);
    h1.run(a, [actor], 30, 1);
    expect(a.carrier(2)).toBe(7);
    expect(a.mode(2)).toBe(PropMode.Carried);
    expect(h1.log.some((e) => e.type === 'propPickup' && e.prop === a.propId(2))).toBe(true);
    const state = a.getNetState!();
    expect(state.length).toBe(1 + a.propCount * PROP_NET_STRIDE);

    const h2 = harness();
    const b = moduleOf('propSpawner').create(inst('propSpawner', params), h2.ctx) as PropSpawnerRuntime;
    b.setNetState!(state);
    expect(b.getNetState!()).toEqual(state);
    expect(b.carrier(2)).toBe(7);
    expect(b.mode(2)).toBe(PropMode.Carried);
    h1.world.free();
    h2.world.free();
  });

  it('respawns props that fall out of the world', () => {
    const h = harness();
    const rt = moduleOf('propSpawner').create(
      inst('propSpawner', { kind: 'ball', respawnBelow: -5, respawnDelay: 0.5 }),
      h.ctx,
    ) as PropSpawnerRuntime;
    // Falls past −5 m at ≈0.74 s under 24 m/s² gravity.
    h.run(rt, [], 48);
    expect(rt.mode(0)).toBe(PropMode.Respawning);
    h.run(rt, [], 40, 0.8);
    expect(h.log.some((e) => e.type === 'obstacleCue' && e.cue === 'propRespawn')).toBe(true);
    h.world.free();
  });

  it('floating crown bobs on its pure pose until grabbed', () => {
    const h = harness();
    const rt = moduleOf('propSpawner').create(
      inst('propSpawner', { kind: 'crown' }),
      h.ctx,
    ) as PropSpawnerRuntime;
    h.run(rt, [], 90);
    expect(rt.mode(0)).toBe(PropMode.Home);
    const pos = { x: 0, y: 0, z: 0 };
    rt.getTransform(0, pos, { x: 0, y: 0, z: 0, w: 1 });
    expect(pos.y).toBeGreaterThan(0.5);
    h.world.free();
  });
});
