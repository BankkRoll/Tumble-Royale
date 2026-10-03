/**
 * `@tumble/sim/character` — the Tumbler controller.
 *
 * Exports the contract types, the {@link TumblerController} implementation and
 * its factory, the tuning type and defaults, and snapshot helpers.
 */
export * from './types.ts';
export * from './tuning.ts';
export * from './state.ts';
export { TumblerController, createTumblerController, GrabKind } from './controller.ts';
export type { TumblerControllerOptions, TumblerDebugInfo } from './controller.ts';
