import type { BufferGeometry } from 'three/webgpu';
import {
  BufferAttribute,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
  type Node,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { abs, attribute, float, positionLocal, sin, uniform, vec3 } from 'three/tsl';
import { createToonMaterial } from '../materials/toon.ts';
import { DecorRandom } from '../level/toolkit.ts';

/**
 * Spectator stands: candy-striped bleachers filled with bobbing mini Tumblers.
 * All stands share 3 draw calls (bleachers, bodies, visors). Hopping is a vertex
 * shader effect driven by an `excitement` uniform, so a cheer costs one write.
 */

/** One stand placement. */
export interface CrowdStandPlacement {
  /** Front-centre of the stand at floor level. */
  position: { x: number; y: number; z: number };
  /** Radians; the crowd faces local -Z rotated by this yaw. */
  yaw: number;
  /** Stand width in metres. Default 16. */
  width?: number;
  /** Number of seat rows. Default 4. */
  rows?: number;
}

/** Options for {@link createCrowd}. */
export interface CrowdOptions {
  stands: readonly CrowdStandPlacement[];
  /** Body colours for spectators. */
  colors: readonly string[];
  /** Bleacher stripe colours [a, b]. */
  stripe: [string, string];
  seed?: number;
  /** Fraction of seats filled. Default 0.85. */
  density?: number;
}

/** Live crowd. */
export interface Crowd {
  readonly object: Group;
  readonly spectatorCount: number;
  /** Kick the crowd's excitement (0..1+); decays over ~2 s. */
  cheer(amount?: number): void;
  update(dt: number): void;
  dispose(): void;
}

function painted(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes))
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(arr, 3));
  return g;
}

/** Gumdrop body profile, ~1 m tall, shared with the placeholder Tumbler look. */
export function createGumdropGeometry(height = 1, radius = 0.4, segments = 14): BufferGeometry {
  const pts: Vector2[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = t * height;
    const bulge = Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5);
    const top = t > 0.7 ? Math.cos(((t - 0.7) / 0.3) * Math.PI * 0.5) : 1;
    const r = radius * (0.82 + 0.18 * bulge) * top;
    pts.push(new Vector2(Math.max(r, 0.001), y));
  }
  pts[0]!.set(0.001, 0);
  pts.splice(1, 0, new Vector2(radius * 0.8, 0));
  return new LatheGeometry(pts, segments);
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpP = new Vector3();
const tmpS = new Vector3(1, 1, 1);
const up = new Vector3(0, 1, 0);

/**
 * Builds spectator stands with a bobbing crowd.
 *
 * @param opts - Stand placements and colours.
 */
