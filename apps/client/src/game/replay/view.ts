/**
 * The replay viewer's 3D view: a regular {@link RoundView} (same level,
 * environment, obstacle visuals, Tumblers and VFX as the live round) driven
 * by a {@link ReplayRoundSource} and a {@link ReplayClock}.
 *
 * Responsibilities:
 * - builds the round from the recording with its own Tumbler pool and its
 *   own replay-only sim, at once (viewer, clips) or in time-sliced steps
 *   ({@link ReplayView.load}, the elimination replay mid-round), and disposes
 *   all of it (GPU resources included) on exit;
 * - advances the playhead, replays recorded sim events into VFX while
 *   playing forward (skipped across seeks), freezes the world while paused
 *   but keeps the camera live;
 * - camera modes: follow any player (prev/next, or locked on one), free orbit
 *   around a pannable point, and the local player's recorded live camera.
 *
 * The per-frame path reuses every object it touches.
 */
import type { PerspectiveCamera, Scene } from 'three/webgpu';
import type { GradeParams } from '@tumble/render/post';
import type { QualityPreset } from '@tumble/render/quality';
import type { CreateTumblerVisual, TumblerLoadout } from '@tumble/render/scenes';
import type { RoundDefinition } from '@tumble/shared';
import { CharacterState, type Rapier, type SimEvent } from '@tumble/sim';
import type { MatchDeps } from '@tumble/sim/match';
import type { ReplayCameraMode, ReplayCommand } from '@tumble/ui';
import { runLoadPipeline } from '../round/loadPipeline.ts';
import { TumblerPool } from '../round/playerVisuals.ts';
import { RoundView, type RoundViewOptions } from '../round/roundView.ts';
import { createPlayerSample } from '../round/source.ts';
import type { CeremonyPost } from '../views/ceremonies.ts';
import type { GameView } from '../views/types.ts';
import { ReplayClock } from './clock.ts';
import { nextCameraMode } from './controls.ts';
import { CameraModeCode } from './format.ts';
import type { RecordableCamera } from './recorder.ts';
import { ReplayRoundSource, createReplaySim } from './source.ts';
import type { ReplayTimeline } from './timeline.ts';

/** Free camera pan speed at the default zoom (m/s). */
const PAN_SPEED = 14;
const MIN_ZOOM = 3;
const MAX_ZOOM = 40;

/** Options for {@link ReplayView}. */
export interface ReplayViewOptions {
  R: Rapier;
  deps: MatchDeps;
  round: RoundDefinition;
  timeline: ReplayTimeline;
  loadouts: ReadonlyMap<number, TumblerLoadout>;
  createTumbler: CreateTumblerVisual;
  preset: QualityPreset;
  post: CeremonyPost;
  nameplates: boolean;
  streamerMode: boolean;
  reduceShake: boolean;
}

/** Snapshot of the viewer for the UI (filled in place). */
export interface ReplayViewStatus {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
  camera: ReplayCameraMode;
  /** Followed player id, or -1. */
  target: number;
}

/**
 * One open replay.
 *
 * @example
 * const view = new ReplayView({ R, deps, round, timeline, loadouts, ... });
 * director.showOverlay(view);
 * view.command({ type: 'seek', t: 30 });
 */
export class ReplayView implements GameView {
  readonly kind = 'replay';
  readonly clock: ReplayClock;
  readonly source: ReplayRoundSource;
  readonly timeline: ReplayTimeline;
  /** The recording carries the local camera. */
  readonly povAvailable: boolean;
  private readonly roundView: RoundView;
  private readonly pool: TumblerPool;
  private mode: ReplayCameraMode = 'follow';
  private target = -1;
  private readonly cam: RecordableCamera = { mode: 0, target: -1, yaw: 0, pitch: 0 };
  private povMode = -1;
  private povTarget = -2;
  private readonly sample = createPlayerSample();
  private readonly focus = { x: 0, y: 0, z: 0 };
  /** Held free-camera pan input: x right, z forward, y up (each −1..1). */
  readonly move = { x: 0, y: 0, z: 0 };
  private readonly defaultDistance: number;
  private readonly onEvent = (e: SimEvent): void => this.roundView.handleEvent(e);
  /** Never move the follow camera to someone else (scripted playback). */
  private locked = false;
  private disposed = false;

