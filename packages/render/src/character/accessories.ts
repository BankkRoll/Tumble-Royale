/**
 * Procedural cosmetic meshes.
 *
 * Responsibilities:
 * - One builder per `AccessoryMeshId` from `@tumble/content/cosmetics`.
 * - Parts are authored in mesh rest space and either bound rigidly to a core
 *   bone or skinned to a chain (verlet strand, spinner, flapper, bobber) that
 *   the runtime drives through the pool bones.
 *
 * Colours: tint entries that name a body colour (`primary`…) become palette
 * kinds so the same geometry serves every wearer; hex tints are baked.
 */
import type { BufferGeometry } from 'three/webgpu';
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  Color,
  Vector2,
  Vector3,
  type BufferAttribute,
} from 'three/webgpu';
import type { AccessoryMeshId } from '@tumble/content/cosmetics';
import { Kind, alignBetween, bodyRadiusAt, finishPart, segments, type KindId, type Lod } from './geometry.ts';
import { Bone, type BoneId } from './rig.ts';

/** How the runtime drives a group of pool bones. */
export type ChainType = 'verlet' | 'spin' | 'flap' | 'bob';

/** A driven bone chain declared by an accessory. */
export interface ChainDef {
  type: ChainType;
  /** Core bone the chain hangs from. */
  attach: BoneId;
  /** Rest points in mesh space. Verlet: ≥ 2 points (one bone each). Others: the pivot. */
  points: Vector3[];
  /** Verlet: pull towards the rest shape per step (0 floppy … 1 rigid). */
  stiffness?: number;
  /** Verlet: velocity damping per step (0–1). */
  damping?: number;
  /** Verlet: gravity scale. */
  gravity?: number;
  /** Verlet: collision radius of each point against the body spheres. */
  radius?: number;
  /** Verlet: sideways wag amplitude (tails). */
  wag?: number;
  /** Spin/flap/bob axis in mesh space. */
  axis?: Vector3;
  /** Spin: base rad/s. */
  speed?: number;
  /** Spin: extra rad/s per m/s of run speed. */
  speedGain?: number;
  /** Flap/bob amplitude (rad or m). */
  amp?: number;
  /** Flap/bob frequency in Hz. */
  freq?: number;
}

/** A finished part plus how it's bound. */
export interface AccessoryPart {
  geo: BufferGeometry;
  /** Core bone index, or a chain index local to this accessory. */
  bind: { bone: BoneId } | { chain: number };
}

/** Output of one accessory builder. */
export interface AccessoryBuild {
  parts: AccessoryPart[];
  chains: ChainDef[];
}

type Tint = string;

class Builder {
  readonly parts: AccessoryPart[] = [];
  readonly chains: ChainDef[] = [];
  readonly seg: ReturnType<typeof segments>;

  constructor(
    readonly lod: Lod,
    readonly tint: readonly Tint[],
  ) {
    this.seg = segments(lod);
  }

  /** Resolves a tint slot into a colour kind + vertex colour. */
  style(slot: number, kind: KindId = Kind.Vertex): { kind: KindId; color?: string } {
    const t = this.tint[slot] ?? this.tint[0] ?? '#ffffff';
    if (t === 'primary') return { kind: Kind.Primary };
    if (t === 'secondary') return { kind: Kind.Secondary };
    if (t === 'tertiary') return { kind: Kind.Tertiary };
    return { kind, color: t };
  }

  add(geo: BufferGeometry, slot: number, bone: BoneId, kind: KindId = Kind.Vertex): BufferGeometry {
    finishPart(geo, this.style(slot, kind), bone);
    this.parts.push({ geo, bind: { bone } });
    return geo;
  }

  addChained(geo: BufferGeometry, slot: number, chain: number, kind: KindId = Kind.Vertex): BufferGeometry {
    finishPart(geo, this.style(slot, kind), Bone.root);
    this.parts.push({ geo, bind: { chain } });
    return geo;
  }

  chain(def: ChainDef): number {
    this.chains.push(def);
    return this.chains.length - 1;
  }

  sphere(r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): SphereGeometry {
    const g = new SphereGeometry(r, this.seg.sphereW, this.seg.sphereH);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    return g;
  }

  cyl(
    rt: number,
    rb: number,
    h: number,
    x: number,
    y: number,
    z: number,
    radial: number = this.seg.limb + 6,
  ): CylinderGeometry {
    const g = new CylinderGeometry(rt, rb, h, radial, 1);
    g.translate(x, y, z);
    return g;
  }

