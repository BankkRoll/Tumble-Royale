import type { SurfaceKind } from '../physics/surfaces.ts';

/**
 * Per-surface control response. Every multiplier is relative to the base
 * value in {@link CharacterTuning}; `1` means "same as normal ground".
 */
export interface SurfaceTuning {
  /** Multiplier on {@link CharacterTuning.maxSpeed}. */
  speedMul: number;
  /** Multiplier on ground acceleration (and turn-around acceleration) while there is move input. */
  accelMul: number;
  /** Multiplier on ground deceleration with no input, and on belly-slide friction. Low values = long slides. */
  decelMul: number;
  /** Multiplier on how fast the Tumbler rotates to face its move direction. */
  turnMul: number;
  /** Multiplier on jump launch speed. */
  jumpMul: number;
  /**
   * Fraction of gravity's along-slope component applied as downhill acceleration
   * while grounded. 0 = you can stand still on any walkable slope; 1 = frictionless.
   */
  slopeSlide: number;
}

/**
 * Every number that shapes how the Tumbler moves. Units are metres, seconds,
 * m/s and m/s² unless stated otherwise. Canonical, documented values live in
 * `@tumble/content/tuning`; {@link DEFAULT_TUNING} mirrors them so the sim has
 * no dependency on content.
 *
 * Values are read live every step, so a debug panel may mutate a controller's
 * tuning object in place.
 */
export interface CharacterTuning {
  // ---------------------------------------------------------------------------
  // Body
  // ---------------------------------------------------------------------------
  /** Capsule radius (m). Changing it at runtime requires a new controller. */
  radius: number;
  /** Capsule cylinder half-height (m); total height = 2 × (halfHeight + radius). */
  halfHeight: number;
  /** Body mass (kg-ish). Only matters when shoving props and other bodies. */
  mass: number;

  // ---------------------------------------------------------------------------
  // Locomotion
  // ---------------------------------------------------------------------------
  /** Top run speed on normal ground (m/s). */
  maxSpeed: number;
  /** Ground acceleration toward the input direction (m/s²). */
  groundAccel: number;
  /** Ground deceleration when there is no input (m/s²). */
  groundDecel: number;
  /** Acceleration used when input opposes current velocity, so reversals feel instant (m/s²). */
  turnAccel: number;
  /** Air acceleration toward the input direction (m/s²). */
  airAccel: number;
  /** Air deceleration with no input (m/s²). Low so jumps keep their momentum. */
  airDecel: number;
  /** Speed bled per second when airborne above max speed (after bounces/dives) and still steering. */
  airOverspeedDrag: number;
  /** Facing rotation speed on the ground (rad/s). */
  turnSpeed: number;
  /** Facing rotation speed in the air (rad/s). */
  airTurnSpeed: number;
  /** Planar speed above which a grounded Tumbler reports Run instead of Idle. */
  runThreshold: number;
  /** Half-life (s) of platform momentum carried into the air after leaving a moving surface. */
  carryHalfLife: number;
  /** Half-life (s) of external pushes (fans, wind) accumulated through `push()`. */
  pushHalfLife: number;

  // ---------------------------------------------------------------------------
  // Ground detection
  // ---------------------------------------------------------------------------
  /** Steepest walkable slope (degrees). Steeper surfaces are slid down. */
  maxSlopeDeg: number;
  /** Gap below the capsule (m) still counted as touching the ground. */
  groundEpsilon: number;
  /** Max drop (m) the Tumbler sticks to while walking (stairs down, crests). */
  snapDistance: number;
  /** Tallest ledge (m) climbed automatically without jumping. */
  stepHeight: number;

