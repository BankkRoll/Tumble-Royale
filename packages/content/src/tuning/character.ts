/**
 * Canonical Tumbler movement tuning.
 *
 * This is the documented source of truth for how the Tumbler feels. The sim
 * keeps an identical `DEFAULT_TUNING` so it has no dependency on content; when
 * you change a value here, change it there too (the debug panel in
 * `playground.html` edits a live copy, so tune there first, then paste).
 *
 * Design intent: snappy, readable, forgiving. Ground control is near-instant
 * (≈0.13 s to full speed, ≈0.14 s to stop), air control is strong enough to
 * correct a jump but keeps momentum, falls are faster than rises so arcs feel
 * punchy, and every failure state (dive, stun) hands control back quickly.
 */
import type { CharacterTuning, SurfaceTuning } from '@tumble/sim/character';

const normal: SurfaceTuning = {
  speedMul: 1,
  accelMul: 1,
  decelMul: 1,
  turnMul: 1,
  jumpMul: 1,
  slopeSlide: 0,
};

/** Per-surface response; every multiplier is relative to normal ground. */
export const SURFACE_TUNING: Record<
  'normal' | 'ice' | 'slime' | 'conveyor' | 'sticky' | 'bouncy' | 'slide',
  SurfaceTuning
> = {
  /** Candy plastic: the reference surface. */
  normal,
  /**
   * Ice: you can still steer (accel 18%), but stopping takes ~14× longer and
   * you slowly slide down tilted ice. Turning is halved so slides read clearly.
   */
  ice: { speedMul: 1.1, accelMul: 0.18, decelMul: 0.07, turnMul: 0.5, jumpMul: 1, slopeSlide: 0.6 },
  /** Shallow slime: wading at half speed with heavy, short jumps. */
  slime: { speedMul: 0.5, accelMul: 0.55, decelMul: 1.4, turnMul: 0.7, jumpMul: 0.7, slopeSlide: 0 },
  /** Belts behave like normal ground; the belt velocity comes from `SurfaceInfo.conveyorVelocity`. */
  conveyor: normal,
  /** Sticky goo: slower than slime and jumps barely leave the ground. */
  sticky: { speedMul: 0.42, accelMul: 0.6, decelMul: 1.6, turnMul: 0.8, jumpMul: 0.6, slopeSlide: 0 },
  /** Walking on a bouncy pad is normal; touching it launches you (see `bounceSpeed`). */
  bouncy: normal,
  /** Slide ramps: almost frictionless, gravity pulls you downhill up to `slideSurfaceMaxSpeed`. */
  slide: { speedMul: 1, accelMul: 0.35, decelMul: 0.05, turnMul: 0.6, jumpMul: 1, slopeSlide: 1 },
};

/**
 * The shipped Tumbler tuning. Units: metres, seconds, m/s, m/s². World gravity
 * is −24 m/s² (`GRAVITY_Y`), heavier than Earth on purpose.
 */
