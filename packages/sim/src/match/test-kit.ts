/**
 * Stand-ins for headless tests, tools and early integration: a minimal
 * capsule controller, two tiny obstacle modules and a small race arena.
 * They implement the real contracts so the match sim, rules and bots can be
 * exercised before (or without) the full character controller and obstacle
 * library.
 */
import type { Collider, Ray, RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  InteractionGroups,
  MAX_PLAYERS,
  RoundDefinitionSchema,
  quatFromYaw,
  quatIdentity,
  vec3,
  type Quat,
  type RoundDefinition,
  type Vec3,
} from '@tumble/shared';
import { z } from 'zod';
import {
  Button,
  CharacterFlag,
  CharacterState,
  type CharacterFullState,
  type CharacterInput,
  type CharacterStateId,
  type CharacterStepContext,
  type CreateControllerOptions,
  type TumblerControllerLike,
} from '../character/types.ts';
import type { ObstacleModule, ObstacleRuntime, ObstacleStepContext, PoseSample } from '../obstacles/types.ts';
import type { Rapier } from '../physics/rapier.ts';
import type { AnyObstacleModule } from './deps.ts';

// -----------------------------------------------------------------------------
// Simple controller
// -----------------------------------------------------------------------------

/** Tuning for {@link SimpleController}. */
export interface SimpleControllerTuning {
  runSpeed: number;
  groundAccel: number;
  airAccel: number;
  jumpSpeed: number;
  diveSpeed: number;
  diveLift: number;
  coyoteTime: number;
}

const DEFAULT_TUNING: SimpleControllerTuning = {
  runSpeed: 7,
  groundAccel: 60,
  airAccel: 18,
  jumpSpeed: 9.5,
  diveSpeed: 9,
  diveLift: 3.5,
  coyoteTime: 0.12,
};

const RADIUS = 0.45;
const HALF_HEIGHT = 0.45;
/** Centre-to-sole distance plus a little slack for ground probing. */
const GROUND_PROBE = RADIUS + HALF_HEIGHT + 0.12;
const FEET_TO_CENTRE = RADIUS + HALF_HEIGHT;
const DIVE_SECONDS = 0.55;

/**
 * Velocity-targeting capsule controller. Deliberately small: run, jump with
 * coyote time, dive, knockback/stun, ghosting and full state round-trips. Not
 * the shipping controller; see `@tumble/sim/character` for that.
 */
export class SimpleController implements TumblerControllerLike {
  readonly id: number;
  readonly body: RigidBody;
  readonly collider: Collider;
  state: CharacterStateId = CharacterState.Idle;
  grounded = false;
  private stateTime = 0;
  private facing: number;
  private coyote = 0;
  private prevButtons = 0;
  private stun = 0;
  private ghost = 0;
  private ghostForever = false;
  private frozen = false;
  private fated = false;
  private emote = 0;
  private flags = 0;
  private readonly tuning: SimpleControllerTuning;
  private readonly ray: Ray;
  private readonly v = vec3();
  private readonly sp = vec3();
  private readonly sa = vec3();
  private readonly sq: Quat = quatIdentity();
  private readonly world: World;
  private readonly R: Rapier;

