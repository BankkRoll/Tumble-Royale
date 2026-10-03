/**
 * The in-round 3D view: level, themed environment + weather, obstacle visuals
 * (posed from match time, fed their runtime for non-pure state), every
 * Tumbler, VFX, cosmetic ragdolls and the gameplay camera (intro flyover,
 * follow with collision against the level, celebration orbit, spectate).
 *
 * Built behind the loading screen in time-sliced steps ({@link RoundView.loadSteps})
 * and disposed in full when the next view replaces it.
 */
import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three/webgpu';
import type { GameAudio, LoopEmitter } from '@tumble/audio';
import { getTheme, type ThemeDefinition, type Weather } from '@tumble/content/themes';
import { MeshBatcher } from '@tumble/render/batching';
import { RagdollManager, RagdollWorld } from '@tumble/render/character';
import { ThirdPersonCamera, type CameraFollowTarget, type CameraVec3 } from '@tumble/render/camera';
import { createEnvironment, type Environment } from '@tumble/render/environment';
import { buildLevelVisuals, quaternionFromRotation, type LevelVisuals } from '@tumble/render/level';
import { getObstacleVisual, type ObstacleVisual } from '@tumble/render/obstacles';
import { gradeFromTheme, type GradeParams } from '@tumble/render/post';
import type { QualityPreset } from '@tumble/render/quality';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { createVfxSystem, type VfxSystem } from '@tumble/render/vfx';
import { CollisionGroup, InteractionGroups, groups, type RoundDefinition } from '@tumble/shared';
import type { ObstacleRuntime, Rapier, SimEvent } from '@tumble/sim';
import type { CeremonyPost } from '../views/ceremonies.ts';
import type { GameView } from '../views/types.ts';
import { runLoadStepsSync, type LoadStep } from './loadPipeline.ts';
import { PlayerVisuals, type TumblerPool } from './playerVisuals.ts';
import type { RoundSource } from './source.ts';

/** Rapier query filter flag: skip sensor colliders (triggers). */
const EXCLUDE_SENSORS = 8;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** Camera behaviours the round flow switches between. */
export type RoundCameraMode = 'flyover' | 'follow' | 'celebrate' | 'spectate';

/** Options for {@link RoundView}. */
export interface RoundViewOptions {
  R: Rapier;
  source: RoundSource;
  round: RoundDefinition;
  /** Show stage (obstacle speed scale index). */
  stage: number;
  /** Show seed (seeded obstacle layouts must match the sim). */
  seed: number;
  loadouts: ReadonlyMap<number, TumblerLoadout>;
  pool: TumblerPool;
  preset: QualityPreset;
  audio: GameAudio | null;
  post: CeremonyPost;
  /** Real Tumblers support cosmetic ragdolls; the placeholder does not. */
  ragdolls: boolean;
  reduceShake: boolean;
  nameplates: boolean;
  streamerMode: boolean;
  /** BOT chip on bots' nameplates. */
  botTags?: boolean;
}

/** Weather for a round: the seeded variation's, else the theme default. */
function roundWeather(round: RoundDefinition, variationId: string | null, theme: ThemeDefinition): Weather {
  const v = variationId ? round.variations.find((x) => x.id === variationId) : undefined;
  return v && v.weather !== 'clear' ? v.weather : theme.weather.default;
}