  // ---------------------------------------------------------------------------
  // Jump
  // ---------------------------------------------------------------------------
  /** Upward launch speed (m/s). Height ≈ v² / (2·|g|). */
  jumpSpeed: number;
  /** Seconds after leaving a ledge during which a jump is still accepted. */
  coyoteTime: number;
  /** Seconds a jump press is remembered before landing. */
  jumpBufferTime: number;
  /** Upward velocity multiplier applied when jump is released early (variable height). */
  jumpCutMultiplier: number;
  /** Gravity multiplier while rising with jump held. */
  riseGravityScale: number;
  /** Gravity multiplier while falling; > 1 makes arcs snappy. */
  fallGravityScale: number;
  /** Gravity multiplier near the apex while jump is held (hang time). */
  apexGravityScale: number;
  /** |vy| (m/s) below which the apex gravity scale applies. */
  apexThreshold: number;
  /** Terminal fall speed (m/s). */
  maxFallSpeed: number;

  // ---------------------------------------------------------------------------
  // Dive
  // ---------------------------------------------------------------------------
  /** Minimum planar dive speed (m/s). */
  diveSpeed: number;
  /** Planar speed added on top of current forward speed when diving (m/s). */
  diveBoost: number;
  /** Planar dive speed cap (m/s). */
  diveMaxSpeed: number;
  /** Upward speed of a dive started on the ground (m/s). */
  diveUpSpeed: number;
  /** Upward speed added by a dive started in the air (m/s). */
  diveAirUpSpeed: number;
  /** Gravity multiplier during a dive. */
  diveGravityScale: number;
  /** How fast a dive's heading follows input (rad/s). Low = committed dives. */
  diveSteer: number;
  /** Belly-slide friction (m/s²) on normal ground. */
  slideFriction: number;
  /** Belly-slide turn rate (rad/s). */
  slideSteer: number;
  /** Minimum belly-slide duration (s). */
  slideMinTime: number;
  /** Maximum belly-slide duration (s). */
  slideMaxTime: number;
  /** Belly-slide speed (m/s) below which the Tumbler starts getting up. */
  slideStopSpeed: number;
  /** Duration of the get-up animation lock (s). */
  getUpTime: number;

  // ---------------------------------------------------------------------------
  // Stun / tumble
  // ---------------------------------------------------------------------------
  /** Impact speed (m/s) from a moving obstacle that knocks the Tumbler over. */
  stunImpactThreshold: number;
  /** `knock()` impulse magnitude (Δv, m/s) that stuns even when `stun` is false. */
  knockStunThreshold: number;
  /** Shortest stun (s), for impacts right at the threshold. */
  stunMinTime: number;
  /** Longest stun (s). */
  stunMaxTime: number;
  /** Impact strength (m/s) that produces the longest stun. */
  stunMaxStrength: number;
  /** Tumble spin (rad/s) applied on stun, scaled by strength. */
  stunSpin: number;
  /** Collider friction while tumbling, so the body rolls and skids comedically. */
  stunFriction: number;
  /** Final part of a stun (s) spent smoothly rotating back upright. */
  stunRecoverTime: number;
  /** Seconds of reduced control after a non-stunning knock. */
  knockControlTime: number;
  /** Control multiplier during {@link knockControlTime}. */
  knockControlMul: number;
  /** Δv (m/s) imparted by a diving Tumbler that counts as a dive tackle. */
  diveHitThreshold: number;
  /** Stun strength assigned to touching a `stunOnTouch` hazard. */
  hazardStunStrength: number;

  // ---------------------------------------------------------------------------
  // Grab
  // ---------------------------------------------------------------------------
  /** Distance in front of the body centre where the grab sphere sits (m). */
  grabRange: number;
  /** Grab sphere radius (m). */
  grabRadius: number;
  /** Distance kept between grabber and grabbed centres (m). */
  grabHoldDistance: number;
  /** Spring rate (1/s) closing the gap when a grabbed player pulls away. */
  grabPull: number;
  /** Max closing speed of the grab spring (m/s). */
  grabMaxPull: number;
  /** Seconds a full stamina bar lasts while holding a player. */
  grabStaminaTime: number;
  /** Stamina regained per second while not holding (fraction of full). */
  grabStaminaRegen: number;
  /** Seconds before the same Tumbler can grab again after a grab ends. */
  grabCooldown: number;
  /** Speed multiplier while reaching with nothing held. */
  reachSpeedMul: number;
  /** Speed multiplier for a Tumbler holding another player. */
  grabberSpeedMul: number;
  /** Speed multiplier for a Tumbler being held. */
  grabbedSpeedMul: number;
  /** Mash presses needed to break free. */
  breakFreeMashes: number;
  /** Mash progress lost per second. */
  breakFreeDecay: number;
  /** Speed multiplier while carrying a prop. */
  carrySpeedMul: number;
  /** Carried prop distance in front of the body centre (m). */
  carryDistance: number;
  /** Carried prop height above the body centre (m). */
  carryHeight: number;

