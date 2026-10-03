import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three/webgpu';
import { abs, float, fract, max, mix, smoothstep, uniform, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEAM_COLORS, type RoundDefinition, type StaticPiece, type TriggerDef } from '@tumble/shared';
import { resolveThemeColor, type ThemeDefinition } from '@tumble/content/themes';
import {
  createEdgeRailGeometry,
  createPieceGeometry,
  createRimRingGeometry,
  type GeometryDetail,
} from './geometry.ts';
import {
  createGrabTrimMaterial,
  createLevelMaterial,
  createLevelUniforms,
  type LevelUniforms,
  type PatternKind,
  type SurfaceKind,
} from './materials.ts';
import { createVoidSurface, type VoidVisual } from './void.ts';
import { quaternionFromRotation } from './toolkit.ts';

/**
 * LevelBuilder: turns a round's static geometry into chunky toy meshes.
 *
 * Strategy: every piece is tessellated once, baked into world space with its
 * resolved palette colour as a vertex attribute, then merged by
 * (surface, pattern, decorative, spatial cell). Draw calls therefore scale with
 * the number of distinct looks × cells, not with piece count — a 400-piece
 * course is ~20–40 draws. Spatial cells keep frustum culling useful on long races.
 */

/** Options for {@link buildLevelVisuals}. */
export interface LevelBuildOptions {
  /** Tessellation level (quality tier). Default 1. */
  detail?: GeometryDetail;
  /** Spatial merge cell size in metres. Default 48. */
  cellSize?: number;
  /** Whether level meshes cast shadows. Default true. */
  castShadows?: boolean;
  /** Include the void surface below the course. Default true. */
  includeVoid?: boolean;
  /** Draw team goal/nest/zone markers. Default true. */
  includeZoneMarkers?: boolean;
}

/** Built level visuals. */
export interface LevelVisuals {
  /** Root to add to the scene. */
  readonly object: Group;
  /** Shared uniforms (time, night glow, sun) for every level material. */
  readonly uniforms: LevelUniforms;
  /** Number of meshes (≈ draw calls before shadow passes). */
  readonly meshCount: number;
  /** World-space AABB of the solid geometry. */
  readonly bounds: { min: Vector3; max: Vector3 };
  /**
   * @param t - Match time (s), for deterministic-looking surface animation.
   * @param dt - Frame delta (s).
   */
  update(t: number, dt: number): void;
  /** 0 = day, 1 = full night: boosts emissive trims and hazard tape. */
  setNight(amount: number): void;
  dispose(): void;
}

interface Bucket {
  surface: SurfaceKind;
  pattern: PatternKind;
  decorative: boolean;
  geos: BufferGeometry[];
}

const tmpMatrix = new Matrix4();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
const unitScale = new Vector3(1, 1, 1);
const tmpColor = new Color();

/** Adds a constant `color` attribute so merged pieces keep their own palette colour. */
function paint(geo: BufferGeometry, c: Color): void {
  const count = geo.getAttribute('position').count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
}

/** Rails along the four top edges of a box-like piece, in piece-local space. */
function grabRails(piece: StaticPiece): BufferGeometry[] {
  const { x, y, z } = piece.size;
  const th = Math.min(0.22, Math.max(0.08, Math.min(x, z) * 0.06));
  const top = y / 2 + th * 0.15;
  const out: BufferGeometry[] = [];
  if (piece.shape === 'cylinder' || piece.shape === 'hexPrism') {
    const g = createRimRingGeometry(x - th * 0.2, th);
    g.translate(0, top, 0);
    out.push(g);
    return out;
  }
  if (piece.shape !== 'box') return out;
  for (const sz of [-1, 1]) {
    const g = createEdgeRailGeometry(x, th);
    g.translate(0, top, (sz * z) / 2);
    out.push(g);
  }
  for (const sx of [-1, 1]) {
    const g = createEdgeRailGeometry(z, th);
    g.rotateY(Math.PI / 2);
    g.translate((sx * x) / 2, top, 0);
    out.push(g);
  }
  return out;
}

/** Translucent pulsing floor marker for team goals, nests and logic zones. */
function createZoneMarker(trigger: TriggerDef, theme: ThemeDefinition, time: LevelUniforms['time']): Mesh {
  const isTeam = trigger.kind === 'goal' || trigger.kind === 'nest';
  const hex = isTeam ? (TEAM_COLORS[trigger.index % TEAM_COLORS.length] ?? theme.palette.safe) : theme.palette.safe;
  const col = uniform(new Color(hex));
  const geo = new PlaneGeometry(trigger.size.x, trigger.size.z);
  geo.rotateX(-Math.PI / 2);
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    fog: true,
  });
  const st = uv();
  const edge = max(abs(st.x.sub(0.5)), abs(st.y.sub(0.5))).mul(2);
  const border = smoothstep(0.86, 0.94, edge);
  const dash = smoothstep(0.4, 0.6, fract(st.x.add(st.y).mul(8).sub(time.mul(0.6))));
  const fill = float(0.12).add(smoothstep(0.3, 1.0, edge).mul(0.12));
  const pulse = time.mul(2.4).sin().mul(0.15).add(0.85);
  const alpha = max(border.mul(mix(0.55, 1.0, dash)), fill).mul(pulse).mul(isTeam ? 0.9 : 0.6);
  mat.colorNode = col.mul(alpha.mul(1.4));
  mat.opacityNode = alpha;
  const mesh = new Mesh(geo, mat);
  quaternionFromRotation(trigger.rotation, mesh.quaternion);
  mesh.position.set(trigger.position.x, trigger.position.y - trigger.size.y / 2 + 0.04, trigger.position.z);
  mesh.renderOrder = 5;
  mesh.name = `zone-${trigger.id}`;
  // Keeps the marker from z-fighting with the floor it sits on.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  return mesh;
}

