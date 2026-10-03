import { DirectionalLight, Group, HemisphereLight, Object3D, Vector3, type Camera } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { Atmosphere } from './atmosphere.ts';

/**
 * Lighting rig: one sun with shadows + hemisphere ambient.
 *
 * Shadow modes, picked by quality tier:
 * - `off`: no shadow map at all (blob shadows still render under characters).
 * - `single`: one shadow map whose ortho frustum follows the focus point and is
 *   snapped to shadow texels, so it never shimmers as the player runs.
 * - `csm`: `CSMShadowNode` cascades (works on both WebGPU and WebGL2 backends).
 */

/** Shadow technique. */
export type ShadowMode = 'off' | 'single' | 'csm';

/** Options for {@link createLightingRig}. */
export interface LightingRigOptions {
  shadows?: ShadowMode;
  /** Shadow map resolution per cascade. Default 2048. */
  mapSize?: number;
  /** CSM cascade count. Default 3. */
  cascades?: number;
  /** `single`: half-extent of the shadow frustum in metres. `csm`: max far distance. */
  shadowDistance?: number;
}

/** Live lighting rig. */
export interface LightingRig {
  readonly object: Group;
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly mode: ShadowMode;
  setAtmosphere(a: Atmosphere): void;
  /** Multiplier over atmosphere intensities (lightning flashes, ceremony spotlights dimming). */
  setIntensityScale(sun: number, hemi: number): void;
  /**
   * Re-fits the shadow frustum.
   *
   * @param camera - Active camera (CSM needs it on first frame).
   * @param focus - World point shadows should be sharpest around (the local player).
   */
  update(camera: Camera, focus?: Vector3): void;
  dispose(): void;
}

const SUN_DISTANCE = 120;

/**
 * Creates the sun + hemisphere lights.
 *
 * @param atmosphere - Initial atmosphere.
 * @param opts - Shadow configuration.
 */
export function createLightingRig(atmosphere: Atmosphere, opts: LightingRigOptions = {}): LightingRig {
  const mode = opts.shadows ?? 'single';
  const mapSize = opts.mapSize ?? 2048;
  const dist = opts.shadowDistance ?? (mode === 'csm' ? 160 : 34);

  const object = new Group();
  object.name = 'lighting';
  const hemi = new HemisphereLight();
  const sun = new DirectionalLight();
  const target = new Object3D();
  sun.target = target;
  object.add(hemi, sun, target);

  let csm: CSMShadowNode | null = null;
  if (mode !== 'off') {
    sun.castShadow = true;
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    if (mode === 'single') {
      const sc = sun.shadow.camera;
      sc.left = -dist;
      sc.right = dist;
      sc.top = dist;
      sc.bottom = -dist;
      sc.near = 1;
      sc.far = SUN_DISTANCE * 2;
      sc.updateProjectionMatrix();
    } else {
      csm = new CSMShadowNode(sun, {
        cascades: opts.cascades ?? 3,
        maxFar: dist,
        mode: 'practical',
        lightMargin: 60,
      });
      csm.fade = true;
      sun.shadow.shadowNode = csm;
    }
  }

  let sunScale = 1;
  let hemiScale = 1;
  let base = atmosphere;
  const sunDir = new Vector3();
  const focusSnap = new Vector3();
  const lightRight = new Vector3();
  const lightUp = new Vector3();
  const worldUp = new Vector3(0, 1, 0);

  const applyIntensity = (): void => {
    sun.intensity = base.sunIntensity * sunScale;
    hemi.intensity = base.hemiIntensity * hemiScale;
  };

  return {
    object,
    sun,
    hemi,
    mode,
    setAtmosphere(a: Atmosphere): void {
      base = a;
      sun.color.copy(a.sunColor);
      hemi.color.copy(a.hemiSky);
      hemi.groundColor.copy(a.hemiGround);
      sunDir.copy(a.sunDirection).normalize();
      applyIntensity();
    },
    setIntensityScale(s: number, h: number): void {
      sunScale = s;
      hemiScale = h;
      applyIntensity();
    },
    update(camera: Camera, focus?: Vector3): void {
      const f = focus ?? camera.position;
      if (mode === 'single') {
        // Snap the focus to whole shadow texels in light space so static shadows don't crawl.
        const texel = (dist * 2) / mapSize;
        lightRight.crossVectors(worldUp, sunDir).normalize();
        if (lightRight.lengthSq() < 1e-6) lightRight.set(1, 0, 0);
        lightUp.crossVectors(sunDir, lightRight).normalize();
        const r = Math.round(f.dot(lightRight) / texel) * texel;
        const u = Math.round(f.dot(lightUp) / texel) * texel;
        const fwd = f.dot(sunDir);
        focusSnap.copy(lightRight).multiplyScalar(r).addScaledVector(lightUp, u).addScaledVector(sunDir, fwd);
        target.position.copy(focusSnap);
      } else {
        target.position.copy(f);
      }
      sun.position.copy(target.position).addScaledVector(sunDir, SUN_DISTANCE);
      target.updateMatrixWorld();
    },
    dispose(): void {
      sun.shadow.dispose();
      csm?.dispose();
      sun.dispose();
      hemi.dispose();
      object.removeFromParent();
    },
  };
}
