import { z } from 'zod';

/**
 * Round definition schema. Every round in `packages/content/src/rounds/<id>/`
 * exports a value that passes `RoundDefinitionSchema.parse`. All coordinates are
 * metres, Y up. The course's general direction of travel is +Z unless stated.
 */

/** 3-vector. */
export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Yaw/pitch/roll in degrees. */
export const RotationSchema = z
  .object({ yaw: z.number().default(0), pitch: z.number().default(0), roll: z.number().default(0) })
  .partial();

/** Surface behaviour of static geometry. */
export const SurfaceKindSchema = z.enum(['normal', 'ice', 'slime', 'conveyor', 'sticky', 'bouncy', 'slide']);

/**
 * A static piece of level geometry. Renderer turns these into chunky toon
 * meshes (rounded edges, theme palette); sim turns them into fixed colliders.
 */
export const StaticPieceSchema = z.object({
  shape: z.enum(['box', 'cylinder', 'ramp', 'wedge', 'sphere', 'hexPrism', 'torus', 'arch']),
  position: Vec3Schema,
  rotation: RotationSchema.optional(),
  /**
   * box/ramp/wedge: full extents x,y,z. cylinder/hexPrism: x = radius, y = height.
   * sphere: x = radius. torus: x = major radius, y = tube radius. arch: x = width, y = height, z = depth.
   */
  size: Vec3Schema,
  surface: SurfaceKindSchema.default('normal'),
  /** Palette key from the theme ("primary", "secondary", "accent", "danger", "safe", "neutral") or a hex colour. */
  color: z.string().default('primary'),
  /** Rounded-edge radius for boxes, for the toy look. */
  bevel: z.number().default(0.15),
  grabbable: z.boolean().default(false),
  /** Purely decorative: rendered, no collider. */
  decorative: z.boolean().default(false),
  /** Optional pattern overlay for readability. */
  pattern: z.enum(['none', 'stripes', 'dots', 'checker', 'chevron', 'hazard']).default('none'),
});

/** Placed obstacle instance (params validated against the module's own schema at load). */
export const ObstacleInstanceSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: Vec3Schema,
  rotation: RotationSchema.optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** Trigger volumes for round logic. */
export const TriggerSchema = z.object({
  id: z.string(),
  kind: z.enum(['checkpoint', 'finish', 'void', 'zone', 'goal', 'nest', 'crown']),
  /** Box volume: centre and full extents. */
  position: Vec3Schema,
  size: Vec3Schema,
  rotation: RotationSchema.optional(),
  /** Checkpoint order (0 = start), team index for goals/nests, zone tag otherwise. */
  index: z.number().int().default(0),
  /** Respawn points for checkpoints (players respawn spread across these). */
  respawn: z.array(Vec3Schema).default([]),
  respawnYaw: z.number().default(0),
});

/** Where players spawn. */
export const SpawnSchema = z.object({
  /** Centre of the spawn grid. */
  origin: Vec3Schema,
  /** Facing yaw in degrees. 0 faces +Z. */
  yaw: z.number().default(0),
  cols: z.number().int().default(8),
  spacing: z.number().default(1.4),
  /** Team rounds: one origin per team overrides `origin`. */
  teamOrigins: z.array(Vec3Schema).default([]),
});

/** Camera flyover keyframes shown during INTRO_FLYOVER. */
export const FlyoverSchema = z.object({
  /** Catmull-Rom control points for the camera position. */
  path: z.array(Vec3Schema).min(2),
  /** Matching look-at targets (same length as path, or one target for all). */
  lookAt: z.array(Vec3Schema).min(1),
  duration: z.number().default(7),
});

/** Bot navigation hints: a directed waypoint graph. */
export const WaypointSchema = z.object({
  id: z.number().int(),
  position: Vec3Schema,
  /** Acceptable arrival radius. */
  radius: z.number().default(1.5),
  next: z.array(z.number().int()).default([]),
  /**
   * What to do when moving FROM this waypoint to the next. `waitForPlatform`
   * holds here until the `timeAgainst` obstacle (lift, moving platform) will
   * be under the whole leg, then boards (also used to ride it: put the next
   * leg's waitForPlatform on the boarding waypoint's successor).
   */
  action: z
    .enum(['run', 'jump', 'dive', 'jumpDive', 'waitForGap', 'grab', 'climb', 'waitForPlatform'])
    .default('run'),
  /** Obstacle to time against for waitForGap / waitForPlatform. */
  timeAgainst: z.string().optional(),
});

