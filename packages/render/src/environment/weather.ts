import {
  AdditiveBlending,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  NormalBlending,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Node,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  float,
  fract,
  hash,
  instanceIndex,
  length,
  mix,
  mod,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { DecorRandom } from '../level/toolkit.ts';
import type { Atmosphere } from './atmosphere.ts';

/**
 * Weather layers: snow, rain (stormy), wind streaks, fairy lights (night) and
 * lightning. Precipitation and streaks are instanced sprites whose positions
 * are pure functions of (instanceIndex, time, camera position): they live in a
 * box that wraps around the camera, so 0 CPU per particle and they are always
 * where the player looks.
 */

/** Options for {@link createWeather}. */
export interface WeatherOptions {
  /** Max precipitation sprites (snow flakes / rain drops). Default 2500. */
  precipitation?: number;
  /** Wind streak sprites. Default 160. */
  streaks?: number;
  /** Bounds the fairy-light strings drape around (the course). */
  courseBounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  seed?: number;
  /** Fairy light bulbs. Default 220. */
  fairyLights?: number;
}

/** Live weather layer. */
export interface WeatherLayer {
  readonly object: Group;
  setAtmosphere(a: Atmosphere): void;
  /**
   * @param dt - Seconds.
   * @returns Current lightning flash 0..1 (the environment applies it to sky and lights).
   */
  update(dt: number): number;
  dispose(): void;
}

function wrappedBoxPosition(time: Node<'float'>, box: Node<'vec3'>, fall: Node<'float'>, wind: Node<'float'>, flutter: number): Node<'vec3'> {
  const i = float(instanceIndex);
  const r = vec3(hash(i), hash(i.add(17.3)), hash(i.add(41.7)));
  const speedVar = hash(i.add(91.1)).mul(0.6).add(0.7);
  const drift = vec3(
    time.mul(wind).mul(speedVar).add(sin(time.mul(1.3).add(r.x.mul(30.0))).mul(flutter)),
    time.mul(fall).mul(speedVar).negate(),
    sin(time.mul(0.9).add(r.z.mul(25.0))).mul(flutter),
  );
  const local = r.mul(box).add(drift).sub(cameraPosition);
  const wrapped = mod(local, box).sub(box.mul(0.5));
  return cameraPosition.add(wrapped) as Node<'vec3'>;
}

/**
 * Creates the weather layer. Everything is built up-front; `setAtmosphere`
 * toggles visibility, so weather changes never allocate.
 *
 * @param atmosphere - Initial atmosphere.
 * @param opts - Budgets and course bounds.
 */
export function createWeather(atmosphere: Atmosphere, opts: WeatherOptions = {}): WeatherLayer {
  const object = new Group();
  object.name = 'weather';
  const time = uniform(0);
  const wind = uniform(2);
  const opacity = uniform(1);

  // --- precipitation (snow or rain share one pool) ---
  const precip = opts.precipitation ?? 2500;
  const fall = uniform(1.6);
  const precipMat = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: NormalBlending });
  const precipBox = uniform(new Vector3(70, 40, 70));
  const isRain = uniform(0);
  precipMat.positionNode = wrappedBoxPosition(time, precipBox as unknown as Node<'vec3'>, fall, wind, 0.6);
  precipMat.scaleNode = mix(vec2(0.16, 0.16), vec2(0.035, 0.9), isRain);
  const pd = length(uv().sub(0.5).mul(vec2(1, mix(float(1), float(0.2), isRain)))).mul(2);
  precipMat.colorNode = mix(vec3(1, 1, 1), vec3(0.75, 0.82, 1.0), isRain);
  precipMat.opacityNode = smoothstep(1.0, 0.3, pd).mul(opacity).mul(mix(float(0.95), float(0.45), isRain));
  const precipSprite = new Sprite(precipMat);
  precipSprite.count = precip;
  precipSprite.frustumCulled = false;
  precipSprite.name = 'weather-precip';
  object.add(precipSprite);

  // --- wind streaks ---
  const streakMat = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  const streakBox = uniform(new Vector3(90, 30, 90));
  streakMat.positionNode = wrappedBoxPosition(time, streakBox as unknown as Node<'vec3'>, float(0), wind.mul(3.0), 0.2);
  streakMat.scaleNode = vec2(4.5, 0.06);
  streakMat.rotationNode = float(0);
  const su = uv();
  const along = smoothstep(0.0, 0.3, su.x).mul(smoothstep(1.0, 0.6, su.x));
  const across = smoothstep(0.5, 0.0, length(su.y.sub(0.5)));
  const life = fract(time.mul(0.35).add(hash(float(instanceIndex))));
  const blink = smoothstep(0.0, 0.25, life).mul(smoothstep(1.0, 0.6, life));
  streakMat.colorNode = vec3(1, 1, 1);
  streakMat.opacityNode = along.mul(across).mul(blink).mul(0.32);
  const streaks = new Sprite(streakMat);
  streaks.count = opts.streaks ?? 160;
  streaks.frustumCulled = false;
  streaks.name = 'weather-streaks';
  object.add(streaks);

  // --- fairy lights strung around the course perimeter ---
  const bulbs = opts.fairyLights ?? 220;
  const bulbGeo = new IcosahedronGeometry(0.16, 1);
  const bulbPhase = new Float32Array(bulbs);
  const bulbMat = new MeshBasicNodeMaterial();
  const night = uniform(0);
  const aPhase = attribute('aPhase', 'float') as unknown as Node<'float'>;
  const twinkle = sin(time.mul(2.2).add(aPhase.mul(6.283))).mul(0.35).add(0.65);
  bulbMat.colorNode = mix(vec3(0.25, 0.25, 0.3), vec3(1, 1, 1), night).mul(twinkle.mul(night).mul(2.2).add(0.4));
  const fairy = new InstancedMesh(bulbGeo, bulbMat, bulbs);
  fairy.name = 'weather-fairy-lights';
  {
    const rng = new DecorRandom(opts.seed ?? 3);
    const b = opts.courseBounds ?? { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 0, z: 60 } };
    const corners: Vector3[] = [];
    const margin = 4;
    const xs = [b.min.x - margin, b.max.x + margin];
    const len = b.max.z - b.min.z + margin * 2;
    const posts = Math.max(2, Math.round(len / 14));
    for (const x of xs) {
      for (let i = 0; i <= posts; i++) corners.push(new Vector3(x, b.max.y + 5, b.min.z - margin + (i / posts) * len));
    }
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    const p = new Vector3();
    const tint = new Color();
    const palette = ['#ffd23f', '#ff6fb5', '#5ce1e6', '#7cf27c', '#ff9a52', '#b28dff'];
    const segments: [Vector3, Vector3][] = [];
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < posts; i++) {
        segments.push([corners[side * (posts + 1) + i]!, corners[side * (posts + 1) + i + 1]!]);
      }
    }
    for (let i = 0; i < bulbs; i++) {
      const seg = segments[i % segments.length]!;
      const t = (Math.floor(i / segments.length) + 0.5) / Math.ceil(bulbs / segments.length);
      p.lerpVectors(seg[0], seg[1], t);
      p.y -= Math.sin(t * Math.PI) * 2.2;
      m.compose(p, q, s);
      fairy.setMatrixAt(i, m);
      fairy.setColorAt(i, tint.set(palette[i % palette.length]!));
      bulbPhase[i] = rng.next();
    }
  }
  bulbGeo.setAttribute('aPhase', new InstancedBufferAttribute(bulbPhase, 1));
  fairy.instanceMatrix.needsUpdate = true;
  fairy.frustumCulled = false;
  object.add(fairy);

  let storm = false;
  let flash = 0;
  let nextStrike = 4;
  let strikeRng = new DecorRandom(opts.seed ?? 99);

  const api: WeatherLayer = {
    object,
    setAtmosphere(a: Atmosphere): void {
      precipSprite.visible = a.snow || a.storm;
      isRain.value = a.storm && !a.snow ? 1 : 0;
      fall.value = a.storm && !a.snow ? 26 : 1.6;
      wind.value = a.wind * (a.storm ? 7 : 4);
      streaks.visible = a.windStreaks;
      fairy.visible = a.night > 0.5;
      night.value = a.night;
      storm = a.storm;
      strikeRng = new DecorRandom(opts.seed ?? 99);
      nextStrike = 3;
    },
    update(dt: number): number {
      time.value += dt;
      if (storm) {
        nextStrike -= dt;
        if (nextStrike <= 0) {
          flash = 1;
          nextStrike = strikeRng.range(4, 11);
        }
      }
      flash = Math.max(0, flash - dt * 3.2);
      // Double-flicker reads as lightning far better than a single fade.
      const flicker = flash > 0.55 && flash < 0.75 ? 0.3 : flash;
      return flicker;
    },
    dispose(): void {
      precipMat.dispose();
      streakMat.dispose();
      bulbGeo.dispose();
      bulbMat.dispose();
      fairy.dispose();
      object.removeFromParent();
    },
  };
  api.setAtmosphere(atmosphere);
  return api;
}