  torus(R: number, r: number, arc = Math.PI * 2, tubular: number = this.seg.radial): TorusGeometry {
    return new TorusGeometry(R, r, Math.max(4, this.seg.limb - 2), tubular, arc);
  }

  /** Thin rod between two points. */
  rod(a: Vector3, b: Vector3, r: number): BufferGeometry {
    return alignBetween(new CylinderGeometry(r, r, a.distanceTo(b), Math.max(5, this.seg.limb - 2), 1), a, b);
  }
}

const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Point on the body surface at height `y`, angle `theta` (0 = front) pushed out by `out`. */
const surface = (theta: number, y: number, out = 0): Vector3 => {
  const r = bodyRadiusAt(y) + out;
  return v(Math.sin(theta) * r, y, Math.cos(theta) * r);
};

/** A skull cap hugging the dome above `fromY`. */
function cap(b: Builder, fromY: number, out: number): BufferGeometry {
  const pts: Vector2[] = [];
  const steps = Math.max(6, b.seg.profile >> 1);
  // Bottom-to-top profile order keeps the lathe's winding (and normals) facing outward.
  for (let i = 0; i < steps; i++) {
    const y = fromY + ((1.79 - fromY) * i) / steps;
    pts.push(new Vector2(bodyRadiusAt(y) + out, y + out * (i / steps)));
  }
  pts.push(new Vector2(0, 1.792 + out));
  return new LatheGeometry(pts, b.seg.radial, Math.PI, Math.PI * 2);
}

function starShape(outer: number, inner: number, points = 5): Shape {
  const s = new Shape();
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return s;
}

/**
 * Extruded five-point star centred at the origin in the XY plane.
 *
 * @param outer - Tip radius.
 * @param inner - Notch radius.
 * @param depth - Extrusion depth along Z.
 * @returns A new geometry.
 */
