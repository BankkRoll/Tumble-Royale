import type { CharacterExtState, CharacterFullState } from './types.ts';
import { CharacterState } from './types.ts';

/** @returns A zeroed {@link CharacterExtState}. */
export function createCharacterExtState(): CharacterExtState {
  return {
    carryVel: { x: 0, y: 0, z: 0 },
    extVel: { x: 0, y: 0, z: 0 },
    ledgePoint: { x: 0, y: 0, z: 0 },
    ledgeNormal: { x: 0, y: 0, z: 0 },
    latches: 0,
    grabKind: 0,
    partnerCollider: -1,
    grabCooldown: 0,
    breakFree: 0,
    knockTimer: 0,
    bounceCooldown: 0,
  };
}

/**
 * Allocates a {@link CharacterFullState} suitable as the `out` argument of
 * `TumblerControllerLike.getState`. Allocate once per history slot and reuse.
 *
 * @returns A neutral state with `ext` pre-allocated.
 * @example
 * const snap = createCharacterFullState();
 * controller.getState(snap);
 */
export function createCharacterFullState(): CharacterFullState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    state: CharacterState.Idle,
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
    ext: createCharacterExtState(),
  };
}

/**
 * Deep-copies `src` into `out` without allocating (except a missing `out.ext`).
 *
 * @returns `out`.
 */
export function copyCharacterFullState(src: CharacterFullState, out: CharacterFullState): CharacterFullState {
  out.pos.x = src.pos.x;
  out.pos.y = src.pos.y;
  out.pos.z = src.pos.z;
  out.rot.x = src.rot.x;
  out.rot.y = src.rot.y;
  out.rot.z = src.rot.z;
  out.rot.w = src.rot.w;
  out.vel.x = src.vel.x;
  out.vel.y = src.vel.y;
  out.vel.z = src.vel.z;
  out.angVel.x = src.angVel.x;
  out.angVel.y = src.angVel.y;
  out.angVel.z = src.angVel.z;
  out.state = src.state;
  out.stateTime = src.stateTime;
  out.facing = src.facing;
  out.grounded = src.grounded;
  out.coyoteTimer = src.coyoteTimer;
  out.jumpBufferTimer = src.jumpBufferTimer;
  out.jumpHeld = src.jumpHeld;
  out.prevButtons = src.prevButtons;
  out.grabStamina = src.grabStamina;
  out.grabTarget = src.grabTarget;
  out.stunTimer = src.stunTimer;
  out.ghostTimer = src.ghostTimer;
  out.emote = src.emote;
  out.flags = src.flags;
  if (src.ext) {
    const o = (out.ext ??= createCharacterExtState());
    const s = src.ext;
    o.carryVel.x = s.carryVel.x;
    o.carryVel.y = s.carryVel.y;
    o.carryVel.z = s.carryVel.z;
    o.extVel.x = s.extVel.x;
    o.extVel.y = s.extVel.y;
    o.extVel.z = s.extVel.z;
    o.ledgePoint.x = s.ledgePoint.x;
    o.ledgePoint.y = s.ledgePoint.y;
    o.ledgePoint.z = s.ledgePoint.z;
    o.ledgeNormal.x = s.ledgeNormal.x;
    o.ledgeNormal.y = s.ledgeNormal.y;
    o.ledgeNormal.z = s.ledgeNormal.z;
    o.latches = s.latches;
    o.grabKind = s.grabKind;
    o.partnerCollider = s.partnerCollider;
    o.grabCooldown = s.grabCooldown;
    o.breakFree = s.breakFree;
    o.knockTimer = s.knockTimer;
    o.bounceCooldown = s.bounceCooldown;
  }
  return out;
}
