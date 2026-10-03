/**
 * Procedural Tumbler geometry.
 *
 * Responsibilities:
 * - The attribute layout every Tumbler mesh shares (`position`, `normal`,
 *   `skinIndex`, `skinWeight`, `color`, `aKind`, `aFace`), so body, limbs and
 *   accessories merge into one draw call.
 * - The gumdrop body (lathe), stubby arms, mitten hands and feet, skinned
 *   procedurally to the core bones, at three levels of detail.
 * - Small helpers accessory builders use to emit parts.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  SplineCurve,
  Uint16BufferAttribute,
  Vector2,
  Vector3,
  type ColorRepresentation,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Bone, RIG, boneRest, type BoneId } from './rig.ts';

/**
 * How the shader colours a vertex. Stored in the `aKind` attribute.
 * Palette kinds follow the wearer's colours, so accessory geometry can be
 * shared by every Tumbler regardless of their colour choice.
 */
export const Kind = {
  /** Body pattern (primary/secondary/tertiary through the pattern function). */
  Pattern: 0,
  Primary: 1,
  Secondary: 2,
  Tertiary: 3,
  /** Fixed vertex colour. */
  Vertex: 4,
  /** Vertex colour with a strong candy/metal highlight. */
  Shiny: 5,
  /** Vertex colour, self-lit (halos, gems, flames). */
  Glow: 6,
  /** Vertex colour with a glassy Fresnel sheen (visors, lenses). */
  Glass: 7,
} as const;

/** A colour kind value. */
export type KindId = (typeof Kind)[keyof typeof Kind];

/** Level of detail. */
export type Lod = 0 | 1 | 2;

/** Value written to `aFace` for vertices that are never part of the face plate. */
const OFF_FACE = 9;

/** Segment counts per LOD. */
const SEG = [
  { radial: 40, profile: 34, limb: 10, sphereW: 14, sphereH: 10 },
  { radial: 20, profile: 16, limb: 6, sphereW: 9, sphereH: 7 },
  { radial: 11, profile: 9, limb: 5, sphereW: 6, sphereH: 4 },
] as const;

/**
 * @param lod - Level of detail.
 * @returns Segment counts for that LOD.
 */
export function segments(lod: Lod): (typeof SEG)[number] {
  return SEG[lod];
}

const tmpColor = new Color();

/** Options for {@link finishPart}. */
export interface PartStyle {
  kind: KindId;
  /** Vertex colour for Vertex/Shiny/Glow/Glass kinds. */
  color?: ColorRepresentation;
}

/**
 * Gives a geometry the shared Tumbler attribute layout, rigidly bound to one bone.
 * Drops `uv` (the shader is fully procedural) and indexes non-indexed input.
 *
 * @param geo - Geometry in mesh rest space. Mutated and returned.
 * @param style - Colour kind and optional vertex colour.
 * @param bone - Skeleton index every vertex is bound to.
 * @returns `geo`.
 */
export function finishPart(geo: BufferGeometry, style: PartStyle, bone: number): BufferGeometry {
  if (geo.index === null) {
    const n = geo.getAttribute('position').count;
    const idx = new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new BufferAttribute(idx, 1));
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const n = geo.getAttribute('position').count;
  tmpColor.set(style.color ?? '#ffffff');
  const col = new Float32Array(n * 3);
  const kind = new Float32Array(n);
  const face = new Float32Array(n * 2);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = tmpColor.r;
    col[i * 3 + 1] = tmpColor.g;
    col[i * 3 + 2] = tmpColor.b;
    kind[i] = style.kind;
    face[i * 2] = OFF_FACE;
    face[i * 2 + 1] = OFF_FACE;
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aKind', new Float32BufferAttribute(kind, 1));
  geo.setAttribute('aFace', new Float32BufferAttribute(face, 2));
  geo.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
  return geo;
}

/**
 * Sets a two-bone blend on one vertex.
 *
 * @param geo - Finished part.
 * @param i - Vertex index.
 * @param a - First bone.
 * @param b - Second bone.
 * @param t - Weight of `b` (0–1).
 */
export function setBlend(geo: BufferGeometry, i: number, a: number, b: number, t: number): void {
  const si = geo.getAttribute('skinIndex') as BufferAttribute;
  const sw = geo.getAttribute('skinWeight') as BufferAttribute;
  si.setXYZW(i, a, b, 0, 0);
  sw.setXYZW(i, 1 - t, t, 0, 0);
}

/**
 * Merges finished parts into one geometry.
 *
 * @param parts - Parts sharing the Tumbler attribute layout.
 * @returns A new merged geometry.
 */
