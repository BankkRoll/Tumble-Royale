/**
 * `@tumble/netcode/dev` — a stand-in {@link MatchSim} built from Rapier capsules
 * on a flat arena with kinematic sweepers.
 *
 * Purpose: let the game server, bot swarm, client net layer and benchmarks run
 * end to end before (and independently of) the real `createMatchSim` from
 * `@tumble/sim/match`. Physics cost is representative (40 dynamic capsules,
 * kinematic obstacles, contacts); gameplay is not (no grabs, dives or rules).
 */
import {
  Button,
  CharacterState,
  EventSink,
  createWorld,
  type CharacterFullState,
  type CharacterInput,
  type Rapier,
  type RigidBody,
  type World,
} from '@tumble/sim';
import {
  InteractionGroups,
  RoundDefinitionSchema,
  RoundPhase,
  SIM_DT,
  quatFromYaw,
  type Quat,
  type RoundDefinition,
  type RoundPhaseId,
  type Vec3,
} from '@tumble/shared';
import type { MatchSim, MatchSimOptions, RoundStatus } from '../simTypes.ts';
import { copyQuat, copyState, copyVec, createCharacterFullState } from '../state.ts';

const RUN_SPEED = 9;
const GROUND_ACCEL = 60;
const AIR_ACCEL = 18;
const JUMP_SPEED = 9.5;
const CAPSULE_HALF = 0.45;
const CAPSULE_RADIUS = 0.45;
const STAND_Y = CAPSULE_HALF + CAPSULE_RADIUS;
const ARENA_HALF = 40;

/**
 * Builds the dev arena round definition (flat 80 × 80 m floor, spawn grid at the south end).
 *
 * @returns A validated round definition.
 */
export function createDevRound(): RoundDefinition {
  return RoundDefinitionSchema.parse({
    id: 'dev-arena',
    name: 'Dev Arena',
    type: 'race',
    theme: 'candy',
    objective: 'Run around. This is a netcode test arena.',
    players: { min: 1, max: 60, ideal: 40 },
    qualification: { mode: 'finish' },
    duration: { seconds: 600 },
    killY: -20,
    bounds: { min: { x: -64, y: -32, z: -64 }, max: { x: 64, y: 32, z: 64 } },
    spawn: { origin: { x: 0, y: STAND_Y + 0.05, z: -30 }, cols: 8, spacing: 1.6 },
    geometry: [{ shape: 'box', position: { x: 0, y: -0.5, z: 0 }, size: { x: 80, y: 1, z: 80 } }],
    obstacles: [{ id: 'blinker', type: 'devBlinker', position: { x: 0, y: 0, z: 0 } }],
    flyover: {
      path: [
        { x: 0, y: 30, z: -60 },
        { x: 0, y: 20, z: 0 },
      ],
      lookAt: [{ x: 0, y: 0, z: 0 }],
    },
    music: 'none',
    fallBehavior: 'respawnCheckpoint',
  });
}

interface DevPlayer {
  id: number;
  body: RigidBody;
  input: CharacterInput;
  state: CharacterFullState;
  remote: boolean;
}

/** Spinning sweeper pose: a pure function of match time like every real obstacle. */
function sweeperYaw(index: number, t: number): number {
  return t * (0.9 + index * 0.35) * (index % 2 === 0 ? 1 : -1);
}

const SWEEPERS: readonly Vec3[] = [
  { x: -15, y: 0.7, z: 0 },
  { x: 15, y: 0.7, z: 0 },
  { x: 0, y: 0.7, z: 15 },
];

/**
 * Creates the capsule stand-in match sim. Signature-compatible with the real
 * `createMatchSim(opts)` so it can be injected wherever that is expected.
 *
 * @example
 * const sim = createCapsuleMatchSim({ R, round: createDevRound(), seed: 1, stage: 0, players, mode: 'authority' });
 */
export function createCapsuleMatchSim(opts: MatchSimOptions): MatchSim {
  return new CapsuleMatchSim(opts);
}

