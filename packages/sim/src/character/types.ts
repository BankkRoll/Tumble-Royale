import type { Quat, Vec3 } from '@tumble/shared';

/** Button bitfield carried in every input packet. */
export const Button = {
  Jump: 1 << 0,
  Dive: 1 << 1,
  Grab: 1 << 2,
  /** Held while the emote wheel is open; the chosen emote travels in {@link CharacterInput.emote}. */
  Emote: 1 << 3,
} as const;

/**
 * One fixed-step worth of player intent. Identical for humans, bots and replays.
 * The netcode quantises this (8-bit axes, 16-bit yaw), so the controller must
 * behave sensibly with quantised values.
 */
export interface CharacterInput {
  /** Strafe axis, -1 (left) … 1 (right), relative to camera yaw. */
  moveX: number;
  /** Forward axis, -1 (back) … 1 (forward), relative to camera yaw. */
  moveZ: number;
  /** Camera yaw in radians; movement is resolved relative to this. */
  yaw: number;
  /** {@link Button} bitfield of currently held buttons. */
  buttons: number;
  /** Emote slot 1–4 requested this step, 0 for none. */
  emote: number;
}

/** @returns A neutral input. */
export const emptyInput = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

/** High-level character states. Values are stable: they go over the wire. */
export const CharacterState = {
  Idle: 0,
  Run: 1,
  Jump: 2,
  Fall: 3,
  Dive: 4,
  DiveSlide: 5,
  GetUp: 6,
  Grab: 7,
  Grabbed: 8,
  Carry: 9,
  Stunned: 10,
  Bounce: 11,
  Slime: 12,
  Emote: 13,
  Finished: 14,
  Spectating: 15,
  LedgeHang: 16,
  LedgeClimb: 17,
  Respawning: 18,
  Eliminated: 19,
} as const;

/** Numeric character state id. */
export type CharacterStateId = (typeof CharacterState)[keyof typeof CharacterState];

/**
 * Complete, restorable controller state. Prediction rewinds by `setState` and
 * replays inputs, so EVERYTHING that influences the next step (timers, latches,
 * grab stamina, coyote/jump-buffer counters) must live here.
 */
export interface CharacterFullState {
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  angVel: Vec3;
  state: CharacterStateId;
  /** Seconds spent in the current state. */
  stateTime: number;
  /** Facing yaw in radians (visual + dive direction). */
  facing: number;
  grounded: boolean;
  coyoteTimer: number;
  jumpBufferTimer: number;
  /** True while jump is held after a jump started (variable height). */
  jumpHeld: boolean;
  /** Previous step's button bitfield, for edge detection. */
  prevButtons: number;
  grabStamina: number;
  /** Player id being held/holding, prop id, or -1. */
  grabTarget: number;
  stunTimer: number;
  ghostTimer: number;
  emote: number;
  /** Bitfield of {@link CharacterFlag}. */
  flags: number;
}

/** Misc character flags replicated alongside state. */
export const CharacterFlag = {
  Ghost: 1 << 0,
  Carrying: 1 << 1,
  HasTail: 1 << 2,
  HasCrown: 1 << 3,
  Qualified: 1 << 4,
  Eliminated: 1 << 5,
  OnIce: 1 << 6,
  InSlime: 1 << 7,
} as const;
