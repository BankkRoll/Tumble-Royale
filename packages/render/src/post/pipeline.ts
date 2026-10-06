import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  NeutralToneMapping,
  RenderPipeline,
  Vector3,
  type Camera,
  type Node,
  type Object3D,
  type Scene,
  type ToneMapping,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  colorToDirection,
  directionToColor,
  dot,
  emissive,
  float,
  length,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  perspectiveDepthToViewZ,
  pow,
  renderOutput,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom, type default as BloomNode } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import type { ThemeDefinition } from '@tumble/content/themes';
import { beginSceneWarmUp, waitForGpuIdle, type SceneWarmUp } from './warmUp.ts';

/**
 * Tiered TSL post-processing stack:
 *
 *   scene pass (+ normals MRT when outlines are on)
 *   → hit chromatic punch (3 offset taps of the scene texture)
 *   → selective bloom: the scene pass writes an `emissive` MRT target and only
 *     that buffer blooms, so bright pastel surfaces never haze the image
 *   → screen-space edge outline (depth + normal discontinuities; High/Ultra)
 *   → exposure → tone mapping + sRGB (`renderOutput`)
 *   → lift/gamma/gain, saturation, contrast, photo filter, vignette, flash
 *   → FXAA or SMAA (on display-referred colour, as both algorithms expect).
 *
 * Grading runs after tone mapping so per-theme params behave like a LUT authored
 * on the final image. Every knob is a uniform, so theme switches and hit punches
 * never rebuild shaders; only structural toggles (AA mode, bloom on/off,
 * outline on/off) rebuild the graph.
 */

/** Tone mapping operator. Neutral keeps candy pastels saturated where ACES would grey them. */
export type ToneMappingMode = 'neutral' | 'aces' | 'agx';

const TONE_MAPPINGS: Record<ToneMappingMode, ToneMapping> = {
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
};

/** Anti-aliasing mode. */
export type AntiAliasMode = 'none' | 'fxaa' | 'smaa';

/** Structural post settings (changing these rebuilds the node graph). */
export interface PostSettings {
  /** Master switch; false renders straight to the canvas with renderer tone mapping. */
  enabled: boolean;
  aa: AntiAliasMode;
  bloom: boolean;
  /** Screen-space edge outline on level geometry. */
  outline: boolean;
  /** Chromatic punch on hits. */
  chromatic: boolean;
  /** Scene pass resolution scale (adaptive resolution writes this). */
  resolutionScale: number;
  /** Tone mapping operator. Default neutral. */
  toneMapping?: ToneMappingMode;
}

/** Per-theme colour grade (all uniforms). */
export interface GradeParams {
  exposure: number;
  saturation: number;
  contrast: number;
  lift: readonly [number, number, number];
  gamma: readonly [number, number, number];
  gain: readonly [number, number, number];
  vignette: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
}

/** Photo-mode / ceremony filters. */
export type PhotoFilter = 'none' | 'vivid' | 'dream' | 'mono' | 'sepia' | 'noir' | 'pop';

/** Every photo filter id, for UIs. */
export const PHOTO_FILTERS: readonly PhotoFilter[] = [
  'none',
  'vivid',
  'dream',
  'mono',
  'sepia',
  'noir',
  'pop',
];

/** Default settings (Medium). */
export const DEFAULT_POST_SETTINGS: PostSettings = {
  enabled: true,
  aa: 'fxaa',
  bloom: true,
  outline: false,
  chromatic: true,
  resolutionScale: 1,
  toneMapping: 'neutral',
};

/** Neutral grade. */
export const NEUTRAL_GRADE: GradeParams = {
  exposure: 1,
  saturation: 1,
  contrast: 1,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  vignette: 0.25,
  bloomStrength: 0.35,
  bloomThreshold: 0.9,
  bloomRadius: 0.45,
};

/**
 * Extracts grade params from a theme.
 *
 * @param theme - Theme definition.
 */
export function gradeFromTheme(theme: ThemeDefinition): GradeParams {
  const g = theme.grade;
  return {
    exposure: g.exposure,
    saturation: g.saturation,
    contrast: g.contrast,
    lift: g.lift,
    gamma: g.gamma,
    gain: g.gain,
    vignette: g.vignette,
    bloomStrength: theme.bloom.strength,
    bloomThreshold: theme.bloom.threshold,
    bloomRadius: theme.bloom.radius,
  };
}

