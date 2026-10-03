/**
 * Free-roam Tumbler physics for the menu platform and the pre-show lobby.
 */
import { InteractionGroups, SIM_DT } from '@tumble/shared';
import {
  EventSink,
  FixedStepper,
  SurfaceRegistry,
  createWorld,
  type Rapier,
  type SimEvent,
  type World,
} from '@tumble/sim';
import {
  CharacterState,
  TumblerController,
  emptyInput,
  type CharacterInput,
  type CharacterStepContext,
} from '@tumble/sim/character';
import type { GameAudio } from '@tumble/audio';
import type { InputSystem } from '../../input/index.ts';

const FALL_RESET_Y = -8;

/**
 * Real-physics free movement on a round floating platform (main menu idle
 * play, pre-show lobby): one Tumbler controller in its own tiny Rapier world,
 * driven by the input system relative to the camera yaw.
 *
 * @example
 * const idle = new IdlePlay(R, 6, input, audio);
 * idle.yaw = cameraYaw; idle.advance(dt); const { feet } = idle.sample();
 */
export class IdlePlay {
  readonly world: World;
  readonly ctrl: TumblerController;
  /** Gameplay surfaces (bounce pads) for colliders added to {@link world}. */
  readonly surfaces = new SurfaceRegistry();
  /** Called after every fixed step with that step's sim events (VFX, props). */
  onStep: ((events: readonly SimEvent[]) => void) | null = null;
  /** When false, steps run with empty input (props settle while the menu shows the standing Tumbler). */
  driven = true;
  private pendingEmote = 0;
  private pendingEmoteTime = 0;
  private readonly ctx: CharacterStepContext;
  private readonly stepper: FixedStepper;
  private readonly input: CharacterInput = emptyInput();
  private readonly feet = { x: 0, y: 0, z: 0 };
  private readonly vel = { x: 0, y: 0, z: 0 };
  yaw = Math.PI;

  /**
   * @param R - Rapier.
   * @param radius - Platform radius (m).
   * @param inputSystem - Keyboard/gamepad/touch input.
   * @param audio - Footsteps, jumps (optional).
   * @param spawn - Where the Tumbler starts and respawns after falling off.
   */
  constructor(
    private readonly R: Rapier,
    radius: number,
    private readonly inputSystem: InputSystem,
    private readonly audio: GameAudio | null,
    private readonly spawn: { x: number; z: number } = { x: 0, z: 0 },
  ) {
    this.world = createWorld(R);
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(R.ColliderDesc.cylinder(0.5, radius).setFriction(0.9).setCollisionGroups(InteractionGroups.static), body);
    this.ctrl = new TumblerController({ R, world: this.world, id: 0, position: { x: spawn.x, y: 0.05, z: spawn.z }, yaw: 0 });
    const events = new EventSink();
    this.ctx = {
      R,
      world: this.world,
      dt: SIM_DT,
      tick: 0,
      time: 0,
      surfaces: this.surfaces,
      events,
      controllerByCollider: (h) => (h === this.ctrl.collider.handle ? this.ctrl : undefined),
    };
    this.stepper = new FixedStepper((tick) => this.step(tick));
  }

  private step(tick: number): void {
    this.ctx.tick = tick;
    this.ctx.time = tick * SIM_DT;
    if (this.driven) this.inputSystem.sample(this.yaw, this.input);
    else {
      const i = this.input;
      i.moveX = i.moveZ = i.buttons = i.emote = 0;
      i.yaw = this.yaw;
    }
    if (this.pendingEmoteTime > 0) {
      this.pendingEmoteTime -= SIM_DT;
      if (this.ctrl.state === CharacterState.Emote) this.pendingEmoteTime = 0;
      else if (this.input.emote === 0) this.input.emote = this.pendingEmote;
    }
    this.ctrl.step(this.input, this.ctx);
    this.world.step();
    this.ctrl.postStep(this.ctx);
    const evs = this.ctx.events.events;
    this.onStep?.(evs);
    if (this.audio) for (const e of evs) this.audio.handleSimEvent(e);
    evs.length = 0;
    if (this.ctrl.body.translation().y < FALL_RESET_Y) this.ctrl.teleport({ x: this.spawn.x, y: 1.5, z: this.spawn.z });
  }

  /**
   * Fences the platform with an invisible wall so the Tumbler (and props) can
   * never leave it: a ring of tall static boxes, frictionless so running into
   * it slides along the rim instead of sticking.
   *
   * @param radius - Inner radius of the wall (m).
   * @param segments - Box count; more is rounder.
   */
  addRimWall(radius: number, segments = 28): void {
    const R = this.R;
    const height = 14;
    const thick = 0.5;
    // Chord length plus a little overlap so no gap opens between boxes.
    const half = radius * Math.tan(Math.PI / segments) + 0.05;
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const d = radius + thick;
      const desc = R.ColliderDesc.cuboid(half, height / 2, thick)
        .setTranslation(Math.sin(a) * d, height / 2 - 0.5, Math.cos(a) * d)
        .setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) })
        .setFriction(0)
        .setCollisionGroups(InteractionGroups.static);
      this.world.createCollider(desc, body);
    }
  }

  /**
   * Plays an emote through the controller on the next grounded step (retried
   * for a moment while airborne), exactly as if its number key were pressed.
   *
   * @param slot - Controller emote slot 1–4.
   */
  queueEmote(slot = 1): void {
    this.pendingEmote = slot;
    this.pendingEmoteTime = 0.8;
  }

  /** Steps the fixed-rate physics by a real frame delta. */
  advance(dt: number): void {
    this.stepper.advance(dt);
  }

  /** Feet position, velocity and anim fields for the visual. */
  sample(): { feet: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } {
    this.ctrl.getFeet(this.feet);
    this.ctrl.getVelocity(this.vel);
    return { feet: this.feet, vel: this.vel };
  }

  /** Back to the spawn point, standing. */
  reset(): void {
    this.ctrl.teleport({ x: this.spawn.x, y: 0.05, z: this.spawn.z }, 0);
  }

  dispose(): void {
    this.ctrl.dispose();
    this.world.free();
  }
}