  constructor(opts: CreateControllerOptions) {
    this.id = opts.id;
    this.R = opts.R;
    this.world = opts.world;
    this.tuning = { ...DEFAULT_TUNING, ...(opts.tuning as Partial<SimpleControllerTuning> | undefined) };
    this.facing = opts.yaw;
    const R = opts.R;
    this.body = opts.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        // Positions are feet, matching the real controller; the body sits at the capsule centre.
        .setTranslation(opts.position.x, opts.position.y + FEET_TO_CENTRE, opts.position.z)
        .lockRotations()
        .setCcdEnabled(true),
    );
    this.collider = opts.world.createCollider(
      R.ColliderDesc.capsule(HALF_HEIGHT, RADIUS)
        .setFriction(0)
        .setRestitution(0)
        .setCollisionGroups(InteractionGroups.player),
      this.body,
    );
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  step(input: CharacterInput, ctx: CharacterStepContext): void {
    const dt = ctx.dt;
    const t = this.tuning;
    const lv = this.body.linvel(this.v);
    let vx = lv.x;
    let vy = lv.y;
    let vz = lv.z;
    const pressed = input.buttons & ~this.prevButtons;
    this.prevButtons = input.buttons;
    this.stateTime += dt;
    if (this.ghost > 0 && !this.ghostForever) {
      this.ghost -= dt;
      if (this.ghost <= 0) this.applyGroups(false);
    }
    if (input.emote > 0) this.emote = input.emote;

    if (this.stun > 0) {
      this.stun -= dt;
    } else if (!this.fated || this.state === CharacterState.Finished) {
      const diving = this.state === CharacterState.Dive && this.stateTime < DIVE_SECONDS;
      let mx = 0;
      let mz = 0;
      if (!this.frozen && !diving) {
        const s = Math.sin(input.yaw);
        const c = Math.cos(input.yaw);
        mx = input.moveX * c + input.moveZ * s;
        mz = -input.moveX * s + input.moveZ * c;
        const len = Math.hypot(mx, mz);
        if (len > 1) {
          mx /= len;
          mz /= len;
        }
        if (len > 0.05) this.facing = Math.atan2(mx, mz);
      }
      if (!diving) {
        const accel = (this.grounded ? t.groundAccel : t.airAccel) * dt;
        vx = toward(vx, mx * t.runSpeed, accel);
        vz = toward(vz, mz * t.runSpeed, accel);
      }
      if (pressed & Button.Jump && (this.grounded || this.coyote > 0)) {
        vy = t.jumpSpeed;
        this.coyote = 0;
        this.grounded = false;
        this.setStateId(CharacterState.Jump);
        ctx.events.push({ type: 'jump', player: this.id, pos: this.posCopy() });
      } else if (pressed & Button.Dive && !this.frozen && !diving) {
        vx = Math.sin(this.facing) * t.diveSpeed;
        vz = Math.cos(this.facing) * t.diveSpeed;
        vy = Math.max(vy, t.diveLift);
        this.setStateId(CharacterState.Dive);
        ctx.events.push({ type: 'dive', player: this.id, pos: this.posCopy() });
      }
    }
    this.v.x = vx;
    this.v.y = vy;
    this.v.z = vz;
    this.body.setLinvel(this.v, true);
  }

  postStep(ctx: CharacterStepContext): void {
    const p = this.body.translation(this.v);
    this.ray.origin.x = p.x;
    this.ray.origin.y = p.y;
    this.ray.origin.z = p.z;
    const hit = ctx.world.castRay(
      this.ray,
      GROUND_PROBE,
      true,
      this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
      this.collider,
      this.body,
    );
    const was = this.grounded;
    const vy = this.body.linvel(this.v).y;
    this.grounded = hit !== null && vy < 3;
    if (this.grounded) this.coyote = this.tuning.coyoteTime;
    else this.coyote = Math.max(0, this.coyote - ctx.dt);
    if (this.fated) return;
    if (this.stun > 0) this.setStateId(CharacterState.Stunned);
    else if (this.state === CharacterState.Dive && this.stateTime < DIVE_SECONDS) return;
    else if (this.grounded) {
      if (!was) ctx.events.push({ type: 'land', player: this.id, pos: this.posCopy(), impact: Math.abs(vy) });
      const v = this.body.linvel(this.v);
      this.setStateId(Math.hypot(v.x, v.z) > 0.5 ? CharacterState.Run : CharacterState.Idle);
    } else if (this.state !== CharacterState.Jump || vy < 0) {
      this.setStateId(CharacterState.Fall);
    }
  }

