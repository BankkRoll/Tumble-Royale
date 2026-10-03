import { Box3, PerspectiveCamera, Scene, Vector3, type Object3D } from 'three/webgpu';
import type { ThemeDefinition, Weather } from '@tumble/content/themes';
import type { CharacterStateId } from '@tumble/sim';
import type {
  CreateTumblerVisual,
  TumblerAnimInput,
  TumblerLoadout,
  TumblerVisual,
} from '../character/types.ts';
import { createEnvironment, type Environment, type EnvironmentDetail } from '../environment/environment.ts';
import type { LightingRigOptions } from '../environment/lighting.ts';
import { gradeFromTheme, type GradeParams } from '../post/pipeline.ts';
import { createPlaceholderTumbler } from './placeholderTumbler.ts';

/**
 * Shared plumbing for menu and ceremony scenes: the common scene contract, a
 * themed stage (environment + camera), and a small actor wrapper around a
 * `TumblerVisual` that owns its animation input.
 */

/** Contract every menu/ceremony scene satisfies. The integrator renders `scene` with `camera`. */
export interface MenuScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Theme grade to hand to the post pipeline (`post.setGrade(scene.grade)`). */
  readonly grade: GradeParams;
  update(dt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Options shared by every scene factory. */
export interface SceneCommonOptions {
  /** Real Tumbler factory from `@tumble/render/character`; a placeholder is used when omitted. */
  createTumbler?: CreateTumblerVisual;
  theme: ThemeDefinition;
  weather?: Weather;
  /** Environment detail (from the quality preset). */
  detail?: Partial<EnvironmentDetail>;
  lighting?: LightingRigOptions;
}

/**
 * Mirrors the `CharacterState` values scenes drive. Importing the runtime enum
 * from `@tumble/sim` would drag Rapier into the menu chunk.
 */
export const SceneState = {
  Idle: 0,
  Run: 1,
  Jump: 2,
  Fall: 3,
  Stunned: 10,
  Emote: 13,
  Finished: 14,
} as const satisfies Record<string, CharacterStateId>;

/** A Tumbler plus its reusable animation input. */
export class TumblerActor {
  readonly visual: TumblerVisual;
  readonly anim: TumblerAnimInput = {
    state: SceneState.Idle,
    stateTime: 0,
    speed: 0,
    verticalSpeed: 0,
    facing: 0,
    grounded: true,
    emote: null,
  };
  private emoteTimer = 0;

  constructor(factory: CreateTumblerVisual, loadout: TumblerLoadout) {
    this.visual = factory(loadout);
  }

  get object(): TumblerVisual['object'] {
    return this.visual.object;
  }

  /** Switches state and resets its timer. */
  setState(state: CharacterStateId): void {
    if (this.anim.state !== state) {
      this.anim.state = state;
      this.anim.stateTime = 0;
    }
  }

  /**
   * Plays an emote for `duration` seconds (null clears).
   *
   * @param emote - Emote id understood by the character module.
   */
  playEmote(emote: string | null, duration = 3): void {
    this.anim.emote = emote;
    this.emoteTimer = emote ? duration : 0;
    this.setState(emote ? SceneState.Emote : SceneState.Idle);
  }

  /** One-shot squash/stretch kick. */
  kick(amount: number): void {
    this.anim.impulse = amount;
  }

  update(dt: number): void {
    this.anim.stateTime += dt;
    if (this.emoteTimer > 0) {
      this.emoteTimer -= dt;
      if (this.emoteTimer <= 0) this.playEmote(null);
    }
    this.visual.update(dt, this.anim);
  }

  dispose(): void {
    this.visual.dispose();
  }
}

/** Resolves the injected factory or the placeholder. */
export function tumblerFactory(f?: CreateTumblerVisual): CreateTumblerVisual {
  return f ?? createPlaceholderTumbler;
}

/** A themed scene base: scene, camera, environment. */
export interface SceneStage {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly env: Environment;
  readonly grade: GradeParams;
  /** Point shadows focus on. */
  readonly focus: Vector3;
  update(dt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Builds a themed stage for a menu/ceremony scene.
 *
 * @param opts - Theme, weather, detail.
 * @param bounds - Footprint the decor should avoid.
 */
export function createSceneStage(
  opts: SceneCommonOptions,
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  extra: { crowd?: boolean; islands?: boolean; fov?: number } = {},
): SceneStage {
  const scene = new Scene();
  const camera = new PerspectiveCamera(extra.fov ?? 40, 16 / 9, 0.1, 1500);
  const env = createEnvironment(opts.theme, {
    weather: opts.weather,
    courseBounds: bounds,
    detail: { ...opts.detail, ...(extra.crowd === false ? { crowd: false } : {}) },
    lighting: opts.lighting ?? { shadows: 'single', shadowDistance: 22, mapSize: 2048 },
    islands: extra.islands,
    crowdStands: extra.crowd === false ? [] : undefined,
  });
  env.attach(scene);
  const focus = new Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  );
  return {
    scene,
    camera,
    env,
    grade: gradeFromTheme(opts.theme),
    focus,
    update(dt: number): void {
      env.update(dt, camera, focus);
    },
    resize(width: number, height: number): void {
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    },
    dispose(): void {
      env.dispose();
    },
  };
}

const headBox = new Box3();

/**
 * Height of a Tumbler's head top above its root (feet), measured from its
 * current bounds, so crowns sit correctly on any character implementation.
 *
 * @param root - The Tumbler's root object (unrotated, standing).
 * @param fallback - Used when the bounds are empty.
 */
export function measureHeadHeight(root: Object3D, fallback = 1.3): number {
  root.updateWorldMatrix(true, true);
  headBox.setFromObject(root);
  if (headBox.isEmpty()) return fallback;
  return headBox.max.y - root.getWorldPosition(scratchHead).y;
}
const scratchHead = new Vector3();
