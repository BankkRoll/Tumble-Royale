import {
  Color,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
  type Node,
} from 'three/webgpu';
import {
  cameraPosition,
  distance,
  float,
  instancedBufferAttribute,
  mix,
  mod,
  modelWorldMatrix,
  normalWorld,
  positionLocal,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { DecorRandom } from '../level/toolkit.ts';
import type { Atmosphere } from './atmosphere.ts';
import { keepOutHitsLane, type DriftLane, type KeepOut, type Vec3Like } from './dressing.ts';

/**
 * Drifting cartoon cloud puffs. Every puff of every cloud is one instance of a
 * single InstancedMesh (1 draw call). Drift and wrap-around run in the vertex
 * shader from a travelled-distance uniform, so the CPU never touches instance matrices after
 * build. Puffs of one cloud share a centre attribute so they wrap together.
 *
 * Clouds drift along X and wrap, so each one sweeps a whole lane; lanes that
 * would cross the course or a camera's view are lifted above (or dropped
 * below) the keep-out volume at layout time. Puffs that still end up near the
 * camera (free cameras, spectating) shrink away instead of filling the screen.
 */

/** Options for {@link createCloudLayer}. */
export interface CloudLayerOptions {
  seed?: number;
  /** Number of clouds (each 4–8 puffs). Default 36. */
  count?: number;
  /** Inner radius of the cloud ring around the course. */
  innerRadius?: number;
  /** Wrap half-width; keep it beyond fog far so the wrap is invisible. */
  wrapRadius?: number;
  /** Height band (min, max) relative to the layer origin. */
  heightRange?: [number, number];
  /** World position of the layer origin (where the parent puts it), for keep-out tests. */
  origin?: Vec3Like;
  /** Volume no cloud lane may cross (world space). */
  keepOut?: KeepOut;
}

/** One puff of a cloud, layer-local. */
export interface CloudPuff {
  pos: Vec3Like;
  scale: Vec3Like;
}

/** One laid-out cloud, layer-local. */
export interface CloudSpec {
  center: Vec3Like;
  /** Drift speed multiplier. */
  speed: number;
  puffs: CloudPuff[];
  /** Layer-local Y/Z band the cloud sweeps as it drifts (puff extents included). */
  lane: DriftLane;
}

/** Live cloud layer. */
export interface CloudLayer {
  readonly object: InstancedMesh;
  /** The layout the mesh was built from (layer-local). */
  readonly clouds: readonly CloudSpec[];
  setAtmosphere(a: Atmosphere): void;
  update(dt: number): void;
  dispose(): void;
}

/** Clouds closer than this to the camera are fully shrunk away (m). */
const FADE_NEAR = 6;
/** Clouds farther than this from the camera are full size (m). */
const FADE_FAR = 30;
/** Clearance kept between a relocated lane and the keep-out volume (m). */
const LANE_GAP = 3;

function laneOf(puffs: readonly CloudPuff[]): DriftLane {
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  // Icosahedron puffs have unit radius before scaling.
  for (const p of puffs) {
    y0 = Math.min(y0, p.pos.y - p.scale.y);
    y1 = Math.max(y1, p.pos.y + p.scale.y);
    z0 = Math.min(z0, p.pos.z - p.scale.z);
    z1 = Math.max(z1, p.pos.z + p.scale.z);
  }
  return { y0, y1, z0, z1 };
}

function shiftY(c: CloudSpec, dy: number): void {
  c.center.y += dy;
  for (const p of c.puffs) p.pos.y += dy;
  c.lane.y0 += dy;
  c.lane.y1 += dy;
}

/** True when the cloud's lane (layer-local) crosses the keep-out (world). */
function blocked(c: CloudSpec, origin: Vec3Like, k: KeepOut): boolean {
  return keepOutHitsLane(k, {
    y0: c.lane.y0 + origin.y - LANE_GAP,
    y1: c.lane.y1 + origin.y + LANE_GAP,
    z0: c.lane.z0 + origin.z - LANE_GAP,
    z1: c.lane.z1 + origin.z + LANE_GAP,
  });
}

/**
 * Moves a blocked cloud straight up (or down, if it started below the
 * keep-out's middle) until its lane is clear. Moving only in Y keeps the
 * ring-shaped layout and the seeded look of the sky.
 */
function clearLane(c: CloudSpec, origin: Vec3Like, k: KeepOut): void {
  if (!blocked(c, origin, k)) return;
  const mid = (k.box.min.y + k.box.max.y) / 2 - origin.y;
  const up = c.center.y >= mid;
  const target = up
    ? k.box.max.y - origin.y + LANE_GAP - c.lane.y0
    : k.box.min.y - origin.y - LANE_GAP - c.lane.y1;
  shiftY(c, target + (up ? 0.01 : -0.01));
  // Flyover spheres can sit above the box; keep stepping the same way.
  for (let i = 0; i < 200 && blocked(c, origin, k); i++) shiftY(c, up ? 2 : -2);
}

/**
 * Lays out the clouds (pure; no GPU objects).
 *
 * @param atmosphereDensity - The atmosphere's `cloudDensity`.
 * @param opts - Layout knobs.
 * @returns Clouds in layer-local space.
 */
export function layoutClouds(atmosphereDensity: number, opts: CloudLayerOptions = {}): CloudSpec[] {
  const rng = new DecorRandom(opts.seed ?? 7);
  const count = Math.max(1, Math.round((opts.count ?? 36) * Math.max(atmosphereDensity, 0.2)));
  const inner = opts.innerRadius ?? 70;
  const wrap = opts.wrapRadius ?? 360;
  const [hMin, hMax] = opts.heightRange ?? [-45, 70];
  const origin = opts.origin ?? { x: 0, y: 0, z: 0 };

  const puffsPerCloud: number[] = [];
  for (let i = 0; i < count; i++) puffsPerCloud.push(rng.int(4, 8));

  const clouds: CloudSpec[] = [];
  for (let c = 0; c < count; c++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(inner, wrap * 0.95);
    const center = { x: Math.cos(ang) * rad, y: rng.range(hMin, hMax), z: Math.sin(ang) * rad };
    const size = rng.range(5, 13);
    const speed = rng.range(0.6, 1.4);
    const n = puffsPerCloud[c]!;
    const puffs: CloudPuff[] = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const along = (t - 0.5) * size * 2.6;
      const r = size * (0.55 + Math.sin(t * Math.PI) * 0.6) * rng.range(0.75, 1.05);
      const pos = {
        x: center.x + along,
        y: center.y + Math.sin(t * Math.PI) * size * 0.35 + rng.range(-0.3, 0.6) * size * 0.3,
        z: center.z + rng.range(-0.4, 0.4) * size,
      };
      // Flattened puffs read as cumulus with a flat base.
      puffs.push({ pos, scale: { x: r * rng.range(1.0, 1.25), y: r * 0.72, z: r * rng.range(0.85, 1.1) } });
    }
    const cloud: CloudSpec = { center, speed, puffs, lane: laneOf(puffs) };
    if (opts.keepOut) clearLane(cloud, origin, opts.keepOut);
    clouds.push(cloud);
  }
  return clouds;
}

