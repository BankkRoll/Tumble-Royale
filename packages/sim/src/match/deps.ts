import type { CreateTumblerController } from '../character/types.ts';
import type { ObstacleModule } from '../obstacles/types.ts';
import type { BotBrainFactory } from '../bots/types.ts';

/**
 * An obstacle module with its params type erased. Modules are looked up by
 * the `type` string found in round data, so the param type is only known
 * after `module.schema.parse` at load time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are validated by each module's own zod schema at load; the registry cannot know P statically and ObstacleModule is invariant in P.
export type AnyObstacleModule = ObstacleModule<any>;

/**
 * Collaborators injected into {@link createMatchSim}. The integrator wires the
 * real character controller and obstacle library; tests inject simple stand-ins.
 */
export interface MatchDeps {
  /** Builds a Tumbler controller (real one: `createTumblerController` from `@tumble/sim/character`). */
  createController: CreateTumblerController;
  /** Obstacle modules keyed by `ObstacleType`. Build with {@link obstacleRegistry}. */
  obstacles: ReadonlyMap<string, AnyObstacleModule>;
  /** Character tuning overrides passed to every controller. */
  controllerTuning?: Record<string, unknown>;
  /** Replaces the built-in bot brain (balance tooling, scripted tests). */
  createBotBrain?: BotBrainFactory;
}

/**
 * Merges obstacle module lists into a lookup keyed by module type. Later lists
 * win on duplicate types so a test or event can override a library module.
 *
 * @param sets - Module arrays, e.g. `obstacleSetA`, `obstacleSetB`.
 * @returns A map suitable for {@link MatchDeps.obstacles}.
 * @example
 * const obstacles = obstacleRegistry(obstacleSetA, obstacleSetB);
 */
export function obstacleRegistry(
  ...sets: readonly (readonly AnyObstacleModule[])[]
): Map<string, AnyObstacleModule> {
  const map = new Map<string, AnyObstacleModule>();
  for (const set of sets) for (const m of set) map.set(m.type, m);
  return map;
}
