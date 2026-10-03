import type { Camera, Object3D } from 'three/webgpu';
import type { SimEvent } from '@tumble/sim';

/**
 * Public contract of the VFX library. Integrators code against these types;
 * `createVfxSystem` in `./vfxSystem.ts` implements them.
 */

/** Plain position, so callers can pass sim vectors, three vectors or literals. */
export interface VfxVec3 {
  x: number;
  y: number;
  z: number;
}

/** Every spawnable effect. */
export type VfxKind =
  /** Colourful paper burst (qualify, win, menu celebrations). */
  | 'confetti'
  /** Small dust puff (footsteps, jump take-off). */
  | 'dust'
  /** Bigger radial dust ring for hard landings. */
  | 'landDust'
  /** Streaks trailing a dive. Needs `direction`. */
  | 'speedLines'
  /** Orbiting cartoon stars over a stunned head. Follows `playerId` anchor when given. */
  | 'stunStars'
  /** Goo droplets + splat ring. */
  | 'slimeSplash'
  /** Rocket + burst fireworks (finish line, victory). */
  | 'fireworks'
  /** Rising sparkle column on qualification. */
  | 'qualifySparkle'
  /** Elimination gag: cartoon cloud puff + balloons that float up and pop. */
  | 'eliminationPoof'
  /** Twinkles around a crown or trophy. */
  | 'crownShine'
  /** Expanding ring on bounce pads / bumpers. */
  | 'bounceRing'
  /** Wind streaks blowing along `direction` (fans, windy weather gusts). */
  | 'windStreaks'
  /** Crack decal on a tile about to fall. */
  | 'tileCrack'
  /** Team-coloured smoke plume (`team` or `color`). */
  | 'teamSmoke'
  /** Teleporter flash: implode/explode sparkle burst + ring. */
  | 'teleport'
  /** Generic sparkle burst (pickups, checkpoints). */
  | 'sparkle'
  /** Quick white "pop" flash. */
  | 'pop';

/** Options common to {@link VfxSystem.spawn}. Everything is optional. */
export interface VfxSpawnOptions {
  /** Override tint (hex). */
  color?: string;
  /** Multi-colour palette for confetti/fireworks (hex). */
  colors?: readonly string[];
  /** Uniform size multiplier. Default 1. */
  scale?: number;
  /** Particle count multiplier on top of the quality tier. Default 1. */
  intensity?: number;
  /** Direction (world, need not be normalised) for speed lines, wind, splashes. */
  direction?: VfxVec3;
  /** Team index 0–3 for team smoke (the active team palette). */
  team?: number;
  /** Seconds to wait before the effect starts (GPU-side, no timers). */
  delay?: number;
  /** Follow this player's anchor (see `setPlayerPosition`) — stun stars, crown shine. */
  playerId?: number;
  /** Lifetime override in seconds, for persistent effects like stun stars. */
  duration?: number;
}

/** Downward ground probe used by blob shadows. */
export type GroundProbe = (
  x: number,
  y: number,
  z: number,
  out: { y: number; nx: number; ny: number; nz: number },
) => boolean;

/** A cosmetic trail ribbon attached to something that moves. */
export interface TrailHandle {
  /** Push the current emitter position (call once per frame). */
  update(x: number, y: number, z: number, dt: number): void;
  /** Stop emitting; the ribbon fades out then returns to the pool. */
  release(): void;
}

/** Trail styles (cosmetic `trail` slot ids map onto these). */
export type TrailStyle = 'rainbow' | 'sparkle' | 'bubbles' | 'flame' | 'candy' | 'plain';

/** Capacity knobs, set from the quality tier. */
export interface VfxBudget {
  /** Max live billboard particles (additive + alpha pools combined). */
  particles: number;
  /** Max live confetti pieces. */
  confetti: number;
  /** Max simultaneous trails. */
  trails: number;
  /** Max blob shadows (characters). */
  shadows: number;
}

/** Options for `createVfxSystem`. */
export interface VfxSystemOptions {
  budget?: Partial<VfxBudget>;
  /** Ground probe for blob shadows; without it shadows sit at the caster's feet. */
  groundProbe?: GroundProbe;
  /**
   * Resolves `tileWarn`/`tileFell` events to a tile centre. Return false if unknown.
   */
  tileResolver?: (obstacle: string, tile: number, out: VfxVec3) => boolean;
  /** Theme void style; a fall into `slime` splashes instead of poofing. */
  voidStyle?: 'clouds' | 'slime' | 'stars' | 'water' | 'lava';
}

/** The VFX system. One per scene. */
export interface VfxSystem {
  /** Add to the scene. Contains every pool (≈ 8–10 draw calls total). */
  readonly object: Object3D;
  /** Spawn an effect. Never allocates on the hot path. */
  spawn(kind: VfxKind, pos: VfxVec3, opts?: VfxSpawnOptions): void;
  /** Maps a sim event to effects (uses player anchors for events without positions). */
  handleSimEvent(e: SimEvent): void;
  /** Update a player's anchor (centre of body, metres). Call each frame for live players. */
  setPlayerPosition(playerId: number, x: number, y: number, z: number): void;
  /**
   * Blob shadows: set how many casters are active and their feet positions this
   * frame. Call `setShadowCount` then `setShadow(i, …)` for i < count.
   */
  setShadowCount(count: number): void;
  setShadow(index: number, x: number, y: number, z: number, radius?: number): void;
  /** Acquire a cosmetic trail ribbon, or null when the pool is exhausted. */
  acquireTrail(style: TrailStyle, color?: string): TrailHandle | null;
  /** Advance effect time. `camera` is used for billboards/stretched sprites. */
  update(dt: number, camera: Camera): void;
  /** Remove every live effect immediately (round change). */
  clear(): void;
  setGroundProbe(probe: GroundProbe | null): void;
  setBudget(budget: Partial<VfxBudget>): void;
  dispose(): void;
}