export function starGeometry(outer: number, inner: number, depth: number): BufferGeometry {
  const g = new ExtrudeGeometry(starShape(outer, inner), {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.4,
    bevelSize: outer * 0.08,
    bevelSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Thin slab strip that hangs along a chain (capes, scarf tails). */
function strip(
  top: Vector3,
  bottom: Vector3,
  wTop: number,
  wBottom: number,
  rows: number,
  thick: number,
  wrap: number,
): BufferGeometry {
  const h = top.distanceTo(bottom);
  const g = new BoxGeometry(1, h, thick, 4, rows, 1);
  const pos = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = 0.5 - pos.getY(i) / h;
    const x = pos.getX(i) * (wTop + (wBottom - wTop) * t);
    pos.setX(i, x);
    // Curving the strip around the body keeps the cape from clipping the shoulders.
    pos.setZ(i, pos.getZ(i) + wrap * x * x);
  }
  g.computeVertexNormals();
  return alignBetween(g, bottom, top);
}

// -----------------------------------------------------------------------------
// Headwear
// -----------------------------------------------------------------------------

const H = Bone.head;

const headwear: Record<string, (b: Builder) => void> = {
  'party-cone': (b) => {
    const cone = new ConeGeometry(0.17, 0.44, b.seg.radial >> 1, 4);
    cone.rotateZ(0.18);
    cone.translate(-0.04, 1.93, 0);
    b.add(cone, 0, H);
    for (const [y, r] of [
      [1.8, 0.15],
      [1.92, 0.1],
    ] as const) {
      const ring = b.torus(r, 0.018, Math.PI * 2, b.seg.radial >> 1);
      ring.rotateX(Math.PI / 2);
      ring.rotateZ(0.18);
      ring.translate(-0.04 - (y - 1.93) * Math.sin(0.18), y, 0);
      b.add(ring, 1, H);
    }
    b.add(b.sphere(0.065, -0.115, 2.14, 0), 2, H);
  },

  'beanie-pom': (b) => {
    b.add(cap(b, 1.46, 0.025), 0, H);
    const cuff = b.torus(bodyRadiusAt(1.5) + 0.03, 0.05);
    cuff.rotateX(Math.PI / 2);
    cuff.translate(0, 1.5, 0);
    b.add(cuff, 1, H);
    const c = b.chain({
      type: 'verlet',
      attach: H,
      points: [v(0, 1.81, 0), v(0, 1.95, -0.02)],
      stiffness: 0.22,
      damping: 0.08,
      gravity: 1,
      radius: 0.08,
    });
    b.addChained(b.sphere(0.095, 0, 1.97, -0.02), 1, c);
  },

  tiara: (b) => {
    const band = b.torus(0.27, 0.022, Math.PI * 1.1);
    band.rotateX(Math.PI / 2);
    band.rotateY(-Math.PI * 0.05 - Math.PI / 2 + Math.PI);
    band.rotateZ(0);
    band.translate(0, 1.66, 0.02);
    b.add(band, 0, H, Kind.Shiny);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = ((i - (n - 1) / 2) / (n - 1)) * 1.6;
      const h = i === 2 ? 0.17 : i % 2 === 0 ? 0.1 : 0.13;
      const spike = new ConeGeometry(0.035, h, 6);
      spike.translate(Math.sin(a) * 0.27, 1.68 + h / 2, Math.cos(a) * 0.27 + 0.02);
      b.add(spike, 0, H, Kind.Shiny);
      b.add(
        b.sphere(i === 2 ? 0.045 : 0.03, Math.sin(a) * 0.29, 1.69 + h * 0.35, Math.cos(a) * 0.29 + 0.02),
        1,
        H,
        Kind.Glow,
      );
    }
  },

  'chef-hat': (b) => {
    b.add(b.cyl(0.24, 0.23, 0.22, 0, 1.76, 0), 0, H);
    const puffs: [number, number, number, number][] = [
      [0, 2.0, 0, 0.2],
      [0.14, 1.94, 0.05, 0.14],
      [-0.14, 1.95, 0.03, 0.15],
      [0.03, 1.95, -0.15, 0.14],
      [0.02, 1.96, 0.15, 0.13],
    ];
    for (const [x, y, z, r] of puffs) b.add(b.sphere(r, x, y, z), 0, H);
  },

  horns: (b) => {
    b.add(cap(b, 1.5, 0.02), 0, H, Kind.Shiny);
    for (const s of [1, -1]) {
      const base = surface(s * 1.35, 1.62, 0.02);
      const tip = base.clone().add(v(s * 0.2, 0.2, 0.04));
      const curve = new CatmullRomCurve3([base, base.clone().add(v(s * 0.13, 0.03, 0.02)), tip]);
      const tube = new TubeGeometry(curve, 8, 0.05, b.seg.limb, false);
      const tp = tube.getAttribute('position') as BufferAttribute;
      // Taper the tube towards the tip so it reads as a horn, not a pipe.
      for (let i = 0; i < tp.count; i++) {
        const t = Math.min(1, Math.floor(i / (b.seg.limb + 1)) / 8);
        const c = curve.getPoint(t);
        const k = 1 - t * 0.75;
        tp.setXYZ(
          i,
          c.x + (tp.getX(i) - c.x) * k,
          c.y + (tp.getY(i) - c.y) * k,
          c.z + (tp.getZ(i) - c.z) * k,
        );
      }
      tube.computeVertexNormals();
      b.add(tube, 1, H);
      b.add(b.sphere(0.055, base.x, base.y, base.z), 1, H);
    }
  },

  'propeller-cap': (b) => {
    b.add(cap(b, 1.5, 0.022), 0, H);
    const brim = new CylinderGeometry(0.2, 0.22, 0.025, b.seg.radial >> 1, 1, false, -0.9, 1.8);
    brim.scale(1, 1, 1.25);
    brim.translate(0, 1.56, 0.26);
    b.add(brim, 1, H);
    b.add(b.cyl(0.018, 0.018, 0.1, 0, 1.86, 0), 1, H);
    const c = b.chain({
      type: 'spin',
      attach: H,
      points: [v(0, 1.92, 0)],
      axis: v(0, 1, 0),
      speed: 4,
      speedGain: 3,
    });
    for (const s of [1, -1]) {
      b.addChained(b.sphere(0.13, s * 0.13, 1.92, 0, 1, 0.12, 0.32), 2, c);
    }
    b.addChained(b.sphere(0.035, 0, 1.92, 0), 1, c);
  },

  'bunny-ears': (b) => {
    for (const s of [1, -1]) {
      const pts = [
        v(s * 0.12, 1.72, -0.02),
        v(s * 0.15, 1.92, -0.03),
        v(s * 0.17, 2.1, -0.04),
        v(s * 0.18, 2.24, -0.05),
      ];
      const c = b.chain({
        type: 'verlet',
        attach: H,
        points: pts,
        stiffness: 0.1,
        damping: 0.06,
        gravity: 1,
        radius: 0.06,
      });
      const top = pts[3]!;
      const bot = pts[0]!;
      const ear = alignBetween(
        new SphereGeometry(0.075, b.seg.sphereW, b.seg.sphereH * 2).scale(1, 3.6, 0.45),
        bot,
        top,
      );
      ear.translate((top.x - bot.x) * 0.02, 0.05, 0);
      b.addChained(ear, 0, c);
      const inner = alignBetween(
        new SphereGeometry(0.05, b.seg.sphereW, b.seg.sphereH * 2).scale(1, 3.6, 0.3),
        bot,
        top,
      );
      inner.translate(0, 0.06, 0.02);
      b.addChained(inner, 1, c);
    }
  },

  halo: (b) => {
    const c = b.chain({
      type: 'bob',
      attach: H,
      points: [v(0, 2.0, 0)],
      axis: v(0, 1, 0),
      amp: 0.035,
      freq: 0.7,
    });
    const ring = b.torus(0.24, 0.032);
    ring.rotateX(Math.PI / 2 - 0.15);
    ring.translate(0, 2.0, 0);
    b.addChained(ring, 0, c, Kind.Glow);
  },

  'top-hat': (b) => {
    const tilt = (g: BufferGeometry): BufferGeometry => g.rotateZ(-0.12).translate(0.02, 0, 0);
    b.add(tilt(b.cyl(0.32, 0.32, 0.03, 0, 1.69, 0, b.seg.radial)), 0, H);
    b.add(tilt(b.cyl(0.2, 0.21, 0.38, 0, 1.88, 0, b.seg.radial)), 0, H);
    b.add(tilt(b.cyl(0.213, 0.217, 0.07, 0, 1.74, 0, b.seg.radial)), 1, H);
  },

  flower: (b) => {
    const pivot = v(0.17, 1.7, 0.08);
    const c = b.chain({ type: 'flap', attach: H, points: [pivot], axis: v(0, 0, 1), amp: 0.12, freq: 1.4 });
    const cx = pivot.x + 0.04;
    const cy = pivot.y + 0.1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const petal = new SphereGeometry(0.06, b.seg.sphereW, b.seg.sphereH).scale(1.6, 0.9, 0.35);
      petal.rotateZ(a);
      petal.translate(cx + Math.cos(a) * 0.08, cy + Math.sin(a) * 0.08, pivot.z + 0.02);
      b.addChained(petal, 0, c);
    }
    b.addChained(b.sphere(0.055, cx, cy, pivot.z + 0.05, 1, 1, 0.6), 1, c, Kind.Shiny);
  },

  antenna: (b) => {
    for (const s of [1, -1]) {
      const pts = [v(s * 0.09, 1.76, 0.02), v(s * 0.12, 1.92, 0.03), v(s * 0.16, 2.06, 0.05)];
      const c = b.chain({
        type: 'verlet',
        attach: H,
        points: pts,
        stiffness: 0.18,
        damping: 0.05,
        gravity: 0.6,
        radius: 0.04,
      });
      b.addChained(b.rod(pts[0]!, pts[1]!, 0.018), 0, c);
      b.addChained(b.rod(pts[1]!, pts[2]!, 0.016), 0, c);
      b.addChained(b.sphere(0.055, pts[2]!.x, pts[2]!.y + 0.02, pts[2]!.z), 1, c, Kind.Glow);
    }
  },

  headphones: (b) => {
    const band = b.torus(0.42, 0.032, Math.PI);
    band.translate(0, 1.36, 0);
    b.add(band, 0, H);
    for (const s of [1, -1]) {
      const cup = b.cyl(0.11, 0.11, 0.08, 0, 0, 0, b.seg.radial >> 1);
      cup.rotateZ(Math.PI / 2);
      cup.translate(s * 0.405, 1.33, 0);
      b.add(cup, 1, H);
      const pad = b.torus(0.085, 0.03, Math.PI * 2, b.seg.radial >> 1);
      pad.rotateY(Math.PI / 2);
      pad.translate(s * 0.37, 1.33, 0);
      b.add(pad, 0, H);
    }
  },

  sprout: (b) => {
    const pts = [v(0, 1.79, 0), v(0.01, 1.9, 0.01)];
    const c = b.chain({
      type: 'verlet',
      attach: H,
      points: pts,
      stiffness: 0.3,
      damping: 0.08,
      gravity: 0.5,
      radius: 0.04,
    });
    b.addChained(b.rod(pts[0]!, pts[1]!, 0.018), 0, c);
    for (const s of [1, -1]) {
      const leaf = new SphereGeometry(0.06, b.seg.sphereW, b.seg.sphereH).scale(1.7, 0.4, 0.9);
      leaf.rotateZ(s * 0.5);
      leaf.translate(s * 0.08, 1.93, 0.01);
      b.addChained(leaf, 0, c);
    }
  },

  'cat-ears': (b) => {
    for (const s of [1, -1]) {
      const p = surface(s * 0.75, 1.66, -0.02);
      const ear = new ConeGeometry(0.11, 0.2, Math.max(6, b.seg.limb), 1);
      ear.scale(1, 1, 0.5);
      ear.rotateZ(-s * 0.35);
      ear.translate(p.x, p.y + 0.1, p.z * 0.4);
      b.add(ear, 0, H);
      const inner = new ConeGeometry(0.065, 0.13, Math.max(6, b.seg.limb), 1);
      inner.scale(1, 1, 0.4);
      inner.rotateZ(-s * 0.35);
      inner.translate(p.x - s * 0.005, p.y + 0.09, p.z * 0.4 + 0.035);
      b.add(inner, 1, H);
    }
  },
};

