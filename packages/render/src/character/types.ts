import type { Object3D } from 'three/webgpu';

/** Cosmetic slots a Tumbler can wear. Ids reference `@tumble/content` cosmetics. */
export interface TumblerLoadout {
  /** Body colours: primary, secondary, tertiary (hex). */
  colors: [string, string, string];
  /** Body pattern id (stripes, dots, camo, gradient, galaxy, checker, …). */
  pattern: string;
  face: string;
  upper: string | null;
  lower: string | null;
  headwear: string | null;
  back: string | null;
  /** Equipped emote ids, slots 1–4. */
  emotes: [string, string, string, string];
  celebration: string;
  victoryPose: string;
  nameplate: string;
  trail: string | null;
}

/** What the visual should show this frame. Filled from sim state or by menu scenes. */
export interface TumblerAnimInput {
  /** `CharacterState` value from `@tumble/sim`. */
  state: number;
  stateTime: number;
  /** World-space planar speed in m/s. */
  speed: number;
  /** Vertical velocity, for jump/fall poses. */
  verticalSpeed: number;
  /** Facing yaw in radians. */
  facing: number;
  grounded: boolean;
  /** Emote id playing, or null. */
  emote: string | null;
  /** Optional world point for the eyes to look at. */
  lookAt?: { x: number; y: number; z: number };
  /** One-shot squash/stretch kick (landing impact, bounce). Consumed by the visual. */
  impulse?: number;
  /** Respawn-grace ghost: rendered with screen-door transparency. */
  ghost?: boolean;
}

/**
 * A renderable Tumbler. Implemented in `@tumble/render/character`; used by the
 * game, the menu lobby, the locker, the end-of-show player wall and the podium.
 */
export interface TumblerVisual {
  /** Root object; place it at the character's feet. */
  readonly object: Object3D;
  setLoadout(loadout: TumblerLoadout): void;
  /** Advance procedural animation. `dt` in seconds. */
  update(dt: number, anim: TumblerAnimInput): void;
  /** Spawn/pin a cosmetic ragdoll (stun). No-op if over the active ragdoll budget. */
  setRagdoll?(active: boolean): void;
  /** Level of detail 0 (full) – 2 (cheapest). */
  setLod(level: 0 | 1 | 2): void;
  dispose(): void;
}

/** Factory signature exported by `@tumble/render/character`. */
export type CreateTumblerVisual = (loadout: TumblerLoadout) => TumblerVisual;