export function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Tumbler part merge failed: attribute layouts differ');
  return merged;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpV = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Places a Y-aligned primitive so its +Y axis runs from `a` to `b`, centred between.
 *
 * @param geo - Primitive built along Y and centred at the origin.
 * @param a - Start point.
 * @param b - End point.
 * @returns `geo`.
 */
export function alignBetween(geo: BufferGeometry, a: Vector3, b: Vector3): BufferGeometry {
  tmpV.subVectors(b, a).normalize();
  tmpQ.setFromUnitVectors(UP, tmpV);
  tmpM.makeRotationFromQuaternion(tmpQ).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo.applyMatrix4(tmpM);
}

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

/** Gumdrop silhouette (radius, height): wide soft bottom, gently tapering domed top. */
const PROFILE: readonly [number, number][] = [
  [0.0, 0.26],
  [0.24, 0.265],
  [0.4, 0.298],
  [0.49, 0.375],
  [0.52, 0.5],
  [0.506, 0.66],
  [0.472, 0.86],
  [0.432, 1.06],
  [0.398, 1.24],
  [0.366, 1.4],
  [0.322, 1.55],
  [0.248, 1.67],
  [0.142, 1.756],
  [0.0, 1.792],
];

const profileCurve = new SplineCurve(PROFILE.map(([r, y]) => new Vector2(r, y)));

/**
 * Body radius at a height, sampled from the gumdrop profile. Accessory builders
 * use it to sit hats, belts and capes on the surface.
 *
 * @param y - Height in mesh space.
 * @returns Approximate body radius at `y` (0 outside the body).
 */
export function bodyRadiusAt(y: number): number {
  if (y <= PROFILE[0]![1] || y >= PROFILE[PROFILE.length - 1]![1]) return 0;
  let best = 0;
  let bestDy = Infinity;
  for (let i = 0; i <= 120; i++) {
    const p = profileCurve.getPoint(i / 120);
    const dy = Math.abs(p.y - y);
    if (dy < bestDy) {
      bestDy = dy;
      best = p.x;
    }
  }
  return best;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Bones along the trunk with their heights, for height-based skin weights. */
function trunkBones(rest: Float32Array): [BoneId, number][] {
  return [
    [Bone.hips, rest[Bone.hips * 3 + 1] ?? 0.55],
    [Bone.spine, rest[Bone.spine * 3 + 1] ?? 0.85],
    [Bone.chest, rest[Bone.chest * 3 + 1] ?? 1.12],
    [Bone.head, rest[Bone.head * 3 + 1] ?? 1.36],
  ];
}

/**
 * Skin weights along the trunk: each vertex blends the two trunk bones whose
 * heights bracket it, with a smoothstep falloff so bends stay soft.
 */
function trunkWeight(y: number, chain: [BoneId, number][]): [number, number, number] {
  const first = chain[0]!;
  if (y <= first[1]) return [first[0], first[0], 0];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    if (y <= b[1]) return [a[0], b[0], smooth(a[1], b[1], y)];
  }
  const last = chain[chain.length - 1]!;
  return [last[0], last[0], 0];
}

function buildTrunk(lod: Lod): BufferGeometry {
  const seg = SEG[lod];
  const pts = profileCurve.getSpacedPoints(seg.profile);
  pts[0]!.x = 0;
  pts[pts.length - 1]!.x = 0;
  // phiStart = π puts the lathe seam at the back, away from the face plate.
  const geo = new LatheGeometry(pts, seg.radial, Math.PI, Math.PI * 2);
  finishPart(geo, { kind: Kind.Pattern }, Bone.hips);

  const pos = geo.getAttribute('position') as BufferAttribute;
  const nrm = geo.getAttribute('normal') as BufferAttribute;
  const face = geo.getAttribute('aFace') as BufferAttribute;
  const chain = trunkBones(boneRest());
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const u = Math.atan2(x, z) * RIG.faceRadius;
    const v = y - RIG.faceY;
    face.setXY(i, u, v);
    // A slight bulge gives the face plate a visor-like lip catching the rim light.
    const e = Math.hypot(u / RIG.faceHalfW, v / RIG.faceHalfH);
    const bulge = 0.016 * (1 - smooth(0.82, 1.02, e));
    if (bulge > 0) pos.setXYZ(i, x + nrm.getX(i) * bulge, y + nrm.getY(i) * bulge, z + nrm.getZ(i) * bulge);
    const [a, b, t] = trunkWeight(y, chain);
    setBlend(geo, i, a, b, t);
  }
  return geo;
}