/** Live post pipeline. */
export interface PostPipeline {
  readonly settings: Readonly<PostSettings>;
  /** Render one frame (post or direct). */
  render(): void;
  /** Swap scene/camera (menu scene switches) without losing settings. */
  setView(scene: Scene, camera: Camera): void;
  /**
   * Starts warming the current view up for display: renders it a few objects
   * at a time with every missing render pipeline (scene pass with its MRT
   * targets, shadow maps, bloom, outline, AA) compiled asynchronously. The
   * view must stay hidden until the warm-up finished and settled.
   *
   * @param budgetMs - Target main-thread time per {@link SceneWarmUp.next}.
   * @param paceFirstDraws - Also budget each render pipeline's first draw (see `SceneWarmUpOptions.paceFirstDraws`).
   */
  beginWarmUp(budgetMs?: number, paceFirstDraws?: boolean): SceneWarmUp;
  /** Resolves once the GPU executed everything submitted so far (see {@link waitForGpuIdle}). */
  gpuIdle(): Promise<void>;
  setSettings(patch: Partial<PostSettings>): void;
  /** Applies a grade instantly. */
  setGrade(grade: GradeParams): void;
  /** Applies a photo filter on top of the grade. */
  setFilter(filter: PhotoFilter): void;
  /** Triggers the chromatic hit punch; decays over ~0.35 s. */
  punch(strength?: number): void;
  /** Full-screen white flash (lightning, crown grab); decays over ~0.4 s. */
  flash(strength?: number): void;
  /** Extra vignette (0..1) for focus moments (player wall spotlight). */
  setFocusVignette(amount: number): void;
  /** Decays punch/flash. Call once per frame. */
  update(dt: number): void;
  dispose(): void;
}

interface FilterParams {
  saturation: number;
  contrast: number;
  mono: number;
  tint: [number, number, number];
  vignette: number;
  bloom: number;
}

const FILTERS: Record<PhotoFilter, FilterParams> = {
  none: { saturation: 1, contrast: 1, mono: 0, tint: [1, 1, 1], vignette: 0, bloom: 1 },
  vivid: { saturation: 1.35, contrast: 1.12, mono: 0, tint: [1, 1, 1], vignette: 0.05, bloom: 1.1 },
  dream: { saturation: 1.1, contrast: 0.92, mono: 0, tint: [1.04, 0.98, 1.06], vignette: 0.15, bloom: 2.2 },
  mono: { saturation: 1, contrast: 1.1, mono: 1, tint: [1, 1, 1], vignette: 0.1, bloom: 1 },
  sepia: { saturation: 1, contrast: 1.05, mono: 1, tint: [1.15, 0.96, 0.74], vignette: 0.2, bloom: 1 },
  noir: { saturation: 1, contrast: 1.45, mono: 1, tint: [0.95, 0.97, 1.05], vignette: 0.45, bloom: 0.6 },
  pop: { saturation: 1.6, contrast: 1.25, mono: 0, tint: [1.02, 1, 1.03], vignette: 0, bloom: 1.3 },
};

/**
 * Turns off frustum culling for everything in `root` so a precompile or warm
 * render touches objects the current camera cannot see yet.
 *
 * @param root - Scene (or subtree) to affect.
 * @returns Restores the previous flags.
 *
 * @example
 * const restore = disableFrustumCulling(scene);
 * renderer.render(scene, camera);
 * restore();
 */
export function disableFrustumCulling(root: Object3D): () => void {
  const touched: Object3D[] = [];
  root.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      touched.push(o);
    }
  });
  return () => {
    for (const o of touched) o.frustumCulled = true;
  };
}

/**
 * Creates the post-processing pipeline for a renderer.
 *
 * @param renderer - Initialised renderer.
 * @param scene - Scene to render.
 * @param camera - Camera to render with.
 * @param settings - Structural settings (see quality presets).
 * @param grade - Initial grade (use {@link gradeFromTheme}).
 */