export function createCrowd(opts: CrowdOptions): Crowd {
  const rng = new DecorRandom(opts.seed ?? 5);
  const density = opts.density ?? 0.85;
  const object = new Group();
  object.name = 'crowd';

  const bleacherParts: BufferGeometry[] = [];
  const seats: { pos: Vector3; yaw: number }[] = [];
  for (const st of opts.stands) {
    const width = st.width ?? 16;
    const rows = st.rows ?? 4;
    const standM = new Matrix4().compose(
      new Vector3(st.position.x, st.position.y, st.position.z),
      new Quaternion().setFromAxisAngle(up, st.yaw),
      new Vector3(1, 1, 1),
    );
    const local: BufferGeometry[] = [];
    for (let r = 0; r < rows; r++) {
      const step = new RoundedBoxGeometry(width, 0.6 + r * 0.7, 1.3, 2, 0.12);
      step.translate(0, (0.6 + r * 0.7) / 2, r * 1.3 + 0.65);
      local.push(painted(step, r % 2 === 0 ? opts.stripe[0] : opts.stripe[1]));
      const cols = Math.floor(width / 0.95);
      for (let c = 0; c < cols; c++) {
        if (rng.next() > density) continue;
        const x = -width / 2 + 0.5 + c * 0.95 + rng.range(-0.08, 0.08);
        const p = new Vector3(x, 0.6 + r * 0.7, r * 1.3 + 0.6).applyMatrix4(standM);
        seats.push({ pos: p, yaw: st.yaw + Math.PI + rng.range(-0.25, 0.25) });
      }
    }
    const back = new RoundedBoxGeometry(width + 0.6, rows * 0.7 + 3.2, 0.5, 2, 0.15);
    back.translate(0, (rows * 0.7 + 3.2) / 2, rows * 1.3 + 0.3);
    local.push(painted(back, opts.stripe[1]));
    const stripes = 8;
    for (let i = 0; i < stripes; i++) {
      const seg = new RoundedBoxGeometry(width / stripes + 0.02, 0.25, rows * 1.3 + 1.2, 1, 0.08);
      seg.rotateX(-0.22);
      seg.translate(-width / 2 + (i + 0.5) * (width / stripes), rows * 0.7 + 3.0, (rows * 1.3) / 2);
      local.push(painted(seg, i % 2 === 0 ? opts.stripe[0] : '#ffffff'));
    }
    for (const sx of [-1, 1]) {
      const post = new RoundedBoxGeometry(0.35, rows * 0.7 + 3.2, 0.35, 1, 0.1);
      post.translate((sx * width) / 2, (rows * 0.7 + 3.2) / 2, 0.2);
      local.push(painted(post, '#ffffff'));
    }
    for (const g of local) {
      g.applyMatrix4(standM);
      bleacherParts.push(g);
    }
  }

  const bleacherMat = createToonMaterial({ color: '#ffffff', rimStrength: 0.35 });
  bleacherMat.vertexColors = true;
  const merged = bleacherParts.length > 0 ? mergeGeometries(bleacherParts) : null;
  for (const g of bleacherParts) g.dispose();
  const bleachers = merged ? new Mesh(merged, bleacherMat) : null;
  if (bleachers) {
    bleachers.castShadow = true;
    bleachers.receiveShadow = true;
    bleachers.name = 'crowd-bleachers';
    object.add(bleachers);
  }

  const time = uniform(0);
  const excitement = uniform(0.25);
  const spectatorMat = createToonMaterial({ color: '#ffffff', rimStrength: 0.5 });
  const aCrowd = attribute('aCrowd', 'vec2') as unknown as Node<'vec2'>;
  const hop = abs(sin(time.mul(aCrowd.y).add(aCrowd.x))).mul(float(0.06).add(excitement.mul(0.42)));
  spectatorMat.positionNode = positionLocal.add(vec3(float(0), hop, float(0)));

  const count = seats.length;
  const bodyGeo = createGumdropGeometry(0.95, 0.36, 12);
  const visorGeo = new SphereGeometry(0.24, 12, 8);
  visorGeo.scale(1.15, 0.8, 0.55);
  visorGeo.translate(0, 0.6, 0.27);
  const crowdAttr = new Float32Array(count * 2);
  const bodies = new InstancedMesh(bodyGeo, spectatorMat, Math.max(count, 1));
  const visors = new InstancedMesh(visorGeo, spectatorMat, Math.max(count, 1));
  const col = new Color();
  const white = new Color('#ffffff');
  seats.forEach((s, i) => {
    tmpQ.setFromAxisAngle(up, s.yaw);
    tmpP.copy(s.pos);
    tmpM.compose(tmpP, tmpQ, tmpS);
    bodies.setMatrixAt(i, tmpM);
    visors.setMatrixAt(i, tmpM);
    bodies.setColorAt(i, col.set(rng.pick(opts.colors)));
    visors.setColorAt(i, white);
    crowdAttr[i * 2] = rng.range(0, Math.PI * 2);
    crowdAttr[i * 2 + 1] = rng.range(5, 9);
  });
  bodies.count = count;
  visors.count = count;
  const attr = new InstancedBufferAttribute(crowdAttr, 2);
  bodyGeo.setAttribute('aCrowd', attr);
  visorGeo.setAttribute('aCrowd', attr);
  for (const m of [bodies, visors]) {
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = true;
    m.computeBoundingSphere();
    object.add(m);
  }
  bodies.name = 'crowd-bodies';
  visors.name = 'crowd-visors';

  let level = 0.25;
  return {
    object,
    spectatorCount: count,
    cheer(amount = 1): void {
      level = Math.max(level, amount);
    },
    update(dt: number): void {
      time.value += dt;
      level += (0.22 - level) * (1 - Math.exp(-dt * 0.8));
      excitement.value = level;
    },
    dispose(): void {
      merged?.dispose();
      bleacherMat.dispose();
      bodyGeo.dispose();
      visorGeo.dispose();
      spectatorMat.dispose();
      bodies.dispose();
      visors.dispose();
      object.removeFromParent();
    },
  };
}
