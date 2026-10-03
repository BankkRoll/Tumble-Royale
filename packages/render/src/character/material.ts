/**
 * Tumbler materials (TSL node graphs, identical on WebGPU and WebGL2).
 *
 * Responsibilities:
 * - One shared toon material for every Tumbler: per-object uniforms (colours,
 *   pattern, face expression) are read from `object.userData.tumbler` at draw
 *   time, so 40 Tumblers share one pipeline and one material.
 * - 16 procedural body patterns in rest space, so they stick to the skinned body.
 * - A fully procedural face plate (eyes, pupils, lids, brows, mouth shapes,
 *   blush, freckles, visor gloss) driven by uniforms — no textures.
 * - Rim light, fake subsurface warmth, candy specular, glow/glass kinds and a
 *   screen-door dither for ghosting/occluder fades.
 * - The inverted-hull outline material, tinted from the body colour.
 */
import {
  BackSide,
  Color,
  MeshBasicNodeMaterial,
  MeshToonNodeMaterial,
  Vector3,
  Vector4,
  type Node,
  type NodeBuilder,
  type Object3D,
} from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cos,
  diffuseColor,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  mod,
  modelWorldMatrix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  normalLocal,
  normalView,
  normalize,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { createToonMaterial } from '../materials/toon.ts';
import { RIG } from './rig.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

// -----------------------------------------------------------------------------
// Per-object state
// -----------------------------------------------------------------------------

/**
 * Per-Tumbler shader inputs. One instance lives in `userData.tumbler` of every
 * mesh belonging to a Tumbler; the shared materials read it per draw.
 */
export class TumblerShaderState {
  readonly primary = new Color('#ff6fb5');
  readonly secondary = new Color('#ffd23f');
  readonly tertiary = new Color('#7c5cff');
  /** Face plate base colour. */
  readonly plate = new Color('#fff7ec');
  /** Iris ring colour. */
  readonly iris = new Color('#3a2a5c');
  /** x pattern index, y scale, z angle (rad), w unused. */
  readonly pattern = new Vector4(0, 1, 0, 0);
  /** x lookX, y lookY (−1…1), z lid closure (0 open … 1 shut), w happy-closed eyes. */
  readonly faceA = new Vector4(0, 0, 0, 0);
  /** x mouth open, y smile (−1 frown … 1 smile), z mouth half-width (m), w squiggle. */
  readonly faceB = new Vector4(0, 0.6, 0.06, 0);
  /** x tongue, y teeth, z brow angle (+ = angry), w brow raise. */
  readonly faceC = new Vector4(0, 0, 0, 0);
  /** x pupil shape, y eye scale, z pupil size, w dizzy spirals. */
  readonly faceD = new Vector4(0, 1, 1, 0);
  /** x blush, y freckles, z lashes, w time (s). */
  readonly faceE = new Vector4(1, 0, 0, 0);
  /** x opacity (dither), y hit flash, z lid tilt (+ determined, − sad), w eye widen. */
  readonly fx = new Vector4(1, 0, 0, 0);
}

const FALLBACK_STATE = new TumblerShaderState();

/**
 * @param object - A mesh that belongs to a Tumbler.
 * @returns Its shader state (or a shared default).
 */
export function shaderStateOf(object: Object3D | null): TumblerShaderState {
  const s = object?.userData.tumbler as TumblerShaderState | undefined;
  return s ?? FALLBACK_STATE;
}

const objColor = (pick: (s: TumblerShaderState) => Color) =>
  uniform(new Color()).onObjectUpdate((frame) => pick(shaderStateOf(frame.object)));
const objVec4 = (pick: (s: TumblerShaderState) => Vector4) =>
  uniform(new Vector4()).onObjectUpdate((frame) => pick(shaderStateOf(frame.object)));

/** Pattern ids in shader index order (mirrors `PATTERN_IDS` in content). */
export const SHADER_PATTERNS = [
  'solid',
  'stripes',
  'dots',
  'camo',
  'gradient',
  'galaxy',
  'checker',
  'zigzag',
  'hearts',
  'spots',
  'swirl',
  'split',
  'sprinkles',
  'plaid',
  'waves',
  'diamonds',
] as const;

