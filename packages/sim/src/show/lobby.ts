/**
 * The pre-show lobby platform as a match round: the floating candy disc every
 * player waits on before round 1. Online rooms run it as a real match sim
 * (`lobby: true`, no rules) so movement, grabs, dives and bumps between
 * players replicate exactly like in rounds. The render side
 * (`createPreShowArena`) draws a disc of the same radius at the same height.
 */
import { RoundDefinitionSchema, type RoundDefinition, type Vec3 } from '@tumble/shared';

/** Round id of the lobby; never part of a playlist pool. */
export const PRE_SHOW_LOBBY_ROUND_ID = 'pre-show-lobby';

/** Walkable radius of the lobby disc (the arena's visual platform is 18 m with a soft rim). */
export const LOBBY_PLATFORM_RADIUS = 17.2;

/** The lobby platform round (validated). */
export const PRE_SHOW_LOBBY_ROUND: RoundDefinition = RoundDefinitionSchema.parse({
  id: PRE_SHOW_LOBBY_ROUND_ID,
  name: 'Pre-show',
  type: 'survival',
  theme: 'candy',
  objective: 'Warm up while the show fills!',
  players: { min: 1, max: 60, ideal: 40 },
  qualification: { mode: 'survive' },
  duration: { seconds: 0 },
  killY: -10,
  bounds: { min: { x: -24, y: -20, z: -24 }, max: { x: 24, y: 30, z: 24 } },
  spawn: { origin: { x: 0, y: 0, z: 0 }, yaw: 0, cols: 8, spacing: 1.6 },
  geometry: [
    {
      shape: 'cylinder',
      position: { x: 0, y: -0.5, z: 0 },
      size: { x: LOBBY_PLATFORM_RADIUS, y: 1, z: 0 },
      color: 'safe',
      bevel: 0,
    },
  ],
  flyover: {
    path: [
      { x: 0, y: 15, z: 30 },
      { x: 0, y: 12, z: 20 },
    ],
    lookAt: [{ x: 0, y: 0.5, z: 0 }],
  },
  music: 'none',
  speedScaleByStage: [1],
  fallBehavior: 'respawnCheckpoint',
});

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Deterministic drop-in spot for a player joining the lobby: a sunflower
 * spiral by player id, so simultaneous joiners never land on each other.
 *
 * @param id - Player id (0–63).
 * @param out - Receives the feet position on the platform (y = 0).
 * @returns `out`.
 * @example
 * const p = lobbySpawnPoint(3, { x: 0, y: 0, z: 0 });
 */
export function lobbySpawnPoint(id: number, out: Vec3): Vec3 {
  const k = (id % 48) + 1;
  const r = Math.min(LOBBY_PLATFORM_RADIUS - 2.5, 2 * Math.sqrt(k));
  const a = k * GOLDEN_ANGLE;
  out.x = Math.sin(a) * r;
  out.y = 0;
  out.z = Math.cos(a) * r;
  return out;
}