  /**
   * Builds the view in time-sliced steps, so a replay can be prepared while
   * a round is still running without a long frame.
   *
   * @param opts - View options.
   * @param isCancelled - Checked between steps; a cancelled build is disposed.
   * @returns The view, or null when cancelled.
   */
  static async load(opts: ReplayViewOptions, isCancelled: () => boolean): Promise<ReplayView | null> {
    const parts = ReplayView.parts(opts);
    const roundView = new RoundView(parts.roundOpts);
    try {
      const t = await runLoadPipeline(roundView.loadSteps(), { label: 'replay', isCancelled, log: null });
      if (t.cancelled || isCancelled()) {
        roundView.dispose();
        parts.pool.dispose();
        parts.source.dispose();
        return null;
      }
    } catch (err) {
      roundView.dispose();
      parts.pool.dispose();
      parts.source.dispose();
      throw err;
    }
    roundView.startLoops();
    return new ReplayView(opts, { ...parts, roundView });
  }

  /** Pool, replay sim and round view options for a recording (nothing built yet). */
  private static parts(opts: ReplayViewOptions): {
    pool: TumblerPool;
    source: ReplayRoundSource;
    roundOpts: RoundViewOptions;
  } {
    const tl = opts.timeline;
    const pool = new TumblerPool(opts.createTumbler);
    let source: ReplayRoundSource;
    try {
      source = new ReplayRoundSource(createReplaySim(opts.R, opts.deps, opts.round, tl), tl);
    } catch (err) {
      pool.dispose();
      throw err;
    }
    source.setTime(0);
    return {
      pool,
      source,
      roundOpts: {
        R: opts.R,
        source,
        round: opts.round,
        stage: tl.header.stage,
        seed: tl.header.seed,
        loadouts: opts.loadouts,
        pool,
        preset: opts.preset,
        // The live round (still running underneath when spectating online) owns the audio routing.
        audio: null,
        post: opts.post,
        // Ragdolls are a module-level singleton the live round view may hold.
        ragdolls: false,
        reduceShake: opts.reduceShake,
        nameplates: opts.nameplates,
        streamerMode: opts.streamerMode,
      },
    };
  }

  /**
   * @param opts - View options.
   * @param built - Parts from {@link load}; without them the view builds synchronously.
   */
  constructor(
    opts: ReplayViewOptions,
    built?: { pool: TumblerPool; source: ReplayRoundSource; roundView: RoundView },
  ) {
    const tl = opts.timeline;
    this.timeline = tl;
    this.clock = new ReplayClock(tl.duration);
    if (built) {
      this.pool = built.pool;
      this.source = built.source;
      this.roundView = built.roundView;
    } else {
      const parts = ReplayView.parts(opts);
      this.pool = parts.pool;
      this.source = parts.source;
      try {
        this.roundView = RoundView.build(parts.roundOpts);
      } catch (err) {
        this.pool.dispose();
        this.source.dispose();
        throw err;
      }
    }
    this.defaultDistance = this.roundView.rig.settings.distance;
    const c = this.source.cursor;
    this.povAvailable = tl.sampleCamera(c, this.cam);
    this.target = this.firstTarget();
    this.setCamera(this.povAvailable ? 'pov' : 'follow');
  }

  get scene(): Scene {
    return this.roundView.scene;
  }

  get camera(): PerspectiveCamera {
    return this.roundView.camera;
  }

  get grade(): GradeParams {
    return this.roundView.grade;
  }

  /** Current camera mode. */
  get cameraMode(): ReplayCameraMode {
    return this.mode;
  }