/** Pupil shapes in shader index order. */
export const SHADER_PUPILS = ['round', 'star', 'heart', 'cat', 'spiral'] as const;

// -----------------------------------------------------------------------------
// Global lighting inputs
// -----------------------------------------------------------------------------

const sunDirection = uniform(new Vector3(18, 30, 12).normalize());
const rimColor = uniform(new Color('#fff2e0'));
const warmTint = uniform(new Color('#ff7a6b'));

/**
 * Points the Tumbler highlight/SSS terms at the scene's key light.
 *
 * @param dir - World-space direction towards the sun.
 * @param rim - Optional rim light colour.
 */
export function setTumblerLighting(dir: Vector3, rim?: Color): void {
  sunDirection.value.copy(dir).normalize();
  if (rim) rimColor.value.copy(rim);
}

// -----------------------------------------------------------------------------
// Small TSL helpers
// -----------------------------------------------------------------------------

/** Antialiased step using screen-space derivatives (call in uniform control flow only). */
const aaStep = (edge: F | number, x: F): F => {
  const w = max(fwidth(x), 0.0001);
  const e = typeof edge === 'number' ? float(edge) : edge;
  return smoothstep(e.sub(w), e.add(w), x);
};

/** Hash without sine (Hoskins): stable across GPUs, no integer ops needed. */
const hash31 = (p: V3): F => {
  const p3 = fract(p.mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};

/** Signed distance to a heart whose bottom tip is at the origin and top at y≈1 (Quilez). */
const sdHeart = (p0: V2): F => {
  const p = vec2(abs(p0.x), p0.y);
  const a = p.sub(vec2(0.25, 0.75));
  const upper = sqrt(dot(a, a)).sub(0.3536);
  const b = p.sub(vec2(0, 1));
  const m = max(p.x.add(p.y), 0).mul(0.5);
  const c = p.sub(vec2(m, m));
  const lower = sqrt(min(dot(b, b), dot(c, c))).mul(select(p.x.sub(p.y).greaterThan(0), float(1), float(-1)));
  return select(p.y.add(p.x).greaterThan(1), upper, lower);
};

const INK = vec3(0.07, 0.04, 0.11);

/** Eye centre (mirrored) and radii on the face plate, metres. */
const EYE_C = [0.112, 0.035] as const;
const EYE_R = [0.08, 0.1] as const;

// -----------------------------------------------------------------------------
// Patterns
// -----------------------------------------------------------------------------

interface PatternInputs {
  primary: V3;
  secondary: V3;
  tertiary: V3;
  pattern: Node<'vec4'>;
  time: F;
}

/** Returns vec4(rgb, glow). Branches on a uniform, so only one pattern runs per draw. */
function buildPattern(u: PatternInputs): Node<'vec4'> {
  return Fn(() => {
    const p = positionGeometry;
    const idx = u.pattern.x;
    const S = u.pattern.y;
    const A = u.pattern.z;
    const P = u.primary;
    const Sc = u.secondary;
    const T = u.tertiary;
    const col = vec3(P).toVar();
    const glow = float(0).toVar();

    // Seamless cylindrical cells: an integer number of cells around the body.
    // IMPORTANT: shared intermediates must be materialised with toVar() before the
    // If chain; otherwise TSL emits them inside the first branch that uses them and
    // every later branch reads an unassigned variable.
    const theta = atan(p.x, p.z).toVar();
    const N = floor(float(14).mul(S).add(0.5)).max(4).toVar();
    const cu = theta.div(Math.PI * 2).mul(N).toVar();
    const cv = p.y.mul(N).div(Math.PI * 2 * 0.42).toVar();
    const dir = vec3(sin(A), cos(A), 0).toVar();
    const d = dot(p, dir).toVar();

    If(idx.lessThan(0.5), () => {
      col.assign(P);
    })
      .ElseIf(idx.lessThan(1.5), () => {
        // stripes
        const tri = abs(fract(d.mul(S).mul(5.5)).sub(0.5));
        col.assign(mix(P, Sc, aaStep(0.25, tri)));
        col.assign(mix(col, T, float(1).sub(aaStep(0.022, abs(tri.sub(0.25))))));
      })
      .ElseIf(idx.lessThan(2.5), () => {
        // dots
        const row = floor(cv);
        const fu = fract(cu.add(mod(row, 2).mul(0.5))).sub(0.5);
        const fv = fract(cv).sub(0.5);
        const r = length(vec2(fu, fv));
        col.assign(mix(Sc, P, aaStep(0.27, r)));
        col.assign(mix(col, T, float(1).sub(aaStep(0.09, r))));
      })
      .ElseIf(idx.lessThan(3.5), () => {
        // camo
        const n1 = mx_noise_float(p.mul(S.mul(3.2)));
        const n2 = mx_noise_float(p.mul(S.mul(5.3)).add(7.31));
        const n3 = mx_noise_float(p.mul(S.mul(4.1)).add(19.7));
        col.assign(mix(P, P.mul(0.62), aaStep(0.22, n3)));
        col.assign(mix(col, Sc, aaStep(0.18, n1)));
        col.assign(mix(col, T, aaStep(0.3, n2)));
      })
      .ElseIf(idx.lessThan(4.5), () => {
        // gradient
        const t = clamp(dot(p.sub(vec3(0, 1, 0)), dir).div(1.6).add(0.5), 0, 1);
        col.assign(mix(mix(P, Sc, smoothstep(0, 0.55, t)), T, smoothstep(0.5, 1, t)));
      })
      .ElseIf(idx.lessThan(5.5), () => {
        // galaxy: dark base, coloured nebula, twinkling star points
        const n = mx_fractal_noise_float(p.mul(S.mul(1.8)), 4, 2.0, 0.5, 1.0);
        const base = mix(T.mul(0.22), P.mul(0.35), smoothstep(-0.4, 0.4, mx_noise_float(p.mul(S.mul(1.1)).add(3.3))));
        const neb = smoothstep(0.0, 0.55, n);
        col.assign(mix(base, Sc.mul(1.05), neb.mul(0.75)));
        const cell = floor(p.mul(S.mul(26)));
        const h = hash31(cell);
        const off = vec3(hash31(cell.add(11.1)), hash31(cell.add(23.7)), hash31(cell.add(37.3))).mul(0.6).add(0.2);
        const dist = length(fract(p.mul(S.mul(26))).sub(off));
        const twinkle = sin(u.time.mul(h.mul(5).add(2)).add(h.mul(40))).mul(0.35).add(0.65);
        const star = smoothstep(0.16, 0.0, dist).mul(select(h.greaterThan(0.86), float(1), float(0))).mul(twinkle);
        col.addAssign(vec3(star));
        glow.assign(star.mul(1.4).add(neb.mul(0.12)));
      })
      .ElseIf(idx.lessThan(6.5), () => {
        // checker (3D sine checker: seamless and antialiasable)
        const k = S.mul(Math.PI * 4.2);
        const s = sin(p.x.mul(k)).mul(sin(p.y.mul(k))).mul(sin(p.z.mul(k).add(0.5)));
        col.assign(mix(P, Sc, aaStep(0, s)));
      })
      .ElseIf(idx.lessThan(7.5), () => {
        // zigzag
        const zz = p.y.mul(S).mul(5.5).add(abs(fract(cu.mul(0.5)).sub(0.5)).mul(1.4));
        const band = mod(floor(zz), 3);
        col.assign(select(band.lessThan(0.5), P, select(band.lessThan(1.5), Sc, T)));
      })
      .ElseIf(idx.lessThan(8.5), () => {
        // hearts
        const row = floor(cv);
        const cx = cu.add(mod(row, 2).mul(0.5));
        const q = vec2(fract(cx).sub(0.5), fract(cv).sub(0.5)).mul(2.6).add(vec2(0, 0.55));
        const hd = sdHeart(q);
        const alt = mod(floor(cx).add(row), 2);
        const hc = mix(Sc, T, alt);
        col.assign(mix(hc, P, aaStep(0, hd)));
      })
      .ElseIf(idx.lessThan(9.5), () => {
        // spots
        const w = mx_worley_noise_float(p.mul(S.mul(3.4)), 0.9);
        col.assign(mix(Sc, P, aaStep(0.38, w)));
        col.assign(mix(T, col, aaStep(0.24, w)));
      })
      .ElseIf(idx.lessThan(10.5), () => {
        // swirl
        const sw = fract(theta.div(Math.PI * 2).mul(3).add(p.y.mul(S).mul(2.6)));
        const tri = abs(sw.sub(0.5));
        col.assign(mix(P, Sc, aaStep(0.25, tri)));
        col.assign(mix(col, T, float(1).sub(aaStep(0.03, abs(tri.sub(0.25))))));
      })
      .ElseIf(idx.lessThan(11.5), () => {
        // two-tone split
        const x = p.x.mul(cos(A)).add(p.y.sub(1).mul(sin(A)));
        col.assign(mix(P, Sc, aaStep(0, x)));
        col.assign(mix(col, T, float(1).sub(aaStep(0.018, abs(x)))));
      })
      .ElseIf(idx.lessThan(12.5), () => {
        // sprinkles
        const gu = cu.mul(2.2);
        const gv = cv.mul(2.2);
        const cell = vec3(floor(gu), floor(gv), 0);
        const h1 = hash31(cell);
        const h2 = hash31(cell.add(5.17));
        const h3 = hash31(cell.add(9.73));
        const lp = vec2(fract(gu), fract(gv)).sub(vec2(h1.mul(0.4).add(0.3), h2.mul(0.4).add(0.3)));
        const ang = h3.mul(Math.PI * 2);
        const ax = vec2(cos(ang), sin(ang));
        const t = clamp(dot(lp, ax), -0.17, 0.17);
        const sd = length(lp.sub(ax.mul(t))).sub(0.075);
        const pick = hash31(cell.add(2.9));
        const sc = select(pick.lessThan(0.33), Sc, select(pick.lessThan(0.66), T, vec3(1, 1, 1)));
        col.assign(mix(sc, P, aaStep(0, sd)));
      })
      .ElseIf(idx.lessThan(13.5), () => {
        // plaid
        const bu = float(1).sub(aaStep(0.17, abs(fract(cu.mul(0.5)).sub(0.5))));
        const bv = float(1).sub(aaStep(0.17, abs(fract(cv.mul(0.5)).sub(0.5))));
        col.assign(mix(P, Sc, bu.mul(0.55)));
        col.assign(mix(col, Sc.mul(0.8), bv.mul(0.55)));
        const lu = float(1).sub(aaStep(0.035, abs(fract(cu.mul(0.5).add(0.25)).sub(0.5))));
        const lv = float(1).sub(aaStep(0.035, abs(fract(cv.mul(0.5).add(0.25)).sub(0.5))));
        col.assign(mix(col, T, max(lu, lv)));
      })
      .ElseIf(idx.lessThan(14.5), () => {
        // waves
        const w = p.y.mul(S).mul(6).add(sin(theta.mul(4).add(p.y.mul(3))).mul(0.4));
        const band = mod(floor(w), 3);
        col.assign(select(band.lessThan(0.5), P, select(band.lessThan(1.5), Sc, T)));
      })
      .Else(() => {
        // harlequin diamonds
        const a = cu.add(cv).mul(0.5);
        const b = cu.sub(cv).mul(0.5);
        const s = sin(a.mul(Math.PI * 2)).mul(sin(b.mul(Math.PI * 2)));
        col.assign(mix(P, Sc, aaStep(0, s)));
        col.assign(mix(col, T, float(1).sub(aaStep(0.06, abs(s)))));
      });

    return vec4(col, glow);
  })();
}

// -----------------------------------------------------------------------------
// Face plate
// -----------------------------------------------------------------------------

interface FaceInputs {
  primary: V3;
  plate: V3;
  iris: V3;
  faceA: Node<'vec4'>;
  faceB: Node<'vec4'>;
  faceC: Node<'vec4'>;
  faceD: Node<'vec4'>;
  faceE: Node<'vec4'>;
  fx: Node<'vec4'>;
}

/** Face colour + plate mask, computed from the `aFace` coordinates (metres on the plate). */
function buildFace(u: FaceInputs, q: V2, aa: F): { color: V3; mask: F; gloss: F } {
  const plateN = q.div(vec2(RIG.faceHalfW, RIG.faceHalfH));
  const plateD = length(plateN).sub(1);
  const aaN = aa.div(RIG.faceHalfH);
  const mask = float(1).sub(smoothstep(aaN.negate(), aaN, plateD));

  // Visor gloss: a crescent reflection in the upper-left of the plate.
  const g1 = length(plateN.sub(vec2(-0.32, 0.42)));
  const g2 = length(plateN.sub(vec2(-0.2, 0.3)));
  const gloss = smoothstep(0.42, 0.36, g1).mul(smoothstep(0.32, 0.4, g2)).mul(mask);

  const color = Fn(() => {
  const col = vec3(u.plate).toVar();
  // Soft inner shade near the plate rim adds depth to the visor.
  col.assign(mix(col, col.mul(0.9), smoothstep(-0.25, 0, plateD)));

  const t = u.faceE.w;
  const side = select(q.x.greaterThan(0), float(1), float(-1));
  const qm = vec2(abs(q.x), q.y);

  // Blush and freckles under the eyes.
  const blushD = length(qm.sub(vec2(0.19, -0.085)).div(vec2(0.055, 0.032)));
  col.assign(mix(col, vec3(1.0, 0.42, 0.55), smoothstep(1, 0.2, blushD).mul(0.45).mul(u.faceE.x)));
  const fr1 = length(qm.sub(vec2(0.15, -0.035)));
  const fr2 = length(qm.sub(vec2(0.18, -0.02)));
  const fr3 = length(qm.sub(vec2(0.195, -0.05)));
  const freck = float(1).sub(smoothstep(0.004, 0.0075, min(fr1, min(fr2, fr3))));
  col.assign(mix(col, vec3(0.55, 0.3, 0.2), freck.mul(u.faceE.y).mul(0.75)));

  // Eyes, in each eye's normalised ellipse space.
  const wide = u.fx.w;
  const r = vec2(EYE_R[0], EYE_R[1]).mul(u.faceD.y).mul(wide.mul(0.14).add(1));
  const e = qm.sub(vec2(EYE_C[0], EYE_C[1])).div(r);
  const aaE = aa.div(r.y).mul(1.3);
  const eyeD = length(e).sub(1);
  const happy = u.faceA.w;
  const eyeMask = float(1).sub(smoothstep(aaE.negate(), aaE, eyeD)).mul(float(1).sub(happy));

  const look = vec2(u.faceA.x.mul(side), u.faceA.y).mul(0.3);
  const pr = u.faceD.z.mul(0.55);
  const pe = e.sub(look).div(pr);
  const pd = length(pe);
  const ang = atan(pe.y, pe.x);
  const shape = select(u.faceD.w.greaterThan(0.5), float(4), u.faceD.x);

  const starR = mix(float(0.48), float(1.08), pow(cos(ang.sub(Math.PI / 2).mul(5)).mul(0.5).add(0.5), 2.2));
  const dStar = pd.sub(starR);
  const dHeart = sdHeart(pe.mul(0.8).add(vec2(0, 0.5))).mul(1.3);
  const dCat = length(pe.mul(vec2(2.8, 1.05))).sub(0.95);
  const spin = ang.add(pd.mul(5)).sub(t.mul(7));
  const dSpiral = abs(fract(spin.div(Math.PI * 2).mul(2)).sub(0.5)).sub(0.22).mul(0.6);

  const irisD = select(shape.lessThan(0.5), pd.sub(1), select(shape.lessThan(1.5), dStar, select(shape.lessThan(2.5), dHeart, pd.sub(1))));
  const coreD = select(
    shape.lessThan(0.5),
    pd.sub(0.56),
    select(shape.lessThan(1.5), dStar.add(0.32), select(shape.lessThan(2.5), dHeart.add(0.28), select(shape.lessThan(3.5), dCat.mul(0.45), dSpiral))),
  );
  const aaP = aaE.div(pr);
  const irisM = float(1).sub(smoothstep(aaP.negate(), aaP, irisD));
  const coreM = float(1).sub(smoothstep(aaP.negate(), aaP, coreD));

  const eyeCol = vec3(1, 1, 1).toVar();
  eyeCol.assign(mix(eyeCol, u.iris, irisM));
  eyeCol.assign(mix(eyeCol, mix(u.iris, INK, 0.75), irisM.mul(smoothstep(0.1, 1.0, pd)).mul(0.35)));
  eyeCol.assign(mix(eyeCol, INK, coreM));
  const hl1 = length(pe.sub(vec2(-0.32, 0.36)));
  const hl2 = length(pe.sub(vec2(0.3, -0.32)));
  const hl = float(1).sub(smoothstep(0.2, 0.2 + 0.08, hl1)).add(float(1).sub(smoothstep(0.09, 0.15, hl2)).mul(0.8));
  eyeCol.assign(mix(eyeCol, vec3(1, 1, 1), clamp(hl, 0, 1).mul(select(shape.greaterThan(3.5), float(0.5), float(1)))));
  // Dark rim around the sclera.
  eyeCol.assign(mix(eyeCol, INK, smoothstep(aaE.negate().sub(0.15), aaE.sub(0.15), eyeD)));

  // Upper lid: closure + tilt (determined/angry tilts the inner corner down).
  const closure = clamp(u.faceA.z, 0, 1);
  const lidY = float(1.05).sub(closure.mul(2.1)).add(u.fx.z.mul(e.x).mul(0.55));
  const lidM = smoothstep(lidY.sub(aaE), lidY.add(aaE), e.y);
  const lidCol = mix(u.plate, u.primary, 0.45).mul(0.92);
  eyeCol.assign(mix(eyeCol, lidCol, lidM));
  const lash = float(1).sub(smoothstep(float(0.06), aaE.mul(2).add(0.06), abs(e.y.sub(lidY)))).mul(smoothstep(0.02, 0.08, closure));
  eyeCol.assign(mix(eyeCol, INK, lash));
  col.assign(mix(col, eyeCol, eyeMask));

  // Lashes: three little flicks at the outer corner.
  const lashTip = length(e.sub(vec2(0.95, 0.55))).sub(0.14);
  const lashM = float(1).sub(smoothstep(0, aaE.mul(2), lashTip)).mul(u.faceE.z).mul(float(1).sub(happy));
  col.assign(mix(col, INK, lashM));

  // Happy closed "^" eyes.
  const arc = abs(length(e.sub(vec2(0, -0.75))).sub(0.95)).sub(0.11);
  const arcM = float(1).sub(smoothstep(aaE.negate(), aaE, arc)).mul(select(e.y.greaterThan(-0.35), float(1), float(0))).mul(select(abs(e.x).lessThan(0.85), float(1), float(0)));
  col.assign(mix(col, INK, arcM.mul(happy)));

  // Brows.
  const browC = vec2(EYE_C[0], r.y.add(EYE_C[1] + 0.05).add(u.faceC.w.mul(0.025)));
  const bq = qm.sub(browC);
  const bx = clamp(bq.x, -0.05, 0.05);
  const by = u.faceC.z.mul(bx).mul(0.7).sub(bx.mul(bx).mul(7));
  const browD = length(vec2(max(abs(bq.x).sub(0.05), 0), bq.y.sub(by))).sub(0.011);
  col.assign(mix(col, INK, float(1).sub(smoothstep(aa.negate(), aa, browD))));

  // Mouth.
  const m = q.sub(vec2(0, -0.125));
  const w = max(u.faceB.z, 0.015);
  const xn = clamp(m.x.div(w), -1, 1);
  const curve = u.faceB.y.mul(0.03).mul(xn.mul(xn).sub(1)).add(u.faceB.w.mul(0.012).mul(sin(xn.mul(Math.PI * 2.5).add(t.mul(6)))));
  const env = sqrt(max(float(1).sub(xn.mul(xn)), 0));
  const open = u.faceB.x;
  const yl = curve.sub(open.mul(0.075).mul(env));
  const yu = curve.add(open.mul(0.022).mul(env).mul(float(1).sub(u.faceB.y.mul(0.5))));
  const insideD = max(abs(m.x).sub(w), max(m.y.sub(yu), yl.sub(m.y)));
  const interior = float(1).sub(smoothstep(aa.negate(), aa, insideD)).mul(smoothstep(0.02, 0.08, open));
  const mouthCol = vec3(0.36, 0.08, 0.2).toVar();
  const teeth = smoothstep(yu.sub(0.022).sub(aa), yu.sub(0.022).add(aa), m.y).mul(u.faceC.y);
  mouthCol.assign(mix(mouthCol, vec3(1, 1, 1), teeth));
  const tongueIn = float(1).sub(smoothstep(0.03 - 0.004, 0.03 + 0.004, length(m.sub(vec2(0.008, yl.add(0.012))))));
  mouthCol.assign(mix(mouthCol, vec3(1.0, 0.42, 0.55), tongueIn.mul(0.85)));
  col.assign(mix(col, mouthCol, interior));
  const lineD = length(vec2(max(abs(m.x).sub(w), 0), m.y.sub(curve))).sub(0.0095);
  const edge = float(1).sub(smoothstep(aa.negate(), aa, abs(insideD).sub(0.006))).mul(smoothstep(0.02, 0.08, open));
  const lineM = max(float(1).sub(smoothstep(aa.negate(), aa, lineD)).mul(float(1).sub(smoothstep(0.02, 0.08, open))), edge);
  col.assign(mix(col, INK, lineM));
  // Tongue sticking out past the lower lip.
  const tongueOut = m.sub(vec2(0.012, yl.sub(u.faceC.x.mul(0.012))));
  const tD = length(tongueOut.mul(vec2(1, 0.85))).sub(0.032);
  const tM = float(1).sub(smoothstep(aa.negate(), aa, tD)).mul(smoothstep(0.4, 0.7, u.faceC.x)).mul(select(tongueOut.y.lessThan(0.006), float(1), float(0)));
  col.assign(mix(col, vec3(1.0, 0.45, 0.58), tM));
  col.assign(mix(col, INK, float(1).sub(smoothstep(0, aa.mul(2), abs(tD).sub(0.004))).mul(tM)));

  return col;
  })();

  return { color, mask, gloss };
}

// -----------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------

/**
 * Toon material whose albedo is injected in `setupDiffuseColor` rather than via
 * `colorNode`: the shadow pass derives alpha from `colorNode`, which would
 * compile the whole face/pattern graph into every shadow-map draw.
 */
class TumblerToonMaterial extends MeshToonNodeMaterial {
  albedoNode: Node | null = null;
  // NOTE: NodeMaterial reads emissiveNode for every lit material; the typings only declare it on Standard.
  declare emissiveNode: Node | null;
  override setupDiffuseColor(builder: NodeBuilder): void {
    super.setupDiffuseColor(builder);
    if (this.albedoNode) diffuseColor.assign(vec4(this.albedoNode as V3, 1));
  }
}

/** Shared material set. */
export interface TumblerMaterials {
  body: MeshToonNodeMaterial;
  outline: MeshBasicNodeMaterial;
}

let shared: TumblerMaterials | null = null;

const uniforms = {
  primary: objColor((s) => s.primary),
  secondary: objColor((s) => s.secondary),
  tertiary: objColor((s) => s.tertiary),
  plate: objColor((s) => s.plate),
  iris: objColor((s) => s.iris),
  pattern: objVec4((s) => s.pattern),
  faceA: objVec4((s) => s.faceA),
  faceB: objVec4((s) => s.faceB),
  faceC: objVec4((s) => s.faceC),
  faceD: objVec4((s) => s.faceD),
  faceE: objVec4((s) => s.faceE),
  fx: objVec4((s) => s.fx),
};

/** Screen-door transparency: keeps the opaque pipeline (no sorting) for ghosts and fades. */
const dither = (opacity: F): void => {
  If(opacity.lessThan(0.999), () => {
    const n = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189));
    Discard(n.greaterThan(opacity));
  });
};

