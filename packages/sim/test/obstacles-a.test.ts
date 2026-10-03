import { describe, expect, it } from 'vitest';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, Rng, SIM_DT, type Vec3 } from '@tumble/shared';
import { EventSink, SurfaceRegistry, createWorld, loadRapier, type Rapier } from '../src/index.ts';
import type {
  DoorGauntletRuntime,
  FallingTilesRuntime,
  SeesawRuntime,
  TiltPlatformRuntime,
} from '../src/obstacles/set-a.ts';
import {
  BOULDER_PARKED_Y,
  TileState,
  boulderLane,
  boulderPoolSize,
  boulderSlotSpawn,
  bouncePad,
  conveyorBelt,
  conveyorTravel,
  conveyorVelocity,
  createPoseBuffer,
  doorGauntlet,
  doorGauntletLayout,
  doorGauntletSchema,
  fallingTileAt,
  fallingTileCenter,
  fallingTiles,
  fallingTilesSchema,
  fanZone,
  obstacleSetA,
  pendulumHammer,
  risingSlime,
  risingSlimeSchema,
  seesaw,
  slimeHeight,
  squareWave,
  squareWaveIntegral,
  tiltPlatform,
} from '../src/obstacles/set-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from '../src/obstacles/types.ts';

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

interface TestActor extends ObstacleActor {
  knocks: number;
  pushes: number;
}

/** A dynamic box standing in for a Tumbler; knock/push act on the body directly. */
function makeActor(R: Rapier, world: World, id: number, pos: Vec3, half = 0.4, density = 1): TestActor {
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setCanSleep(false),
  );
  world.createCollider(
    R.ColliderDesc.cuboid(half, half, half).setDensity(density).setCollisionGroups(InteractionGroups.player),
    body,
  );
  const actor: TestActor = {
    id,
    body,
    isGhost: false,
    knocks: 0,
    pushes: 0,
    knock(impulse) {
      actor.knocks++;
      body.applyImpulse(impulse, true);
    },
    push(dv) {
      actor.pushes++;
      const v = body.linvel();
      body.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
    },
    teleport(p) {
      body.setTranslation(p, true);
    },
  };
  return actor;
}

interface Harness {
  R: Rapier;
  world: World;
  ctx: ObstacleBuildContext;
  actors: TestActor[];
  tick: number;
}

async function harness(seed = 1, floor = true): Promise<Harness> {
  const R = await loadRapier();
  const world = createWorld(R);
  if (floor) {
    const fb = world.createRigidBody(R.RigidBodyDesc.fixed());
    world.createCollider(
      R.ColliderDesc.cuboid(80, 0.5, 80)
        .setTranslation(0, -20.5, 0)
        .setCollisionGroups(InteractionGroups.static),
      fb,
    );
  }
  const ctx: ObstacleBuildContext = {
    R,
    world,
    surfaces: new SurfaceRegistry(),
    events: new EventSink(),
    rng: new Rng(seed),
    speedScale: 1,
  };
  return { R, world, ctx, actors: [], tick: 0 };
}

function inst<P>(
  module: ObstacleModule<P>,
  params: Partial<P> = {},
  position: Vec3 = { x: 0, y: 0, z: 0 },
): ObstacleInstance<P> {
  return { id: `${module.type}-1`, type: module.type, position, params: params as P };
}

/**
 * Steps the world with obstacle updates and the same contact/trigger routing
 * the match sim performs (narrow-phase pairs with at least one contact point).
 */
function run(h: Harness, rt: ObstacleRuntime, steps: number): void {
  const inside = new Set<string>();
  for (let s = 0; s < steps; s++) {
    h.tick++;
    const step: ObstacleStepContext = {
      t: h.tick * SIM_DT,
      dt: SIM_DT,
      tick: h.tick,
      events: h.ctx.events,
      actors: h.actors,
    };
    rt.update(step);
    h.world.step();
    const seen = new Set<string>();
    for (const c of rt.colliders) {
      if (!h.world.colliders.contains(c.handle)) continue;
      if (c.isSensor()) {
        h.world.intersectionPairsWith(c, (other: Collider) => {
          const actor = actorFor(h, other.parent());
          if (!actor) return;
          const key = `${c.handle}:${actor.id}`;
          seen.add(key);
          if (!inside.has(key)) {
            inside.add(key);
            rt.onTrigger?.(actor, c, true, step);
          }
        });
      } else {
        h.world.contactPairsWith(c, (other: Collider) => {
          const actor = actorFor(h, other.parent());
          if (!actor) return;
          let touching = false;
          h.world.contactPair(c, other, (m) => {
            if (m.numContacts() > 0) touching = true;
          });
          if (touching) rt.onContact?.(actor, c, step);
        });
      }
    }
    for (const key of inside) if (!seen.has(key)) inside.delete(key);
  }
}

