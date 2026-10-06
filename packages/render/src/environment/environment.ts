import { Color, Fog, Group, Vector3, type Camera, type Scene } from 'three/webgpu';
import type { ThemeDefinition, Weather } from '@tumble/content/themes';
import { resolveAtmosphere, type Atmosphere } from './atmosphere.ts';
import { createThemedSky, type ThemedSky } from './sky.ts';
import { createLightingRig, type LightingRig, type LightingRigOptions } from './lighting.ts';
import { createCloudLayer, type CloudLayer, type CloudSpec } from './clouds.ts';
import { PropBuilder, type PropBatch } from './propKit.ts';
import { layoutIslands, type IslandSpec } from './islands.ts';
import { createSkyTraffic, type BlimpOrbit, type SkyTraffic } from './balloons.ts';
import {
  buildKeepOut,
  planStands,
  type BoxLike,
  type KeepOut,
  type StandAnchors,
  type Vec3Like,
} from './dressing.ts';
import { createCrowd, type Crowd, type CrowdStandPlacement } from './crowd.ts';
import { createWeather, type WeatherLayer } from './weather.ts';

/**
 * Environment composer: sky, fog, lighting rig, clouds, floating islands, sky
 * traffic, spectator stands and weather for one theme. One call dresses any
 * scene (rounds, menus, ceremonies) consistently.
 */

/** Detail knobs, normally taken from the quality preset. */
export interface EnvironmentDetail {
  /** Cloud count (before theme density). */
  clouds: number;
  islands: number;
  balloons: number;
  blimps: number;
  crowd: boolean;
  /** Precipitation sprite budget. */
  precipitation: number;
  streaks: number;
}

/** Default detail (Medium). */
export const DEFAULT_ENVIRONMENT_DETAIL: EnvironmentDetail = {
  clouds: 36,
  islands: 14,
  balloons: 40,
  blimps: 3,
  crowd: true,
  precipitation: 2500,
  streaks: 160,
};

/** Options for {@link createEnvironment}. */
export interface EnvironmentOptions {
  weather?: Weather;
  /**
   * Playable course AABB (`measureCourse` from `@tumble/sim/match` for rounds);
   * decor stays outside it and fairy lights drape around it.
   */
  courseBounds?: BoxLike;
  /**
   * Volume clouds, islands, balloons, blimps and stands keep out of. Defaults
   * to the course padded by the gameplay camera's reach; rounds also add their
   * intro flyover path (see {@link buildKeepOut}).
   */
  keepOut?: KeepOut;
  /** Floor points the default stands face (see `standAnchorsForRound`); defaults to the course's low corners. */
  standAnchors?: StandAnchors;
  seed?: number;
  detail?: Partial<EnvironmentDetail>;
  lighting?: LightingRigOptions;
  /** Explicit stand placements; default puts two stands beside the course start and end. */
  crowdStands?: readonly CrowdStandPlacement[];
  /** Skip islands entirely (tiny menu scenes that build their own set). */
  islands?: boolean;
}

/** Where every backdrop prop ended up (world space), for placement checks and debugging. */
export interface EnvironmentDressing {
  readonly keepOut: KeepOut;
  /** World position of the cloud layer's origin (cloud specs are relative to it). */
  readonly cloudOrigin: Vec3Like;
  readonly clouds: readonly CloudSpec[];
  readonly islands: readonly IslandSpec[];
  readonly balloonColumns: readonly BoxLike[];
  /** Blimp orbits around {@link EnvironmentDressing.center}. */
  readonly blimpOrbits: readonly BlimpOrbit[];
  readonly center: Vec3Like;
  readonly stands: readonly CrowdStandPlacement[];
}