/** Global outline width (local units). Scaled up with distance so far Tumblers stay readable. */
export const outlineThickness = uniform(0.018);

/**
 * The shared Tumbler materials. Created on first use; never disposed while
 * Tumblers exist (call {@link disposeTumblerMaterials} on teardown).
 *
 * @returns Body + outline materials.
 */
export function getTumblerMaterials(): TumblerMaterials {
  if (shared) return shared;

  const ref = createToonMaterial({ color: '#ffffff', rimStrength: 0 });
  const body = new TumblerToonMaterial();
  body.gradientMap = ref.gradientMap;
  ref.dispose();
  const kind = attribute('aKind', 'float') as unknown as F;
  const vcol = attribute('color', 'vec3') as unknown as V3;
  const faceUV = attribute('aFace', 'vec2') as unknown as V2;
  const aa = max(fwidth(faceUV.y), 0.0004);

  const pat = buildPattern({
    primary: uniforms.primary as unknown as V3,
    secondary: uniforms.secondary as unknown as V3,
    tertiary: uniforms.tertiary as unknown as V3,
    pattern: uniforms.pattern,
    time: uniforms.faceE.w,
  });
  const face = buildFace(
    {
      primary: uniforms.primary as unknown as V3,
      plate: uniforms.plate as unknown as V3,
      iris: uniforms.iris as unknown as V3,
      faceA: uniforms.faceA,
      faceB: uniforms.faceB,
      faceC: uniforms.faceC,
      faceD: uniforms.faceD,
      faceE: uniforms.faceE,
      fx: uniforms.fx,
    },
    faceUV,
    aa,
  );

  const P = uniforms.primary as unknown as V3;
  const isPattern = kind.lessThan(0.5);
  const bodyCol = mix(pat.xyz, face.color, face.mask);
  const albedo = select(
    isPattern,
    bodyCol,
    select(
      kind.lessThan(1.5),
      P,
      select(kind.lessThan(2.5), uniforms.secondary as unknown as V3, select(kind.lessThan(3.5), uniforms.tertiary as unknown as V3, vcol)),
    ),
  );

  body.albedoNode = Fn(() => {
    dither(uniforms.fx.x);
    return albedo;
  })();

  // View-space lighting terms layered on top of the toon ramp.
  const N = normalize(normalView);
  const V = positionViewDirection;
  const L = normalize(cameraViewMatrix.mul(vec4(sunDirection, 0)).xyz);
  const NdotL = dot(N, L);
  const NdotV = clamp(dot(N, V), 0, 1);
  const H = normalize(L.add(V));
  const NdotH = clamp(dot(N, H), 0, 1);

  const isPal = kind.lessThan(3.5);
  const isShiny = kind.greaterThan(4.5).and(kind.lessThan(5.5));
  const isGlow = kind.greaterThan(5.5).and(kind.lessThan(6.5));
  const isGlass = kind.greaterThan(6.5);

  const rim = smoothstep(0.58, 0.88, float(1).sub(NdotV)).mul(0.32);
  const terminator = float(1).sub(smoothstep(0, 0.42, abs(NdotL))).mul(0.16);
  const backlit = pow(clamp(dot(V, L.negate()), 0, 1), 4).mul(float(1).sub(NdotV)).mul(0.35);
  const sss = albedo.mul(warmTint).mul(terminator.add(backlit)).mul(select(isPal, float(1), float(0.4)));
  const specEdge = select(isShiny, float(0.93), float(0.962));
  const specAmt = select(isShiny, float(1.1), select(isGlass, float(0.9), float(0.45))).add(face.mask.mul(0.45));
  const spec = smoothstep(specEdge, specEdge.add(0.018), NdotH).mul(specAmt).mul(smoothstep(-0.1, 0.25, NdotL));
  const glassSheen = pow(float(1).sub(NdotV), 2).mul(0.6).mul(select(isGlass, float(1), float(0)));
  const glow = albedo.mul(select(isGlow, float(0.85), float(0))).add(vec3(pat.w.mul(select(isPattern, float(1), float(0))).mul(float(1).sub(face.mask))));
  const flash = uniforms.fx.y;

  body.emissiveNode = rimColor
    .mul(rim)
    .add(sss)
    .add(vec3(spec))
    .add(vec3(face.gloss.mul(0.4)))
    .add(vec3(glassSheen))
    .add(glow)
    .add(vec3(flash));

  const outline = new MeshBasicNodeMaterial({ side: BackSide });
  const origin = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  const distScale = clamp(origin.distance(cameraPosition).mul(0.1), 1, 2.6);
  outline.positionNode = positionLocal.add(normalLocal.mul(outlineThickness.mul(distScale)));
  outline.colorNode = Fn(() => {
    dither(uniforms.fx.x);
    return vec4(mix(INK, P.mul(0.32), 0.35), 1);
  })();

  shared = { body, outline };
  return shared;
}

/** Disposes the shared materials (scene teardown). */
export function disposeTumblerMaterials(): void {
  shared?.body.dispose();
  shared?.outline.dispose();
  shared = null;
}