  // ---------------------------------------------------------------------------
  // Ledges
  // ---------------------------------------------------------------------------
  /** Lowest ledge top, relative to body centre, that can be grabbed (m). */
  ledgeReachMin: number;
  /** Highest ledge top, relative to body centre, that can be grabbed (m). */
  ledgeReachMax: number;
  /** How far beyond the capsule surface the wall probe reaches (m). */
  ledgeProbe: number;
  /** Body centre sits this far below the ledge top while hanging (m). */
  ledgeHangOffset: number;
  /** Duration of the climb-up (s). */
  ledgeClimbTime: number;
  /** Grab ledges automatically when falling into them with move input (no grab button). */
  autoLedgeGrab: boolean;
  /** Vertical speed (m/s) above which ledges are not caught (still rising fast). */
  ledgeMaxRiseSpeed: number;

  // ---------------------------------------------------------------------------
  // Bounce
  // ---------------------------------------------------------------------------
  /** Launch speed off bouncy surfaces without an authored `bounceImpulse` (m/s). */
  bounceSpeed: number;
  /** Seconds after a bounce before another bounce can trigger. */
  bounceCooldown: number;

  // ---------------------------------------------------------------------------
  // Emote
  // ---------------------------------------------------------------------------
  /** Emote duration (s) before returning to Idle. */
  emoteTime: number;
  /** Input magnitude that cancels an emote. */
  emoteCancelInput: number;

  // ---------------------------------------------------------------------------
  // Surfaces
  // ---------------------------------------------------------------------------
  /** Max planar speed on `slide` surfaces (m/s); slides are allowed to exceed run speed. */
  slideSurfaceMaxSpeed: number;
  /** Per-surface response. */
  surfaces: Record<SurfaceKind, SurfaceTuning>;
}

/** Default (normal-ground) surface response. */
const NORMAL_SURFACE: SurfaceTuning = {
  speedMul: 1,
  accelMul: 1,
  decelMul: 1,
  turnMul: 1,
  jumpMul: 1,
  slopeSlide: 0,
};

/**
 * Default tuning. Mirrors `@tumble/content/tuning` CHARACTER_TUNING, which is
 * the documented, canonical source; keep the two in sync.
 */