function buildArm(lod: Lod, side: 1 | -1): BufferGeometry[] {
  const seg = SEG[lod];
  const rest = boneRest();
  const upper = side === 1 ? Bone.upperArmL : Bone.upperArmR;
  const lower = side === 1 ? Bone.lowerArmL : Bone.lowerArmR;
  const hand = side === 1 ? Bone.handL : Bone.handR;
  const sh = new Vector3(rest[upper * 3], rest[upper * 3 + 1], rest[upper * 3 + 2]);
  const el = new Vector3(rest[lower * 3], rest[lower * 3 + 1], rest[lower * 3 + 2]);
  const wr = new Vector3(rest[hand * 3], rest[hand * 3 + 1], rest[hand * 3 + 2]);
  const dir = new Vector3().subVectors(wr, sh).normalize();

  const r = 0.08;
  const start = sh.clone().addScaledVector(dir, -0.05);
  const end = wr.clone().addScaledVector(dir, 0.01);
  const arm = new CapsuleGeometry(r, start.distanceTo(end) - r * 2 + 0.06, Math.max(2, seg.limb >> 1), seg.limb);
  alignBetween(arm, start, end);
  finishPart(arm, { kind: Kind.Pattern }, upper);
  const pos = arm.getAttribute('position') as BufferAttribute;
  const elbowT = sh.distanceTo(el);
  for (let i = 0; i < pos.count; i++) {
    tmpV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(sh);
    const t = tmpV.dot(dir);
    setBlend(arm, i, upper, lower, smooth(elbowT - 0.05, elbowT + 0.05, t));
  }

  // Mitten: a soft paddle with a thumb nub pointing forward and inward.
  const mitten = new SphereGeometry(0.1, seg.sphereW, seg.sphereH);
  mitten.scale(0.95, 1.15, 0.82);
  tmpQ.setFromUnitVectors(new Vector3(0, -1, 0), dir);
  mitten.applyQuaternion(tmpQ);
  const mc = wr.clone().addScaledVector(dir, 0.075);
  mitten.translate(mc.x, mc.y, mc.z);
  finishPart(mitten, { kind: Kind.Pattern }, hand);

  const thumb = new SphereGeometry(0.042, Math.max(5, seg.sphereW >> 1), Math.max(4, seg.sphereH >> 1));
  const tc = wr.clone().addScaledVector(dir, 0.035);
  thumb.translate(tc.x - side * 0.035, tc.y, tc.z + 0.07);
  finishPart(thumb, { kind: Kind.Pattern }, hand);
  return [arm, mitten, thumb];
}

function buildLeg(lod: Lod, side: 1 | -1): BufferGeometry[] {
  const seg = SEG[lod];
  const rest = boneRest();
  const upper = side === 1 ? Bone.upperLegL : Bone.upperLegR;
  const lower = side === 1 ? Bone.lowerLegL : Bone.lowerLegR;
  const foot = side === 1 ? Bone.footL : Bone.footR;
  const hip = new Vector3(rest[upper * 3], rest[upper * 3 + 1], rest[upper * 3 + 2]);
  const knee = new Vector3(rest[lower * 3], rest[lower * 3 + 1], rest[lower * 3 + 2]);
  const ankle = new Vector3(rest[foot * 3], rest[foot * 3 + 1], rest[foot * 3 + 2]);

  const r = 0.075;
  const top = hip.clone().add(new Vector3(0, 0.06, 0));
  const leg = new CapsuleGeometry(r, top.distanceTo(ankle) - r, Math.max(2, seg.limb >> 1), seg.limb);
  alignBetween(leg, ankle, top);
  finishPart(leg, { kind: Kind.Pattern }, upper);
  const pos = leg.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    setBlend(leg, i, lower, upper, smooth(knee.y - 0.04, knee.y + 0.04, y));
  }

  const shoe = new SphereGeometry(0.115, seg.sphereW, seg.sphereH);
  shoe.scale(0.88, 0.58, 1.3);
  shoe.translate(ankle.x, 0.062, ankle.z + 0.045);
  finishPart(shoe, { kind: Kind.Secondary }, foot);
  return [leg, shoe];
}

/**
 * Builds the base Tumbler mesh (body, arms, mittens, legs, shoes) for a LOD.
 * Uncached: callers go through the geometry cache in `assembly.ts`.
 *
 * @param lod - Level of detail.
 * @returns Geometry in mesh rest space with the shared attribute layout.
 */
export function buildBaseGeometry(lod: Lod): BufferGeometry {
  return mergeParts([buildTrunk(lod), ...buildArm(lod, 1), ...buildArm(lod, -1), ...buildLeg(lod, 1), ...buildLeg(lod, -1)]);
}