export function createPostPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  settings: Partial<PostSettings> = {},
  grade: GradeParams = NEUTRAL_GRADE,
): PostPipeline {
  const current: PostSettings = { ...DEFAULT_POST_SETTINGS, ...settings };
  let view = { scene, camera };

  const u = {
    exposure: uniform(1),
    saturation: uniform(1),
    contrast: uniform(1),
    lift: uniform(new Vector3()),
    gamma: uniform(new Vector3(1, 1, 1)),
    gain: uniform(new Vector3(1, 1, 1)),
    vignette: uniform(0.25),
    focusVignette: uniform(0),
    punch: uniform(0),
    flash: uniform(0),
    mono: uniform(0),
    tint: uniform(new Vector3(1, 1, 1)),
    filterSat: uniform(1),
    filterContrast: uniform(1),
    filterVignette: uniform(0),
    bloomStrength: uniform(0.35),
    bloomThreshold: uniform(0.9),
    bloomRadius: uniform(0.45),
    outlineColor: uniform(new Color('#2b1d3a')),
    outlineStrength: uniform(0.55),
    near: uniform(0.1),
    far: uniform(1000),
  };
  let baseBloom = grade.bloomStrength;
  let filterBloom = 1;

  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let bloomNode: BloomNode | null = null;
  let scenePassNode: ReturnType<typeof pass> | null = null;
  let disposables: { dispose(): void }[] = [];

  const build = (): void => {
    for (const d of disposables) d.dispose();
    disposables = [];
    bloomNode = null;

    const scenePass = pass(view.scene, view.camera);
    disposables.push(scenePass);
    scenePass.setResolutionScale(current.resolutionScale);
    scenePassNode = scenePass;
    const targets: Record<string, Node> = { output };
    if (current.bloom) targets.emissive = emissive;
    if (current.outline) targets.normal = directionToColor(normalView);
    if (Object.keys(targets).length > 1) scenePass.setMRT(mrt(targets));
    const sceneTex = scenePass.getTextureNode('output');

    let color: Node<'vec3'>;
    if (current.chromatic) {
      const off = screenUV.sub(0.5).mul(u.punch.mul(0.035));
      const r = sceneTex.sample(screenUV.add(off)).r;
      const g = sceneTex.sample(screenUV).g;
      const b = sceneTex.sample(screenUV.sub(off)).b;
      color = vec3(r, g, b);
    } else {
      color = sceneTex.rgb as Node<'vec3'>;
    }

    if (current.bloom) {
      bloomNode = bloom(
        scenePass.getTextureNode('emissive'),
        u.bloomStrength.value,
        u.bloomRadius.value,
        u.bloomThreshold.value,
      );
      bloomNode.strength = u.bloomStrength;
      bloomNode.threshold = u.bloomThreshold;
      bloomNode.radius = u.bloomRadius;
      disposables.push(bloomNode);
      color = color.add(bloomNode.rgb) as Node<'vec3'>;
    }

    if (current.outline) {
      const normalTex = scenePass.getTextureNode('normal');
      const depthTex = scenePass.getTextureNode('depth');
      const texel = vec2(1, 1).div(screenSize);
      const uvR = screenUV.add(vec2(texel.x, 0));
      const uvU = screenUV.add(vec2(0, texel.y));
      const nC = colorToDirection(normalTex.sample(screenUV).rgb);
      const nR = colorToDirection(normalTex.sample(uvR).rgb);
      const nU = colorToDirection(normalTex.sample(uvU).rgb);
      // The post quad renders with its own camera, so near/far come from uniforms mirrored off the view camera.
      const zC = perspectiveDepthToViewZ(depthTex.sample(screenUV).r, u.near, u.far);
      const zR = perspectiveDepthToViewZ(depthTex.sample(uvR).r, u.near, u.far);
      const zU = perspectiveDepthToViewZ(depthTex.sample(uvU).r, u.near, u.far);
      const depthEdge = max(abs(zC.sub(zR)), abs(zC.sub(zU))).div(abs(zC).max(0.1));
      const normalEdge = max(float(1).sub(dot(nC, nR)), float(1).sub(dot(nC, nU)));
      const fade = smoothstep(u.far.mul(0.5), u.far.mul(0.05), abs(zC));
      const edge = max(smoothstep(0.2, 0.45, normalEdge), smoothstep(0.04, 0.1, depthEdge)).mul(fade);
      color = mix(color, color.mul(u.outlineColor).mul(0.6), edge.mul(u.outlineStrength)) as Node<'vec3'>;
    }

    color = color.mul(u.exposure) as Node<'vec3'>;
    let c = renderOutput(vec4(color, 1), TONE_MAPPINGS[current.toneMapping ?? 'neutral']).rgb as Node<'vec3'>;

    // Lift / gamma / gain (ASC-CDL style) on display-referred colour.
    c = c.mul(u.gain).add(u.lift.mul(float(1).sub(c))) as Node<'vec3'>;
    c = pow(max(c, vec3(0, 0, 0)), vec3(1, 1, 1).div(u.gamma)) as Node<'vec3'>;
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma, luma, luma), c, u.saturation.mul(u.filterSat)) as Node<'vec3'>;
    c = c.sub(0.5).mul(u.contrast.mul(u.filterContrast)).add(0.5) as Node<'vec3'>;
    const luma2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, u.tint.mul(luma2), u.mono) as Node<'vec3'>;
    c = c.mul(mix(vec3(1, 1, 1), u.tint, float(1).sub(u.mono).mul(0.5))) as Node<'vec3'>;

    const aspect = vec2(1.0, 0.82);
    const vd = length(screenUV.sub(0.5).mul(aspect)).mul(2);
    const vig = u.vignette.add(u.filterVignette).add(u.focusVignette);
    c = c.mul(float(1).sub(smoothstep(0.55, 1.45, vd).mul(vig))) as Node<'vec3'>;
    c = c.mul(float(1).sub(smoothstep(0.2, 1.0, vd).mul(u.focusVignette.mul(0.6)))) as Node<'vec3'>;
    c = mix(c, vec3(1, 1, 1), u.flash) as Node<'vec3'>;

    let out: Node = vec4(c.clamp(0, 1), 1);
    if (current.aa === 'fxaa') {
      const n = fxaa(out);
      disposables.push(n);
      out = n;
    } else if (current.aa === 'smaa') {
      const n = smaa(out);
      disposables.push(n);
      out = n;
    }
    pipeline.outputNode = out;
    pipeline.needsUpdate = true;
  };

  const applyBloom = (): void => {
    u.bloomStrength.value = baseBloom * filterBloom;
  };

  const api: PostPipeline = {
    get settings(): Readonly<PostSettings> {
      return current;
    },
    render(): void {
      const cam = view.camera as Camera & { near?: number; far?: number };
      if (cam.near !== undefined && cam.far !== undefined) {
        u.near.value = cam.near;
        u.far.value = cam.far;
      }
      // PERF: three updates the whole scene graph at the start of every render() call, and each
      // shadow map (three per CSM light) is its own render() — 4+ full matrix passes a frame.
      // A 100-player round has ~5,400 nodes; updating once saved ~4 ms a frame on Ultra.
      const scene = view.scene;
      const auto = scene.matrixWorldAutoUpdate;
      if (auto) scene.updateMatrixWorld();
      scene.matrixWorldAutoUpdate = false;
      try {
        if (current.enabled) pipeline.render();
        else renderer.render(scene, view.camera);
      } finally {
        scene.matrixWorldAutoUpdate = auto;
      }
    },
    setView(s: Scene, cam: Camera): void {
      // Rebuilding the graph would drop the scene pass a precompile just targeted.
      if (view.scene === s && view.camera === cam && scenePassNode) return;
      view = { scene: s, camera: cam };
      if (current.enabled) build();
    },
    beginWarmUp(budgetMs?: number, paceFirstDraws?: boolean): SceneWarmUp {
      return beginSceneWarmUp(renderer, view.scene, {
        render: () => api.render(),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(paceFirstDraws ? { paceFirstDraws } : {}),
      });
    },
    gpuIdle(): Promise<void> {
      return waitForGpuIdle(renderer);
    },
    setSettings(patch: Partial<PostSettings>): void {
      const structural =
        (patch.aa !== undefined && patch.aa !== current.aa) ||
        (patch.bloom !== undefined && patch.bloom !== current.bloom) ||
        (patch.outline !== undefined && patch.outline !== current.outline) ||
        (patch.chromatic !== undefined && patch.chromatic !== current.chromatic) ||
        (patch.enabled !== undefined && patch.enabled !== current.enabled) ||
        (patch.toneMapping !== undefined && patch.toneMapping !== current.toneMapping);
      const scaleChanged =
        patch.resolutionScale !== undefined && patch.resolutionScale !== current.resolutionScale;
      Object.assign(current, patch);
      if (structural && current.enabled) build();
      // Adaptive resolution steps often: resize the scene pass in place instead of recompiling the graph.
      else if (scaleChanged && current.enabled) {
        if (scenePassNode) scenePassNode.setResolutionScale(current.resolutionScale);
        else build();
      }
    },
    setGrade(g: GradeParams): void {
      u.exposure.value = g.exposure;
      u.saturation.value = g.saturation;
      u.contrast.value = g.contrast;
      u.lift.value.set(g.lift[0], g.lift[1], g.lift[2]);
      u.gamma.value.set(g.gamma[0], g.gamma[1], g.gamma[2]);
      u.gain.value.set(g.gain[0], g.gain[1], g.gain[2]);
      u.vignette.value = g.vignette;
      baseBloom = g.bloomStrength;
      u.bloomThreshold.value = g.bloomThreshold;
      u.bloomRadius.value = g.bloomRadius;
      applyBloom();
    },
    setFilter(filter: PhotoFilter): void {
      const f = FILTERS[filter];
      u.filterSat.value = f.saturation;
      u.filterContrast.value = f.contrast;
      u.mono.value = f.mono;
      u.tint.value.set(f.tint[0], f.tint[1], f.tint[2]);
      u.filterVignette.value = f.vignette;
      filterBloom = f.bloom;
      applyBloom();
    },
    punch(strength = 1): void {
      u.punch.value = Math.max(u.punch.value, strength);
    },
    flash(strength = 1): void {
      u.flash.value = Math.max(u.flash.value, strength * 0.85);
    },
    setFocusVignette(amount: number): void {
      u.focusVignette.value = amount;
    },
    update(dt: number): void {
      u.punch.value = Math.max(0, u.punch.value - dt * 3);
      u.flash.value = Math.max(0, u.flash.value - dt * 2.4);
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
      disposables = [];
      pipeline.dispose();
    },
  };

  api.setGrade(grade);
  api.setFilter('none');
  if (current.enabled) build();
  return api;
}
