/**
 * Ice Floor visual: glossy pale-cyan slab with twinkling sparkles, a frosty
 * snow lip around the edge and drifting snowflake glints.
 */
import { CylinderGeometry, Group, TorusGeometry, type BufferGeometry } from 'three/webgpu';
import { IceFloorSchema } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  applyInstanceTransform,
  iceMaterial,
  parseParams,
  rand01,
  roundedBox,
  solid,
  toon,
} from './visual-helpers-b.ts';

const FLAKES = 28;

/** Creates the Ice Floor visual. */
export const iceFloorVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(IceFloorSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `iceFloor:${instance.id}`;
  applyInstanceTransform(root, instance);

  const ht = p.thickness / 2;
  let slab: BufferGeometry;
  if (p.shape === 'box') slab = roundedBox(d, p.sizeX / 2, ht, p.sizeZ / 2, 0.2);
  else {
    // thetaStart π/2 puts a hex vertex on +X, matching the sim's convex hull.
    slab = d.track(
      new CylinderGeometry(
        p.radius,
        p.radius,
        p.thickness,
        p.shape === 'hex' ? 6 : 56,
        1,
        false,
        Math.PI / 2,
      ),
    );
  }
  const ice = solid(slab, iceMaterial(d, p.surface === 'slide' ? '#bfe9ff' : PAL.ice));
  ice.position.y = -ht;
  root.add(ice);

  const snow = toon(d, { color: '#ffffff', rimStrength: 0.3 });
  if (p.shape === 'box') {
    for (const [sx, sz, hx, hz] of [
      [0, 1, p.sizeX / 2, 0.12],
      [0, -1, p.sizeX / 2, 0.12],
      [1, 0, 0.12, p.sizeZ / 2],
      [-1, 0, 0.12, p.sizeZ / 2],
    ] as const) {
      const lip = solid(roundedBox(d, hx, 0.09, hz, 0.08), snow);
      lip.position.set((sx * p.sizeX) / 2, -0.05, (sz * p.sizeZ) / 2);
      root.add(lip);
    }
  } else {
    const ring = solid(d.track(new TorusGeometry(p.radius, 0.12, 8, p.shape === 'hex' ? 6 : 56)), snow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.04;
    root.add(ring);
  }

  const flakes = new Sparkles(d, FLAKES, '#ffffff', 0.09);
  root.add(flakes.mesh);
  const ex = p.shape === 'box' ? p.sizeX / 2 : p.radius * 0.7;
  const ez = p.shape === 'box' ? p.sizeZ / 2 : p.radius * 0.7;

  return {
    object: root,
    update(t) {
      for (let i = 0; i < FLAKES; i++) {
        const life = 3 + rand01(i, 1) * 3;
        const u = ((t + rand01(i, 2) * life) % life) / life;
        const x = (rand01(i, 3) * 2 - 1) * ex + Math.sin(t * 0.7 + i) * 0.3;
        const z = (rand01(i, 4) * 2 - 1) * ez + Math.cos(t * 0.6 + i) * 0.3;
        flakes.set(i, x, 0.1 + u * 2.2, z, Math.sin(u * Math.PI));
      }
      flakes.commit();
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
