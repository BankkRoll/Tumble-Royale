/**
 * The match simulation: one round running inside a Rapier world.
 *
 * Responsibilities:
 * - Build the level (static colliders, trigger sensors, seeded variation,
 *   obstacle runtimes with per-instance Rng and stage speed scale).
 * - Spawn and drive player controllers (humans via `setInput`, bots via brains),
 *   or kinematic proxies for remote players when predicting on a client.
 * - Route physics events to obstacles (`onTrigger`/`onContact`) and to the
 *   round rules (checkpoints, finish, voids, zones, goals, nests, crown).
 * - Falls and respawns, fates (qualified/eliminated), status and standings.
 *
 * Step order (identical on server and client):
 *   obstacles.update(t) → inputs (bots think) → controller.step → world.step
 *   → controller.postStep → event routing → killY → respawns → rules → time.
 */
import type { Collider, EventQueue, World } from '@dimforge/rapier3d-compat';
import {
  CollisionGroup,
  Rng,
  RoundDefinitionSchema,
  RoundPhase,
  SIM_DT,
  hashString,
  quatIdentity,
  vec3,
  type Quat,
  type RoundDefinition,
  type RoundPhaseId,
  type TriggerDef,
  type Vec3,
} from '@tumble/shared';
import { createBotBrain } from '../bots/brain.ts';
import type { BotBrainLike, BotPeer, BotSelfView, BotWorldView } from '../bots/types.ts';
import {
  CharacterFlag,
  CharacterState,
  emptyInput,
  type CharacterFullState,
  type CharacterInput,
  type CharacterStepContext,
  type TumblerControllerLike,
} from '../character/types.ts';
import { EventSink, type SimEvent } from '../events.ts';
import type { ObstacleActor, ObstacleRuntime, ObstacleStepContext } from '../obstacles/types.ts';
import type { Rapier } from '../physics/rapier.ts';
import { SurfaceRegistry } from '../physics/surfaces.ts';
import { createWorld } from '../physics/world.ts';
import { compareStanding } from '../rounds/base.ts';
import { createRoundRules } from '../rounds/factory.ts';
import { assignTeams } from '../rounds/team-score.ts';
import { CourseMetric } from '../rounds/progress.ts';
import type { RoundRules, RulesHost, RulesPlayer } from '../rounds/types.ts';
import type { MatchDeps } from './deps.ts';
import { buildStaticGeometry } from './geometry.ts';
import { chooseVariation, resolveObstacles, spawnSlots, type SpawnSlot } from './layout.ts';
import { ObstacleOracle } from './oracle.ts';
import { RemoteProxy } from './proxy.ts';
import { RoundTriggers } from './triggers.ts';
import {
  PlayerRoundStatus,
  type MatchPlayerInfo,
  type MatchSim,
  type MatchSimOptions,
  type PlayerRoundStatusId,
  type RoundStatus,
} from './types.ts';

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

/** Seconds between falling out and reappearing at a checkpoint. */
export const RESPAWN_DELAY_SECONDS = 1.2;
/** Ghost grace after a respawn, seconds. */
export const RESPAWN_GHOST_SECONDS = 1;
/** Countdown length; the match clock runs from −this to 0 during COUNTDOWN. */
export const COUNTDOWN_SECONDS = 3;
/** Lift from an authored floor point (spawn, respawn) to the capsule centre. */
export const SPAWN_LIFT = 1;
/** Lateral random spread around a respawn point, metres. */
const RESPAWN_SPREAD = 0.75;
/** Progress is re-measured every N ticks per player (staggered). */
const PROGRESS_INTERVAL = 4;

const RULES_SALT = 0x0e1e_5a17;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * The full match sim API: the {@link MatchSim} contract plus extras for the
 * server room, offline mode, tools and tests.
 */
export interface MatchSimHandle extends MatchSim {
  readonly phase: RoundPhaseId;
  readonly variationId: string | null;
  /** Players expected to qualify. */
  readonly qualifyTarget: number;
  /** Non-fatal load problems (unknown obstacle types, bad params). */
  readonly warnings: readonly string[];
  /** The rule set, or null in predict mode. */
  readonly rules: RoundRules | null;
  readonly surfaces: SurfaceRegistry;
  readonly obstacleRuntimes: readonly ObstacleRuntime[];
  /** What bots see: obstacle prediction and ground probes (also handy for debug overlays). */
  readonly botView: BotWorldView;
  /** @returns The controller (or remote proxy) for a player. */
  controller(playerId: number): TumblerControllerLike | undefined;
  /** @returns The live runtime of an obstacle instance. */
  obstacle(id: string): ObstacleRuntime | undefined;
  /** A player left mid-round: they are eliminated (or given up items) at once. */
  forfeit(playerId: number): void;
  /** Predict mode: mirror a fate decided by the server. */
  setPlayerFate(playerId: number, status: PlayerRoundStatusId, place: number): void;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** Adapts a controller to the obstacle-facing actor interface. */
class ControllerActor implements ObstacleActor {
  constructor(private readonly ctrl: TumblerControllerLike) {}

