/**
 * Start Gate visual: hazard-striped barrier halves that drop / rise / split
 * exactly like the sim pose, under a gantry with three countdown lamps that
 * light red-red-amber and flash green on GO.
 */
import { CylinderGeometry, Group, SphereGeometry } from 'three/webgpu';
import type { PoseSample } from '@tumble/sim';
import { StartGateSchema, startGateLights, startGatePose } from '@tumble/sim/obstacles';
import type { MeshToonNodeMaterial } from 'three/webgpu';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  addOutline,
  applyInstanceTransform,
  applyPose,
  parseParams,
  roundedBox,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

const RED = '#ff3355';
const AMBER = '#ffb020';
const GREEN = '#3dff8a';

/** Creates the Start Gate visual. */
export const startGateVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(StartGateSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `startGate:${instance.id}`;
  applyInstanceTransform(root, instance);

  const panelMat = stripedToon(d, PAL.yellow, PAL.ink, 1.1, 'diagXY', { rimStrength: 0.5 });
  const panelGeo = roundedBox(d, p.width / 4 - 0.03, p.height / 2, p.thickness / 2, 0.12);
  const panels = [solid(panelGeo, panelMat), solid(panelGeo, panelMat)];
  root.add(...panels);

  // Gantry sits outside the barrier's footprint so it never overlaps the sim colliders.
  const postMat = toon(d, { color: PAL.violet, rimStrength: 0.5 });
  const gantryY = p.height + 1.4;
  const postGeo = d.track(new CylinderGeometry(0.22, 0.28, gantryY + 0.3, 16));
  for (const side of [-1, 1]) {
    const post = solid(postGeo, postMat);
    post.position.set(side * (p.width / 2 + 0.5), (gantryY + 0.3) / 2, 0);
    root.add(post);
  }
  const bar = solid(roundedBox(d, p.width / 2 + 0.7, 0.3, 0.3, 0.12), postMat);
  bar.position.y = gantryY;
  root.add(bar);
  const box = solid(roundedBox(d, 1.6, 0.55, 0.35, 0.15), toon(d, { color: PAL.ink }));
  box.position.y = gantryY + 0.6;
  root.add(box);

  const lampGeo = d.track(new SphereGeometry(0.32, 20, 14));
  const lamps: MeshToonNodeMaterial[] = [];
  for (let i = 0; i < 3; i++) {
    const mat = toon(d, { color: '#3a2d4f', emissive: RED, emissiveIntensity: 0, rimStrength: 0.4 });
    const lamp = solid(lampGeo, mat);
    lamp.position.set((i - 1) * 1.0, gantryY + 0.6, -0.3);
    addOutline(d, lamp, 0.03);
    root.add(lamp);
    lamps.push(mat);
  }

  const samples: PoseSample[] = [];
  type LampUniforms = { emissive: { value: { set(c: string): void } }; emissiveIntensity: { value: number } };
  const setLamp = (mat: MeshToonNodeMaterial, tint: string, k: number): void => {
    const u = mat.userData.uniforms as LampUniforms;
    u.emissive.value.set(tint);
    u.emissiveIntensity.value = k;
  };

  return {
    object: root,
    update(t) {
      startGatePose(t, p, samples, 1);
      applyPose(panels[0]!, samples[0]!);
      applyPose(panels[1]!, samples[1]!);
      const lit = startGateLights(t, p);
      for (let i = 0; i < 3; i++) {
        const mat = lamps[i]!;
        if (lit === -1) {
          // Green for 2 s after GO, then the gantry goes dark.
          const since = t - p.openTime;
          setLamp(mat, GREEN, since < 2 ? 1.4 * (since % 0.3 < 0.18 ? 1 : 0.5) : 0);
        } else {
          // Lamps light left→right as the count falls: 3 → 1 lamp, 2 → 2, 1 → 3.
          const on = i < 4 - lit && lit <= 3 && lit > 0;
          setLamp(mat, i === 2 ? AMBER : RED, on ? 1.3 : 0);
        }
      }
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
