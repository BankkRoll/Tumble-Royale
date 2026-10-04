import {
  Color,
  DataTexture,
  LinearFilter,
  MeshToonNodeMaterial,
  RedFormat,
  type ColorRepresentation,
} from 'three/webgpu';
import { float, materialReference, normalView, positionViewDirection, smoothstep } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** Options for {@link createToonMaterial}. */
export interface ToonMaterialOptions {
  color: ColorRepresentation;
  /** Rim light colour. Defaults to a warm white. */
  rimColor?: ColorRepresentation;
  /** Rim light intensity, 0 disables. */
  rimStrength?: number;
  /** Self-illumination for telegraphing hazards and pickups. */
  emissive?: ColorRepresentation;
  emissiveIntensity?: number;
}

let sharedRamp: DataTexture | null = null;

/**
 * Three-band diffuse ramp. A few intermediate texels with linear filtering give
 * the "soft edge" between bands without resorting to a smooth gradient.
 */
function toonRamp(): DataTexture {
  if (sharedRamp) return sharedRamp;
  const bands = [70, 70, 70, 140, 165, 165, 165, 165, 235, 255, 255, 255, 255, 255, 255, 255];
  const data = new Uint8Array(bands);
  const tex = new DataTexture(data, bands.length, 1, RedFormat);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  sharedRamp = tex;
  return tex;
}

/**
 * A toon material's per-material inputs (`material.userData.uniforms`). Set
 * `value` to animate them; the shader reads them for each draw.
 */
export interface ToonUniforms {
  rimColor: { value: Color };
  rimStrength: { value: number };
  emissive: { value: Color };
  emissiveIntensity: { value: number };
}

let sharedEmissive: Node | null = null;

/**
 * Rim light plus telegraph glow, one graph for every toon material, reading
 * each material's {@link ToonUniforms} through material references.
 *
 * PERF: three keys compiled shaders by node identity. A graph built per
 * material (fresh `uniform()` nodes) made every toon material a shader of
 * its own: 186 shader builds on one course for 99 distinct ones.
 */
function toonEmissive(): Node {
  if (sharedEmissive) return sharedEmissive;
  // The typings declare reference nodes untyped; they resolve to a vec3/float uniform.
  const color = (name: keyof ToonUniforms): Node<'vec3'> =>
    materialReference(`userData.uniforms.${name}.value`, 'color') as unknown as Node<'vec3'>;
  const scalar = (name: keyof ToonUniforms): Node<'float'> =>
    materialReference(`userData.uniforms.${name}.value`, 'float') as unknown as Node<'float'>;
  const facing = normalView.dot(positionViewDirection).clamp(0, 1);
  const rim = smoothstep(float(0.62), float(0.8), float(1).sub(facing)).mul(scalar('rimStrength'));
  const emissive = color('rimColor')
    .mul(rim)
    .add(color('emissive').mul(scalar('emissiveIntensity')));
  sharedEmissive = emissive;
  return emissive;
}

/**
 * Stylised toon material used for characters, obstacles and level geometry.
 * Identical node graph on WebGPU and WebGL2 backends.
 *
 * @example
 * const mat = createToonMaterial({ color: '#ff6fb5', rimStrength: 0.6 });
 */
export function createToonMaterial(opts: ToonMaterialOptions): MeshToonNodeMaterial {
  const mat = new MeshToonNodeMaterial({ color: new Color(opts.color) });
  mat.gradientMap = toonRamp();

  const uniforms: ToonUniforms = {
    rimColor: { value: new Color(opts.rimColor ?? '#fff4e0') },
    rimStrength: { value: opts.rimStrength ?? 0.45 },
    emissive: { value: new Color(opts.emissive ?? '#000000') },
    emissiveIntensity: { value: opts.emissiveIntensity ?? 0 },
  };
  // userData stays out of three's shader cache key, so animating these never forces a rebuild.
  mat.userData.uniforms = uniforms;
  // NOTE: NodeMaterial reads emissiveNode for every lit material; the typings only declare it on Standard.
  (mat as MeshToonNodeMaterial & { emissiveNode: Node | null }).emissiveNode = toonEmissive();
  return mat;
}
