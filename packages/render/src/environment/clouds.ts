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
  float,
  instancedBufferAttribute,
  mix,
  mod,
  normalWorld,
  positionLocal,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { DecorRandom } from '../level/toolkit.ts';
import type { Atmosphere } from './atmosphere.ts';

/**
 * Drifting cartoon cloud puffs. Every puff of every cloud is one instance of a
 * single InstancedMesh (1 draw call). Drift and wrap-around run in the vertex
 * shader from a travelled-distance uniform, so the CPU never touches instance matrices after
 * build. Puffs of one cloud share a centre attribute so they wrap together.
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
}

/** Live cloud layer. */
export interface CloudLayer {
  readonly object: InstancedMesh;
  setAtmosphere(a: Atmosphere): void;
  update(dt: number): void;
  dispose(): void;
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
  const rng = new DecorRandom(opts.seed ?? 7);
  const count = Math.max(1, Math.round((opts.count ?? 36) * Math.max(atmosphere.cloudDensity, 0.2)));
  const inner = opts.innerRadius ?? 70;
  const wrap = opts.wrapRadius ?? 360;
  const [hMin, hMax] = opts.heightRange ?? [-45, 70];

  const puffsPerCloud: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const n = rng.int(4, 8);
    puffsPerCloud.push(n);
    total += n;
  }

  const geo = new IcosahedronGeometry(1, 3);
  const drift = new Float32Array(total * 3);
  const driftAttr = new InstancedBufferAttribute(drift, 3);

  const travelled = uniform(0);
  let windSpeed = 2;
  const wrapR = uniform(wrap);
  const tint = uniform(new Color());
  const shade = uniform(new Color());
  const sunDir = uniform(new Vector3(0, 1, 0));

  const aDrift = instancedBufferAttribute(driftAttr) as unknown as Node<'vec3'>;
  const cx = aDrift.x;
  const speed = aDrift.y;
  const travel = cx.add(travelled.mul(speed)).add(wrapR);
  const offset = mod(travel, wrapR.mul(2)).sub(wrapR).sub(cx);

  const mat = new MeshBasicNodeMaterial({ fog: true });
  mat.positionNode = positionLocal.add(vec3(offset, float(0), float(0)));
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
  for (let c = 0; c < count; c++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(inner, wrap * 0.95);
    const center = new Vector3(Math.cos(ang) * rad, rng.range(hMin, hMax), Math.sin(ang) * rad);
    const size = rng.range(5, 13);
    const spd = rng.range(0.6, 1.4);
    const n = puffsPerCloud[c]!;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const along = (t - 0.5) * size * 2.6;
      const r = size * (0.55 + Math.sin(t * Math.PI) * 0.6) * rng.range(0.75, 1.05);
      p.set(
        center.x + along,
        center.y + Math.sin(t * Math.PI) * size * 0.35 + rng.range(-0.3, 0.6) * size * 0.3,
        center.z + rng.range(-0.4, 0.4) * size,
      );
      // Flattened puffs read as cumulus with a flat base.
      s.set(r * rng.range(1.0, 1.25), r * 0.72, r * rng.range(0.85, 1.1));
      q.identity();
      m4.compose(p, q, s);
      mesh.setMatrixAt(k, m4);
      drift[k * 3] = center.x;
      drift[k * 3 + 1] = spd;
      drift[k * 3 + 2] = c;
      k++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;

  const api: CloudLayer = {
    object: mesh,
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
