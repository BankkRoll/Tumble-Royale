/**
 * Match simulation: one round in a Rapier world, driven identically by the
 * authoritative server, client prediction and offline play.
 */
export * from './types.ts';
export {
  createMatchSim,
  COUNTDOWN_SECONDS,
  RESPAWN_DELAY_SECONDS,
  RESPAWN_GHOST_SECONDS,
  SPAWN_LIFT,
  type MatchSimHandle,
} from './match-sim.ts';
export { obstacleRegistry, type AnyObstacleModule, type MatchDeps } from './deps.ts';
export { buildStaticGeometry, pieceParts, type StaticGeometry } from './geometry.ts';
export {
  emptyBox,
  growPoint,
  isBoxEmpty,
  measureCourse,
  pieceHalfExtents,
  type CourseBox,
} from './course.ts';
export { chooseVariation, resolveObstacles, spawnSlots, type SpawnSlot } from './layout.ts';
export {
  ROUND_TIME_SCALE_MAX,
  ROUND_TIME_SCALE_MIN,
  clampRoundTimeScale,
  scaleRoundTimer,
} from './round-time.ts';
export { RoundTriggers } from './triggers.ts';
export { RemoteProxy } from './proxy.ts';
export {
  ObstacleOracle,
  isBotObjective,
  type BotObjectiveProvider,
  type BotSafeSpotProvider,
} from './oracle.ts';
export {
  SimpleController,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
  type SimpleControllerTuning,
} from './test-kit.ts';