// -----------------------------------------------------------------------------
// Back
// -----------------------------------------------------------------------------

const C = Bone.chest;

const back: Record<string, (b: Builder) => void> = {
  cape: (b) => {
    const rows = b.lod === 0 ? 8 : 4;
    const pts = [
      v(0, 1.12, -0.41),
      v(0, 0.92, -0.5),
      v(0, 0.72, -0.56),
      v(0, 0.52, -0.58),
      v(0, 0.32, -0.58),
    ];
    const c = b.chain({
      type: 'verlet',
      attach: C,
      points: pts,
      stiffness: 0.035,
      damping: 0.05,
      gravity: 1,
      radius: 0.05,
    });
    const cape = strip(pts[0]!, pts[pts.length - 1]!, 0.62, 0.78, rows, 0.025, 0.55);
    // Lining in the second tint: colour faces that point towards the body.
    finishPart(cape, b.style(0), Bone.root);
    const nrm = cape.getAttribute('normal') as BufferAttribute;
    const col = cape.getAttribute('color') as BufferAttribute;
    const lining = b.style(1);
    const linColor = lining.color ? hexToLinear(lining.color, new Vector3()) : null;
    for (let i = 0; i < nrm.count; i++) {
      if (nrm.getZ(i) > 0.5 && linColor) col.setXYZ(i, linColor.x, linColor.y, linColor.z);
    }
    b.parts.push({ geo: cape, bind: { chain: c } });
    const collar = b.torus(0.33, 0.04, Math.PI * 0.9);
    collar.rotateX(Math.PI / 2);
    collar.rotateZ(0);
    collar.rotateY(Math.PI * 0.55);
    collar.translate(0, 1.12, -0.05);
    b.add(collar, 1, C);
  },

  wings: (b) => {
    for (const s of [1, -1]) {
      const pivot = v(s * 0.1, 1.1, -0.42);
      const c = b.chain({
        type: 'flap',
        attach: C,
        points: [pivot],
        axis: v(0, 1, 0),
        amp: s * 0.35,
        freq: 2.6,
      });
      const upper = new SphereGeometry(0.2, b.seg.sphereW, b.seg.sphereH).scale(1.5, 1.1, 0.12);
      upper.rotateZ(s * 0.5);
      upper.translate(pivot.x + s * 0.27, pivot.y + 0.16, pivot.z - 0.08);
      b.addChained(upper, 0, c, Kind.Glass);
      const lower = new SphereGeometry(0.14, b.seg.sphereW, b.seg.sphereH).scale(1.4, 1, 0.12);
      lower.rotateZ(-s * 0.6);
      lower.translate(pivot.x + s * 0.2, pivot.y - 0.14, pivot.z - 0.06);
      b.addChained(lower, 1, c, Kind.Glass);
    }
  },

  jetpack: (b) => {
    b.add(new BoxGeometry(0.36, 0.3, 0.12).translate(0, 1.0, -0.47), 0, C, Kind.Shiny);
    for (const s of [1, -1]) {
      b.add(b.cyl(0.1, 0.1, 0.42, s * 0.15, 1.0, -0.56), 0, C, Kind.Shiny);
      b.add(
        new SphereGeometry(0.1, b.seg.sphereW, b.seg.sphereH, 0, Math.PI * 2, 0, Math.PI / 2).translate(
          s * 0.15,
          1.21,
          -0.56,
        ),
        1,
        C,
      );
      b.add(b.cyl(0.06, 0.09, 0.08, s * 0.15, 0.75, -0.56), 1, C);
      const c = b.chain({
        type: 'bob',
        attach: C,
        points: [v(s * 0.15, 0.7, -0.56)],
        axis: v(0, 1, 0),
        amp: 0.025,
        freq: 9 + s,
      });
      const flame = new ConeGeometry(0.065, 0.2, 10);
      flame.rotateX(Math.PI);
      flame.translate(s * 0.15, 0.61, -0.56);
      b.addChained(flame, 1, c, Kind.Glow);
    }
  },

  tail: (b) => {
    const pts = [
      v(0, 0.45, -0.44),
      v(0, 0.43, -0.58),
      v(0, 0.47, -0.72),
      v(0, 0.56, -0.84),
      v(0, 0.68, -0.92),
    ];
    const c = b.chain({
      type: 'verlet',
      attach: Bone.hips,
      points: pts,
      stiffness: 0.09,
      damping: 0.06,
      gravity: 0.5,
      radius: 0.05,
      wag: 1,
    });
    const curve = new CatmullRomCurve3(pts);
    const tube = new TubeGeometry(curve, b.lod === 0 ? 16 : 8, 0.055, b.seg.limb, false);
    b.addChained(tube, 0, c);
    const tip = pts[pts.length - 1]!;
    b.addChained(b.sphere(0.085, tip.x, tip.y + 0.02, tip.z - 0.02), 1, c);
  },

  backpack: (b) => {
    b.add(new BoxGeometry(0.44, 0.46, 0.22, 2, 2, 2).translate(0, 0.98, -0.52), 0, C);
    b.add(b.sphere(0.12, 0, 0.88, -0.63, 1.4, 0.8, 0.5), 1, C);
    for (const s of [1, -1]) {
      const strap = b.torus(0.2, 0.025, Math.PI * 0.9, 12);
      strap.rotateY(Math.PI / 2);
      strap.rotateX(-Math.PI * 0.05);
      strap.translate(s * 0.2, 1.05, -0.2);
      b.add(strap, 1, C);
    }
  },

  shell: (b) => {
    const shell = new SphereGeometry(0.42, b.seg.radial >> 1, b.seg.sphereH, 0, Math.PI * 2, 0, Math.PI / 2);
    shell.scale(1.05, 1.2, 0.5);
    shell.rotateX(-Math.PI / 2);
    shell.translate(0, 0.92, -0.38);
    b.add(shell, 0, C, Kind.Shiny);
    const rim = b.torus(0.43, 0.035);
    rim.scale(1.05, 1.2, 1);
    rim.translate(0, 0.92, -0.39);
    b.add(rim, 1, C);
  },
};