  get id(): number {
    return this.ctrl.id;
  }

  get body(): TumblerControllerLike['body'] {
    return this.ctrl.body;
  }

  get isGhost(): boolean {
    return ((this.ctrl.collider.collisionGroups() >>> 16) & CollisionGroup.PlayerGhost) !== 0;
  }

  knock(impulse: Vec3, stun: boolean): void {
    this.ctrl.knock(impulse, stun);
  }

  push(deltaVelocity: Vec3): void {
    this.ctrl.push(deltaVelocity);
  }

  teleport(pos: Vec3, yaw?: number): void {
    this.ctrl.teleport(pos, yaw);
  }
}

interface Slot {
  readonly index: number;
  readonly info: MatchPlayerInfo;
  readonly ctrl: TumblerControllerLike;
  /** Set when the player is a kinematic stand-in for a remote client. */
  readonly proxy: RemoteProxy | null;
  readonly actor: ControllerActor;
  readonly rp: RulesPlayer;
  readonly spawn: SpawnSlot;
  readonly input: CharacterInput;
  readonly brain: BotBrainLike | null;
  readonly self: BotSelfView;
  readonly prevPos: Vec3;
  /** Simulated this step (not eliminated). */
  active: boolean;
  falling: boolean;
  respawnTick: number;
  respawnCount: number;
  /** Index of the checkpoint trigger to respawn at, -1 for the spawn slot. */
  checkpointTrigger: number;
}

function newFullState(): CharacterFullState {
  return {
    pos: vec3(),
    rot: quatIdentity(),
    vel: vec3(),
    angVel: vec3(),
    state: CharacterState.Idle,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 0,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
}

function copyInput(src: CharacterInput, out: CharacterInput): void {
  out.moveX = src.moveX;
  out.moveZ = src.moveZ;
  out.yaw = src.yaw;
  out.buttons = src.buttons;
  out.emote = src.emote;
}

class MatchSimImpl implements MatchSimHandle, RulesHost {
  readonly world: World;
  readonly events = new EventSink();
  readonly round: RoundDefinition;
  readonly surfaces = new SurfaceRegistry();
  readonly warnings: string[] = [];
  readonly variationId: string | null;
  readonly rules: RoundRules | null;
  readonly rng: Rng;
  readonly entrants: number;
  readonly players: RulesPlayer[] = [];
  readonly obstacleRuntimes: ObstacleRuntime[] = [];

  tick = 0;
  time = 0;
  phase: RoundPhaseId = RoundPhase.Loading;
  inOvertime = false;

  private readonly R: Rapier;
  private readonly mode: MatchSimOptions['mode'];
  private readonly dt = SIM_DT;
  private readonly slots: Slot[] = [];
  private readonly slotById = new Map<number, Slot>();
  private readonly slotByCollider = new Map<number, Slot>();
  private readonly obstacleById = new Map<string, ObstacleRuntime>();
  private colliderOwner = new Map<number, number>();
  private readonly staticHandles = new Set<number>();
  private readonly triggers: RoundTriggers;
  private readonly eventQueue: EventQueue;
  private readonly oracle: ObstacleOracle;
  private readonly course: CourseMetric;
  private readonly actors: ObstacleActor[] = [];
  private readonly octx: ObstacleStepContext;
  private readonly cctx: CharacterStepContext;
  readonly botView: BotWorldView;
  private readonly scratchState = newFullState();
  private readonly scratchVec = vec3();
  private readonly status: RoundStatus;
  private readonly standings: number[] = [];
  private readonly standingScratch: RulesPlayer[] = [];
  private readonly netStates = new Map<string, number[]>();
  private qualifiedCount = 0;
  private eliminatedCount = 0;
  private started = false;
  private disposed = false;
  private actorsDirty = true;

  // Collision events are buffered, then routed in a fixed order.
  private pendA: number[] = [];
  private pendB: number[] = [];
  private pendS: boolean[] = [];
  private pendCount = 0;
  private readonly onCollision = (h1: number, h2: number, started: boolean): void => {
    const i = this.pendCount++;
    this.pendA[i] = h1;
    this.pendB[i] = h2;
    this.pendS[i] = started;
  };
  // Ongoing player↔obstacle contacts, for per-step onContact.
  private cSlot: number[] = [];
  private cHandle: number[] = [];
  private cOwner: number[] = [];
  private contactCount = 0;
  // Finish crossings this step, sorted by sub-tick before reaching the rules.
  private finSlot: number[] = [];
  private finSub: number[] = [];
  private finCount = 0;

  constructor(opts: MatchSimOptions, deps: MatchDeps) {
    const R = opts.R;
    this.R = R;
    this.mode = opts.mode;
    // Accept authored input too: defaults are applied here so callers may pass raw content.
    this.round = RoundDefinitionSchema.parse(opts.round);
    const round = this.round;
    this.world = createWorld(R);
    this.eventQueue = new R.EventQueue(true);
    const roundSeed = (opts.seed ^ hashString(round.id)) >>> 0;
    this.rng = new Rng((roundSeed ^ RULES_SALT) >>> 0);
    this.oracle = new ObstacleOracle(R, this.world);

    // Level.
    const geo = buildStaticGeometry(R, this.world, round, this.surfaces);
    for (const c of geo.colliders) this.staticHandles.add(c.handle);
    this.triggers = new RoundTriggers(R, this.world, round);

    // Obstacles.
    const variation = chooseVariation(round, opts.seed, opts.variationId);
    this.variationId = variation?.id ?? null;
    const stageScales = round.speedScaleByStage;
    const speedScale =
      stageScales.length > 0 ? (stageScales[Math.max(0, Math.min(opts.stage, stageScales.length - 1))] ?? 1) : 1;
    for (const inst of resolveObstacles(round, variation)) {
      const mod = deps.obstacles.get(inst.type);
      if (!mod) {
        this.warnings.push(`obstacle ${inst.id}: no module registered for type "${inst.type}"`);
        continue;
      }
      let params: unknown;
      try {
        params = mod.schema.parse(inst.params);
      } catch (err) {
        this.warnings.push(`obstacle ${inst.id}: invalid params (${(err as Error).message})`);
        continue;
      }
      const rng = new Rng((roundSeed ^ hashString(inst.id)) >>> 0);
      const runtime = mod.create(
        { ...inst, params },
        { R, world: this.world, surfaces: this.surfaces, events: this.events, rng, speedScale },
      );
      this.obstacleRuntimes.push(runtime);
      this.obstacleById.set(inst.id, runtime);
      this.oracle.add(inst, runtime, mod, params, speedScale);
    }
    this.rebuildColliderOwners();

    // Players.
    const teams = opts.players.map((p) => p.team);
    if (round.qualification.mode === 'teamScore') assignTeams(teams, opts.players.map((p) => p.id), round.qualification.teams);
    const spawns = spawnSlots(round, opts.seed, teams);
    this.entrants = opts.players.length;
    const brainFactory = deps.createBotBrain ?? createBotBrain;
    const simulateAll = opts.mode !== 'predict';
    opts.players.forEach((info, index) => {
      const spawn = spawns[index] as SpawnSlot;
      const pos = { x: spawn.pos.x, y: spawn.pos.y + SPAWN_LIFT, z: spawn.pos.z };
      const isLocal = simulateAll || info.id === opts.localPlayerId;
      const proxy = isLocal ? null : new RemoteProxy(R, this.world, info.id, pos);
      const ctrl =
        proxy ??
        deps.createController({ R, world: this.world, id: info.id, position: pos, yaw: spawn.yaw, tuning: deps.controllerTuning });
      if (!proxy) ctrl.collider.setActiveEvents(ctrl.collider.activeEvents() | R.ActiveEvents.COLLISION_EVENTS);
      const rp: RulesPlayer = {
        id: info.id,
        team: teams[index] as number,
        isBot: info.isBot,
        status: PlayerRoundStatus.Playing,
        score: 0,
        progress: 0,
        place: 0,
        finishTick: -1,
        finishSubTick: 0,
        hasItem: false,
        scoreTick: 0,
        checkpoint: 0,
        pos: { ...pos },
        forfeited: false,
      };
      const input = emptyInput();
      input.yaw = spawn.yaw;
      const brain =
        info.isBot && simulateAll
          ? brainFactory({
              id: info.id,
              skill: info.botSkill ?? 'average',
              seed: (roundSeed ^ Math.imul(info.id + 1, 0x9e3779b1)) >>> 0,
              round,
            })
          : null;
      const slot: Slot = {
        index,
        info,
        ctrl,
        proxy,
        actor: new ControllerActor(ctrl),
        rp,
        spawn,
        input,
        brain,
        self: {
          pos: vec3(),
          vel: vec3(),
          grounded: false,
          state: CharacterState.Idle,
          facing: spawn.yaw,
          status: PlayerRoundStatus.Playing,
          team: teams[index] as number,
          hasItem: false,
          checkpoint: 0,
        },
        prevPos: { ...pos },
        active: true,
        falling: false,
        respawnTick: 0,
        respawnCount: 0,
        checkpointTrigger: -1,
      };
      this.slots.push(slot);
      this.players.push(rp);
      this.slotById.set(info.id, slot);
      this.slotByCollider.set(ctrl.collider.handle, slot);
      if (!proxy) ctrl.setFrozen(true);
    });

    this.course = new CourseMetric(round, round.spawn.origin);

    this.octx = { t: 0, dt: this.dt, tick: 0, events: this.events, actors: this.actors };
    this.cctx = {
      R,
      world: this.world,
      dt: this.dt,
      tick: 0,
      time: 0,
      surfaces: this.surfaces,
      events: this.events,
      controllerByCollider: (handle) => this.slotByCollider.get(handle)?.ctrl,
    };
    this.botView = this.createBotView();

    this.status = {
      phase: this.phase,
      time: 0,
      timeLeft: round.duration.seconds > 0 ? round.duration.seconds : -1,
      qualifiedCount: 0,
      qualifyTarget: 0,
      eliminatedCount: 0,
      teamScores: [],
      players: new Map(),
      finished: false,
    };
    for (const s of this.slots) {
      this.status.players.set(s.info.id, { status: 0, score: 0, progress: 0, place: 0, team: s.rp.team, hasItem: false });
    }

    if (simulateAll) {
      this.rules = createRoundRules(round, this.entrants, { ...opts.rules, qualifyTarget: opts.qualifyTarget ?? opts.rules?.qualifyTarget });
      this.rules.init(this);
      for (const s of this.slots) s.self.team = s.rp.team;
    } else {
      this.rules = null;
    }
    this.status.qualifyTarget = this.rules?.qualifyTarget ?? 0;
  }

  get qualifyTarget(): number {
    return this.rules?.qualifyTarget ?? 0;
  }

  /** Seconds left including overtime; -1 when untimed. */
  get timeLeft(): number {
    const d = this.round.duration;
    if (d.seconds <= 0) return -1;
    const limit = d.seconds + (this.inOvertime ? d.overtimeSeconds : 0);
    return Math.max(0, limit - Math.max(0, this.time));
  }

  // ---------------------------------------------------------------------------
  // Contract
  // ---------------------------------------------------------------------------

  setInput(playerId: number, input: CharacterInput): void {
    const s = this.slotById.get(playerId);
    if (s && !s.brain) copyInput(input, s.input);
  }

  setPhase(phase: RoundPhaseId, time?: number): void {
    const prev = this.phase;
    this.phase = phase;
    if (time !== undefined) this.time = time;
    else if (phase === RoundPhase.Countdown && prev !== RoundPhase.Countdown) this.time = -COUNTDOWN_SECONDS;
    else if (phase === RoundPhase.Playing && this.time < 0) this.time = 0;
    this.inOvertime = phase === RoundPhase.Overtime;
    const frozen = phase < RoundPhase.Playing || phase >= RoundPhase.Results;
    for (const s of this.slots) if (!s.proxy && s.active) s.ctrl.setFrozen(frozen);
    if ((phase === RoundPhase.Playing || phase === RoundPhase.Overtime) && !this.started) {
      this.started = true;
      this.rules?.start();
    }
  }

  step(): void {
    if (this.disposed) return;
    const tick = this.tick;
    const evStart = this.events.events.length;
    const live = this.phase === RoundPhase.Playing || this.phase === RoundPhase.Overtime;

    if (this.actorsDirty) this.rebuildActors();
    this.octx.t = this.time;
    this.octx.tick = tick;
    this.oracle.poseTime = this.time;
    for (const o of this.obstacleRuntimes) o.update(this.octx);

    this.cctx.tick = tick;
    this.cctx.time = this.time;
    for (const s of this.slots) {
      if (!s.active || s.proxy) continue;
      const p = s.ctrl.body.translation(this.scratchVec);
      s.prevPos.x = p.x;
      s.prevPos.y = p.y;
      s.prevPos.z = p.z;
      if (s.brain) this.thinkBot(s);
      s.ctrl.step(s.input, this.cctx);
    }

    this.pendCount = 0;
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents(this.onCollision);

    for (const s of this.slots) if (s.active && !s.proxy) s.ctrl.postStep(this.cctx);

    this.routeObstacleEvents();
    if (this.rules && live) {
      const evs = this.events.events;
      const end = evs.length;
      for (let i = evStart; i < end; i++) this.rules.onEvent(evs[i] as SimEvent);
    }
    this.routeRoundTriggers(live);

    this.updatePositions(tick);
    if (this.mode !== 'predict') {
      this.checkKillY();
      this.processRespawns(tick);
      if (this.rules && live) this.rules.update(this.dt);
    }

    this.tick = tick + 1;
    if (
      this.phase === RoundPhase.Countdown ||
      this.phase === RoundPhase.Playing ||
      this.phase === RoundPhase.Overtime ||
      this.phase === RoundPhase.RoundEnd
    ) {
      this.time += this.dt;
      if (this.phase === RoundPhase.Countdown && this.time > 0) this.time = 0;
    }
  }

  getPlayerState(playerId: number, out: CharacterFullState): boolean {
    const s = this.slotById.get(playerId);
    if (!s) return false;
    s.ctrl.getState(out);
    return true;
  }

  setPlayerState(playerId: number, state: CharacterFullState): void {
    this.slotById.get(playerId)?.ctrl.setState(state);
  }

  setRemoteProxy(playerId: number, pos: Vec3, rot: Quat, vel: Vec3, state: number): void {
    const s = this.slotById.get(playerId);
    if (!s?.proxy) return;
    s.proxy.place(pos, rot, vel, state);
    s.rp.pos.x = pos.x;
    s.rp.pos.y = pos.y;
    s.rp.pos.z = pos.z;
  }

  getObstacleNetStates(): Map<string, number[]> {
    for (const o of this.obstacleRuntimes) {
      if (o.getNetState) this.netStates.set(o.instance.id, o.getNetState());
    }
    return this.netStates;
  }

  setObstacleNetState(obstacleId: string, state: readonly number[]): void {
    this.obstacleById.get(obstacleId)?.setNetState?.(state);
  }

  /** Returns a live object that is updated in place on every call. */
  getStatus(): RoundStatus {
    const st = this.status;
    st.phase = this.phase;
    st.time = this.time;
    st.timeLeft = this.timeLeft;
    st.qualifiedCount = this.qualifiedCount;
    st.eliminatedCount = this.eliminatedCount;
    st.teamScores = this.rules ? (this.rules.teamScores as number[]) : st.teamScores;
    st.finished = this.rules?.finished ?? false;
    for (const s of this.slots) {
      const e = st.players.get(s.info.id);
      if (!e) continue;
      e.status = s.rp.status;
      e.score = s.rp.score;
      e.progress = s.rp.progress;
      e.place = s.rp.place;
      e.team = s.rp.team;
      e.hasItem = s.rp.hasItem;
    }
    return st;
  }

  /** Returns a shared array, rewritten on every call. */
  getStandings(): number[] {
    const list = this.standingScratch;
    if (list.length !== this.players.length) list.splice(0, list.length, ...this.players);
    list.sort(standingOrder);
    this.standings.length = 0;
    for (const p of list) this.standings.push(p.id);
    return this.standings;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.obstacleRuntimes) o.dispose();
    for (const s of this.slots) s.ctrl.dispose();
    this.eventQueue.free();
    this.world.free();
  }

  // ---------------------------------------------------------------------------
  // Extras
  // ---------------------------------------------------------------------------

  controller(playerId: number): TumblerControllerLike | undefined {
    return this.slotById.get(playerId)?.ctrl;
  }

  obstacle(id: string): ObstacleRuntime | undefined {
    return this.obstacleById.get(id);
  }

  forfeit(playerId: number): void {
    const s = this.slotById.get(playerId);
    if (!s || s.rp.forfeited) return;
    s.rp.forfeited = true;
    if (!this.rules) return;
    if (this.started) this.rules.onForfeit(s.rp);
    else this.forceEliminate(s);
  }

  setPlayerFate(playerId: number, status: PlayerRoundStatusId, place: number): void {
    const s = this.slotById.get(playerId);
    if (!s) return;
    s.rp.status = status;
    s.rp.place = place;
    if (status === PlayerRoundStatus.Qualified) {
      this.qualifiedCount++;
      if (!s.proxy) s.ctrl.setFate(CharacterState.Finished);
    } else if (status === PlayerRoundStatus.Eliminated) {
      this.eliminatedCount++;
      if (!s.proxy) s.ctrl.setFate(CharacterState.Eliminated);
    }
  }

  // ---------------------------------------------------------------------------
  // RulesHost
  // ---------------------------------------------------------------------------

  playerById(id: number): RulesPlayer | undefined {
    return this.slotById.get(id)?.rp;
  }

  qualify(p: RulesPlayer): void {
    if (p.status !== PlayerRoundStatus.Playing) return;
    const s = this.slotById.get(p.id);
    p.status = PlayerRoundStatus.Qualified;
    p.place = ++this.qualifiedCount;
    this.events.push({ type: 'qualified', player: p.id, place: p.place });
    if (s && !s.proxy) {
      s.ctrl.setFate(CharacterState.Finished);
      s.ctrl.setGhost(true);
    }
  }

  eliminate(p: RulesPlayer): void {
    if (p.status !== PlayerRoundStatus.Playing) return;
    p.status = PlayerRoundStatus.Eliminated;
    p.place = this.entrants - this.eliminatedCount++;
    this.events.push({ type: 'eliminated', player: p.id, place: p.place });
    const s = this.slotById.get(p.id);
    if (s) this.deactivate(s);
  }

  setHasItem(p: RulesPlayer, has: boolean): void {
    p.hasItem = has;
    const s = this.slotById.get(p.id);
    if (!s || s.proxy) return;
    const st = s.ctrl.getState(this.scratchState);
    const flags = has ? st.flags | CharacterFlag.HasTail : st.flags & ~CharacterFlag.HasTail;
    if (flags !== st.flags) {
      st.flags = flags;
      s.ctrl.setState(st);
    }
  }

  requestOvertime(): boolean {
    if (this.inOvertime || this.round.duration.overtimeSeconds <= 0) return false;
    this.inOvertime = true;
    this.phase = RoundPhase.Overtime;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Step helpers
  // ---------------------------------------------------------------------------

  private forceEliminate(s: Slot): void {
    if (s.rp.status !== PlayerRoundStatus.Playing) return;
    this.eliminate(s.rp);
  }

  private deactivate(s: Slot): void {
    if (!s.active) return;
    s.active = false;
    s.falling = false;
    if (!s.proxy) {
      s.ctrl.setFate(CharacterState.Eliminated);
      s.ctrl.setGhost(true);
      // Eliminated bodies leave the simulation entirely; they would otherwise keep falling forever.
      s.ctrl.body.setEnabled(false);
    }
    for (let i = this.contactCount - 1; i >= 0; i--) if (this.cSlot[i] === s.index) this.removeContactAt(i);
    this.actorsDirty = true;
  }

  private rebuildActors(): void {
    this.actors.length = 0;
    for (const s of this.slots) if (s.active && !s.proxy) this.actors.push(s.actor);
    this.actorsDirty = false;
  }

  private rebuildColliderOwners(): void {
    const m = new Map<number, number>();
    this.obstacleRuntimes.forEach((o, i) => {
      for (const c of o.colliders) m.set(c.handle, i);
    });
    this.colliderOwner = m;
    this.oracle.refresh();
  }

  private ownerOf(handle: number): number {
    const o = this.colliderOwner.get(handle);
    if (o !== undefined) return o;
    if (this.staticHandles.has(handle) || this.triggers.indexOf(handle) >= 0) return -1;
    // Obstacles may create colliders after build (props, projectiles).
    this.rebuildColliderOwners();
    const again = this.colliderOwner.get(handle);
    if (again === undefined) this.staticHandles.add(handle);
    return again ?? -1;
  }

  private thinkBot(s: Slot): void {
    const brain = s.brain as BotBrainLike;
    const st = s.ctrl.getState(this.scratchState);
    const self = s.self;
    self.pos.x = st.pos.x;
    self.pos.y = st.pos.y;
    self.pos.z = st.pos.z;
    self.vel.x = st.vel.x;
    self.vel.y = st.vel.y;
    self.vel.z = st.vel.z;
    self.grounded = st.grounded;
    self.state = st.state;
    self.facing = st.facing;
    self.status = s.rp.status;
    self.team = s.rp.team;
    self.hasItem = s.rp.hasItem;
    self.checkpoint = s.rp.checkpoint;
    brain.think(this.botView, self, s.input);
  }

  /** Obstacle sensors/contacts, lethal surfaces, then ongoing contacts. */
  private routeObstacleEvents(): void {
    const n = this.pendCount;
    for (let i = 0; i < n; i++) {
      const h1 = this.pendA[i] as number;
      const h2 = this.pendB[i] as number;
      const started = this.pendS[i] as boolean;
      const s1 = this.slotByCollider.get(h1);
      const s2 = this.slotByCollider.get(h2);
      if ((s1 && s2) || (!s1 && !s2)) continue;
      const slot = (s1 ?? s2) as Slot;
      if (slot.proxy || !slot.active) continue;
      const other = s1 ? h2 : h1;
      if (this.triggers.indexOf(other) >= 0) continue;
      const owner = this.ownerOf(other);
      if (owner >= 0) {
        const runtime = this.obstacleRuntimes[owner] as ObstacleRuntime;
        const collider = this.world.getCollider(other);
        if (collider && collider.isSensor()) {
          runtime.onTrigger?.(slot.actor, collider, started, this.octx);
        } else if (started) {
          this.addContact(slot.index, other, owner);
        } else {
          this.removeContact(slot.index, other);
        }
      }
      if (started && this.mode !== 'predict' && this.surfaces.get(other)?.lethal) this.fallOut(slot);
    }
    for (let i = 0; i < this.contactCount; i++) {
      const slot = this.slots[this.cSlot[i] as number] as Slot;
      const runtime = this.obstacleRuntimes[this.cOwner[i] as number] as ObstacleRuntime;
      if (!runtime.onContact) continue;
      const collider: Collider | undefined = this.world.getCollider(this.cHandle[i] as number);
      if (collider) runtime.onContact(slot.actor, collider, this.octx);
    }
  }

  /** Round triggers: checkpoints, finish (ordered by sub-tick), voids, zones, props. */
  private routeRoundTriggers(live: boolean): void {
    const n = this.pendCount;
    const authority = this.mode !== 'predict';
    this.finCount = 0;
    for (let i = 0; i < n; i++) {
      const h1 = this.pendA[i] as number;
      const h2 = this.pendB[i] as number;
      const started = this.pendS[i] as boolean;
      let ti = this.triggers.indexOf(h1);
      let other = h2;
      if (ti < 0) {
        ti = this.triggers.indexOf(h2);
        other = h1;
      }
      if (ti < 0) continue;
      const def = this.triggers.defs[ti] as TriggerDef;
      const slot = this.slotByCollider.get(other);
      if (!slot) {
        if (authority && live && this.rules && this.triggers.indexOf(other) < 0) this.rules.onPropTrigger(def, other, started);
        continue;
      }
      if (!authority || slot.proxy || !slot.active) continue;
      switch (def.kind) {
        case 'void':
          if (started) this.fallOut(slot);
          break;
        case 'checkpoint':
          if (started && def.index > slot.rp.checkpoint) {
            slot.rp.checkpoint = def.index;
            slot.checkpointTrigger = ti;
            this.events.push({ type: 'checkpoint', player: slot.info.id, index: def.index });
          } else if (started && def.index === slot.rp.checkpoint && slot.checkpointTrigger < 0) {
            slot.checkpointTrigger = ti;
          }
          break;
        case 'finish':
          if (started && live && slot.rp.status === PlayerRoundStatus.Playing) {
            const k = this.finCount++;
            this.finSlot[k] = slot.index;
            const pos = slot.ctrl.body.translation(this.scratchVec);
            this.finSub[k] = this.triggers.entryFraction(ti, slot.prevPos, pos);
          }
          break;
        default:
          if (live && this.rules) this.rules.onTrigger(slot.rp, def, started);
      }
    }
    if (this.finCount > 0 && this.rules) this.flushFinishes();
  }

  private flushFinishes(): void {
    const rules = this.rules as RoundRules;
    // Insertion sort: rarely more than a handful of finishers share a step.
    for (let i = 1; i < this.finCount; i++) {
      const sub = this.finSub[i] as number;
      const sl = this.finSlot[i] as number;
      let j = i - 1;
      while (j >= 0 && ((this.finSub[j] as number) > sub || ((this.finSub[j] as number) === sub && (this.finSlot[j] as number) > sl))) {
        this.finSub[j + 1] = this.finSub[j] as number;
        this.finSlot[j + 1] = this.finSlot[j] as number;
        j--;
      }
      this.finSub[j + 1] = sub;
      this.finSlot[j + 1] = sl;
    }
    for (let i = 0; i < this.finCount; i++) {
      const s = this.slots[this.finSlot[i] as number] as Slot;
      const sub = this.finSub[i] as number;
      this.events.push({ type: 'finish', player: s.info.id, tick: this.tick, subTick: sub });
      rules.onFinishLine(s.rp, this.tick, sub);
    }
  }

  private updatePositions(tick: number): void {
    const progressMode = this.rules?.mode;
    const survivalLike = progressMode === 'survive' || progressMode === 'logicSurvive' || progressMode === 'lastStanding';
    for (const s of this.slots) {
      if (!s.active) continue;
      if (!s.proxy) {
        const p = s.ctrl.body.translation(this.scratchVec);
        s.rp.pos.x = p.x;
        s.rp.pos.y = p.y;
        s.rp.pos.z = p.z;
      }
      if (s.rp.status !== PlayerRoundStatus.Playing || (tick + s.index) % PROGRESS_INTERVAL !== 0) continue;
      if (survivalLike) {
        const d = this.round.duration.seconds;
        s.rp.progress = d > 0 ? Math.min(1, Math.max(0, this.time) / d) : 0;
      } else if (!s.falling) {
        s.rp.progress = this.course.measure(s.rp.pos);
      }
    }
  }

  private checkKillY(): void {
    const killY = this.round.killY;
    for (const s of this.slots) {
      if (!s.active || s.proxy || s.falling) continue;
      if (s.rp.pos.y < killY) this.fallOut(s);
    }
  }

  private fallOut(s: Slot): void {
    if (s.falling || !s.active) return;
    const pos = s.ctrl.body.translation(this.scratchVec);
    this.events.push({ type: 'fellOut', player: s.info.id, pos: { x: pos.x, y: pos.y, z: pos.z } });
    const verdict =
      s.rp.status === PlayerRoundStatus.Playing && this.rules ? this.rules.onFellOut(s.rp) : ('respawn' as const);
    if (verdict === 'eliminate') {
      this.eliminate(s.rp);
      return;
    }
    s.falling = true;
    s.respawnTick = this.tick + Math.round(RESPAWN_DELAY_SECONDS / this.dt);
  }

  private processRespawns(tick: number): void {
    for (const s of this.slots) {
      if (!s.falling || !s.active || tick < s.respawnTick) continue;
      s.falling = false;
      const out = this.scratchVec;
      let yaw = s.spawn.yaw;
      const def = s.checkpointTrigger >= 0 ? this.triggers.defs[s.checkpointTrigger] : undefined;
      if (def && def.respawn.length > 0) {
        const p = def.respawn[(s.index + s.respawnCount) % def.respawn.length] as Vec3;
        out.x = p.x + this.rng.range(-RESPAWN_SPREAD, RESPAWN_SPREAD);
        out.y = p.y + SPAWN_LIFT;
        out.z = p.z + this.rng.range(-RESPAWN_SPREAD, RESPAWN_SPREAD);
        yaw = (def.respawnYaw * Math.PI) / 180;
      } else if (def) {
        out.x = def.position.x + this.rng.range(-RESPAWN_SPREAD, RESPAWN_SPREAD);
        out.y = def.position.y - def.size.y / 2 + SPAWN_LIFT;
        out.z = def.position.z + this.rng.range(-RESPAWN_SPREAD, RESPAWN_SPREAD);
        yaw = (def.respawnYaw * Math.PI) / 180;
      } else {
        out.x = s.spawn.pos.x;
        out.y = s.spawn.pos.y + SPAWN_LIFT;
        out.z = s.spawn.pos.z;
      }
      s.respawnCount++;
      s.ctrl.teleport(out, yaw);
      s.ctrl.setGhost(true, RESPAWN_GHOST_SECONDS);
      s.rp.pos.x = out.x;
      s.rp.pos.y = out.y;
      s.rp.pos.z = out.z;
      this.events.push({ type: 'respawn', player: s.info.id, pos: { x: out.x, y: out.y, z: out.z } });
      s.brain?.onRespawn?.();
    }
  }

  private addContact(slotIndex: number, handle: number, owner: number): void {
    for (let i = 0; i < this.contactCount; i++) {
      if (this.cSlot[i] === slotIndex && this.cHandle[i] === handle) return;
    }
    const k = this.contactCount++;
    this.cSlot[k] = slotIndex;
    this.cHandle[k] = handle;
    this.cOwner[k] = owner;
  }

  private removeContact(slotIndex: number, handle: number): void {
    for (let i = 0; i < this.contactCount; i++) {
      if (this.cSlot[i] === slotIndex && this.cHandle[i] === handle) {
        this.removeContactAt(i);
        return;
      }
    }
  }

  private removeContactAt(i: number): void {
    const last = --this.contactCount;
    this.cSlot[i] = this.cSlot[last] as number;
    this.cHandle[i] = this.cHandle[last] as number;
    this.cOwner[i] = this.cOwner[last] as number;
  }

  private createBotView(): BotWorldView {
    return new SimBotView(this, this.oracle);
  }
}

/** Read-only window onto the sim for bot brains. */
class SimBotView implements BotWorldView {
  readonly peers: readonly BotPeer[];
  readonly dt: number;

  constructor(
    private readonly sim: MatchSimImpl,
    private readonly oracle: ObstacleOracle,
  ) {
    this.peers = sim.players;
    this.dt = SIM_DT;
  }

  get round(): RoundDefinition {
    return this.sim.round;
  }

  get phase(): RoundPhaseId {
    return this.sim.phase;
  }

  get time(): number {
    return this.sim.time;
  }

  get tick(): number {
    return this.sim.tick;
  }

  obstacleClearance(id: string, point: Vec3, ahead: number): number {
    return this.oracle.obstacleClearance(id, point, ahead);
  }

  hazardDistance(point: Vec3, maxDist: number, ahead: number, outClosest?: Vec3): number {
    return this.oracle.hazardDistance(point, maxDist, ahead, outClosest);
  }

  groundBelow(point: Vec3, depth: number): boolean {
    return this.oracle.groundBelow(point, depth);
  }

  safeSpot(out: Vec3): boolean {
    return this.oracle.safeSpot(this.sim.time, out);
  }

  propCount(): number {
    return this.oracle.propCount();
  }

  propPosition(index: number, out: Vec3): void {
    this.oracle.propPosition(index, out);
  }
}

/** Qualified by place, then players still in by standing, then eliminated by place. */
function standingOrder(a: RulesPlayer, b: RulesPlayer): number {
  const ra = statusRank(a.status);
  const rb = statusRank(b.status);
  if (ra !== rb) return ra - rb;
  if (a.status === PlayerRoundStatus.Playing) return compareStanding(a, b);
  return a.place - b.place || a.id - b.id;
}

function statusRank(s: PlayerRoundStatusId): number {
  return s === PlayerRoundStatus.Qualified ? 0 : s === PlayerRoundStatus.Playing ? 1 : 2;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Creates a match simulation for one round.
 *
 * @param opts - Round, seed, stage, players and mode (see {@link MatchSimOptions}).
 * @param deps - Controller factory and obstacle modules (see {@link MatchDeps}).
 * @returns A sim in the LOADING phase with every player frozen at spawn.
 * @example
 * const sim = createMatchSim(
 *   { R, round, seed, stage: 0, players, mode: 'authority' },
 *   { createController: createTumblerController, obstacles: obstacleRegistry(obstacleSetA, obstacleSetB) },
 * );
 * sim.setPhase(RoundPhase.Countdown);
 * for (;;) sim.step();
 */
export function createMatchSim(opts: MatchSimOptions, deps: MatchDeps): MatchSimHandle {
  return new MatchSimImpl(opts, deps);
}
