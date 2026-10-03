/**
 * Sticky Goo visual: a bubbling purple-green puddle (TSL noise colour + vertex
 * swell) with toon bubbles that inflate and pop.
 */
import { CylinderGeometry, Group, InstancedMesh, SphereGeometry } from 'three/webgpu';
import { StickyGooSchema } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  gooMaterial,
  parseParams,
  rand01,
  roundedBox,
  setInstanceTRS,
  solid,
  toon,
} from './visual-helpers-b.ts';

const BUBBLES = 14;

/** Creates the Sticky Goo visual. */
export const stickyGooVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(StickyGooSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `stickyGoo:${instance.id}`;
  applyInstanceTransform(root, instance);

  const slime = p.surface === 'slime';
  const mat = gooMaterial(d, slime ? '#2bb673' : PAL.gooPurple, slime ? '#c6ff6b' : PAL.gooGreen);
  const geo =
    p.shape === 'box'
      ? roundedBox(d, p.sizeX / 2, p.thickness / 2, p.sizeZ / 2, Math.min(0.1, p.thickness * 0.45), 4)
      : d.track(new CylinderGeometry(p.radius, p.radius * 1.05, p.thickness, 64, 4));
  const puddle = solid(geo, mat);
  puddle.position.y = p.thickness / 2;
  root.add(puddle);

  const bubbleMat = toon(d, { color: slime ? '#b6ff8a' : '#c58cff', rimColor: '#ffffff', rimStrength: 0.9 });
  const bubbles = new InstancedMesh(d.track(new SphereGeometry(1, 16, 10)), bubbleMat, BUBBLES);
  bubbles.frustumCulled = false;
  root.add(bubbles);
  const ex = p.shape === 'box' ? p.sizeX / 2 - 0.3 : p.radius * 0.7;
  const ez = p.shape === 'box' ? p.sizeZ / 2 - 0.3 : p.radius * 0.7;

  return {
    object: root,
    update(t) {
      for (let i = 0; i < BUBBLES; i++) {
        const period = 1.6 + rand01(i, 7) * 2.2;
        const u = ((t + rand01(i, 8) * period) % period) / period;
        // Grow slowly, pop fast: the last 8% of the cycle collapses the bubble.
        const s = u < 0.92 ? Math.pow(u / 0.92, 0.7) * (0.12 + rand01(i, 9) * 0.22) : 0;
        const cycle = Math.floor((t + rand01(i, 8) * period) / period);
        const x = (rand01(i * 31 + cycle, 1) * 2 - 1) * ex;
        const z = (rand01(i * 17 + cycle, 2) * 2 - 1) * ez;
        setInstanceTRS(bubbles, i, x, p.thickness, z, null, s, s * 0.8, s);
      }
      bubbles.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