/** How qualification is decided. */
export const QualificationSchema = z.object({
  /** Fraction of entrants that qualify (race/survival/hunt). Ignored for finals (one winner). */
  ratio: z.number().min(0).max(1).default(0.65),
  /** Team rounds: number of lowest teams eliminated. */
  teamsEliminated: z.number().int().default(1),
  teams: z.number().int().min(0).max(4).default(0),
  /**
   * `scoreTarget` only: points a player must bank to qualify (pickups, time in
   * a scoring zone).
   */
  scoreGoal: z.number().int().min(1).optional(),
  /**
   * Survival: survive until timer end. Race: finish. Hunt: hold item at end, or
   * bank `scoreGoal` points first (`scoreTarget`). Final: crown/last standing.
   */
  mode: z.enum([
    'finish',
    'survive',
    'teamScore',
    'holdItem',
    'lastStanding',
    'crownGrab',
    'logicSurvive',
    'scoreTarget',
  ]),
});

/** One pictogram line of the rules card shown before a round. */
export const RulesCardLineSchema = z.object({
  /** A single emoji or short glyph. */
  icon: z.string().min(1).max(8),
  text: z.string().min(1).max(40),
});

/** Seeded variations applied at round load. */
export const VariationSchema = z.object({
  id: z.string(),
  weight: z.number().default(1),
  description: z.string(),
  /** Obstacle param overrides keyed by obstacle id. */
  obstacleParams: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Obstacle ids removed in this variation. */
  removeObstacles: z.array(z.string()).default([]),
  /** Extra obstacles added in this variation. */
  addObstacles: z.array(ObstacleInstanceSchema).default([]),
  weather: z.enum(['clear', 'windy', 'night', 'sunset', 'snow', 'stormy']).default('clear'),
});

/** Full round definition. */
export const RoundDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['race', 'survival', 'team', 'hunt', 'logic', 'final']),
  theme: z.enum([
    'candy',
    'factory',
    'frosty',
    'jungle',
    'sunset',
    'space',
    'beach',
    'neon',
    'castle',
    'goo',
  ]),
  /** One-line objective shown on the rules card. */
  objective: z.string(),
  /** Tips carousel during intro. */
  tips: z.array(z.string()).default([]),
  /**
   * Rules card lines for rounds whose rules differ from their type's stock card
   * (empty = the stock card for the round type).
   */
  rulesCard: z.array(RulesCardLineSchema).max(4).optional(),
  players: z.object({ min: z.number().int(), max: z.number().int(), ideal: z.number().int() }),
  qualification: QualificationSchema,
  duration: z.object({
    /** Hard time limit in seconds. */
    seconds: z.number(),
    /** Survival rounds: the timer is the goal. Races: limit before remaining players are eliminated. */
    overtimeSeconds: z.number().default(0),
  }),
  /** Players below this Y fall out (respawn at checkpoint or eliminate, per round type). */
  killY: z.number().default(-20),
  /** Quantisation bounds for the netcode; must contain the whole playable space. */
  bounds: z.object({ min: Vec3Schema, max: Vec3Schema }),
  spawn: SpawnSchema,
  geometry: z.array(StaticPieceSchema),
  obstacles: z.array(ObstacleInstanceSchema).default([]),
  triggers: z.array(TriggerSchema).default([]),
  flyover: FlyoverSchema,
  cameraMode: z.enum(['orbit', 'sideFixed', 'topDownTilt']).default('orbit'),
  music: z.string(),
  /** Speed multiplier per show stage (index 0 = round 1 of a show). */
  speedScaleByStage: z.array(z.number()).default([1, 1.1, 1.2, 1.3, 1.4]),
  /** Respawn behaviour when falling below killY. */
  fallBehavior: z.enum(['respawnCheckpoint', 'eliminate']),
  botNav: z.array(WaypointSchema).default([]),
  variations: z.array(VariationSchema).default([]),
  /** Decorative set dressing seed (background islands, balloons, crowd). */
  decorSeed: z.number().int().default(1),
  /** Short difficulty note for designers / balance tooling. */
  designNotes: z.string().default(''),
});

/** Validated round definition (defaults applied). */
export type RoundDefinition = z.output<typeof RoundDefinitionSchema>;
/** Round definition as authored (defaults optional). */
export type RoundDefinitionInput = z.input<typeof RoundDefinitionSchema>;
/** Static geometry piece. */
export type StaticPiece = z.output<typeof StaticPieceSchema>;
/** Trigger volume. */
export type TriggerDef = z.output<typeof TriggerSchema>;
/** Rules card pictogram line. */
export type RulesCardLine = z.output<typeof RulesCardLineSchema>;
/** Bot waypoint. */
export type Waypoint = z.output<typeof WaypointSchema>;

/**
 * Identity helper giving authored rounds type checking and autocompletion.
 *
 * @example
 * export default defineRound({ id: 'gumdrop-gauntlet', ... });
 */
export function defineRound(def: RoundDefinitionInput): RoundDefinitionInput {
  return def;
}