export const CHARACTER_TUNING: CharacterTuning = {
  // --- Body -----------------------------------------------------------------
  /** Capsule radius. 0.45 m reads chunky on screen yet fits 1 m doors with margin. */
  radius: 0.45,
  /** Cylinder half-height; total height 1.8 m. */
  halfHeight: 0.45,
  /** Light enough that props get shoved, heavy enough that a 1 kg box does not stop you. */
  mass: 1,

  // --- Locomotion -----------------------------------------------------------
  /** Top run speed. Slightly faster than "realistic" so 40-player races feel urgent. */
  maxSpeed: 7.8,
  /** 0 → max in ~0.13 s: responsive without feeling weightless. */
  groundAccel: 62,
  /** Max → 0 in ~0.14 s when the stick is released: precise platforming. */
  groundDecel: 56,
  /** Used when input opposes velocity, so 180° turns snap instead of skating. */
  turnAccel: 95,
  /** Air steering strong enough to correct a jump (~0.3 s to full speed). */
  airAccel: 24,
  /** Releasing the stick mid-air barely slows you: jumps keep their momentum. */
  airDecel: 4,
  /** Speed above max (bounces, dives) bleeds slowly while you keep steering. */
  airOverspeedDrag: 3,
  /** Facing turn rate on ground (rad/s). Fast so the body visibly points where you go. */
  turnSpeed: 16,
  /** Facing turn rate in the air (rad/s). */
  airTurnSpeed: 9,
  /** Planar speed above which the state reads Run. */
  runThreshold: 0.6,
  /** Platform momentum half-life after jumping off; long enough to land a jump between movers. */
  carryHalfLife: 0.9,
  /** Fan/wind push half-life: steady wind of A m/s² settles at ≈0.37·A m/s extra speed. */
  pushHalfLife: 0.25,

  // --- Ground ---------------------------------------------------------------
  /** Steepest walkable slope; 45° ramps are climbable, 60° walls are not. */
  maxSlopeDeg: 50,
  /** Contact tolerance for "standing". */
  groundEpsilon: 0.06,
  /** Stick to the ground over small drops (stairs down, slope crests) instead of skipping. */
  snapDistance: 0.32,
  /** Auto step-up height: stairs and curbs never need a jump. */
  stepHeight: 0.35,

  // --- Jump -----------------------------------------------------------------
  /** 1.6 m full jump (with apex hang): clears 1.5 m walls with a hand on the lip. */
  jumpSpeed: 8.8,
  /** 120 ms of grace after running off a ledge. */
  coyoteTime: 0.12,
  /** 120 ms of early jump presses honoured on landing. */
  jumpBufferTime: 0.12,
  /** Tapping jump gives roughly a third of the full height. */
  jumpCutMultiplier: 0.45,
  /** Normal gravity on the way up. */
  riseGravityScale: 1,
  /**
   * Double gravity on the way down: snappy, readable arcs. Together with the apex
   * hang this puts a full-speed running jump at ~5.1 m, so 4.5 m gaps need a clean
   * jump and 5.5 m gaps need a jump → dive (~7.3 m).
   */
  fallGravityScale: 2,
  /** Lighter gravity at the apex while jump is held: a beat to aim the landing or start a dive. */
  apexGravityScale: 0.75,
  /** Apex window, |vy| below this. */
  apexThreshold: 1.2,
  /** Terminal velocity so long falls stay readable. */
  maxFallSpeed: 26,

  // --- Dive -----------------------------------------------------------------
  /** Minimum dive speed; a standing dive still lunges. */
  diveSpeed: 10,
  /** Running dives add this on top of current speed. */
  diveBoost: 2,
  /** Dive speed cap; jump+dive spans ~7–8 m, so 5.5 m gaps need a committed jump-dive. */
  diveMaxSpeed: 12,
  /** Ground dive hop. */
  diveUpSpeed: 4.4,
  /** Air dive lift; small so dives extend jumps rather than double-jump. */
  diveAirUpSpeed: 3.4,
  /** Slightly heavy dives land decisively. */
  diveGravityScale: 1.25,
  /** Dives are committed: heading turns only ~125°/s. */
  diveSteer: 2.2,
  /** Belly-slide friction: a full-speed slide lasts ~0.9 s. */
  slideFriction: 11,
  /** Slight steering on the belly. */
  slideSteer: 1.6,
  /** Minimum slide before you may get up. */
  slideMinTime: 0.22,
  /** Slide cap on normal ground (ice/slides scale it up). */
  slideMaxTime: 0.9,
  /** Slide speed at which the Tumbler starts to get up. */
  slideStopSpeed: 1.4,
  /** Get-up lock (spec: 0.45 s). A jump buffered in its last 120 ms fires immediately. */
  getUpTime: 0.45,

  // --- Stun -----------------------------------------------------------------
  /** Being swatted at ≥ 7 m/s by a moving obstacle knocks you over. Walking into still ones never does. */
  stunImpactThreshold: 7,
  /** `knock()` impulses at or above this stun even without the stun flag. */
  knockStunThreshold: 9,
  /** Gentle hits: short comedic tumble. */
  stunMinTime: 0.8,
  /** Big hits: long tumble (spec range 0.8–1.6 s). */
  stunMaxTime: 1.6,
  /** Impact speed for the longest stun. */
  stunMaxStrength: 20,
  /** Tumble spin; enough to cartwheel once or twice. */
  stunSpin: 9,
  /** Friction while tumbling so you roll and skid instead of ice-skating. */
  stunFriction: 0.5,
  /** Last 0.3 s of a stun eases you upright. */
  stunRecoverTime: 0.3,
  /** Non-stunning knocks reduce control briefly so the knockback reads. */
  knockControlTime: 0.3,
  /** Control fraction during that window. */
  knockControlMul: 0.15,
  /** Being hit by a diving Tumbler with ≥ 3.5 m/s of push is a tackle. */
  diveHitThreshold: 3.5,
  /** Lasers, cannonballs and other stun-on-touch hazards. */
  hazardStunStrength: 10,

  // --- Grab -----------------------------------------------------------------
  /** Reach in front of the body centre. */
  grabRange: 0.85,
  /** Grab sphere radius; generous so grabs feel fair. */
  grabRadius: 0.5,
  /** Held Tumblers are kept about an arm's length away. */
  grabHoldDistance: 1.15,
  /** Spring closing the gap when the held Tumbler pulls away. */
  grabPull: 10,
  /** Cap on that spring's speed. */
  grabMaxPull: 6,
  /** A full bar holds someone for 3 s; then you must let go. */
  grabStaminaTime: 3,
  /** Refills in ~1.7 s. */
  grabStaminaRegen: 0.6,
  /** Prevents instantly re-grabbing the same player. */
  grabCooldown: 0.8,
  /** Reaching with empty arms slows you a little. */
  reachSpeedMul: 0.85,
  /** Holding someone slows you a lot: grabbing is a trade-off, not a free win. */
  grabberSpeedMul: 0.55,
  /** Being held: you can still drag your feet. */
  grabbedSpeedMul: 0.3,
  /** Five quick presses break free. */
  breakFreeMashes: 5,
  /** Mash progress decays so slow presses do not count. */
  breakFreeDecay: 1.2,
  /** Carrying a prop (egg, ball, crown) slows you modestly. */
  carrySpeedMul: 0.8,
  /** Held props float in front of the chest, clear of the capsule. */
  carryDistance: 1.0,
  /** Carry height above the body centre. */
  carryHeight: 0.55,

  // --- Ledges ---------------------------------------------------------------
  /** Ledges this far below the body centre are still caught. */
  ledgeReachMin: -0.35,
  /** Ledges up to here (hands above the head) are caught: a full jump reaches a 2.4 m wall. */
  ledgeReachMax: 1.2,
  /** Wall probe reach beyond the capsule. */
  ledgeProbe: 0.35,
  /** Hang with the head just below the lip. */
  ledgeHangOffset: 0.85,
  /** Climb-up duration. */
  ledgeClimbTime: 0.42,
  /** Falling into a grabbable ledge while pushing toward it catches it automatically. */
  autoLedgeGrab: true,
  /** No catching while still rising fast (prevents snagging on the way up). */
  ledgeMaxRiseSpeed: 3,

  // --- Bounce ---------------------------------------------------------------
  /** Default bounce pad launch (~5.3 m with rise gravity). Authored pads override via `bounceImpulse`. */
  bounceSpeed: 16,
  /** Debounce so one pad contact is one bounce. */
  bounceCooldown: 0.15,

  // --- Emote ----------------------------------------------------------------
  /** Emote length before returning to idle. */
  emoteTime: 2.5,
  /** Stick deflection that cancels an emote. */
  emoteCancelInput: 0.25,

  // --- Surfaces -------------------------------------------------------------
  /** Slide ramps may exceed run speed up to this. */
  slideSurfaceMaxSpeed: 15,
  surfaces: SURFACE_TUNING,
};