  /** Followed player id (follow / your view), or -1. */
  get targetId(): number {
    return this.mode === 'free' ? -1 : this.target;
  }

  // ---------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------

  /**
   * Applies a viewer command (UI button, key, pad).
   *
   * @param cmd - Command; `save` and `exit` are the controller's business.
   */
  command(cmd: ReplayCommand): void {
    const clock = this.clock;
    switch (cmd.type) {
      case 'toggle':
        clock.toggle();
        break;
      case 'seek':
        clock.seek(cmd.t);
        break;
      case 'seekBy':
        clock.seekBy(cmd.seconds);
        break;
      case 'speed':
        clock.setSpeed(cmd.speed);
        break;
      case 'speedStep':
        clock.stepSpeed(cmd.dir);
        break;
      case 'camera':
        this.setCamera(cmd.mode === 'next' ? nextCameraMode(this.mode, this.povAvailable) : cmd.mode);
        break;
      case 'player':
        this.cyclePlayer(cmd.dir);
        break;
      default:
        break;
    }
  }

  /**
   * Switches camera mode. "Your view" falls back to follow when the
   * recording has no camera track.
   */
  setCamera(mode: ReplayCameraMode): void {
    const m = mode === 'pov' && !this.povAvailable ? 'follow' : mode;
    if (m === 'free') {
      const rv = this.roundView;
      if (this.target < 0 || !rv.players.feetOf(this.target, this.focus)) {
        const s = rv.camera.position;
        this.focus.x = s.x;
        this.focus.y = s.y - 2;
        this.focus.z = s.z;
      }
      rv.orbitPoint(this.focus);
    } else if (m === 'follow') {
      if (this.target < 0 || !this.visible(this.target)) this.target = this.firstTarget();
      if (this.target >= 0) this.roundView.spectate(this.target);
    }
    if (m !== 'free') this.roundView.rig.settings.distance = this.defaultDistance;
    this.povMode = -1;
    this.povTarget = -2;
    this.mode = m;
  }