// -----------------------------------------------------------------------------
// Upper / lower
// -----------------------------------------------------------------------------

const upper: Record<string, (b: Builder) => void> = {
  'bow-tie': (b) => {
    const p = surface(0, 0.96, 0.03);
    for (const s of [1, -1]) {
      const wing = new ConeGeometry(0.07, 0.13, 8);
      wing.rotateZ((s * Math.PI) / 2);
      wing.scale(1, 1, 0.55);
      wing.translate(p.x + s * 0.07, p.y, p.z);
      b.add(wing, 0, C);
    }
    b.add(b.sphere(0.035, p.x, p.y, p.z + 0.01), 0, C);
  },

  scarf: (b) => {
    const ring = b.torus(bodyRadiusAt(1.0) + 0.035, 0.06);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 1.0, 0);
    b.add(ring, 0, C);
    for (const s of [1, -1]) {
      const pts = [
        v(s * 0.1, 0.98, -0.47),
        v(s * 0.13, 0.85, -0.53),
        v(s * 0.15, 0.72, -0.56),
        v(s * 0.16, 0.6, -0.57),
      ];
      const c = b.chain({
        type: 'verlet',
        attach: C,
        points: pts,
        stiffness: 0.04,
        damping: 0.05,
        gravity: 1,
        radius: 0.05,
      });
      const tail = strip(pts[0]!, pts[pts.length - 1]!, 0.1, 0.11, b.lod === 0 ? 6 : 3, 0.03, 0);
      finishPart(tail, b.style(0), Bone.root);
      // Stripe the tail every other row in the second tint.
      const stripe = b.style(1);
      const sc = stripe.color ? hexToLinear(stripe.color, new Vector3()) : null;
      const pos = tail.getAttribute('position') as BufferAttribute;
      const col = tail.getAttribute('color') as BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        if (sc && Math.floor((pts[0]!.y - pos.getY(i)) / 0.09) % 2 === 1) col.setXYZ(i, sc.x, sc.y, sc.z);
      }
      b.parts.push({ geo: tail, bind: { chain: c } });
    }
  },

  medal: (b) => {
    const top = surface(0, 1.0, 0.02);
    const c = b.chain({ type: 'flap', attach: C, points: [top], axis: v(1, 0, 0), amp: 0.08, freq: 1.8 });
    const disc = new CylinderGeometry(0.075, 0.075, 0.02, 18);
    disc.rotateX(Math.PI / 2);
    const dp = surface(0, 0.8, 0.05);
    disc.translate(dp.x, dp.y, dp.z);
    b.addChained(disc, 0, c, Kind.Shiny);
    for (const s of [1, -1]) {
      b.addChained(b.rod(v(s * 0.08, top.y, top.z), v(dp.x + s * 0.02, dp.y + 0.06, dp.z), 0.018), 1, c);
    }
  },
};