export const DEFAULT_TUNING: Readonly<CharacterTuning> = Object.freeze({
  radius: 0.45,
  halfHeight: 0.45,
  mass: 1,

  maxSpeed: 7.8,
  groundAccel: 62,
  groundDecel: 56,
  turnAccel: 95,
  airAccel: 24,
  airDecel: 4,
  airOverspeedDrag: 3,
  turnSpeed: 16,
  airTurnSpeed: 9,
  runThreshold: 0.6,
  carryHalfLife: 0.9,
  pushHalfLife: 0.25,

  maxSlopeDeg: 50,
  groundEpsilon: 0.06,
  snapDistance: 0.32,
  stepHeight: 0.35,

  jumpSpeed: 8.8,
  coyoteTime: 0.12,
  jumpBufferTime: 0.12,
  jumpCutMultiplier: 0.45,
  riseGravityScale: 1,
  fallGravityScale: 2,
  apexGravityScale: 0.75,
  apexThreshold: 1.2,
  maxFallSpeed: 26,

  diveSpeed: 10,
  diveBoost: 2,
  diveMaxSpeed: 12,
  diveUpSpeed: 4.4,
  diveAirUpSpeed: 3.4,
  diveGravityScale: 1.25,
  diveSteer: 2.2,
  slideFriction: 11,
  slideSteer: 1.6,
  slideMinTime: 0.22,
  slideMaxTime: 0.9,
  slideStopSpeed: 1.4,
  getUpTime: 0.45,

  stunImpactThreshold: 7,
  knockStunThreshold: 9,
  stunMinTime: 0.8,
  stunMaxTime: 1.6,
  stunMaxStrength: 20,
  stunSpin: 9,
  stunFriction: 0.5,
  stunRecoverTime: 0.3,
  knockControlTime: 0.3,
  knockControlMul: 0.15,
  diveHitThreshold: 3.5,
  hazardStunStrength: 10,

  grabRange: 0.85,
  grabRadius: 0.5,
  grabHoldDistance: 1.15,
  grabPull: 10,
  grabMaxPull: 6,
  grabStaminaTime: 3,
  grabStaminaRegen: 0.6,
  grabCooldown: 0.8,
  reachSpeedMul: 0.85,
  grabberSpeedMul: 0.55,
  grabbedSpeedMul: 0.3,
  breakFreeMashes: 5,
  breakFreeDecay: 1.2,
  carrySpeedMul: 0.8,
  carryDistance: 1.0,
  carryHeight: 0.55,

  ledgeReachMin: -0.35,
  ledgeReachMax: 1.2,
  ledgeProbe: 0.35,
  ledgeHangOffset: 0.85,
  ledgeClimbTime: 0.42,
  autoLedgeGrab: true,
  ledgeMaxRiseSpeed: 3,

  bounceSpeed: 16,
  bounceCooldown: 0.15,

  emoteTime: 2.5,
  emoteCancelInput: 0.25,

  slideSurfaceMaxSpeed: 15,
  surfaces: Object.freeze({
    normal: NORMAL_SURFACE,
    ice: { speedMul: 1.1, accelMul: 0.18, decelMul: 0.07, turnMul: 0.5, jumpMul: 1, slopeSlide: 0.6 },
    slime: { speedMul: 0.5, accelMul: 0.55, decelMul: 1.4, turnMul: 0.7, jumpMul: 0.7, slopeSlide: 0 },
    conveyor: NORMAL_SURFACE,
    sticky: { speedMul: 0.42, accelMul: 0.6, decelMul: 1.6, turnMul: 0.8, jumpMul: 0.6, slopeSlide: 0 },
    bouncy: NORMAL_SURFACE,
    slide: { speedMul: 1, accelMul: 0.35, decelMul: 0.05, turnMul: 0.6, jumpMul: 1, slopeSlide: 1 },
  }),
}) as Readonly<CharacterTuning>;

/**
 * Builds a mutable tuning object from defaults plus partial overrides. Surface
 * overrides are merged per kind, so `{ surfaces: { ice: { decelMul: 0.02 } } }`
 * keeps the other ice fields.
 *
 * @param overrides - Partial tuning; unknown keys are ignored.
 * @returns A fresh, deeply-copied tuning object safe to mutate.
 * @example
 * const t = resolveTuning({ maxSpeed: 9 });
 */
export function resolveTuning(
  overrides?: Partial<CharacterTuning> | Record<string, unknown>,
): CharacterTuning {
  const out = { ...DEFAULT_TUNING, surfaces: {} as Record<SurfaceKind, SurfaceTuning> } as CharacterTuning;
  for (const kind of Object.keys(DEFAULT_TUNING.surfaces) as SurfaceKind[]) {
    out.surfaces[kind] = { ...DEFAULT_TUNING.surfaces[kind] };
  }
  if (!overrides) return out;
  const target = out as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'surfaces') continue;
    if (key in DEFAULT_TUNING && typeof value === typeof target[key]) target[key] = value;
  }
  const surf = (overrides as { surfaces?: Partial<Record<SurfaceKind, Partial<SurfaceTuning>>> }).surfaces;
  if (surf && typeof surf === 'object') {
    for (const kind of Object.keys(out.surfaces) as SurfaceKind[]) {
      const s = surf[kind];
      if (s) Object.assign(out.surfaces[kind], s);
    }
  }
  return out;
}