  /**
   * Follows the previous/next player still on the course at the playhead.
   *
   * @param dir - Direction through the entrant order.
   */
  cyclePlayer(dir: 1 | -1): void {
    const players = this.timeline.header.players;
    const n = players.length;
    if (n === 0) return;
    let i = Math.max(
      0,
      players.findIndex((p) => p.id === this.target),
    );
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      const id = (players[i] as { id: number }).id;
      if (this.visible(id)) {
        this.target = id;
        break;
      }
    }
    if (this.mode !== 'follow') this.setCamera('follow');
    else this.roundView.spectate(this.target);
  }

  /**
   * Follows one player for good: the camera stays on them even once they are
   * out (the elimination replay ends on the local player falling).
   *
   * @param id - Player to follow; unknown ids fall back to the default target.
   */
  lockFollow(id: number): void {
    this.locked = true;
    this.mode = 'follow';
    this.povMode = -1;
    this.povTarget = -2;
    this.roundView.rig.settings.distance = this.defaultDistance;
    this.target = this.timeline.slotOf(id) >= 0 ? id : this.firstTarget();
    if (this.target >= 0) this.roundView.spectate(this.target);
  }

  /** Camera look input (radians before sensitivity); ignored in "your view". */
  look(dYaw: number, dPitch: number): void {
    if (this.mode === 'pov' || (dYaw === 0 && dPitch === 0)) return;
    this.roundView.rig.addLook(dYaw, dPitch);
  }

  /**
   * Free camera zoom.
   *
   * @param steps - Positive zooms in.
   */
  zoom(steps: number): void {
    if (this.mode !== 'free' || steps === 0) return;
    const s = this.roundView.rig.settings;
    s.distance = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.distance * Math.pow(0.88, steps)));
  }

  /**
   * Fills the UI status.
   *
   * @param out - Reused status object.
   */
  status(out: ReplayViewStatus): ReplayViewStatus {
    const c = this.clock;
    out.time = c.time;
    out.duration = c.duration;
    out.playing = c.playing;
    out.speed = c.speed;
    out.camera = this.mode;
    out.target = this.targetId;
    return out;
  }

  /**
   * Accessibility toggles that apply while watching.
   */
  setAccessibility(reduceShake: boolean, nameplates: boolean, streamer: boolean): void {
    this.roundView.setAccessibility(reduceShake, nameplates, streamer);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** True when the player is on the course (present, not out) at the playhead. */
  private visible(id: number): boolean {
    const tl = this.timeline;
    if (!tl.samplePlayer(tl.slotOf(id), this.source.cursor, this.sample)) return false;
    const st = this.sample.state;
    return st !== CharacterState.Eliminated && st !== CharacterState.Spectating;
  }

  private firstTarget(): number {
    const local = this.timeline.header.localId;
    if (local >= 0 && this.visible(local)) return local;
    for (const p of this.timeline.header.players) if (this.visible(p.id)) return p.id;
    return local >= 0 ? local : (this.timeline.header.players[0]?.id ?? -1);
  }

  private applyPov(): void {
    const tl = this.timeline;
    const rv = this.roundView;
    const cam = this.cam;
    if (!tl.sampleCamera(this.source.cursor, cam)) return;
    if (cam.mode !== this.povMode || cam.target !== this.povTarget) {
      this.povMode = cam.mode;
      this.povTarget = cam.target;
      if (cam.mode === CameraModeCode.Celebrate) rv.celebrate();
      else if (cam.mode === CameraModeCode.Spectate && cam.target >= 0) rv.spectate(cam.target);
      else rv.followLocal();
      this.target = cam.mode === CameraModeCode.Spectate ? cam.target : tl.header.localId;
    }
    if (cam.mode !== CameraModeCode.Celebrate) {
      rv.rig.yaw = cam.yaw;
      rv.rig.pitch = cam.pitch;
    }
  }

  private applyFree(dt: number): void {
    const m = this.move;
    if (m.x !== 0 || m.y !== 0 || m.z !== 0) {
      const rig = this.roundView.rig;
      const speed = PAN_SPEED * (rig.settings.distance / this.defaultDistance) * dt;
      const sy = Math.sin(rig.yaw);
      const cy = Math.cos(rig.yaw);
      // Camera forward on the ground plane is (sin yaw, cos yaw); right is its clockwise perpendicular.
      this.focus.x += (sy * m.z - cy * m.x) * speed;
      this.focus.z += (cy * m.z + sy * m.x) * speed;
      this.focus.y += m.y * speed;
    }
    this.roundView.orbitPoint(this.focus);
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(_dt: number, realDt: number): void {
    if (this.disposed) return;
    const clock = this.clock;
    const before = clock.time;
    clock.advance(realDt);
    const jumped = clock.consumeJump();
    this.source.setTime(clock.time);
    if (!jumped && clock.time > before) this.timeline.forEachEvent(before, clock.time, this.onEvent);

    if (this.mode === 'pov') this.applyPov();
    else if (this.mode === 'free') this.applyFree(realDt);
    else if (!this.locked && this.target >= 0 && !this.visible(this.target) && clock.playing) {
      // The followed player just went out: move on to someone still running.
      const next = this.firstTarget();
      if (next !== this.target && next >= 0) {
        this.target = next;
        this.roundView.spectate(next);
      }
    }

    const worldDt = clock.playing ? realDt * clock.speed : 0;
    this.roundView.cameraDt = realDt;
    this.roundView.update(worldDt);
    // A seek teleports the target; cut instead of swinging the camera across the course.
    if (jumped && this.mode !== 'free') this.roundView.snapCamera();
  }

  resize(width: number, height: number): void {
    this.roundView.resize(width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.roundView.dispose();
    this.pool.dispose();
    this.source.dispose();
  }
}
