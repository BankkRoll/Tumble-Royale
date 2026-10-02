import RAPIER from '@dimforge/rapier3d-compat';

/** The Rapier module namespace. Import types from here so every package uses the one pinned build. */
export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | null = null;

/**
 * Initialises the Rapier WASM module once and returns it. Safe to call repeatedly.
 *
 * The `-compat` build inlines its WASM as base64, so this works unchanged in
 * browsers, Node and workers without bundler configuration.
 *
 * @returns The initialised Rapier namespace.
 */
export function loadRapier(): Promise<Rapier> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Rapier package version, surfaced in debug overlays to confirm client and server match. */
export function rapierVersion(): string {
  return RAPIER.version();
}

export { RAPIER };