/** One round on screen. */
export class RoundView implements GameView {
  readonly kind = 'round';
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1600);
  readonly grade: GradeParams;
  readonly theme: ThemeDefinition;
  // Assigned by the load steps; nothing outside sees the view before they all ran.
  private rigRef: ThirdPersonCamera | undefined;
  private playersRef: PlayerVisuals | undefined;
  private vfxRef: VfxSystem | undefined;
  private level: LevelVisuals | undefined;
  private env: Environment | undefined;
  private readonly obstacles: { visual: ObstacleVisual; runtime: ObstacleRuntime }[] = [];
  /** Instances render-identical obstacle parts across the whole course (hundreds of draws → dozens). */
  private readonly batcher = new MeshBatcher();
  private readonly loops: LoopEmitter[] = [];
  private loopsStarted = false;
  private ragdollMgr: RagdollManager | null = null;
  private ragdollWorld: RagdollWorld | null = null;
  private mode: RoundCameraMode = 'follow';
  private targetId: number;
  private flyoverDone: (() => void) | null = null;
  private readonly follow: CameraFollowTarget = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  };
  private readonly focus = new Vector3();
  private readonly camPos = new Vector3();
  private readonly ray: InstanceType<Rapier['Ray']>;
  private readonly camBall: InstanceType<Rapier['Ball']>;
  private readonly camGroups = groups(0xffff, CollisionGroup.Static | CollisionGroup.KinematicObstacle);
  private readonly obstaclePos = new Map<string, CameraVec3>();
  private disposed = false;
  /**
   * Overrides the camera rig's frame delta. Replays freeze the world while
   * paused (dt 0) but keep the camera live.
   */
  cameraDt: number | null = null;

  /**
   * Cheap setup only. Call {@link loadSteps} (time-sliced) or {@link build}
   * (all at once) before showing the view.
   */
  constructor(private readonly opts: RoundViewOptions) {
    const { round, source, R } = opts;
    this.theme = getTheme(round.theme);
    this.grade = gradeFromTheme(this.theme);
    this.targetId = source.localId;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.camBall = new R.Ball(0.2);
  }

  /** Builds a view synchronously (flows that need it in the same call). */
  static build(opts: RoundViewOptions): RoundView {
    const view = new RoundView(opts);
    runLoadStepsSync(view.loadSteps());
    view.startLoops();
    return view;
  }

  /** Gameplay camera rig. */
  get rig(): ThirdPersonCamera {
    return this.rigRef as ThirdPersonCamera;
  }

  /** Every entrant's Tumbler. */
  get players(): PlayerVisuals {
    return this.playersRef as PlayerVisuals;
  }

  /** Round VFX. */
  get vfx(): VfxSystem {
    return this.vfxRef as VfxSystem;
  }

  /**
   * The view's construction, split where the main thread may pause. Weights
   * are estimated relative costs for the progress bar (obstacles and the
   * first round's Tumblers are expected to dominate); retune them from
   * `window.__tumble.loadTimings`.
   *
   * @returns Steps for {@link runLoadPipeline}, in order.
   */
  loadSteps(): LoadStep[] {
    const { round, source, preset, R } = this.opts;
    return [
      {
        name: 'level',
        weight: 3,
        run: () => {
          this.level = buildLevelVisuals(round, this.theme, { detail: preset.geometryDetail });
          this.scene.add(this.level.object);
        },
      },
      {
        name: 'environment',
        weight: 3,
        run: () => {
          const level = this.level as LevelVisuals;
          const b = level.bounds;
          const env = createEnvironment(this.theme, {
            weather: roundWeather(round, source.sim.variationId, this.theme),
            courseBounds: Number.isFinite(b.min.x) ? { min: b.min, max: b.max } : round.bounds,
            seed: round.decorSeed,
            detail: preset.environment,
            lighting: {
              shadows: preset.shadows,
              mapSize: preset.shadowMapSize,
              cascades: preset.cascades,
              shadowDistance: preset.shadowDistance,
            },
          });
          this.env = env;
          env.attach(this.scene);
          env.onAtmosphere = (a) => level.setNight(a.night);
          level.setNight(env.atmosphere.night);
        },
      },
      {
        name: 'vfx',
        weight: 1,
        run: () => {
          this.vfxRef = createVfxSystem({
            budget: preset.vfx,
            groundProbe: (x, y, z, out) => this.probe(x, y, z, out),
            voidStyle: this.theme.void.style,
          });
          this.scene.add(this.vfxRef.object);
        },
      },
      { name: 'obstacles', weight: 5, run: () => this.buildObstacles() },
      {
        name: 'batching',
        weight: 1,
        run: () => {
          for (const o of this.obstacles) this.batcher.add(o.visual.object);
          this.batcher.build();
          this.scene.add(this.batcher.object);
        },
      },
      { name: 'tumblers', weight: 4, run: () => this.warmTumblers() },
      {
        name: 'players',
        weight: 1,
        run: () => {
          this.playersRef = new PlayerVisuals(source, {
            parent: this.scene,
            pool: this.opts.pool,
            loadouts: this.opts.loadouts,
            vfx: this.vfx,
            preset,
            audio: this.opts.audio,
            nameplates: this.opts.nameplates,
            streamerMode: this.opts.streamerMode,
            ...(this.opts.botTags !== undefined ? { botTags: this.opts.botTags } : {}),
          });
        },
      },
      {
        name: 'camera',
        weight: 1,
        run: () => {
          this.rigRef = new ThirdPersonCamera(this.camera, {
            yaw: round.spawn.yaw,
            collide: (o, d, max) => this.collide(o, d, max),
            settings: { shakeScale: this.opts.reduceShake ? 0 : 1 },
          });
          this.placeAtSpawn();
          this.hookAudio();
        },
      },
      {
        name: 'ragdolls',
        weight: 1,
        run: () => (this.opts.ragdolls && preset.maxRagdolls > 0 ? this.buildRagdolls(R) : undefined),
      },
    ];
  }

  private *buildObstacles(): Generator<number> {
    const { round, source, stage, seed } = this.opts;
    const scales = round.speedScaleByStage;
    const speedScale = scales.length > 0 ? (scales[Math.max(0, Math.min(stage, scales.length - 1))] ?? 1) : 1;
    const runtimes = source.sim.obstacleRuntimes;
    let i = 0;
    for (const runtime of runtimes) {
      const inst = runtime.instance;
      this.obstaclePos.set(inst.id, inst.position);
      const factory = getObstacleVisual(inst.type);
      if (factory) {
        try {
          const visual = factory(inst, { theme: round.theme, speedScale, seed });
          this.scene.add(visual.object);
          this.obstacles.push({ visual, runtime });
        } catch (err) {
          console.warn(`[round] obstacle visual ${inst.id} (${inst.type}) failed`, err);
        }
      }
      // Created now, started on reveal: a 60 s wait for other players must stay silent.
      const loop = this.opts.audio?.createObstacleLoop(inst.type, inst.position);
      if (loop) this.loops.push(loop);
      yield ++i / Math.max(1, runtimes.length);
    }
  }

  /**
   * Builds (first round) or re-skins (later rounds) every entrant's pooled
   * Tumbler one at a time, so {@link PlayerVisuals} only has to place them.
   */
  private *warmTumblers(): Generator<number> {
    const players = this.opts.source.players;
    let i = 0;
    for (const info of players) {
      const loadout = this.opts.loadouts.get(info.id);
      if (loadout) this.opts.pool.get(info.id, loadout).setLoadout(loadout);
      yield ++i / Math.max(1, players.length);
    }
  }

  private *buildRagdolls(R: Rapier): Generator<number> {
    const world = new RagdollWorld(R);
    this.ragdollWorld = world;
    const q = new Quaternion();
    const pieces = this.opts.round.geometry;
    let i = 0;
    for (const piece of pieces) {
      i++;
      if (piece.decorative || (piece.shape !== 'box' && piece.shape !== 'ramp')) continue;
      quaternionFromRotation(piece.rotation, q);
      world.addBox(
        new Vector3(piece.position.x, piece.position.y, piece.position.z),
        new Vector3(piece.size.x / 2, piece.size.y / 2, piece.size.z / 2),
        q,
      );
      yield i / Math.max(1, pieces.length);
    }
    this.ragdollMgr = new RagdollManager(world, this.opts.preset.maxRagdolls).install();
  }

  private hookAudio(): void {
    const { audio, source } = this.opts;
    if (!audio) return;
    const feet = { x: 0, y: 0, z: 0 };
    audio.setPlayerPositionResolver((id) => (this.players.feetOf(id, feet) ? feet : undefined));
    audio.setObstacleResolver((id) => {
      const rt = source.sim.obstacle(id);
      return rt ? { type: rt.instance.type, pos: rt.instance.position } : undefined;
    });
  }

  /** Starts the obstacle sound loops (once, when the round is revealed). */
  startLoops(): void {
    if (this.loopsStarted || this.disposed) return;
    this.loopsStarted = true;
    for (const l of this.loops) l.start();
  }

  // ---------------------------------------------------------------------------
  // Physics queries (only while the sim is alive)
  // ---------------------------------------------------------------------------

  private probe(
    x: number,
    y: number,
    z: number,
    out: { y: number; nx: number; ny: number; nz: number },
  ): boolean {
    const src = this.opts.source;
    if (!src.alive) return false;
    this.ray.origin.x = x;
    this.ray.origin.y = y;
    this.ray.origin.z = z;
    const hit = src.sim.world.castRayAndGetNormal(
      this.ray,
      40,
      true,
      EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
    );
    if (!hit) return false;
    out.y = y - hit.timeOfImpact;
    out.nx = hit.normal.x;
    out.ny = hit.normal.y;
    out.nz = hit.normal.z;
    return true;
  }

  private collide(o: CameraVec3, d: CameraVec3, max: number): number {
    const src = this.opts.source;
    if (!src.alive) return max;
    const hit = src.sim.world.castShape(
      o,
      IDENTITY,
      d,
      this.camBall,
      0,
      max,
      false,
      EXCLUDE_SENSORS,
      this.camGroups,
    );
    return hit ? hit.time_of_impact : max;
  }

  // ---------------------------------------------------------------------------
  // Camera control
  // ---------------------------------------------------------------------------

  /** Current camera behaviour. */
  get cameraMode(): RoundCameraMode {
    return this.mode;
  }

  /** Player the camera follows (local, spectated or celebrated). */
  get cameraTarget(): number {
    return this.targetId;
  }

  private placeAtSpawn(): void {
    const s = this.opts.round.spawn.origin;
    this.follow.position.x = s.x;
    this.follow.position.y = s.y;
    this.follow.position.z = s.z;
    this.rig.yaw = this.opts.round.spawn.yaw;
    this.rig.snapTo(this.follow);
  }

  /**
   * Plays the round's authored intro flyover.
   *
   * @param onDone - Called when the path finishes (or is skipped).
   */
  playFlyover(onDone?: () => void): void {
    const f = this.opts.round.flyover;
    this.mode = 'flyover';
    this.flyoverDone = onDone ?? null;
    const done = (): void => {
      const cb = this.flyoverDone;
      this.flyoverDone = null;
      cb?.();
    };
    let points = f.path;
    if (points.length < 2) {
      const o = this.opts.round.spawn.origin;
      points = [
        { x: o.x - 18, y: o.y + 14, z: o.z - 12 },
        { x: o.x + 18, y: o.y + 10, z: o.z + 12 },
      ];
    }
    this.rig.playFlyover({
      points,
      lookAts: f.lookAt.length ? f.lookAt : [this.opts.round.spawn.origin],
      duration: Math.max(1, f.duration),
      then: 'orbit',
      onDone: done,
    });
  }

  /** Cuts from the flyover to behind the local player at the start gate. */
  settleBehindPlayer(): void {
    if (this.mode === 'flyover') this.rig.skipFlyover();
    this.flyoverDone = null;
    this.mode = 'follow';
    this.targetId = this.opts.source.localId;
    this.rig.setMode('orbit');
    this.rig.yaw = this.opts.round.spawn.yaw;
    this.rig.pitch = this.rig.settings.defaultPitch;
    if (this.targetId >= 0 && this.players.feetOf(this.targetId, this.follow.position))
      this.rig.snapTo(this.follow);
    else this.placeAtSpawn();
  }

  /** Follows the local player (gameplay). */
  followLocal(): void {
    this.mode = 'follow';
    this.targetId = this.opts.source.localId;
    this.rig.setMode('orbit');
  }

  /** Orbits the local player (qualified celebration). */
  celebrate(): void {
    this.mode = 'celebrate';
    this.targetId = this.opts.source.localId;
    this.rig.setMode('orbitAround');
  }

  /**
   * Spectates a player.
   *
   * @param id - Player to follow.
   */
  spectate(id: number): void {
    const changed = id !== this.targetId || this.mode !== 'spectate';
    this.mode = 'spectate';
    this.targetId = id;
    this.rig.setMode('spectate');
    if (changed && this.players.feetOf(id, this.follow.position)) this.rig.snapTo(this.follow);
  }

  /** Cuts the camera to its current target (after a replay seek teleports everyone). */
  snapCamera(): void {
    if (this.targetId >= 0 && this.players.feetOf(this.targetId, this.follow.position))
      this.rig.snapTo(this.follow);
  }

  /**
   * Detaches the camera from players and orbits a free point (replay free
   * camera). Call every frame the point moves.
   *
   * @param p - World-space focus.
   */
  orbitPoint(p: CameraVec3): void {
    if (this.mode !== 'spectate' || this.targetId !== -1) {
      this.mode = 'spectate';
      this.targetId = -1;
      this.rig.setMode('spectate');
    }
    this.follow.position.x = p.x;
    this.follow.position.y = p.y;
    this.follow.position.z = p.z;
    this.follow.velocity.x = 0;
    this.follow.velocity.y = 0;
    this.follow.velocity.z = 0;
    this.follow.grounded = true;
    this.focus.set(p.x, p.y, p.z);
  }

  /** Adds camera shake (no-op with Reduce Shake). */
  shake(amount: number): void {
    this.rig.addTrauma(amount);
  }

  /** Accessibility toggles that apply mid-round. */
  setAccessibility(reduceShake: boolean, nameplates: boolean, streamer: boolean): void {
    this.rig.settings.shakeScale = reduceShake ? 0 : 1;
    this.players.setNameplates(nameplates, streamer);
  }

  /** Shows or hides the BOT chip on bots' nameplates mid-round. */
  setBotTags(on: boolean): void {
    this.players.setBotTags(on);
  }

  /** Quality tier changed mid-round (LOD distances, budgets). */
  setPreset(p: QualityPreset): void {
    this.players.setPreset(p);
    this.vfx.setBudget(p.vfx);
    if (this.ragdollMgr) this.ragdollMgr.maxActive = p.maxRagdolls;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Routes one sim event to VFX, squash/stretch and camera feedback.
   *
   * @param e - Event from the sim (or the server).
   */
  handleEvent(e: SimEvent): void {
    if (this.disposed) return;
    this.vfx.handleSimEvent(e);
    const local = 'player' in e && e.player === this.opts.source.localId;
    switch (e.type) {
      case 'jump':
        this.players.kick(e.player, 0.32);
        break;
      case 'land':
        this.players.kick(e.player, -Math.min(0.45, e.impact * 0.028));
        if (local && e.impact > 16) this.rig.addTrauma(0.18);
        break;
      case 'dive':
        this.players.kick(e.player, 0.15);
        if (local) this.rig.kickFov(7);
        break;
      case 'bounce':
        this.players.kick(e.player, 0.5);
        if (local) this.rig.kickFov(5);
        break;
      case 'stun':
        if (local) {
          this.rig.addTrauma(0.45 + Math.min(0.3, e.strength * 0.015));
          this.opts.post.punch(0.35);
        }
        break;
      case 'respawn':
        if (local && this.mode === 'follow') {
          this.follow.position.x = e.pos.x;
          this.follow.position.y = e.pos.y;
          this.follow.position.z = e.pos.z;
          this.rig.snapTo(this.follow);
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    const src = this.opts.source;
    const level = this.level as LevelVisuals;
    this.players.update(dt, this.camera);

    const t = src.renderTime();
    if (src.alive) {
      for (const o of this.obstacles) o.visual.update(t, dt, o.runtime);
    }
    level.update(t, dt);

    if (this.targetId >= 0 && this.players.followTarget(this.targetId, this.follow)) {
      const p = this.follow.position;
      this.focus.set(p.x, p.y, p.z);
    }
    this.rig.update(this.cameraDt ?? dt, this.follow);

    this.camera.getWorldPosition(this.camPos);
    this.ragdollMgr?.update(dt, this.camPos);
    this.vfx.update(dt, this.camera);
    (this.env as Environment).update(dt, this.camera, this.focus);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.opts.audio) {
      this.opts.audio.setPlayerPositionResolver(null);
      this.opts.audio.setObstacleResolver(null);
    }
    for (const l of this.loops) l.dispose();
    this.loops.length = 0;
    // A build cancelled halfway leaves later parts unset.
    this.ragdollMgr?.uninstall();
    this.ragdollWorld?.dispose();
    this.playersRef?.dispose();
    this.batcher.dispose();
    for (const o of this.obstacles) o.visual.dispose();
    this.obstacles.length = 0;
    this.vfxRef?.dispose();
    this.level?.dispose();
    this.env?.dispose();
    this.scene.clear();
  }
}
