import type { BufferGeometry } from 'three/webgpu';
import {
  BufferAttribute,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
  type Node,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, mod, positionLocal, sin, smoothstep, uniform, vec3, float } from 'three/tsl';
import { createToonMaterial } from '../materials/toon.ts';
import { DecorRandom } from '../level/toolkit.ts';
import { keepOutHitsBox, type BoxLike, type KeepOut, type Vec3Like } from './dressing.ts';

/** Blimp hull half length and radius at its 1.6× instance scale (capsule 1.8 r, 6 long). */
const BLIMP_HALF_LENGTH = 7.7;
const BLIMP_RADIUS = 3;
/** Balloon envelope radius at the largest instance scale, plus sway. */
const BALLOON_REACH = 2.6;

/**
 * Box a balloon sweeps: it rises through `range` metres centred on its spawn
 * point (wrapping), swaying sideways a little.
 *
 * @returns The balloon's column.
 */
export function balloonColumn(c: Vec3Like, range: number): BoxLike {
  return {
    min: { x: c.x - BALLOON_REACH, y: c.y - range / 2 - BALLOON_REACH, z: c.z - BALLOON_REACH },
    max: { x: c.x + BALLOON_REACH, y: c.y + range / 2 + BALLOON_REACH, z: c.z + BALLOON_REACH },
  };
}

/**
 * True when a blimp flying the orbit (bob included) would touch the keep-out.
 *
 * @param center - Orbit centre (the course centre).
 */
export function blimpOrbitHits(k: KeepOut, center: Vec3Like, orbit: BlimpOrbit): boolean {
  const steps = Math.max(32, Math.ceil((orbit.radius * Math.PI * 2) / BLIMP_HALF_LENGTH));
  const r = BLIMP_HALF_LENGTH + 2;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = {
      x: center.x + Math.cos(a) * orbit.radius,
      y: orbit.height,
      z: center.z + Math.sin(a) * orbit.radius,
    };
    const hull: BoxLike = {
      min: { x: c.x - r, y: c.y - BLIMP_RADIUS - 1.5, z: c.z - r },
      max: { x: c.x + r, y: c.y + BLIMP_RADIUS + 1.5, z: c.z + r },
    };
    if (keepOutHitsBox(k, hull)) return true;
  }
  return false;
}
/**
 * Sky traffic: drifting party balloons (GPU-animated, 1 draw) and a few slow
 * blimps circling the course (2 draws, 3 CPU matrices per frame).
 */

/** Options for {@link createSkyTraffic}. */
export interface SkyTrafficOptions {
  seed?: number;
  colors: readonly string[];
  balloons?: number;
  blimps?: number;
  center?: { x: number; y: number; z: number };
  /** Balloons spawn between these radii from the centre. */
  innerRadius?: number;
  outerRadius?: number;
  /** Volume no balloon's rise column and no blimp orbit may touch. */
  keepOut?: KeepOut;
}

/** One blimp's circular route around the course centre. */
export interface BlimpOrbit {
  radius: number;
  height: number;
}

/** Live sky traffic. */
export interface SkyTraffic {
  readonly meshes: InstancedMesh[];
  /** World boxes each balloon sweeps while it rises and loops. */
  readonly balloonColumns: readonly BoxLike[];
  readonly blimpOrbits: readonly BlimpOrbit[];
  update(dt: number): void;
  dispose(): void;
}

function flat(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes))
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(arr, 3));
  return g;
}

function balloonGeometry(): BufferGeometry {
  const body = new IcosahedronGeometry(1, 2);
  body.scale(1, 1.2, 1);
  const knot = new ConeGeometry(0.16, 0.22, 8);
  knot.rotateX(Math.PI);
  knot.translate(0, -1.27, 0);
  const string = new CylinderGeometry(0.015, 0.015, 2.6, 4);
  string.translate(0, -2.6, 0);
  return mergeGeometries([flat(body, '#ffffff'), flat(knot, '#ffffff'), flat(string, '#f2f2f2')])!;
}

function blimpTrimGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const fin = new RoundedBoxGeometry(1.8, 0.12, 1.6, 1, 0.05);
    fin.translate(0, 0, 0.9);
    fin.rotateX((i / 4) * Math.PI * 2 + Math.PI / 4);
    fin.translate(-4.4, 0, 0);
    parts.push(flat(fin, '#ffffff'));
  }
  const gondola = new RoundedBoxGeometry(2.4, 0.8, 1, 2, 0.25);
  gondola.translate(0.4, -1.95, 0);
  parts.push(flat(gondola, '#ffd23f'));
  const band = new TorusGeometry(1.74, 0.12, 8, 32);
  band.rotateY(Math.PI / 2);
  band.translate(1.2, 0, 0);
  parts.push(flat(band, '#ffffff'));
  const band2 = new TorusGeometry(1.74, 0.12, 8, 32);
  band2.rotateY(Math.PI / 2);
  band2.translate(-0.4, 0, 0);
  parts.push(flat(band2, '#ff4f8b'));
  return mergeGeometries(parts)!;
}

interface Blimp {
  radius: number;
  height: number;
  speed: number;
  phase: number;
}

/**
 * Creates drifting balloons and circling blimps.
 *
 * @param opts - Colours, counts and placement.
 */