const m4 = new Matrix4();
const q = new Quaternion();
const p = new Vector3();
const s = new Vector3();

/**
 * Builds a cloud layer centred on the parent's origin.
 *
 * @param atmosphere - Initial colours, density and wind.
 * @param opts - Layout knobs.
 */
export function createCloudLayer(atmosphere: Atmosphere, opts: CloudLayerOptions = {}): CloudLayer {
  const wrap = opts.wrapRadius ?? 360;
  const clouds = layoutClouds(atmosphere.cloudDensity, opts);
  let total = 0;
  for (const c of clouds) total += c.puffs.length;

  const geo = new IcosahedronGeometry(1, 3);
  const drift = new Float32Array(total * 3);
  const centers = new Float32Array(total * 3);
  const driftAttr = new InstancedBufferAttribute(drift, 3);
  const centerAttr = new InstancedBufferAttribute(centers, 3);

  const travelled = uniform(0);
  let windSpeed = 2;
  const wrapR = uniform(wrap);
  const tint = uniform(new Color());
  const shade = uniform(new Color());
  const sunDir = uniform(new Vector3(0, 1, 0));

  const aDrift = instancedBufferAttribute(driftAttr) as unknown as Node<'vec3'>;
  const aCenter = instancedBufferAttribute(centerAttr) as unknown as Node<'vec3'>;
  const cx = aDrift.x;
  const speed = aDrift.y;
  const travel = cx.add(travelled.mul(speed)).add(wrapR);
  const offset = mod(travel, wrapR.mul(2)).sub(wrapR).sub(cx);
  const shift = vec3(offset, float(0), float(0));
  const centre = aCenter.add(shift);
  const centreWorld = modelWorldMatrix.mul(vec4(centre, 1)).xyz;
  const shrink = smoothstep(FADE_NEAR, FADE_FAR, distance(centreWorld, cameraPosition));

  const mat = new MeshBasicNodeMaterial({ fog: true });
  mat.positionNode = centre.add(positionLocal.add(shift).sub(centre).mul(shrink));
  const n = normalWorld.normalize();
  const lit = n.dot(sunDir).mul(0.6).add(n.y.mul(0.4));
  const band = smoothstep(-0.15, 0.25, lit);
  mat.colorNode = mix(shade, tint, band).add(vec3(0.04, 0.04, 0.05).mul(smoothstep(0.55, 0.9, lit)));

  const mesh = new InstancedMesh(geo, mat, total);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  let k = 0;
  for (let c = 0; c < clouds.length; c++) {
    const cloud = clouds[c]!;
    for (const puff of cloud.puffs) {
      p.set(puff.pos.x, puff.pos.y, puff.pos.z);
      s.set(puff.scale.x, puff.scale.y, puff.scale.z);
      q.identity();
      m4.compose(p, q, s);
      mesh.setMatrixAt(k, m4);
      drift[k * 3] = cloud.center.x;
      drift[k * 3 + 1] = cloud.speed;
      drift[k * 3 + 2] = c;
      centers[k * 3] = cloud.center.x;
      centers[k * 3 + 1] = cloud.center.y;
      centers[k * 3 + 2] = cloud.center.z;
      k++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;

  const api: CloudLayer = {
    object: mesh,
    clouds,
    setAtmosphere(a: Atmosphere): void {
      tint.value.copy(a.cloudTint);
      shade.value.copy(a.cloudShade);
      sunDir.value.copy(a.sunDirection);
      windSpeed = 1.2 + a.wind * 9;
    },
    update(dt: number): void {
      travelled.value += dt * windSpeed;
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
  api.setAtmosphere(atmosphere);
  return api;
}
