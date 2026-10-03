/**
 * Prop visuals: speckled team eggs, giant beach balls, fluffy ribbon tails,
 * the gem-studded Crown (with a travelling shine and orbiting glints), keys
 * and toy blocks. One InstancedMesh (+ outline twin) per spawner.
 *
 * Props are replicated, non-pure state: when a runtime is supplied the visual
 * reads every prop's live transform/mode from it; without one (gallery) props
 * sit at home on the sim's pure bob/spin pose.
 */
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type MeshToonNodeMaterial,
} from 'three/webgpu';
import {
  atan,
  color,
  float,
  floor,
  fract,
  hash,
  mix,
  positionLocal,
  sin,
  smoothstep,
  step,
  time,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEAM_COLORS } from '@tumble/shared';
import type { ObstacleRuntime, PoseSample } from '@tumble/sim';
import {
  PROP_SPECS,
  PropMode,
  PropSpawnerSchema,
  propCount,
  propSpawnerPose,
  type PropKind,
  type PropSpawnerParams,
  type PropSpawnerRuntime,
} from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import { createOutlineMaterial } from '../materials/outline.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  addEmissive,
  instanceMatrix,
  parseParams,
  roundedBox,
  toon,
} from './visual-helpers-b.ts';

const BLOCK_COLORS = [PAL.pink, PAL.cyan, PAL.yellow, PAL.mint, PAL.violet, PAL.orange];
const GLINTS_PER_CROWN = 8;

function isPropRuntime(rt: ObstacleRuntime | undefined): rt is PropSpawnerRuntime {
  return !!rt && typeof (rt as Partial<PropSpawnerRuntime>).getTransform === 'function';
}

/** Unit-scale geometry per kind (instance scale = kind size × params.scale). */
function kindGeometry(d: Disposer, kind: PropKind): BufferGeometry {
  switch (kind) {
    case 'egg':
    case 'ball':
      return d.track(new SphereGeometry(1, 32, 22));
    case 'tail': {
      const parts: BufferGeometry[] = [];
      const radii = [0.36, 0.33, 0.3, 0.26, 0.21, 0.15];
      radii.forEach((r, i) => parts.push(new SphereGeometry(r, 16, 12).translate(0, -0.7 + i * 0.27, 0)));
      const g = mergeGeometries(parts);
      parts.forEach((p) => p.dispose());
      return d.track(g);
    }
    case 'crown': {
      const parts: BufferGeometry[] = [new CylinderGeometry(1, 0.9, 0.5, 40, 1, true)];
      parts.push(new TorusGeometry(0.95, 0.08, 8, 40).rotateX(Math.PI / 2).translate(0, -0.25, 0));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        parts.push(new ConeGeometry(0.24, 0.55, 12).translate(Math.cos(a) * 0.95, 0.52, Math.sin(a) * 0.95));
      }
      const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
      parts.forEach((p) => p.dispose());
      return d.track(g);
    }
    case 'key': {
      const parts: BufferGeometry[] = [
        new TorusGeometry(0.34, 0.11, 10, 24).translate(0, 0.62, 0),
        new BoxGeometry(0.16, 1.3, 0.14).translate(0, -0.2, 0),
        new BoxGeometry(0.32, 0.14, 0.14).translate(0.16, -0.75, 0),
        new BoxGeometry(0.24, 0.12, 0.14).translate(0.12, -0.48, 0),
      ];
      const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
      parts.forEach((p) => p.dispose());
      return d.track(g);
    }
    default:
      return roundedBox(d, 1, 1, 1, 0.25, 3);
  }
}

/** Kind-specific toon material. */
function kindMaterial(d: Disposer, p: PropSpawnerParams): MeshToonNodeMaterial {
  const L = positionLocal;
  switch (p.kind) {
    case 'egg': {
      const base = p.team >= 0 ? TEAM_COLORS[p.team]! : PAL.cream;
      const mat = toon(d, { color: '#ffffff', rimStrength: 0.7, rimColor: '#ffffff' });
      const cell = floor(L.mul(6.5));
      const speck = step(float(0.78), hash(cell.x.add(cell.y.mul(31)).add(cell.z.mul(97))));
      const baseC = color(new Color(base));
      mat.colorNode = mix(baseC, baseC.mul(0.62), speck);
      return mat;
    }
    case 'ball': {
      const mat = toon(d, { color: '#ffffff', rimStrength: 0.6 });
      const seg = floor(
        atan(L.z, L.x)
          .div(Math.PI * 2)
          .add(0.5)
          .mul(6),
      );
      const k = fract(seg.div(3)).mul(3);
      const c0 = color(new Color(PAL.pink));
      const c1 = color(new Color(PAL.yellow));
      const c2 = color(new Color(PAL.cyan));
      const panel = mix(mix(c0, c1, step(float(0.5), k)), c2, step(float(1.5), k));
      mat.colorNode = mix(panel, color(new Color('#ffffff')), step(float(0.86), L.y.abs()));
      return mat;
    }
    case 'tail': {
      const mat = toon(d, { color: '#ffffff', rimStrength: 0.8, rimColor: '#fff6e8' });
      const band = step(float(0.5), fract(L.y.mul(2.6)));
      mat.colorNode = mix(color(new Color(PAL.orange)), color(new Color(PAL.cream)), band);
      // Fluffy sway: more toward the tip (+Y).
      const tip = L.y.add(0.7).max(0);
      mat.positionNode = L.add(
        vec3(
          sin(time.mul(7).add(L.y.mul(3)))
            .mul(tip)
            .mul(0.12),
          0,
          sin(time.mul(5.3)).mul(tip).mul(0.08),
        ),
      );
      return mat;
    }
    case 'crown': {
      const mat = toon(d, { color: PAL.gold, rimColor: '#fff3c0', rimStrength: 0.9 });
      mat.side = DoubleSide;
      const sweep = sin(L.x.add(L.y.mul(2)).add(L.z).mul(3).sub(time.mul(3.5)));
      addEmissive(mat, color(new Color('#fff6c8')).mul(smoothstep(float(0.93), float(1), sweep).mul(1.4)));
      return mat;
    }
    case 'key':
      return toon(d, { color: PAL.yellow, rimStrength: 0.8, emissive: PAL.yellow, emissiveIntensity: 0.15 });
    default:
      return toon(d, { color: '#ffffff', rimStrength: 0.55 });
  }
}