export function createSkyTraffic(opts: SkyTrafficOptions): SkyTraffic {
  const rng = new DecorRandom(opts.seed ?? 23);
  const center = opts.center ?? { x: 0, y: 0, z: 0 };
  const nBalloons = opts.balloons ?? 40;
  const nBlimps = opts.blimps ?? 3;
  const inner = opts.innerRadius ?? 50;
  const outer = opts.outerRadius ?? 200;
  const time = uniform(0);
  const meshes: InstancedMesh[] = [];
  const balloonColumns: BoxLike[] = [];
  const m4 = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();
  const one = new Vector3(1, 1, 1);
  const tint = new Color();

  if (nBalloons > 0) {
    const geo = balloonGeometry();
    const centers = new Float32Array(nBalloons * 3);
    const motion = new Float32Array(nBalloons * 3);
    const mat = createToonMaterial({ color: '#ffffff', rimStrength: 0.6 });
    mat.vertexColors = true;
    const aC = attribute('aCenter', 'vec3') as unknown as Node<'vec3'>;
    const aM = attribute('aMotion', 'vec3') as unknown as Node<'vec3'>;
    const range = aM.z;
    const f = mod(time.mul(aM.y).add(aM.x.mul(range)), range).div(range);
    const rise = f.sub(0.5).mul(range);
    const fade = smoothstep(0.0, 0.08, f).mul(smoothstep(1.0, 0.92, f));
    const sway = vec3(
      sin(time.mul(0.7).add(aM.x.mul(20.0))).mul(0.6),
      float(0),
      sin(time.mul(0.5).add(aM.x.mul(13.0))).mul(0.6),
    );
    mat.positionNode = aC
      .add(positionLocal.sub(aC).mul(fade))
      .add(vec3(float(0), rise, float(0)))
      .add(sway);

    const balloonMesh = new InstancedMesh(geo, mat, nBalloons);
    for (let i = 0; i < nBalloons; i++) {
      const a = rng.range(0, Math.PI * 2);
      let d = rng.range(inner, outer);
      v.set(center.x + Math.cos(a) * d, center.y + rng.range(-10, 40), center.z + Math.sin(a) * d);
      const s = rng.range(0.9, 1.5);
      const range = rng.range(70, 130);
      // A rising column through a flyover sightline would sweep balloons across the camera; push it outward.
      for (let k = 0; k < 60 && opts.keepOut && keepOutHitsBox(opts.keepOut, balloonColumn(v, range)); k++) {
        d += 6;
        v.set(center.x + Math.cos(a) * d, v.y, center.z + Math.sin(a) * d);
      }
      m4.compose(v, q.identity(), one.set(s, s, s));
      balloonMesh.setMatrixAt(i, m4);
      balloonMesh.setColorAt(i, tint.set(rng.pick(opts.colors)));
      centers.set([v.x, v.y, v.z], i * 3);
      motion.set([rng.next(), rng.range(0.8, 2.2), range], i * 3);
      balloonColumns.push(balloonColumn(v, range));
    }
    geo.setAttribute('aCenter', new InstancedBufferAttribute(centers, 3));
    geo.setAttribute('aMotion', new InstancedBufferAttribute(motion, 3));
    balloonMesh.frustumCulled = false;
    balloonMesh.name = 'sky-balloons';
    meshes.push(balloonMesh);
  }

  const blimps: Blimp[] = [];
  let body: InstancedMesh | null = null;
  let trim: InstancedMesh | null = null;
  if (nBlimps > 0) {
    const bodyGeo = new CapsuleGeometry(1.8, 6, 8, 20);
    bodyGeo.rotateZ(Math.PI / 2);
    bodyGeo.scale(1, 1, 1);
    body = new InstancedMesh(bodyGeo, createToonMaterial({ color: '#ffffff', rimStrength: 0.5 }), nBlimps);
    const trimMat = createToonMaterial({ color: '#ffffff', rimStrength: 0.4 });
    trimMat.vertexColors = true;
    trim = new InstancedMesh(blimpTrimGeometry(), trimMat, nBlimps);
    for (let i = 0; i < nBlimps; i++) {
      const blimp: Blimp = {
        radius: rng.range(outer * 0.6, outer * 1.05),
        height: center.y + rng.range(35, 70),
        speed: rng.range(0.012, 0.025) * (rng.next() < 0.5 ? -1 : 1),
        phase: rng.range(0, Math.PI * 2),
      };
      // Long courses reach past the orbit ring; climb over the keep-out rather than through it.
      for (let k = 0; k < 100 && opts.keepOut && blimpOrbitHits(opts.keepOut, center, blimp); k++)
        blimp.height += 4;
      blimps.push(blimp);
      body.setColorAt(i, tint.set(rng.pick(opts.colors)));
    }
    for (const m of [body, trim]) {
      m.frustumCulled = false;
      m.castShadow = false;
      meshes.push(m);
    }
    body.name = 'sky-blimps';
    trim.name = 'sky-blimps-trim';
  }

  let t = 0;
  const yawQ = new Quaternion();
  const up = new Vector3(0, 1, 0);
  return {
    meshes,
    balloonColumns,
    blimpOrbits: blimps.map((b) => ({ radius: b.radius, height: b.height })),
    update(dt: number): void {
      t += dt;
      time.value = t;
      if (!body || !trim) return;
      for (let i = 0; i < blimps.length; i++) {
        const b = blimps[i]!;
        const a = b.phase + t * b.speed;
        v.set(
          center.x + Math.cos(a) * b.radius,
          b.height + Math.sin(t * 0.3 + b.phase) * 1.5,
          center.z + Math.sin(a) * b.radius,
        );
        // Nose (+X) points along the direction of travel.
        yawQ.setFromAxisAngle(up, -a - (b.speed > 0 ? Math.PI / 2 : -Math.PI / 2));
        m4.compose(v, yawQ, one.set(1.6, 1.6, 1.6));
        body.setMatrixAt(i, m4);
        trim.setMatrixAt(i, m4);
      }
      body.instanceMatrix.needsUpdate = true;
      trim.instanceMatrix.needsUpdate = true;
    },
    dispose(): void {
      for (const m of meshes) {
        m.geometry.dispose();
        (m.material as { dispose(): void }).dispose();
        m.dispose();
      }
    },
  };
}