const lower: Record<string, (b: Builder) => void> = {
  belt: (b) => {
    const r = bodyRadiusAt(0.56);
    const ring = b.torus(r + 0.012, 0.045);
    ring.rotateX(Math.PI / 2);
    ring.scale(1, 1.4, 1);
    ring.translate(0, 0.56, 0);
    b.add(ring, 0, Bone.hips);
    b.add(new BoxGeometry(0.16, 0.12, 0.04).translate(0, 0.56, r + 0.05), 1, Bone.hips, Kind.Shiny);
  },

  tutu: (b) => {
    const ring = new TorusGeometry(0.56, 0.08, 5, b.seg.radial + 8);
    ring.rotateX(Math.PI / 2);
    ring.scale(1, 0.55, 1);
    const pos = ring.getAttribute('position') as BufferAttribute;
    // Ruffle: radial wobble + flare outward on the lower edge.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const a = Math.atan2(x, z);
      const k = 1 + Math.sin(a * 11) * 0.05 + Math.max(0, -pos.getY(i)) * 1.5;
      pos.setXYZ(i, x * k, pos.getY(i) + Math.cos(a * 11) * 0.015, z * k);
    }
    ring.computeVertexNormals();
    ring.translate(0, 0.5, 0);
    b.add(ring, 0, Bone.hips);
  },

  'shorts-stripes': (b) => {
    const pts: Vector2[] = [];
    const steps = Math.max(5, b.seg.profile >> 2);
    for (let i = 0; i <= steps; i++) {
      const y = 0.285 + (0.53 - 0.285) * (i / steps);
      pts.push(new Vector2(bodyRadiusAt(y) + 0.014, y));
    }
    const shorts = new LatheGeometry(pts, b.seg.radial, Math.PI, Math.PI * 2);
    finishPart(shorts, b.style(0), Bone.hips);
    const stripe = b.style(1);
    const sc = stripe.color ? hexToLinear(stripe.color, new Vector3()) : null;
    const pos = shorts.getAttribute('position') as BufferAttribute;
    const col = shorts.getAttribute('color') as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.abs(Math.atan2(pos.getX(i), pos.getZ(i)));
      if (sc && Math.abs(a - Math.PI / 2) < 0.16) col.setXYZ(i, sc.x, sc.y, sc.z);
    }
    b.parts.push({ geo: shorts, bind: { bone: Bone.hips } });
  },

  floatie: (b) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const arc = new TorusGeometry(
        0.58,
        0.13,
        Math.max(6, b.seg.limb),
        Math.max(3, b.seg.radial >> 3),
        (Math.PI * 2) / n,
      );
      arc.rotateZ((i / n) * Math.PI * 2);
      arc.rotateX(Math.PI / 2);
      arc.translate(0, 0.62, 0);
      b.add(arc, i % 2, Bone.hips, Kind.Shiny);
    }
  },
};

