import { Color, Fog, Group, Vector3, type Camera, type Scene } from 'three/webgpu';
import type { ThemeDefinition, Weather } from '@tumble/content/themes';
import { resolveAtmosphere, type Atmosphere } from './atmosphere.ts';
import { createThemedSky, type ThemedSky } from './sky.ts';
import { createLightingRig, type LightingRig, type LightingRigOptions } from './lighting.ts';
import { createCloudLayer, type CloudLayer } from './clouds.ts';
import { PropBuilder, type PropBatch } from './propKit.ts';
import { layoutIslands } from './islands.ts';
import { createSkyTraffic, type SkyTraffic } from './balloons.ts';
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
  /** Course AABB; decor stays outside it and fairy lights drape around it. */
  courseBounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  seed?: number;
  detail?: Partial<EnvironmentDetail>;
  lighting?: LightingRigOptions;
  /** Explicit stand placements; default puts two stands beside the course start and end. */
  crowdStands?: readonly CrowdStandPlacement[];
  /** Skip islands entirely (tiny menu scenes that build their own set). */
  islands?: boolean;
}

/** Live environment. */
export interface Environment {
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
  const detail: EnvironmentDetail = { ...DEFAULT_ENVIRONMENT_DETAIL, ...opts.detail };
  const seed = opts.seed ?? 1;
  let weather: Weather = opts.weather ?? theme.weather.default;
  let atmosphere = resolveAtmosphere(theme, weather);

  const object = new Group();
  object.name = `environment-${theme.id}`;
  const b = opts.courseBounds ?? { min: { x: -20, y: -2, z: -20 }, max: { x: 20, y: 6, z: 60 } };
  const center = new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;

  const fog = new Fog(new Color(), 60, 240);
  const sky = createThemedSky(atmosphere, 900);
  const lights = createLightingRig(atmosphere, opts.lighting);
  object.add(sky.object, lights.object);

  const cloudRoot = new Group();
  cloudRoot.position.copy(center);
  const clouds: CloudLayer | null =
    detail.clouds > 0
      ? createCloudLayer(atmosphere, { seed: seed * 3 + 1, count: detail.clouds, innerRadius: extent + 30, wrapRadius: Math.max(theme.fog.far + 40, extent + 200) })
      : null;
  if (clouds) {
    cloudRoot.add(clouds.object);
    object.add(cloudRoot);
  }

  let props: PropBatch | null = null;
  if ((opts.islands ?? true) && detail.islands > 0) {
    const builder = new PropBuilder();
    layoutIslands(builder, theme, {
      seed: seed * 7 + 3,
      count: detail.islands,
      center: { x: center.x, y: center.y - 6, z: center.z },
      innerRadius: extent + 45,
      outerRadius: extent + 240,
      exclude: { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z },
    });
    props = builder.build(false);
    for (const m of props.meshes) object.add(m);
  }

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
    });
    for (const m of traffic.meshes) object.add(m);
  }

  let crowd: Crowd | null = null;
  if (theme.decor.crowd && detail.crowd) {
    const stands: readonly CrowdStandPlacement[] = opts.crowdStands ?? [
      { position: { x: b.max.x + 9, y: b.min.y + 1, z: b.min.z + 10 }, yaw: Math.PI / 2, width: 18, rows: 4 },
      { position: { x: b.min.x - 9, y: b.min.y + 1, z: b.max.z - 10 }, yaw: -Math.PI / 2, width: 18, rows: 4 },
    ];
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
