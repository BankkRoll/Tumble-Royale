/**
 * Main menu 3D view: the themed floating platform with the player's Tumbler
 * (live loadout), party slots and drifting camera, plus "idle play": click the
 * platform and run, jump and dive around it with the real Tumbler controller.
 */
import { Vector3, type Object3D } from 'three/webgpu';
import { getTheme } from '@tumble/content/themes';
import type { QualityPreset } from '@tumble/render/quality';
import {
  createMainMenuStage,
  type CreateTumblerVisual,
  type MainMenuStage,
  type TumblerLoadout,
  type TumblerVisual,
} from '@tumble/render/scenes';
import { InteractionGroups, SIM_DT } from '@tumble/shared';
import {
  EventSink,
  FixedStepper,
  SurfaceRegistry,
  createWorld,
  type Rapier,
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
import { sceneOptions } from './common.ts';
import type { GameView } from './types.ts';

const FALL_RESET_Y = -8;

/** Real-physics idle play on the menu platform. */
class IdlePlay {
  readonly world: World;
  readonly ctrl: TumblerController;
  private readonly ctx: CharacterStepContext;
  private readonly stepper: FixedStepper;
  private readonly input: CharacterInput = emptyInput();
  private readonly feet = { x: 0, y: 0, z: 0 };
  private readonly vel = { x: 0, y: 0, z: 0 };
  yaw = Math.PI;

  constructor(
    private readonly R: Rapier,
    radius: number,
    private readonly inputSystem: InputSystem,
    private readonly audio: GameAudio | null,
  ) {
    this.world = createWorld(R);
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(R.ColliderDesc.cylinder(0.5, radius).setFriction(0.9).setCollisionGroups(InteractionGroups.static), body);
    this.ctrl = new TumblerController({ R, world: this.world, id: 0, position: { x: 0, y: 0.05, z: 0 }, yaw: 0 });
    const events = new EventSink();
    this.ctx = {
      R,
      world: this.world,
      dt: SIM_DT,
      tick: 0,
      time: 0,
      surfaces: new SurfaceRegistry(),
      events,
      controllerByCollider: (h) => (h === this.ctrl.collider.handle ? this.ctrl : undefined),
    };
    this.stepper = new FixedStepper((tick) => this.step(tick));
  }

  private step(tick: number): void {
    this.ctx.tick = tick;
    this.ctx.time = tick * SIM_DT;
    this.inputSystem.sample(this.yaw, this.input);
    this.ctrl.step(this.input, this.ctx);
    this.world.step();
    this.ctrl.postStep(this.ctx);
    const evs = this.ctx.events.events;
    if (this.audio) for (const e of evs) this.audio.handleSimEvent(e);
    evs.length = 0;
    if (this.ctrl.body.translation().y < FALL_RESET_Y) this.ctrl.teleport({ x: 0, y: 1.5, z: 0 });
  }

  advance(dt: number): void {
    this.stepper.advance(dt);
  }

  /** Feet position, velocity and anim fields for the visual. */
  sample(): { feet: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } {
    this.ctrl.getFeet(this.feet);
    this.ctrl.getVelocity(this.vel);
    return { feet: this.feet, vel: this.vel };
  }

  reset(): void {
    this.ctrl.teleport({ x: 0, y: 0.05, z: 0 }, 0);
  }

  dispose(): void {
    this.ctrl.dispose();
    this.world.free();
  }
}

/** Options for {@link MenuView}. */
export interface MenuViewOptions {
  R: Rapier;
  preset: QualityPreset;
  createTumbler: CreateTumblerVisual;
  loadout: TumblerLoadout;
  input: InputSystem;
  audio: GameAudio | null;
}

/**
 * The menu's 3D lobby.
 *
 * @example
 * const menu = new MenuView({ R, preset, createTumbler, loadout, input, audio });
 * director.show(menu);
 * menu.setLoadout(profile.tumblerLoadout());
 */
export class MenuView implements GameView {
  readonly kind = 'menu';
  readonly stage: MainMenuStage;
  private readonly idle: IdlePlay;
  private readonly visual: TumblerVisual;
  private readonly stageTumbler: Object3D | null;
  private playing = false;
  private loadout: TumblerLoadout;
  private emoteTime = 0;
  private emoteId: string | null = null;
  private readonly camDir = new Vector3();
  private readonly camTarget = new Vector3();

  constructor(private readonly opts: MenuViewOptions) {
    this.loadout = opts.loadout;
    this.stage = createMainMenuStage({ ...sceneOptions(getTheme('candy'), opts.preset, opts.createTumbler), player: opts.loadout, party: [] });
    this.idle = new IdlePlay(opts.R, this.stage.platformRadius + 0.6, opts.input, opts.audio);
    this.visual = opts.createTumbler(opts.loadout);
    this.visual.object.visible = false;
    // HACK: MainMenuStage keeps its Tumbler actor private; idle play needs a
    // physics-driven animation input, so we swap in our own visual and hide the
    // stage's one (always the holder's first child).
    this.stageTumbler = this.stage.playerObject.children[0] ?? null;
    this.stage.playerObject.add(this.visual.object);
  }

  get scene(): GameView['scene'] {
    return this.stage.scene;
  }

  get camera(): GameView['camera'] {
    return this.stage.camera;
  }

  get grade(): GameView['grade'] {
    return this.stage.grade;
  }

  /** True while the player is running around the platform. */
  get idlePlaying(): boolean {
    return this.playing;
  }

  /** Updates the Tumbler's look (locker equips, welcome colours). */
  setLoadout(l: TumblerLoadout): void {
    this.loadout = l;
    this.stage.setPlayerLoadout(l);
    this.visual.setLoadout(l);
  }

  /** Plays an emote on the lobby Tumbler. */
  emote(id: string): void {
    if (this.playing) {
      this.emoteId = id;
      this.emoteTime = 2.5;
    } else this.stage.playEmote(0, id, 2.6);
  }

  /** Enters/leaves idle play. */
  setIdlePlay(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    this.stage.setPlayable(on);
    this.visual.object.visible = on;
    if (this.stageTumbler) this.stageTumbler.visible = !on;
    if (on) this.idle.reset();
  }

  update(dt: number, realDt: number): void {
    if (this.playing) {
      this.camera.getWorldDirection(this.camDir);
      this.idle.yaw = Math.atan2(this.camDir.x, this.camDir.z);
      this.idle.advance(realDt);
      const { feet, vel } = this.idle.sample();
      this.stage.playerObject.position.set(feet.x, feet.y, feet.z);
      const c = this.idle.ctrl;
      if (this.emoteTime > 0) this.emoteTime -= realDt;
      const slot = c.emote;
      const emote = c.state === CharacterState.Emote && slot > 0 ? (this.loadout.emotes[slot - 1] ?? null) : this.emoteTime > 0 ? this.emoteId : null;
      this.visual.update(realDt, {
        state: c.state,
        stateTime: c.stateTime,
        speed: Math.hypot(vel.x, vel.z),
        verticalSpeed: vel.y,
        facing: c.facing,
        grounded: c.grounded,
        emote,
        lookAt: this.camera.getWorldPosition(this.camTarget),
      });
    }
    this.stage.update(dt);
  }

  resize(width: number, height: number): void {
    this.stage.resize(width, height);
  }

  dispose(): void {
    this.visual.dispose();
    this.idle.dispose();
    this.stage.dispose();
  }
}