// -----------------------------------------------------------------------------
// Face accessories
// -----------------------------------------------------------------------------

/** Eye placement on the plate; mirrors the face shader's eye centre. */
const EYE_X = 0.112;
const EYE_Y = 1.255;

const face: Record<string, (b: Builder) => void> = {
  visor: (b) => {
    // Sports sun-visor: headband above the brows plus a tinted brim, so the eyes stay visible.
    const y = EYE_Y + 0.2;
    const band = b.torus(bodyRadiusAt(y) + 0.012, 0.03);
    band.rotateX(Math.PI / 2);
    band.translate(0, y, 0);
    b.add(band, 0, H);
    const brim = new CylinderGeometry(0.3, 0.3, 0.02, b.seg.radial, 1, false, -0.85, 1.7);
    brim.scale(1.05, 1, 1.35);
    brim.rotateX(-0.22);
    brim.translate(0, y + 0.02, 0.1);
    b.add(brim, 0, H, Kind.Glass);
  },

  glasses: (b) => {
    for (const s of [1, -1]) {
      const p = surface(Math.asin((s * EYE_X) / 0.4), EYE_Y, 0.045);
      const ring = b.torus(0.08, 0.013, Math.PI * 2, 18);
      ring.rotateY(s * 0.25);
      ring.translate(p.x, p.y, p.z);
      b.add(ring, 0, H);
      const side = surface(s * 1.25, EYE_Y + 0.01, 0.02);
      b.add(b.rod(v(p.x + s * 0.075, p.y, p.z - 0.03), side, 0.012), 0, H);
    }
    const mid = surface(0, EYE_Y + 0.02, 0.05);
    b.add(b.rod(v(-0.035, mid.y, mid.z), v(0.035, mid.y, mid.z), 0.012), 0, H);
  },

  mustache: (b) => {
    const p = surface(0, 1.14, 0.03);
    for (const s of [1, -1]) {
      const lobe = new SphereGeometry(0.06, b.seg.sphereW, b.seg.sphereH).scale(1.25, 0.5, 0.45);
      lobe.rotateZ(s * 0.3);
      lobe.translate(p.x + s * 0.06, p.y, p.z - 0.005);
      b.add(lobe, 0, H);
      b.add(b.sphere(0.028, p.x + s * 0.13, p.y + 0.03, p.z - 0.03), 0, H);
    }
  },

  monocle: (b) => {
    const p = surface(Math.asin(-EYE_X / 0.4), EYE_Y, 0.04);
    const ring = b.torus(0.085, 0.014, Math.PI * 2, 18);
    ring.rotateY(-0.25);
    ring.translate(p.x, p.y, p.z);
    b.add(ring, 0, H, Kind.Shiny);
    const lens = new CylinderGeometry(0.075, 0.075, 0.006, 18).rotateX(Math.PI / 2).rotateY(-0.25);
    lens.translate(p.x, p.y, p.z);
    b.add(lens, 0, H, Kind.Glass);
    b.add(b.rod(v(p.x - 0.06, p.y - 0.06, p.z), surface(-0.9, 1.0, 0.01), 0.008), 0, H, Kind.Shiny);
  },

  'star-shades': (b) => {
    for (const s of [1, -1]) {
      const p = surface(Math.asin((s * EYE_X) / 0.4), EYE_Y, 0.045);
      const star = starGeometry(0.1, 0.05, 0.025);
      star.rotateY(s * 0.25);
      star.translate(p.x, p.y, p.z);
      b.add(star, 0, H, Kind.Shiny);
    }
    const mid = surface(0, EYE_Y + 0.02, 0.05);
    b.add(b.rod(v(-0.04, mid.y, mid.z), v(0.04, mid.y, mid.z), 0.012), 0, H);
  },
};

/** Hex → linear working-space RGB, matching what {@link finishPart} bakes. */
function hexToLinear(hex: string, out: Vector3): Vector3 {
  const c = new Color(hex);
  return out.set(c.r, c.g, c.b);
}

const BUILDERS: Record<string, (b: Builder) => void> = { ...headwear, ...back, ...upper, ...lower, ...face };

/**
 * Builds a cosmetic accessory.
 *
 * @param mesh - Accessory mesh id from the cosmetics catalog.
 * @param tint - Tint list from the catalog item.
 * @param lod - Level of detail.
 * @returns Parts and chains, or `null` for an unknown id.
 */
export function buildAccessory(
  mesh: AccessoryMeshId | string,
  tint: readonly string[],
  lod: Lod,
): AccessoryBuild | null {
  const fn = BUILDERS[mesh];
  if (!fn) return null;
  const b = new Builder(lod, tint);
  fn(b);
  return { parts: b.parts, chains: b.chains };
}

/** Every accessory mesh id this module can build. */
export const BUILT_ACCESSORIES: readonly string[] = Object.keys(BUILDERS);
