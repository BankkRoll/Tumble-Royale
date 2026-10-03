import { BackSide, Color, MeshBasicNodeMaterial, type ColorRepresentation } from 'three/webgpu';
import { normalLocal, positionLocal, uniform } from 'three/tsl';

/**
 * Inverted-hull outline material: render a back-face copy of the mesh pushed out
 * along its normals. Works on smooth-normal meshes (characters, props); hard-edged
 * level geometry uses the screen-space edge pass instead.
 *
 * @param thickness - Outline width in local units.
 * @param color - Outline colour.
 */
export function createOutlineMaterial(
  thickness = 0.03,
  color: ColorRepresentation = '#2b1d3a',
): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({ color: new Color(color), side: BackSide });
  const t = uniform(thickness);
  mat.positionNode = positionLocal.add(normalLocal.mul(t));
  mat.userData.uniforms = { thickness: t };
  return mat;
}