function actorFor(h: Harness, body: RigidBody | null): TestActor | undefined {
  if (!body) return undefined;
  return h.actors.find((a) => a.body.handle === body.handle);
}

const finite = (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

// -----------------------------------------------------------------------------
// Generic per-module checks
// -----------------------------------------------------------------------------

describe('obstacle set A — every module', () => {
  it('contains all sixteen set-A types exactly once', () => {
    const types = obstacleSetA.map((m) => m.type).sort();
    expect(types).toEqual(
      [
        'bouncePad',
        'boulderLane',
        'bumperPillar',
        'conveyorBelt',
        'doorGauntlet',
        'fallingTiles',
        'fanZone',
        'movingPlatform',
        'pendulumHammer',
        'punchWall',
        'risingSlime',
        'seesaw',
        'spinningDisc',
        'spinwheel',
        'sweeperArm',
        'tiltPlatform',
      ].sort(),
    );
  });

  for (const module of obstacleSetA) {
    describe(module.type, () => {
      it('schema defaults parse', () => {
        const p = module.schema.parse({});
        expect(p).toBeTypeOf('object');
        expect(module.displayName.length).toBeGreaterThan(0);
      });

      if (module.pose) {
        it('pose is deterministic and continuous', () => {
          const p = module.schema.parse({});
          const n = module.poseCount?.(p, 1) ?? 1;
          const a = createPoseBuffer(n);
          const b = createPoseBuffer(n);
          for (const t of [-3, 0, 0.37, 5.5, 61.25]) {
            module.pose!(t, p, a, 1);
            module.pose!(t, p, b, 1);
            expect(a).toEqual(b);
            for (const s of a) {
              expect(finite(s.pos)).toBe(true);
              expect(Math.hypot(s.rot.x, s.rot.y, s.rot.z, s.rot.w)).toBeCloseTo(1, 5);
            }
          }
          // Boulders teleport on respawn by design; covered by their own test.
          if (module.type === 'boulderLane') return;
          module.pose!(0, p, a, 1);
          let maxJump = 0;
          let minDot = 1;
          for (let i = 1; i <= 1200; i++) {
            module.pose!(i * SIM_DT, p, b, 1);
            for (let k = 0; k < n; k++) {
              const pa = a[k]!;
              const pb = b[k]!;
              maxJump = Math.max(
                maxJump,
                Math.hypot(pb.pos.x - pa.pos.x, pb.pos.y - pa.pos.y, pb.pos.z - pa.pos.z),
              );
              minDot = Math.min(
                minDot,
                Math.abs(
                  pa.rot.x * pb.rot.x + pa.rot.y * pb.rot.y + pa.rot.z * pb.rot.z + pa.rot.w * pb.rot.w,
                ),
              );
            }
            for (let k = 0; k < n; k++) {
              Object.assign(a[k]!.pos, b[k]!.pos);
              Object.assign(a[k]!.rot, b[k]!.rot);
            }
          }
          // Punch pistons legitimately cover ~0.7 m per step while striking.
          expect(maxJump).toBeLessThan(module.type === 'punchWall' ? 1 : 0.6);
          expect(minDot).toBeGreaterThan(0.995);
        });
      }

      it('builds in a Rapier world, survives 300 steps and disposes cleanly', async () => {
        const h = await harness(7);
        const baseBodies = h.world.bodies.len();
        const rt = module.create(inst(module), h.ctx);
        expect(rt.colliders.length).toBeGreaterThan(0);
        for (let i = 0; i < 4; i++)
          h.actors.push(makeActor(h.R, h.world, i, { x: i * 1.5 - 2, y: 3 + i, z: 1 }));
        expect(() => run(h, rt, 300)).not.toThrow();
        for (const a of h.actors) expect(finite(a.body.translation())).toBe(true);
        const tg = rt.telegraph?.(5);
        if (tg !== undefined) expect(tg).toBeGreaterThanOrEqual(0);
        if (rt.getNetState && rt.setNetState) {
          const s = rt.getNetState();
          expect(s.every((v) => Number.isInteger(v))).toBe(true);
          rt.setNetState(s);
          const back = rt.getNetState();
          expect(back.length).toBe(s.length);
          for (let i = 0; i < s.length; i++) expect(Math.abs(back[i]! - s[i]!)).toBeLessThanOrEqual(1);
        }
        rt.dispose();
        expect(h.world.bodies.len()).toBe(baseBodies + h.actors.length);
        h.world.free();
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Waveforms
// -----------------------------------------------------------------------------

describe('helpers-a waveforms', () => {
  it('squareWaveIntegral is the integral of squareWave', () => {
    const P = 3;
    const r = 0.8;
    let acc = 0;
    const dt = 1 / 600;
    for (let i = 0; i < 6000; i++) {
      const t = i * dt;
      acc += squareWave(t + dt / 2, P, r) * dt;
      expect(Math.abs(acc - squareWaveIntegral(t + dt, P, r))).toBeLessThan(1e-3);
    }
  });
});

// -----------------------------------------------------------------------------
// Type-specific behaviour
// -----------------------------------------------------------------------------

describe('doorGauntlet', () => {
  it('layout is identical for the same seed and differs for another', () => {
    const p = doorGauntletSchema.parse({ rows: 6, doorsPerRow: 5, fakePerRow: 2 });
    const a = doorGauntletLayout(p, new Rng(1234));
    const b = doorGauntletLayout(p, new Rng(1234));
    const c = doorGauntletLayout(p, new Rng(98765));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    for (let r = 0; r < p.rows; r++) {
      let fakes = 0;
      for (let d = 0; d < p.doorsPerRow; d++) fakes += a[r * p.doorsPerRow + d]!;
      expect(fakes).toBe(2);
    }
  });

  it('runtime layout comes from ctx.rng and broken doors replicate', async () => {
    const h1 = await harness(55);
    const h2 = await harness(55);
    const r1 = doorGauntlet.create(inst(doorGauntlet), h1.ctx) as DoorGauntletRuntime;
    const r2 = doorGauntlet.create(inst(doorGauntlet), h2.ctx) as DoorGauntletRuntime;
    expect(Array.from(r1.layout)).toEqual(Array.from(r2.layout));
    run(h1, r1, 10);
    run(h2, r2, 10);
    const fake = r1.layout.indexOf(1);
    const solid = r1.layout.indexOf(0);
    expect(r1.breakDoor(solid, 0.1)).toBe(false);
    expect(r1.breakDoor(fake, 0.1)).toBe(true);
    r2.setNetState(r1.getNetState());
    expect(r2.doorBroken[fake]).toBe(1);
    expect(r2.doorBroken[solid]).toBe(0);
  });

  it('a player running into a fake door bursts it', async () => {
    const h = await harness(3);
    const rt = doorGauntlet.create(inst(doorGauntlet, { rows: 1 }), h.ctx) as DoorGauntletRuntime;
    const fake = rt.layout.indexOf(1);
    const p = doorGauntletSchema.parse({ rows: 1 });
    const x = (fake - (p.doorsPerRow - 1) / 2) * (p.doorWidth + p.postWidth);
    const runner = makeActor(h.R, h.world, 1, { x, y: 1.2, z: -2 });
    runner.body.setGravityScale(0, true);
    runner.body.setLinvel({ x: 0, y: 0, z: 8 }, true);
    h.actors.push(runner);
    run(h, rt, 40);
    expect(rt.doorBroken[fake]).toBe(1);
    expect(h.ctx.events.events.some((e) => e.type === 'obstacleCue' && e.cue === 'doorBreak')).toBe(true);
  });
});

describe('fallingTiles', () => {
  it('tile lookup matches tile centres for both grid shapes', () => {
    for (const shape of ['square', 'hex'] as const) {
      const p = fallingTilesSchema.parse({ shape, cols: 5, rows: 4 });
      const c = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < p.cols * p.rows; i++) {
        fallingTileCenter(i, p, c);
        expect(fallingTileAt(c.x, c.z, p)).toBe(i);
      }
      expect(fallingTileAt(1000, 0, p)).toBe(-1);
    }
  });

  it('a tile shakes then drops after a body stands on it', async () => {
    const h = await harness(9);
    const rt = fallingTiles.create(
      inst(fallingTiles, { shape: 'square', cols: 3, rows: 3, warnTime: 0.5 }),
      h.ctx,
    ) as FallingTilesRuntime;
    // Centre tile of a 3×3 grid is index 4, centred on the origin.
    const box = makeActor(h.R, h.world, 1, { x: 0, y: 1, z: 0 });
    h.actors.push(box);
    run(h, rt, 30);
    expect(rt.tileState[4]).toBe(TileState.Warning);
    expect(h.ctx.events.events.some((e) => e.type === 'tileWarn' && e.tile === 4)).toBe(true);
    expect(box.body.translation().y).toBeGreaterThan(0);
    run(h, rt, 40);
    expect(rt.tileState[4]).toBe(TileState.Fallen);
    expect(h.ctx.events.events.some((e) => e.type === 'tileFell' && e.tile === 4)).toBe(true);
    run(h, rt, 30);
    expect(box.body.translation().y).toBeLessThan(-1);
    // Neighbours were never stood on.
    expect(rt.tileState[0]).toBe(TileState.Idle);

    const h2 = await harness(9);
    const mirror = fallingTiles.create(
      inst(fallingTiles, { shape: 'square', cols: 3, rows: 3, warnTime: 0.5 }),
      h2.ctx,
    ) as FallingTilesRuntime;
    run(h2, mirror, 100);
    mirror.setNetState(rt.getNetState());
    expect(mirror.tileState[4]).toBe(TileState.Fallen);
    expect(mirror.colliders[4]!.isEnabled()).toBe(false);
  });
});

describe('tiltPlatform & seesaw', () => {
  it('tilt platform tips under an off-centre weight and self-centres when unloaded', async () => {
    const h = await harness(1);
    const rt = tiltPlatform.create(
      inst(tiltPlatform, {}, { x: 0, y: 5, z: 0 }),
      h.ctx,
    ) as TiltPlatformRuntime;
    const weight = makeActor(h.R, h.world, 1, { x: 3, y: 6, z: 0 }, 0.5, 40);
    h.actors.push(weight);
    run(h, rt, 120);
    // Weight on +X pushes the +X edge down: rotation about Z is negative.
    expect(rt.tiltZ).toBeLessThan(-0.05);
    expect(Math.abs(rt.tiltX)).toBeLessThan(0.05);

    const h2 = await harness(1);
    const mirror = tiltPlatform.create(
      inst(tiltPlatform, {}, { x: 0, y: 5, z: 0 }),
      h2.ctx,
    ) as TiltPlatformRuntime;
    mirror.setNetState(rt.getNetState());
    expect(mirror.tiltZ).toBeCloseTo(rt.tiltZ, 2);

    weight.teleport({ x: 0, y: -15, z: 0 });
    run(h, rt, 300);
    expect(Math.abs(rt.tiltZ)).toBeLessThan(0.02);
  });

  it('seesaw drops toward the loaded end', async () => {
    const h = await harness(1);
    const rt = seesaw.create(inst(seesaw), h.ctx) as SeesawRuntime;
    h.actors.push(makeActor(h.R, h.world, 1, { x: -4, y: 2.5, z: 0 }, 0.4, 10));
    run(h, rt, 120);
    // −X end goes down → positive rotation about Z.
    expect(rt.angle).toBeGreaterThan(0.1);
  });
});

describe('conveyorBelt', () => {
  it('writes the pure belt velocity into the surface registry', async () => {
    const h = await harness();
    const rt = conveyorBelt.create(inst(conveyorBelt, { pattern: 'switch', switchPeriod: 2 }), h.ctx);
    run(h, rt, 60);
    const surface = h.ctx.surfaces.get(rt.colliders[0]!.handle)!;
    expect(surface.kind).toBe('conveyor');
    const p = conveyorBelt.schema.parse({ pattern: 'switch', switchPeriod: 2 });
    expect(surface.conveyorVelocity!.z).toBeCloseTo(conveyorVelocity(1, p, 1), 5);
    run(h, rt, 120);
    expect(surface.conveyorVelocity!.z).toBeCloseTo(conveyorVelocity(3, p, 1), 5);
    expect(Math.sign(conveyorVelocity(1, p, 1))).toBe(-Math.sign(conveyorVelocity(3, p, 1)));
    expect(conveyorTravel(4, p, 1)).toBeCloseTo(0, 5);
  });
});

describe('fanZone', () => {
  it('pushes actors inside the wind volume while on, not outside', async () => {
    const h = await harness();
    const rt = fanZone.create(inst(fanZone, { offTime: 0 }, { x: 0, y: 2, z: 0 }), h.ctx);
    const inside = makeActor(h.R, h.world, 1, { x: 0, y: 2, z: 3 });
    const outside = makeActor(h.R, h.world, 2, { x: 10, y: 2, z: 3 });
    for (const a of [inside, outside]) a.body.setGravityScale(0, true);
    h.actors.push(inside, outside);
    run(h, rt, 30);
    expect(inside.body.linvel().z).toBeGreaterThan(3);
    expect(Math.abs(outside.body.linvel().z)).toBeLessThan(1e-3);
  });
});

describe('bouncePad', () => {
  it('launches a body that lands on it and emits a bounce event', async () => {
    const h = await harness();
    const rt = bouncePad.create(inst(bouncePad), h.ctx);
    const a = makeActor(h.R, h.world, 1, { x: 0, y: 2, z: 0 });
    h.actors.push(a);
    let maxVy = 0;
    for (let i = 0; i < 60; i++) {
      run(h, rt, 1);
      maxVy = Math.max(maxVy, a.body.linvel().y);
    }
    expect(maxVy).toBeGreaterThan(12);
    expect(h.ctx.events.events.some((e) => e.type === 'bounce' && e.player === 1)).toBe(true);
  });
});

describe('pendulumHammer', () => {
  it('knocks a player standing in the swing path and emits a whoosh', async () => {
    const h = await harness();
    const rt = pendulumHammer.create(inst(pendulumHammer), h.ctx);
    const floor = h.world.createRigidBody(h.R.RigidBodyDesc.fixed());
    h.world.createCollider(h.R.ColliderDesc.cuboid(10, 0.5, 10).setTranslation(0, -0.5, 0), floor);
    const a = makeActor(h.R, h.world, 1, { x: 0, y: 1.4, z: 0 });
    h.actors.push(a);
    run(h, rt, 240);
    expect(a.knocks).toBeGreaterThan(0);
    expect(h.ctx.events.events.some((e) => e.type === 'obstacleCue' && e.cue === 'whoosh')).toBe(true);
  });
});

describe('risingSlime', () => {
  it('follows its keyframes and registers a lethal surface', async () => {
    const p = risingSlimeSchema.parse({
      keyframes: [
        { t: 10, h: 0 },
        { t: 0, h: -2 },
      ],
      easing: 'linear',
    });
    expect(slimeHeight(-5, p)).toBe(-2);
    expect(slimeHeight(5, p)).toBeCloseTo(-1, 6);
    expect(slimeHeight(50, p)).toBe(0);
    const h = await harness();
    const rt = risingSlime.create(inst(risingSlime), h.ctx);
    expect(h.ctx.surfaces.get(rt.colliders[0]!.handle)?.lethal).toBe(true);
    expect(rt.colliders[0]!.isSensor()).toBe(true);
  });
});

describe('boulderLane', () => {
  it('balls roll continuously between spawns and park when done', () => {
    const p = boulderLane.schema.parse({});
    const pool = boulderPoolSize(p, 1);
    const a = createPoseBuffer(pool);
    const b = createPoseBuffer(pool);
    let active = 0;
    for (let i = 0; i < 1200; i++) {
      const t0 = i * SIM_DT;
      const t1 = t0 + SIM_DT;
      boulderLane.pose!(t0, p, a, 1);
      boulderLane.pose!(t1, p, b, 1);
      for (let j = 0; j < pool; j++) {
        const pa = a[j]!.pos;
        const pb = b[j]!.pos;
        if (pa.y <= BOULDER_PARKED_Y + 1 || pb.y <= BOULDER_PARKED_Y + 1) continue;
        if (boulderSlotSpawn(t0, j, pool, p) !== boulderSlotSpawn(t1, j, pool, p)) continue;
        active++;
        expect(Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)).toBeLessThan(0.5);
        expect(pb.z).toBeGreaterThanOrEqual(pa.z);
      }
    }
    expect(active).toBeGreaterThan(1000);
  });
});
