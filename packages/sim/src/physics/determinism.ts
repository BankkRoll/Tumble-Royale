import { InteractionGroups, Rng, SIM_DT, quatFromYaw } from '@tumble/shared';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { Rapier } from './rapier.ts';
import { createWorld } from './world.ts';

/** Result of running {@link runDeterminismScenario}. */
export interface DeterminismResult {
  /** Number of fixed steps simulated. */
  steps: number;
  /** Final state per dynamic body: x, y, z, qx, qy, qz, qw. */
  state: number[];
  /** FNV-1a hash over the float32 bit patterns of `state`. Equal hashes mean bit-identical results. */
  hash: string;
  /** Rapier version that produced the result. */
  rapierVersion: string;
}

/**
 * Scripted physics scenario used to verify that client and server Rapier builds
 * produce the same results: a pile of mixed bodies dropped onto a floor under a
 * kinematic spinning bar whose pose is a pure function of sim time.
 *
 * @param R - Initialised Rapier namespace.
 * @param steps - Number of fixed steps to run. Phase 0 acceptance uses 600.
 * @param seed - Seed for initial body placement.
 * @returns The final state and its hash.
 */
export function runDeterminismScenario(R: Rapier, steps = 600, seed = 1337): DeterminismResult {
  const world = createWorld(R);
  const rng = new Rng(seed);

  const floor = world.createRigidBody(R.RigidBodyDesc.fixed());
  world.createCollider(
    R.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0).setCollisionGroups(InteractionGroups.static),
    floor,
  );

  const bar = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.6, 0));
  world.createCollider(R.ColliderDesc.cuboid(6, 0.25, 0.25).setCollisionGroups(InteractionGroups.kinematic), bar);

  const bodies: RigidBody[] = [];
  for (let i = 0; i < 32; i++) {
    const desc = R.RigidBodyDesc.dynamic().setTranslation(rng.range(-4, 4), 2 + i * 0.6, rng.range(-4, 4));
    const body = world.createRigidBody(desc);
    const kind = i % 3;
    const col =
      kind === 0
        ? R.ColliderDesc.ball(0.4)
        : kind === 1
          ? R.ColliderDesc.cuboid(0.35, 0.35, 0.35)
          : R.ColliderDesc.capsule(0.45, 0.45);
    world.createCollider(col.setRestitution(0.3).setFriction(0.7).setCollisionGroups(InteractionGroups.prop), body);
    bodies.push(body);
  }

  const q = quatFromYaw(0);
  for (let s = 0; s < steps; s++) {
    const t = (s + 1) * SIM_DT;
    bar.setNextKinematicRotation(quatFromYaw(t * 2.2, q));
    world.step();
  }

  const state: number[] = [];
  for (const b of bodies) {
    const p = b.translation();
    const r = b.rotation();
    state.push(p.x, p.y, p.z, r.x, r.y, r.z, r.w);
  }
  world.free();

  return { steps, state, hash: hashFloats(state), rapierVersion: R.version() };
}

/**
 * Hashes numbers by their float32 bit patterns. Rapier stores state as f32, so
 * this is exact without being sensitive to f64 formatting differences.
 */
export function hashFloats(values: readonly number[]): string {
  const f = new Float32Array(values);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) {
    h ^= u[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Largest absolute per-component difference between two scenario results.
 *
 * @returns `Infinity` if the results have different shapes.
 */
export function maxStateError(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}