  getState(out: CharacterFullState): CharacterFullState {
    const p = this.body.translation(this.sp);
    const r = this.body.rotation(this.sq);
    const v = this.body.linvel(this.v);
    const a = this.body.angvel(this.sa);
    out.pos.x = p.x;
    out.pos.y = p.y;
    out.pos.z = p.z;
    out.rot.x = r.x;
    out.rot.y = r.y;
    out.rot.z = r.z;
    out.rot.w = r.w;
    out.vel.x = v.x;
    out.vel.y = v.y;
    out.vel.z = v.z;
    out.angVel.x = a.x;
    out.angVel.y = a.y;
    out.angVel.z = a.z;
    out.state = this.state;
    out.stateTime = this.stateTime;
    out.facing = this.facing;
    out.grounded = this.grounded;
    out.coyoteTimer = this.coyote;
    out.jumpBufferTimer = 0;
    out.jumpHeld = false;
    out.prevButtons = this.prevButtons;
    out.grabStamina = 1;
    out.grabTarget = -1;
    out.stunTimer = this.stun;
    out.ghostTimer = this.ghostForever ? -1 : this.ghost;
    out.emote = this.emote;
    out.flags = this.flags | (this.ghost > 0 || this.ghostForever ? CharacterFlag.Ghost : 0);
    return out;
  }

  setState(s: CharacterFullState): void {
    this.body.setTranslation(s.pos, true);
    this.body.setRotation(s.rot, true);
    this.body.setLinvel(s.vel, true);
    this.body.setAngvel(s.angVel, true);
    this.state = s.state;
    this.stateTime = s.stateTime;
    this.facing = s.facing;
    this.grounded = s.grounded;
    this.coyote = s.coyoteTimer;
    this.prevButtons = s.prevButtons;
    this.stun = s.stunTimer;
    this.ghostForever = s.ghostTimer < 0;
    this.ghost = Math.max(0, s.ghostTimer);
    this.emote = s.emote;
    this.flags = s.flags & ~CharacterFlag.Ghost;
    this.applyGroups(this.ghostForever || this.ghost > 0);
  }

  knock(impulse: Vec3, stun: boolean): void {
    const v = this.body.linvel(this.v);
    this.v.x = v.x + impulse.x;
    this.v.y = v.y + impulse.y;
    this.v.z = v.z + impulse.z;
    this.body.setLinvel(this.v, true);
    if (stun || Math.hypot(impulse.x, impulse.y, impulse.z) > 14) this.stun = 1;
  }

  push(deltaVelocity: Vec3): void {
    const v = this.body.linvel(this.v);
    this.v.x = v.x + deltaVelocity.x;
    this.v.y = v.y + deltaVelocity.y;
    this.v.z = v.z + deltaVelocity.z;
    this.body.setLinvel(this.v, true);
  }

  teleport(pos: Vec3, yaw?: number): void {
    this.v.x = pos.x;
    this.v.y = pos.y + FEET_TO_CENTRE;
    this.v.z = pos.z;
    this.body.setTranslation(this.v, true);
    this.v.x = 0;
    this.v.y = 0;
    this.v.z = 0;
    this.body.setLinvel(this.v, true);
    if (yaw !== undefined) this.facing = yaw;
    this.stun = 0;
  }