/** Gem geometry for crowns (tips + band jewels). */
function crownGems(d: Disposer): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(new SphereGeometry(0.12, 10, 8).translate(Math.cos(a) * 0.95, 0.82, Math.sin(a) * 0.95));
    const b = a + Math.PI / 5;
    parts.push(new SphereGeometry(0.13, 10, 8).translate(Math.cos(b) * 1.0, 0, Math.sin(b) * 1.0));
  }
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return d.track(g);
}

/** Creates the Prop Spawner visual. */
export const propSpawnerVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(PropSpawnerSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `propSpawner:${instance.id}`;
  const n = propCount(p);
  const spec = PROP_SPECS[p.kind];
  const size = spec.size * p.scale;

  const geo = kindGeometry(d, p.kind);
  const mat = kindMaterial(d, p);
  const mesh = new InstancedMesh(geo, mat, n);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const outline = new InstancedMesh(geo, d.track(createOutlineMaterial(p.kind === 'ball' ? 0.025 : 0.05)), n);
  outline.instanceMatrix = mesh.instanceMatrix;
  outline.frustumCulled = false;
  root.add(mesh);
  if (p.kind !== 'crown') root.add(outline);
  if (p.kind === 'block') {
    const c = new Color();
    for (let i = 0; i < n; i++) mesh.setColorAt(i, c.set(BLOCK_COLORS[i % BLOCK_COLORS.length]!));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  let glints: Sparkles | null = null;
  if (p.kind === 'crown') {
    const gems = new InstancedMesh(
      crownGems(d),
      toon(d, {
        color: PAL.magenta,
        emissive: PAL.pink,
        emissiveIntensity: 0.6,
        rimColor: '#ffffff',
        rimStrength: 0.9,
      }),
      n,
    );
    gems.instanceMatrix = mesh.instanceMatrix;
    gems.frustumCulled = false;
    root.add(gems);
    glints = new Sparkles(d, GLINTS_PER_CROWN * n, '#fffbe0', 0.14);
    root.add(glints.mesh);
  }

  // Non-uniform base shape per kind (eggs are tall); applied after the prop transform.
  const shape = new Vector3(size, size, size);
  if (p.kind === 'egg') shape.set(size * 0.85, size * 1.15, size * 0.85);

  const inst = instanceMatrix(instance, new Matrix4());
  const local = new Matrix4();
  const m = new Matrix4();
  const pos = new Vector3();
  const q = new Quaternion();
  const zero = new Vector3(0, 0, 0);
  const pv = { x: 0, y: 0, z: 0 };
  const pq = { x: 0, y: 0, z: 0, w: 1 };
  const samples: PoseSample[] = [];

  return {
    object: root,
    update(t, _dt, runtime) {
      const live = isPropRuntime(runtime) ? runtime : null;
      if (!live) propSpawnerPose(t, p, samples, ctx.speedScale);
      for (let i = 0; i < n; i++) {
        let visible = true;
        if (live) {
          live.getTransform(i, pv, pq);
          visible = live.mode(i) !== PropMode.Respawning;
          pos.set(pv.x, pv.y, pv.z);
          q.set(pq.x, pq.y, pq.z, pq.w);
          m.compose(pos, q, visible ? shape : zero);
        } else {
          const s = samples[i]!;
          pos.set(s.pos.x, s.pos.y, s.pos.z);
          q.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
          local.compose(pos, q, shape);
          m.multiplyMatrices(inst, local);
          pos.setFromMatrixPosition(m);
        }
        mesh.setMatrixAt(i, m);
        if (glints) {
          for (let g = 0; g < GLINTS_PER_CROWN; g++) {
            const a = t * 1.6 + (g / GLINTS_PER_CROWN) * Math.PI * 2;
            const r = size * 1.6;
            const tw = 0.5 + 0.5 * Math.sin(t * 7 + g * 2.1);
            glints.set(
              i * GLINTS_PER_CROWN + g,
              pos.x + Math.cos(a) * r,
              pos.y + Math.sin(a * 2) * size * 0.4,
              pos.z + Math.sin(a) * r,
              visible ? tw : 0,
            );
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      glints?.commit();
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
