/**
 * @tumble/sim — the simulation core shared by the authoritative server and
 * client-side prediction. Headless: no DOM, no three.js, no wall clock.
 *
 * Sub-modules are also importable directly: `@tumble/sim/character`,
 * `@tumble/sim/obstacles`, `@tumble/sim/rounds`, `@tumble/sim/match`, `@tumble/sim/bots`.
 */
export * from './physics/rapier.ts';
export * from './physics/world.ts';
export * from './physics/surfaces.ts';
export * from './physics/determinism.ts';
export * from './loop.ts';
export * from './events.ts';
export * from './character/types.ts';
export * from './obstacles/types.ts';
export type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