/**
 * Converts every `StaticPiece` of a round into merged toy meshes, plus zone
 * markers and the void below.
 *
 * @param round - Validated round definition (defaults applied).
 * @param theme - Theme resolving palette keys, sky/fog/void.
 * @param opts - Tessellation and batching options.
 * @returns Live level visuals; call `update` each frame and `dispose` on unload.
 * @example
 * const level = buildLevelVisuals(round, getTheme(round.theme), { detail: tier.geometryDetail });
 * scene.add(level.object);
 * // per frame
 * level.update(matchTime, dt);
 */
export function buildLevelVisuals(round: RoundDefinition, theme: ThemeDefinition, opts: LevelBuildOptions = {}): LevelVisuals {
  const detail = opts.detail ?? 1;
  const cellSize = opts.cellSize ?? 48;
  const castShadows = opts.castShadows ?? true;
  const root = new Group();
  root.name = `level-${round.id}`;
  const uniforms = createLevelUniforms(theme);

  const buckets = new Map<string, Bucket>();
  const grabGeos = new Map<string, BufferGeometry[]>();
  const bmin = new Vector3(Infinity, Infinity, Infinity);
  const bmax = new Vector3(-Infinity, -Infinity, -Infinity);

  for (const piece of round.geometry) {
    quaternionFromRotation(piece.rotation, tmpQuat);
    tmpPos.set(piece.position.x, piece.position.y, piece.position.z);
    tmpMatrix.compose(tmpPos, tmpQuat, unitScale);

    const geo = createPieceGeometry(piece, detail);
    geo.applyMatrix4(tmpMatrix);
    tmpColor.set(resolveThemeColor(theme, piece.color));
    paint(geo, tmpColor);

    geo.computeBoundingBox();
    if (!piece.decorative) {
      bmin.min(geo.boundingBox!.min);
      bmax.max(geo.boundingBox!.max);
    }

    const cell = `${Math.floor(piece.position.x / cellSize)},${Math.floor(piece.position.z / cellSize)}`;
    const key = `${piece.surface}|${piece.pattern}|${piece.decorative ? 1 : 0}|${cell}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { surface: piece.surface, pattern: piece.pattern, decorative: piece.decorative, geos: [] };
      buckets.set(key, bucket);
    }
    bucket.geos.push(geo);

    if (piece.grabbable) {
      const list = grabGeos.get(cell) ?? [];
      for (const rail of grabRails(piece)) {
        rail.applyMatrix4(tmpMatrix);
        paint(rail, tmpColor.set(theme.palette.interact));
        list.push(rail);
      }
      grabGeos.set(cell, list);
    }
  }

  const materials = new Map<string, Material>();
  const materialFor = (b: Bucket): Material => {
    const k = `${b.surface}|${b.pattern}|${b.decorative}`;
    let m = materials.get(k);
    if (!m) {
      m = createLevelMaterial(uniforms, { surface: b.surface, pattern: b.pattern, decorative: b.decorative });
      materials.set(k, m);
    }
    return m;
  };

  let meshCount = 0;
  for (const [key, b] of buckets) {
    const merged = mergeGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, materialFor(b));
    mesh.name = `level:${key}`;
    mesh.castShadow = castShadows && !b.decorative;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    meshCount++;
  }

  if (grabGeos.size > 0) {
    const trim = createGrabTrimMaterial(uniforms);
    materials.set('grab', trim);
    for (const [cell, list] of grabGeos) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, trim);
      mesh.name = `level:grab|${cell}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      meshCount++;
    }
  }

  const markers: Mesh[] = [];
  if (opts.includeZoneMarkers ?? true) {
    for (const trig of round.triggers) {
      if (trig.kind !== 'goal' && trig.kind !== 'nest' && trig.kind !== 'zone') continue;
      const m = createZoneMarker(trig, theme, uniforms.time);
      markers.push(m);
      root.add(m);
      meshCount++;
    }
  }

  if (!Number.isFinite(bmin.x)) {
    bmin.set(-10, -1, -10);
    bmax.set(10, 1, 10);
  }

  let voidVisual: VoidVisual | null = null;
  if (opts.includeVoid ?? true) {
    const cx = (bmin.x + bmax.x) / 2;
    const cz = (bmin.z + bmax.z) / 2;
    const y = Math.min(theme.void.depth, bmin.y - 4);
    voidVisual = createVoidSurface(theme, { x: cx, z: cz }, y, Math.max(700, theme.fog.far * 2.5));
    root.add(voidVisual.object);
    meshCount++;
  }

  return {
    object: root,
    uniforms,
    meshCount,
    bounds: { min: bmin, max: bmax },
    update(t: number): void {
      uniforms.time.value = t;
      voidVisual?.update(t);
    },
    setNight(amount: number): void {
      uniforms.nightGlow.value = amount;
    },
    dispose(): void {
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh && mesh !== voidVisual?.object) mesh.geometry.dispose();
      });
      for (const m of markers) (m.material as Material).dispose();
      for (const m of materials.values()) m.dispose();
      voidVisual?.dispose();
      root.removeFromParent();
    },
  };
}
