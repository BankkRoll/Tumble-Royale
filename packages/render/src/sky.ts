import {
  BackSide,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  type ColorRepresentation,
} from 'three/webgpu';
import { mix, positionLocal, smoothstep, uniform } from 'three/tsl';

/** Colours for {@link createSkyDome}. */
export interface SkyColors {
  top: ColorRepresentation;
  horizon: ColorRepresentation;
  bottom: ColorRepresentation;
}

/** Default candy-sky palette. */
export const DEFAULT_SKY: SkyColors = { top: '#5aa9ff', horizon: '#ffd6f2', bottom: '#b8e7ff' };

/**
 * Gradient sky dome. Rendered first, ignores fog and depth writes.
 *
 * @param radius - Dome radius; keep inside the camera far plane.
 */
export function createSkyDome(colors: SkyColors = DEFAULT_SKY, radius = 400): Mesh {
  const top = uniform(new Color(colors.top));
  const horizon = uniform(new Color(colors.horizon));
  const bottom = uniform(new Color(colors.bottom));

  const mat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  const y = positionLocal.normalize().y;
  const upper = mix(horizon, top, smoothstep(0.0, 0.55, y));
  mat.colorNode = mix(bottom, upper, smoothstep(-0.25, 0.02, y));

  const mesh = new Mesh(new SphereGeometry(radius, 32, 16), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = { top, horizon, bottom };
  return mesh;
}