/** Live environment. */
export interface Environment {
  /** Placement of the backdrop props. */
  readonly dressing: EnvironmentDressing;
  /** Everything except fog; add to the scene (or call `attach`). */
  readonly object: Group;
  readonly fog: Fog;
  readonly lights: LightingRig;
  readonly sky: ThemedSky;
  readonly crowd: Crowd | null;
  /** Current resolved atmosphere (read-only snapshot). */
  readonly atmosphere: Atmosphere;
  readonly theme: ThemeDefinition;
  readonly weather: Weather;
  /** Adds `object` to the scene and installs the fog. */
  attach(scene: Scene): void;
  setWeather(weather: Weather): void;
  /**
   * Per frame.
   *
   * @param dt - Seconds.
   * @param camera - Active camera (sky follow, shadow fit).
   * @param focus - Point shadows should be sharpest around.
   */
  update(dt: number, camera: Camera, focus?: Vector3): void;
  /** Optional hook so the level can mirror night glow. Called whenever weather changes. */
  onAtmosphere?: (a: Atmosphere) => void;
  dispose(): void;
}

/**
 * Builds a complete themed environment.
 *
 * @param theme - Theme definition.
 * @param opts - Weather, bounds, detail and lighting options.
 * @example
 * const env = createEnvironment(getTheme('candy'), { courseBounds: level.bounds, weather: 'clear' });
 * env.attach(scene);
 * // per frame: env.update(dt, camera, playerPos);
 */
