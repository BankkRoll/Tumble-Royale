import {
  Color,
  DataTexture,
  LinearFilter,
  MeshToonNodeMaterial,
  RedFormat,
  type ColorRepresentation,
} from 'three/webgpu';
import { float, normalView, positionViewDirection, smoothstep, uniform } from 'three/tsl';
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
 * Stylised toon material used for characters, obstacles and level geometry.
 * Identical node graph on WebGPU and WebGL2 backends.
 *
 * @example
 * const mat = createToonMaterial({ color: '#ff6fb5', rimStrength: 0.6 });
 */
export function createToonMaterial(opts: ToonMaterialOptions): MeshToonNodeMaterial {
  const mat = new MeshToonNodeMaterial({ color: new Color(opts.color) });
  mat.gradientMap = toonRamp();

  const rimColor = uniform(new Color(opts.rimColor ?? '#fff4e0'));
  const rimStrength = uniform(opts.rimStrength ?? 0.45);
  const facing = normalView.dot(positionViewDirection).clamp(0, 1);
  const rim = smoothstep(float(0.62), float(0.8), float(1).sub(facing)).mul(rimStrength);

  const emissive = uniform(new Color(opts.emissive ?? '#000000'));
  const emissiveIntensity = uniform(opts.emissiveIntensity ?? 0);
  // NOTE: NodeMaterial reads emissiveNode for every lit material; the typings only declare it on Standard.
  (mat as MeshToonNodeMaterial & { emissiveNode: Node | null }).emissiveNode = rimColor
    .mul(rim)
    .add(emissive.mul(emissiveIntensity));

  mat.userData.uniforms = { rimColor, rimStrength, emissive, emissiveIntensity };
  return mat;
}
