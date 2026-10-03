import { Color, Vector3, type MeshToonNodeMaterial, type Node, type UniformNode } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { ThemeDefinition } from '@tumble/content/themes';
import { createToonMaterial } from '../materials/toon.ts';

/**
 * Level surface materials. Base colour comes from vertex colours so many pieces
 * with different palette colours share one material (and one draw call); the
 * surface kind and pattern pick the node graph. Patterns are projected in world
 * space so merged geometry needs no UV work and stripes line up across pieces.
 */

/** Surface kinds from round data. */
export type SurfaceKind = 'normal' | 'ice' | 'slime' | 'conveyor' | 'sticky' | 'bouncy' | 'slide';
/** Pattern overlays from round data. */
export type PatternKind = 'none' | 'stripes' | 'dots' | 'checker' | 'chevron' | 'hazard';

/** Uniforms shared by every level material so one write per frame animates them all. */
export interface LevelUniforms {
  /** Seconds; drives slime flow, sparkles, wobble and conveyor scroll. */
  time: UniformNode<'float', number>;
  /** World-space direction towards the sun, for fake glossy highlights. */
  sunDir: UniformNode<'vec3', Vector3>;
  sunColor: UniformNode<'color', Color>;
  /** Overlay colour for stripes/dots/checker. */
  patternColor: UniformNode<'color', Color>;
  /** Hazard tape colours. */
  hazardA: UniformNode<'color', Color>;
  hazardB: UniformNode<'color', Color>;
  rimColor: UniformNode<'color', Color>;
  /** Global emissive boost for night weather (fairy-light look). */
  nightGlow: UniformNode<'float', number>;
}

/**
 * Creates the uniform block shared by all level materials of one level.
 *
 * @param theme - Active theme.
 */
export function createLevelUniforms(theme: ThemeDefinition): LevelUniforms {
  const d = theme.sun.direction;
  return {
    time: uniform(0),
    sunDir: uniform(new Vector3(d.x, d.y, d.z).normalize()),
    sunColor: uniform(new Color(theme.sun.color)),
    patternColor: uniform(new Color(theme.palette.pattern)),
    hazardA: uniform(new Color(theme.palette.interact)),
    hazardB: uniform(new Color(theme.palette.ink)),
    rimColor: uniform(new Color('#fff4e0')),
    nightGlow: uniform(0),
  };
}

/**
 * Re-points shared level uniforms at a new theme (live theme switching in the lab
 * and weather changes) without rebuilding materials.
 */
export function applyThemeToLevelUniforms(u: LevelUniforms, theme: ThemeDefinition): void {
  const d = theme.sun.direction;
  u.sunDir.value.set(d.x, d.y, d.z).normalize();
  u.sunColor.value.set(theme.sun.color);
  u.patternColor.value.set(theme.palette.pattern);
  u.hazardA.value.set(theme.palette.interact);
  u.hazardB.value.set(theme.palette.ink);
}

type F = Node<'float'>;

/** Planar projection coordinates picked by the dominant world normal axis. */
function projectedUV(): Node<'vec2'> {
  const n = abs(normalWorld);
  const p = positionWorld;
  const topFacing = n.y.greaterThan(max(n.x, n.z));
  const sideX = n.x.greaterThan(n.z);
  return select(topFacing, vec2(p.x, p.z), select(sideX, vec2(p.z, p.y), vec2(p.x, p.y))) as Node<'vec2'>;
}

/** Anti-aliased step: hard edge that stays crisp at any distance without shimmering. */
function aaStep(edge: F, x: F): F {
  const w = max(fwidth(x), float(1e-4));
  return smoothstep(edge.sub(w), edge.add(w), x) as F;
}

/** Pattern coverage mask in [0, 1]. */
function patternMask(pattern: PatternKind, time: UniformNode<'float', number>, scroll: boolean): F {
  const uv = projectedUV();
  switch (pattern) {
    case 'stripes': {
      const s = fract(uv.x.add(uv.y).mul(0.55)) as F;
      return aaStep(float(0.5), s);
    }
    case 'hazard': {
      const s = fract(uv.x.add(uv.y).mul(1.1)) as F;
      return aaStep(float(0.5), s);
    }
    case 'dots': {
      const cell = fract(uv.mul(0.9)).sub(0.5);
      const d = length(cell) as F;
      return float(1).sub(aaStep(float(0.28), d)) as F;
    }
    case 'checker': {
      const c = floor(uv.mul(0.5));
      const parity = fract(c.x.add(c.y).mul(0.5)).mul(2) as F;
      return step(0.5, parity) as F;
    }
    case 'chevron': {
      const p = positionWorld;
      const z = scroll ? p.z.sub(time.mul(2.2)) : p.z;
      const v = fract(z.mul(0.5).sub(abs(p.x).mul(0.35))) as F;
      return aaStep(float(0.55), v);
    }
    case 'none':
      return float(0);
  }
}

/** Fake glossy highlight from the sun; toon ramps have no specular term. */
function glossHighlight(u: LevelUniforms, sharpness: number, strength: number): Node<'vec3'> {
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const r = reflect(viewDir.negate(), normalWorld.normalize());
  const spec = pow(max(r.dot(u.sunDir), float(0)), float(sharpness));
  const banded = smoothstep(0.45, 0.6, spec);
  return u.sunColor.mul(banded.mul(strength)) as Node<'vec3'>;
}

/** Rim light, identical to `createToonMaterial`'s, re-derived because we replace the emissive graph. */
function rimTerm(u: LevelUniforms, strength: number): Node<'vec3'> {
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorld.normalize().dot(viewDir).clamp(0, 1);
  const rim = smoothstep(0.62, 0.8, float(1).sub(facing)).mul(strength);
  return u.rimColor.mul(rim) as Node<'vec3'>;
}