export function createEnvironment(theme: ThemeDefinition, opts: EnvironmentOptions = {}): Environment {
  const steps = createEnvironmentSliced(theme, opts);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/**
 * {@link createEnvironment} split where the main thread may pause: it yields
 * its progress (0..1) after the sky and lights, the clouds, the islands, the
 * sky traffic and the stands, and returns the environment.
 *
 * PERF: built in one piece it blocked the round load for 30-110 ms.
 *
 * @param theme - Theme definition.
 * @param opts - Weather, bounds, detail and lighting options.
 * @returns A generator whose return value is the environment.
 */
export function* createEnvironmentSliced(
  theme: ThemeDefinition,
  opts: EnvironmentOptions = {},
): Generator<number, Environment> {
  const detail: EnvironmentDetail = { ...DEFAULT_ENVIRONMENT_DETAIL, ...opts.detail };
  const seed = opts.seed ?? 1;
  let weather: Weather = opts.weather ?? theme.weather.default;
  let atmosphere = resolveAtmosphere(theme, weather);

  const object = new Group();
  object.name = `environment-${theme.id}`;
  const b = opts.courseBounds ?? { min: { x: -20, y: -2, z: -20 }, max: { x: 20, y: 6, z: 60 } };
  const center = new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
  const keepOut = opts.keepOut ?? buildKeepOut(b);

  const fog = new Fog(new Color(), 60, 240);
  const sky = createThemedSky(atmosphere, 900);
  const lights = createLightingRig(atmosphere, opts.lighting);
  object.add(sky.object, lights.object);
  yield 0.15;

  const cloudRoot = new Group();
  cloudRoot.position.copy(center);
  const clouds: CloudLayer | null =
    detail.clouds > 0
      ? createCloudLayer(atmosphere, {
          seed: seed * 3 + 1,
          count: detail.clouds,
          innerRadius: extent + 30,
          wrapRadius: Math.max(theme.fog.far + 40, extent + 200),
          origin: center,
          keepOut,
        })
      : null;
  if (clouds) {
    cloudRoot.add(clouds.object);
    object.add(cloudRoot);
  }
  yield 0.3;

  let props: PropBatch | null = null;
  let islands: IslandSpec[] = [];
  if ((opts.islands ?? true) && detail.islands > 0) {
    const builder = new PropBuilder();
    islands = layoutIslands(builder, theme, {
      seed: seed * 7 + 3,
      count: detail.islands,
      center: { x: center.x, y: center.y - 6, z: center.z },
      innerRadius: extent + 45,
      outerRadius: extent + 240,
      exclude: { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z },
      keepOut,
    });
    props = builder.build(false);
    for (const m of props.meshes) object.add(m);
  }
  yield 0.55;

  let traffic: SkyTraffic | null = null;
  if (theme.decor.balloons && (detail.balloons > 0 || detail.blimps > 0)) {
    traffic = createSkyTraffic({
      seed: seed * 11 + 5,
      colors: theme.decor.colors,
      balloons: detail.balloons,
      blimps: detail.blimps,
      center,
      innerRadius: extent + 25,
      outerRadius: extent + 170,
      keepOut,
    });
    for (const m of traffic.meshes) object.add(m);
  }
  yield 0.7;

  let crowd: Crowd | null = null;
  let stands: readonly CrowdStandPlacement[] = [];
  if (theme.decor.crowd && detail.crowd) {
    // NOTE: rounds pass anchors: stands then face the floor at the start and goal. Sitting at the level's
    // lowest point put the stadium under the map on courses with deep supports or a raised start. Composed
    // menu scenes (no anchors) keep their framed placement.
    stands =
      opts.crowdStands ??
      (opts.standAnchors
        ? planStands(b, opts.standAnchors, keepOut)
        : [
            {
              position: { x: b.max.x + 9, y: b.min.y + 1, z: b.min.z + 10 },
              yaw: Math.PI / 2,
              width: 18,
              rows: 4,
            },
            {
              position: { x: b.min.x - 9, y: b.min.y + 1, z: b.max.z - 10 },
              yaw: -Math.PI / 2,
              width: 18,
              rows: 4,
            },
          ]);
    if (stands.length > 0) {
      crowd = createCrowd({
        stands,
        colors: theme.decor.colors,
        stripe: [theme.palette.primary, theme.palette.trim],
        seed: seed * 13 + 1,
      });
      object.add(crowd.object);
    }
  }
  yield 0.85;

  const weatherLayer: WeatherLayer = createWeather(atmosphere, {
    precipitation: detail.precipitation,
    streaks: detail.streaks,
    courseBounds: b,
    seed,
  });
  object.add(weatherLayer.object);

  const flashColor = new Color();
  const apply = (a: Atmosphere): void => {
    fog.color.copy(a.fogColor);
    fog.near = a.fogNear;
    fog.far = a.fogFar;
    sky.setAtmosphere(a);
    lights.setAtmosphere(a);
    clouds?.setAtmosphere(a);
    weatherLayer.setAtmosphere(a);
    props?.setGlow(theme.id === 'neon' ? 0.7 + a.night * 0.5 : 0.25 + a.night * 0.9);
  };
  apply(atmosphere);

  const env: Environment = {
    dressing: {
      keepOut,
      cloudOrigin: { x: center.x, y: center.y, z: center.z },
      clouds: clouds?.clouds ?? [],
      islands,
      balloonColumns: traffic?.balloonColumns ?? [],
      blimpOrbits: traffic?.blimpOrbits ?? [],
      center: { x: center.x, y: center.y, z: center.z },
      stands,
    },
    object,
    fog,
    lights,
    sky,
    crowd,
    get atmosphere(): Atmosphere {
      return atmosphere;
    },
    theme,
    get weather(): Weather {
      return weather;
    },
    attach(scene: Scene): void {
      scene.add(object);
      scene.fog = fog;
    },
    setWeather(w: Weather): void {
      weather = w;
      atmosphere = resolveAtmosphere(theme, w);
      apply(atmosphere);
      env.onAtmosphere?.(atmosphere);
    },
    update(dt: number, camera: Camera, focus?: Vector3): void {
      sky.update(dt, camera);
      lights.update(camera, focus);
      clouds?.update(dt);
      props?.update(dt);
      traffic?.update(dt);
      crowd?.update(dt);
      const flash = weatherLayer.update(dt);
      if (atmosphere.storm) {
        sky.setFlash(flash);
        lights.setIntensityScale(1 + flash * 1.5, 1 + flash * 1.2);
        flashColor.copy(atmosphere.fogColor).lerp(atmosphere.skyHorizon, flash * 0.6);
        fog.color.copy(flashColor);
      }
    },
    dispose(): void {
      sky.dispose();
      lights.dispose();
      clouds?.dispose();
      props?.dispose();
      traffic?.dispose();
      crowd?.dispose();
      weatherLayer.dispose();
      object.removeFromParent();
    },
  };
  return env;
}
