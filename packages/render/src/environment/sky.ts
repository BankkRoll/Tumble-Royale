import {
  BackSide,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
} from 'three/webgpu';
import {
  abs,
  acos,
  atan,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  mx_fractal_noise_float,
  positionLocal,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Atmosphere } from './atmosphere.ts';

/**
 * Themed sky dome: three-stop gradient (as the original `createSkyDome`), sun
 * disc with layered glow, twinkling starfield and a faint nebula for night and
 * space skies. Follows the camera so the horizon never parallaxes.
 */

/** Live sky handle. */
export interface ThemedSky {
  readonly object: Mesh;
  /** Apply a resolved atmosphere (instant). */
  setAtmosphere(a: Atmosphere): void;
  /** 0..1 lightning flash brightening the whole dome. */
  setFlash(amount: number): void;
  /** Keep centred on the camera and advance twinkle. */
  update(dt: number, camera: Camera): void;
  dispose(): void;
}

/**
 * Creates the themed sky dome.
 *
 * @param atmosphere - Initial atmosphere.
 * @param radius - Dome radius; must sit inside the camera far plane.
 */
export function createThemedSky(atmosphere: Atmosphere, radius = 600): ThemedSky {
  const top = uniform(new Color());
  const horizon = uniform(new Color());
  const bottom = uniform(new Color());
  const sunColor = uniform(new Color());
  const sunDir = uniform(new Vector3(0, 1, 0));
  const sunSize = uniform(1);
  const stars = uniform(0);
  const flash = uniform(0);
  const time = uniform(0);

  const mat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  const dir = positionLocal.normalize();
  const y = dir.y;
  const upper = mix(horizon, top, smoothstep(0.0, 0.6, y));
  const grad = mix(bottom, upper, smoothstep(-0.3, 0.03, y));

  const d = max(dir.dot(sunDir), float(0));
  const discEdge = float(0.9994).sub(sunSize.mul(0.0004));
  const disc = smoothstep(discEdge, discEdge.add(0.0003), d);
  const glow = pow(d, float(10))
    .mul(0.35)
    .add(pow(d, float(90)).mul(0.6));
  const sun = sunColor.mul(disc.mul(2.4).add(glow));

  // Equirectangular-ish cells; stars cluster slightly near the poles but nobody notices.
  const lon = atan(dir.z, dir.x);
  const lat = acos(y.clamp(-1, 1));
  const cellUV = vec2(lon.mul(90.0), lat.mul(90.0));
  const cell = floor(cellUV);
  const local = fract(cellUV).sub(0.5);
  const h = hash(cell.x.add(cell.y.mul(311.0)));
  const starMask = step(0.985, h).mul(smoothstep(0.32, 0.0, local.length()));
  const twinkle = sin(time.mul(1.7).add(h.mul(80.0)))
    .mul(0.4)
    .add(0.6);
  const aboveHorizon = smoothstep(-0.05, 0.15, y);
  const starCol = mix(vec3(0.8, 0.85, 1.0), vec3(1.0, 0.85, 0.95), fract(h.mul(13.0)));
  const starLight = starCol.mul(starMask.mul(twinkle).mul(stars).mul(aboveHorizon).mul(1.8));

  const neb = mx_fractal_noise_float(dir.mul(2.2), 3, 2.0, 0.5);
  const nebula = mix(vec3(0.35, 0.15, 0.6), vec3(0.1, 0.35, 0.6), smoothstep(-0.3, 0.3, neb.mul(1.3))).mul(
    smoothstep(0.0, 0.6, abs(neb)).mul(stars).mul(0.22).mul(aboveHorizon),
  );

  mat.colorNode = grad
    .add(sun)
    .add(starLight)
    .add(nebula)
    .add(vec3(0.6, 0.62, 0.8).mul(flash));

  const mesh = new Mesh(new SphereGeometry(radius, 48, 24), mat);
  mesh.name = 'sky';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const api: ThemedSky = {
    object: mesh,
    setAtmosphere(a: Atmosphere): void {
      top.value.copy(a.skyTop);
      horizon.value.copy(a.skyHorizon);
      bottom.value.copy(a.skyBottom);
      sunColor.value.copy(a.sunDisc);
      sunDir.value.copy(a.sunDirection);
      sunSize.value = a.sunSize;
      stars.value = a.stars;
    },
    setFlash(amount: number): void {
      flash.value = amount;
    },
    update(dt: number, camera: Camera): void {
      time.value += dt;
      mesh.position.copy(camera.position);
    },
    dispose(): void {
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
  api.setAtmosphere(atmosphere);
  return api;
}