class CapsuleMatchSim implements MatchSim {
  readonly world: World;
  readonly events = new EventSink();
  readonly round: RoundDefinition;
  private readonly R: Rapier;
  private readonly players = new Map<number, DevPlayer>();
  private readonly sweepers: RigidBody[] = [];
  private readonly mode: MatchSimOptions['mode'];
  private readonly localId: number;
  private stepCount = 0;
  private matchTime = 0;
  private currentPhase: RoundPhaseId = RoundPhase.Playing;
  private readonly netStates = new Map<string, number[]>();
  private readonly blinker = [0];
  private readonly scratchQ: Quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(opts: MatchSimOptions) {
    this.R = opts.R;
    this.round = opts.round;
    this.mode = opts.mode;
    this.localId = opts.localPlayerId ?? -1;
    const R = opts.R;
    this.world = createWorld(R);
    const floor = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.world.createCollider(
      R.ColliderDesc.cuboid(ARENA_HALF, 0.5, ARENA_HALF)
        .setTranslation(0, -0.5, 0)
        .setCollisionGroups(InteractionGroups.static),
      floor,
    );
    for (const p of SWEEPERS) {
      const b = this.world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z),
      );
      this.world.createCollider(
        R.ColliderDesc.cuboid(7, 0.3, 0.3).setCollisionGroups(InteractionGroups.kinematic),
        b,
      );
      this.sweepers.push(b);
    }
    const spawn = opts.round.spawn;
    const cols = Math.max(1, spawn.cols);
    opts.players.forEach((info, i) => {
      const x = spawn.origin.x + ((i % cols) - (cols - 1) / 2) * spawn.spacing;
      const z = spawn.origin.z - Math.floor(i / cols) * spawn.spacing;
      const remote = this.mode === 'predict' && info.id !== this.localId;
      const desc = remote
        ? R.RigidBodyDesc.kinematicPositionBased()
        : R.RigidBodyDesc.dynamic().lockRotations();
      const body = this.world.createRigidBody(desc.setTranslation(x, spawn.origin.y, z).setCcdEnabled(false));
      this.world.createCollider(
        R.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_RADIUS)
          .setFriction(0)
          .setCollisionGroups(InteractionGroups.player),
        body,
      );
      this.players.set(info.id, {
        id: info.id,
        body,
        remote,
        input: { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 },
        state: initState(x, spawn.origin.y, z),
      });
    });
    this.netStates.set('blinker', this.blinker);
  }

  get tick(): number {
    return this.stepCount;
  }

  get time(): number {
    return this.matchTime;
  }

  get phase(): RoundPhaseId {
    return this.currentPhase;
  }

  setInput(playerId: number, input: CharacterInput): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.input.moveX = input.moveX;
    p.input.moveZ = input.moveZ;
    p.input.yaw = input.yaw;
    p.input.buttons = input.buttons;
    p.input.emote = input.emote;
  }

  step(): void {
    const t = this.matchTime + SIM_DT;
    for (let i = 0; i < this.sweepers.length; i++) {
      this.sweepers[i]!.setNextKinematicRotation(quatFromYaw(sweeperYaw(i, t), this.scratchQ));
    }
    for (const p of this.players.values()) if (!p.remote) this.drive(p);
    this.world.step();
    for (const p of this.players.values()) if (!p.remote) this.post(p);
    this.stepCount++;
    this.matchTime = t;
    const cycle = Math.floor(t / 2) % 4;
    if (cycle !== this.blinker[0]) this.blinker[0] = cycle;
  }

  setPhase(phase: RoundPhaseId, time?: number): void {
    this.currentPhase = phase;
    if (time !== undefined) this.setTime(time);
  }

  /**
   * Jumps match time (prediction replay / resync). Kinematic obstacles are
   * TELEPORTED to `pose(time)`: driving them there with next-kinematic targets
   * would give them a huge one-step velocity that flings anyone touching them.
   */
  setTime(time: number): void {
    this.matchTime = time;
    for (let i = 0; i < this.sweepers.length; i++) {
      this.sweepers[i]!.setRotation(quatFromYaw(sweeperYaw(i, time), this.scratchQ), true);
    }
  }

  getPlayerState(playerId: number, out: CharacterFullState): boolean {
    const p = this.players.get(playerId);
    if (!p) return false;
    copyState(p.state, out);
    return true;
  }

  setPlayerState(playerId: number, s: CharacterFullState): void {
    const p = this.players.get(playerId);
    if (!p) return;
    copyState(s, p.state);
    p.body.setTranslation(s.pos, true);
    p.body.setLinvel(s.vel, true);
    p.body.setRotation(s.rot, true);
  }

  setRemoteProxy(playerId: number, pos: Vec3, rot: Quat, vel: Vec3, state: number): void {
    const p = this.players.get(playerId);
    if (!p || !p.remote) return;
    p.body.setNextKinematicTranslation(pos);
    p.body.setNextKinematicRotation(rot);
    copyVec(pos, p.state.pos);
    copyQuat(rot, p.state.rot);
    copyVec(vel, p.state.vel);
    p.state.state = state as CharacterFullState['state'];
  }

  getObstacleNetStates(): Map<string, number[]> {
    return this.netStates;
  }

  setObstacleNetState(obstacleId: string, state: readonly number[]): void {
    if (obstacleId === 'blinker' && state.length > 0) this.blinker[0] = state[0]!;
  }

  getStatus(): RoundStatus {
    const players = new Map<
      number,
      { status: 0 | 1 | 2 | 3; score: number; progress: number; place: number }
    >();
    for (const p of this.players.values()) {
      players.set(p.id, {
        status: 0,
        score: 0,
        progress: (p.state.pos.z + ARENA_HALF) / (2 * ARENA_HALF),
        place: 0,
      });
    }
    return {
      phase: this.currentPhase,
      time: this.matchTime,
      timeLeft: Math.max(0, this.round.duration.seconds - this.matchTime),
      qualifiedCount: 0,
      qualifyTarget: Math.ceil(this.players.size * this.round.qualification.ratio),
      eliminatedCount: 0,
      teamScores: [],
      players,
      finished: false,
    };
  }

  getStandings(): number[] {
    return [...this.players.values()].sort((a, b) => b.state.pos.z - a.state.pos.z).map((p) => p.id);
  }

  dispose(): void {
    this.world.free();
    this.players.clear();
  }

  private drive(p: DevPlayer): void {
    const s = p.state;
    const inp = p.input;
    const frozen = this.currentPhase !== RoundPhase.Playing && this.currentPhase !== RoundPhase.Overtime;
    const sin = Math.sin(inp.yaw);
    const cos = Math.cos(inp.yaw);
    // Camera-relative: +moveZ is "forward" along the camera yaw.
    const wantX = frozen ? 0 : (inp.moveX * cos + inp.moveZ * sin) * RUN_SPEED;
    const wantZ = frozen ? 0 : (-inp.moveX * sin + inp.moveZ * cos) * RUN_SPEED;
    const v = p.body.linvel();
    const accel = (s.grounded ? GROUND_ACCEL : AIR_ACCEL) * SIM_DT;
    let vx = v.x + clampAbs(wantX - v.x, accel);
    let vz = v.z + clampAbs(wantZ - v.z, accel);
    let vy = v.y;
    const pressed = (inp.buttons & Button.Jump) !== 0 && (s.prevButtons & Button.Jump) === 0;
    if (pressed) s.jumpBufferTimer = 0.12;
    if (s.jumpBufferTimer > 0 && (s.grounded || s.coyoteTimer > 0)) {
      vy = JUMP_SPEED;
      s.jumpBufferTimer = 0;
      s.coyoteTimer = 0;
      s.grounded = false;
      this.events.push({ type: 'jump', player: p.id, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z } });
    }
    if (!Number.isFinite(vx)) vx = 0;
    if (!Number.isFinite(vz)) vz = 0;
    p.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    s.prevButtons = inp.buttons;
    s.jumpBufferTimer = Math.max(0, s.jumpBufferTimer - SIM_DT);
    s.coyoteTimer = Math.max(0, s.coyoteTimer - SIM_DT);
    if (Math.hypot(wantX, wantZ) > 0.1) s.facing = Math.atan2(wantX, wantZ);
  }

  private post(p: DevPlayer): void {
    const s = p.state;
    const t = p.body.translation();
    const v = p.body.linvel();
    if (t.y < this.round.killY) {
      const o = this.round.spawn.origin;
      p.body.setTranslation({ x: o.x, y: o.y + 1, z: o.z }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.events.push({ type: 'respawn', player: p.id, pos: { x: o.x, y: o.y + 1, z: o.z } });
    }
    const wasGrounded = s.grounded;
    s.grounded = t.y <= STAND_Y + 0.06 && Math.abs(v.y) < 1.5;
    if (s.grounded) s.coyoteTimer = 0.12;
    if (s.grounded && !wasGrounded) {
      this.events.push({
        type: 'land',
        player: p.id,
        pos: { x: t.x, y: t.y, z: t.z },
        impact: Math.abs(v.y),
      });
    }
    s.pos.x = t.x;
    s.pos.y = t.y;
    s.pos.z = t.z;
    s.vel.x = v.x;
    s.vel.y = v.y;
    s.vel.z = v.z;
    quatFromYaw(s.facing, s.rot);
    const speed = Math.hypot(v.x, v.z);
    const next = !s.grounded
      ? v.y > 0
        ? CharacterState.Jump
        : CharacterState.Fall
      : speed > 0.5
        ? CharacterState.Run
        : CharacterState.Idle;
    if (next !== s.state) {
      s.state = next;
      s.stateTime = 0;
    } else {
      s.stateTime += SIM_DT;
    }
  }
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}

function initState(x: number, y: number, z: number): CharacterFullState {
  const s = createCharacterFullState();
  s.pos.x = x;
  s.pos.y = y;
  s.pos.z = z;
  return s;
}
