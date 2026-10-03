import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatIdentity, vec3, type Quat, type Vec3 } from '@tumble/shared';
import {
  CharacterState,
  type CharacterFullState,
  type CharacterInput,
  type CharacterStateId,
  type CharacterStepContext,
  type TumblerControllerLike,
} from '../character/types.ts';
import type { Rapier } from '../physics/rapier.ts';

/** Capsule matching the Tumbler's default shape, used for remote proxies. */
const PROXY_RADIUS = 0.45;
const PROXY_HALF_HEIGHT = 0.45;

/**
 * Client-side stand-in for a remote player: a kinematic capsule placed from
 * interpolated snapshots so the local player can bump into and grab it. It
 * implements the controller interface with inert behaviour; the server owns
 * the real simulation of that player.
 */
export class RemoteProxy implements TumblerControllerLike {
  readonly body: RigidBody;
  readonly collider: Collider;
  state: CharacterStateId = CharacterState.Idle;
  grounded = true;
  private readonly vel: Vec3 = vec3();
  private readonly rot: Quat = quatIdentity();
  private readonly pos: Vec3 = vec3();

  constructor(
    R: Rapier,
    private readonly world: World,
    readonly id: number,
    position: Vec3,
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(PROXY_HALF_HEIGHT, PROXY_RADIUS).setCollisionGroups(InteractionGroups.player),
      this.body,
    );
    this.pos.x = position.x;
    this.pos.y = position.y;
    this.pos.z = position.z;
  }

  /** Moves the proxy to the latest interpolated snapshot pose. */
  place(pos: Vec3, rot: Quat, vel: Vec3, state: number): void {
    this.pos.x = pos.x;
    this.pos.y = pos.y;
    this.pos.z = pos.z;
    this.rot.x = rot.x;
    this.rot.y = rot.y;
    this.rot.z = rot.z;
    this.rot.w = rot.w;
    this.vel.x = vel.x;
    this.vel.y = vel.y;
    this.vel.z = vel.z;
    this.state = state as CharacterStateId;
    this.body.setNextKinematicTranslation(this.pos);
    this.body.setNextKinematicRotation(this.rot);
  }

  step(_input: CharacterInput, _ctx: CharacterStepContext): void {}

  postStep(_ctx: CharacterStepContext): void {}

  getState(out: CharacterFullState): CharacterFullState {
    out.pos.x = this.pos.x;
    out.pos.y = this.pos.y;
    out.pos.z = this.pos.z;
    out.rot.x = this.rot.x;
    out.rot.y = this.rot.y;
    out.rot.z = this.rot.z;
    out.rot.w = this.rot.w;
    out.vel.x = this.vel.x;
    out.vel.y = this.vel.y;
    out.vel.z = this.vel.z;
    out.angVel.x = 0;
    out.angVel.y = 0;
    out.angVel.z = 0;
    out.state = this.state;
    out.grounded = this.grounded;
    return out;
  }

  setState(s: CharacterFullState): void {
    this.place(s.pos, s.rot, s.vel, s.state);
  }

  knock(_impulse: Vec3, _stun: boolean): void {}

  push(_deltaVelocity: Vec3): void {}

  teleport(pos: Vec3, _yaw?: number): void {
    this.body.setTranslation(pos, true);
    this.place(pos, this.rot, this.vel, this.state);
  }

  setGhost(ghost: boolean, _seconds?: number): void {
    this.collider.setCollisionGroups(ghost ? InteractionGroups.playerGhost : InteractionGroups.player);
  }

  setFrozen(_frozen: boolean): void {}

  setFate(state: CharacterStateId): void {
    this.state = state;
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }
}