  setGhost(ghost: boolean, seconds?: number): void {
    this.ghostForever = ghost && seconds === undefined;
    this.ghost = ghost ? (seconds ?? 0) : 0;
    this.applyGroups(ghost);
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  setFate(state: CharacterStateId): void {
    this.fated = true;
    this.state = state;
    this.stateTime = 0;
    if (state === CharacterState.Finished) this.flags |= CharacterFlag.Qualified;
    if (state === CharacterState.Eliminated) this.flags |= CharacterFlag.Eliminated;
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }

  private applyGroups(ghost: boolean): void {
    this.collider.setCollisionGroups(ghost ? InteractionGroups.playerGhost : InteractionGroups.player);
  }

  private setStateId(s: CharacterStateId): void {
    if (this.state !== s) {
      this.state = s;
      this.stateTime = 0;
    }
  }

  private posCopy(): Vec3 {
    const p = this.body.translation();
    return { x: p.x, y: p.y, z: p.z };
  }
}

function toward(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  return Math.abs(d) <= maxDelta ? target : v + Math.sign(d) * maxDelta;
}

/**
 * {@link CreateTumblerController}-compatible factory for {@link SimpleController}.
 *
 * @example
 * createMatchSim(opts, { createController: createSimpleController, obstacles: testObstacleModules() });
 */
export function createSimpleController(opts: CreateControllerOptions): TumblerControllerLike {
  return new SimpleController(opts);
}

// -----------------------------------------------------------------------------
// Test obstacles
// -----------------------------------------------------------------------------

const SweeperSchema = z.object({
  length: z.number().positive().default(9),
  /** Radians per second at speed scale 1. */
  speed: z.number().default(1),
  /** Bar centre height above the instance origin. */
  height: z.number().default(0.3),
});
type SweeperParams = z.output<typeof SweeperSchema>;

/** A low bar spinning about Y: pure `pose(t)`, kinematic body, jump over it. */
const testSweeper: ObstacleModule<SweeperParams> = {
  type: 'sweeperArm',
  displayName: 'Test Sweeper',
  schema: SweeperSchema,
  pose(t, params, out, speedScale) {
    if (out.length === 0) out.push({ pos: vec3(), rot: quatIdentity() });
    const s = out[0] as PoseSample;
    s.pos.x = 0;
    s.pos.y = params.height;
    s.pos.z = 0;
    quatFromYaw(t * params.speed * speedScale, s.rot);
  },
  create(instance, ctx): ObstacleRuntime {
    const { R, world } = ctx;
    const yaw0 = ((instance.rotation?.yaw ?? 0) * Math.PI) / 180;
    const body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(
        instance.position.x,
        instance.position.y + instance.params.height,
        instance.position.z,
      ),
    );
    const col = world.createCollider(
      R.ColliderDesc.cuboid(instance.params.length / 2, 0.22, 0.22).setCollisionGroups(
        InteractionGroups.kinematic,
      ),
      body,
    );
    const rot: Quat = quatIdentity();
    const pos = vec3();
    return {
      instance,
      colliders: [col],
      update(sctx: ObstacleStepContext) {
        pos.x = instance.position.x;
        pos.y = instance.position.y + instance.params.height;
        pos.z = instance.position.z;
        // Instance yaw and spin are both about Y, so the angles simply add.
        quatFromYaw(sctx.t * instance.params.speed * ctx.speedScale + yaw0, rot);
        body.setNextKinematicTranslation(pos);
        body.setNextKinematicRotation(rot);
      },
      dispose() {
        world.removeRigidBody(body);
      },
    };
  },
};

const BouncePadSchema = z.object({
  size: z.number().positive().default(2),
  power: z.number().default(13),
});
type BouncePadParams = z.output<typeof BouncePadSchema>;

/** A sensor pad that launches players upward and replicates a bounce counter. */
const testBouncePad: ObstacleModule<BouncePadParams> = {
  type: 'bouncePad',
  displayName: 'Test Bounce Pad',
  schema: BouncePadSchema,
  create(instance, ctx): ObstacleRuntime {
    const { R, world } = ctx;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const h = instance.params.size / 2;
    const col = world.createCollider(
      R.ColliderDesc.cuboid(h, 0.3, h)
        .setTranslation(instance.position.x, instance.position.y + 0.3, instance.position.z)
        .setSensor(true)
        .setCollisionGroups(InteractionGroups.trigger),
      body,
    );
    let bounces = 0;
    const up = vec3(0, instance.params.power, 0);
    return {
      instance,
      colliders: [col],
      update() {},
      onTrigger(actor, _collider, entered, sctx) {
        if (!entered || actor.isGhost) return;
        bounces++;
        actor.push(up);
        sctx.events.push({
          type: 'bounce',
          player: actor.id,
          pos: { ...instance.position },
          obstacle: instance.id,
        });
      },
      getNetState() {
        return [bounces];
      },
      setNetState(state) {
        bounces = state[0] ?? 0;
      },
      dispose() {
        world.removeRigidBody(body);
      },
    };
  },
};

/**
 * Test obstacle modules keyed by type (`sweeperArm`, `bouncePad`).
 *
 * @returns A fresh registry map.
 */
export function testObstacleModules(): Map<string, AnyObstacleModule> {
  return new Map<string, AnyObstacleModule>([
    ['sweeperArm', testSweeper],
    ['bouncePad', testBouncePad],
  ]);
}

