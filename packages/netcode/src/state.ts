/**
 * Allocation-free helpers for {@link CharacterFullState}, the restorable
 * character state used by prediction rewind/replay.
 */
import type { CharacterFullState } from '@tumble/sim';
import type { Quat, Vec3 } from '@tumble/shared';

/** @returns A fresh, zeroed {@link CharacterFullState} (preallocate for get/setPlayerState). */
export function createCharacterFullState(): CharacterFullState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    // CharacterState.Idle; a value import of the sim would drag Rapier into every netcode consumer.
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 1,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
}

/** Deep-copies a full character state (no allocation). */
export function copyState(src: CharacterFullState, dst: CharacterFullState): CharacterFullState {
  copyVec(src.pos, dst.pos);
  copyQuat(src.rot, dst.rot);
  copyVec(src.vel, dst.vel);
  copyVec(src.angVel, dst.angVel);
  dst.state = src.state;
  dst.stateTime = src.stateTime;
  dst.facing = src.facing;
  dst.grounded = src.grounded;
  dst.coyoteTimer = src.coyoteTimer;
  dst.jumpBufferTimer = src.jumpBufferTimer;
  dst.jumpHeld = src.jumpHeld;
  dst.prevButtons = src.prevButtons;
  dst.grabStamina = src.grabStamina;
  dst.grabTarget = src.grabTarget;
  dst.stunTimer = src.stunTimer;
  dst.ghostTimer = src.ghostTimer;
  dst.emote = src.emote;
  dst.flags = src.flags;
  return dst;
}

/** Copies vector `a` into `b`. */
export function copyVec(a: Vec3, b: Vec3): void {
  b.x = a.x;
  b.y = a.y;
  b.z = a.z;
}

/** Copies quaternion `a` into `b`. */
export function copyQuat(a: Quat, b: Quat): void {
  b.x = a.x;
  b.y = a.y;
  b.z = a.z;
  b.w = a.w;
}