/** Options for {@link createLevelMaterial}. */
export interface LevelMaterialOptions {
  surface: SurfaceKind;
  pattern: PatternKind;
  /** Pieces flagged decorative get a softer rim so gameplay geometry reads first. */
  decorative?: boolean;
}

/**
 * Builds a level material. Base colour must be supplied as a `color` vertex
 * attribute (see `buildLevelVisuals`).
 *
 * @param u - Shared level uniforms.
 * @param opts - Surface + pattern.
 * @returns A toon node material; dispose it with the level.
 */
export function createLevelMaterial(u: LevelUniforms, opts: LevelMaterialOptions): MeshToonNodeMaterial {
  const mat = createToonMaterial({ color: '#ffffff' });
  const base = vertexColor() as unknown as Node<'vec3'>;
  const t = u.time;
  const p = positionWorld;

  let pattern = opts.pattern;
  if (opts.surface === 'slide' && pattern === 'none') pattern = 'stripes';
  if (opts.surface === 'conveyor' && pattern === 'none') pattern = 'chevron';
  const mask = patternMask(pattern, t, opts.surface === 'conveyor');

  let albedo: Node<'vec3'>;
  if (pattern === 'hazard') albedo = mix(u.hazardA, u.hazardB, mask) as Node<'vec3'>;
  else if (pattern === 'none') albedo = base;
  else albedo = mix(base, mix(base, u.patternColor, 0.85), mask) as Node<'vec3'>;

  let emissive: Node<'vec3'> = rimTerm(u, opts.decorative ? 0.25 : 0.45);

  switch (opts.surface) {
    case 'ice': {
      albedo = mix(albedo, vec3(0.9, 0.97, 1.0), 0.35) as Node<'vec3'>;
      const cell = floor(p.mul(5.0));
      const h = hash(cell.x.add(cell.y.mul(57.0)).add(cell.z.mul(113.0)));
      const twinkle = step(0.965, h).mul(
        sin(t.mul(4.0).add(h.mul(60.0)))
          .mul(0.5)
          .add(0.5),
      );
      emissive = emissive
        .add(glossHighlight(u, 40, 0.9))
        .add(vec3(0.9, 0.97, 1.0).mul(twinkle.mul(1.6))) as Node<'vec3'>;
      break;
    }
    case 'slime': {
      const flow = mx_noise_float(vec3(p.x.mul(0.35), p.z.mul(0.35).sub(t.mul(0.25)), t.mul(0.2)));
      albedo = mix(albedo, albedo.mul(1.35), smoothstep(-0.2, 0.6, flow)) as Node<'vec3'>;
      emissive = emissive.add(glossHighlight(u, 18, 0.7)).add(albedo.mul(0.12)) as Node<'vec3'>;
      const wave = sin(p.x.mul(1.3).add(t.mul(2.2)))
        .mul(sin(p.z.mul(1.1).sub(t.mul(1.7))))
        .mul(0.035);
      mat.positionNode = positionLocal.add(normalLocal.mul(wave));
      break;
    }
    case 'sticky': {
      albedo = albedo.mul(0.82) as Node<'vec3'>;
      const cells = p.xz.mul(1.4);
      const id = floor(cells);
      const local = fract(cells).sub(0.5);
      const rnd = hash(id.x.add(id.y.mul(31.0)));
      const pulse = sin(t.mul(1.5).add(rnd.mul(20.0)))
        .mul(0.5)
        .add(0.5);
      const bubble = float(1).sub(
        aaStep(rnd.mul(0.18).add(0.08).mul(pulse.mul(0.6).add(0.6)), length(local) as F),
      );
      albedo = mix(albedo, albedo.mul(1.45), bubble.mul(step(0.35, rnd))) as Node<'vec3'>;
      emissive = emissive.add(glossHighlight(u, 22, 0.55)) as Node<'vec3'>;
      break;
    }
    case 'bouncy': {
      const wob = sin(t.mul(5.5).add(p.x.mul(0.8)).add(p.z.mul(0.6))).mul(0.045);
      mat.positionNode = positionLocal.add(normalLocal.mul(wob));
      emissive = emissive
        .add(glossHighlight(u, 14, 0.5))
        .add(albedo.mul(sin(t.mul(3.0)).mul(0.05).add(0.1))) as Node<'vec3'>;
      break;
    }
    case 'slide':
      emissive = emissive.add(glossHighlight(u, 26, 0.75)) as Node<'vec3'>;
      break;
    case 'conveyor':
      albedo = albedo.mul(0.92) as Node<'vec3'>;
      break;
    case 'normal':
      break;
  }

  emissive = emissive.add(albedo.mul(u.nightGlow.mul(0.18))) as Node<'vec3'>;
  if (pattern === 'hazard')
    emissive = emissive.add(u.hazardA.mul(mask.mul(u.nightGlow).mul(0.35))) as Node<'vec3'>;

  mat.colorNode = albedo;
  (mat as MeshToonNodeMaterial & { emissiveNode: Node | null }).emissiveNode = emissive;
  mat.userData.levelSurface = opts.surface;
  return mat;
}

/**
 * Bright yellow "you can grab this" trim material.
 *
 * @param u - Shared level uniforms.
 */
export function createGrabTrimMaterial(u: LevelUniforms): MeshToonNodeMaterial {
  const mat = createToonMaterial({ color: '#ffffff' });
  const pulse = sin(u.time.mul(3.0)).mul(0.5).add(0.5);
  mat.colorNode = u.hazardA;
  (mat as MeshToonNodeMaterial & { emissiveNode: Node | null }).emissiveNode = rimTerm(u, 0.6).add(
    u.hazardA.mul(pulse.mul(0.12).add(0.1).add(u.nightGlow.mul(0.6))),
  );
  return mat;
}