// -----------------------------------------------------------------------------
// Test arena
// -----------------------------------------------------------------------------

/**
 * A ~58 m race: start pad, jump gap, branching run, ramp, a low spinning
 * sweeper, checkpoint, second gap, finish. Exercises every match feature
 * the tests need with only the test modules above.
 *
 * @param overrides - Shallow overrides (e.g. a different qualification mode).
 * @returns A validated round definition.
 */
export function createTestArenaRound(overrides: Partial<RoundDefinition> = {}): RoundDefinition {
  return RoundDefinitionSchema.parse({
    id: 'sim-test-arena',
    name: 'Sim Test Arena',
    type: 'race',
    theme: 'candy',
    objective: 'Reach the finish!',
    players: { min: 1, max: MAX_PLAYERS, ideal: MAX_PLAYERS },
    qualification: { mode: 'finish', ratio: 0.65 },
    duration: { seconds: 90 },
    killY: -10,
    bounds: { min: { x: -40, y: -20, z: -20 }, max: { x: 40, y: 30, z: 80 } },
    spawn: { origin: { x: 0, y: 0, z: -2 }, yaw: 0, cols: 8, spacing: 1.4 },
    geometry: [
      { shape: 'box', position: { x: 0, y: -0.5, z: 0 }, size: { x: 14, y: 1, z: 12 } },
      { shape: 'box', position: { x: 0, y: -0.5, z: 14 }, size: { x: 10, y: 1, z: 12 } },
      { shape: 'ramp', position: { x: 0, y: 1, z: 24 }, size: { x: 8, y: 2, z: 8 } },
      { shape: 'box', position: { x: 0, y: 1.5, z: 36 }, size: { x: 10, y: 1, z: 16 } },
      { shape: 'box', position: { x: 0, y: 1.5, z: 52 }, size: { x: 10, y: 1, z: 12 } },
      {
        shape: 'cylinder',
        position: { x: -5.5, y: 3, z: 52 },
        size: { x: 0.5, y: 2, z: 0 },
        decorative: true,
      },
    ],
    obstacles: [
      { id: 'sweep-1', type: 'sweeperArm', position: { x: 0, y: 2, z: 36 }, params: { length: 9, speed: 1 } },
      { id: 'pad-1', type: 'bouncePad', position: { x: 3.5, y: 0, z: 16 }, params: {} },
    ],
    triggers: [
      {
        id: 'cp-1',
        kind: 'checkpoint',
        index: 1,
        position: { x: 0, y: 3.5, z: 30 },
        size: { x: 10, y: 3, z: 2 },
        respawn: [
          { x: -2, y: 2, z: 30 },
          { x: 2, y: 2, z: 30 },
        ],
      },
      { id: 'finish', kind: 'finish', position: { x: 0, y: 3.5, z: 55 }, size: { x: 10, y: 3, z: 2 } },
      { id: 'void', kind: 'void', position: { x: 0, y: -7, z: 28 }, size: { x: 80, y: 2, z: 120 } },
    ],
    flyover: {
      path: [
        { x: 0, y: 12, z: 70 },
        { x: 0, y: 10, z: -10 },
      ],
      lookAt: [{ x: 0, y: 0, z: 28 }],
    },
    music: 'test',
    fallBehavior: 'respawnCheckpoint',
    botNav: [
      { id: 0, position: { x: 0, y: 0, z: 4.5 }, radius: 1.2, next: [1, 7], action: 'jump' },
      { id: 1, position: { x: 1.5, y: 0, z: 12 }, next: [2] },
      { id: 7, position: { x: -1.5, y: 0, z: 12 }, next: [2] },
      { id: 2, position: { x: 0, y: 0, z: 19 }, next: [3] },
      { id: 3, position: { x: 0, y: 2, z: 29.5 }, next: [4] },
      { id: 4, position: { x: 0, y: 2, z: 43 }, radius: 1, next: [5], action: 'jump' },
      { id: 5, position: { x: 0, y: 2, z: 50 }, next: [6] },
      { id: 6, position: { x: 0, y: 2, z: 56 }, next: [] },
    ],
    ...overrides,
  });
}
