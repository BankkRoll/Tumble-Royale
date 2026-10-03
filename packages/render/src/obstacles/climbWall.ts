/**
 * Climb Wall visual: a soft mint wall with chunky candy-coloured handholds
 * (instanced) and a sunny grab lip — yellow reads as "interactable".
 */
import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { ClimbWallSchema, climbWallParts } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  addOutline,
  applyInstanceTransform,
  parseParams,
  roundedBox,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

const HOLD_COLORS = [PAL.yellow, PAL.orange, PAL.pink, PAL.cyan, PAL.violet];

/** Creates the Climb Wall visual. */
export const climbWallVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(ClimbWallSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `climbWall:${instance.id}`;
  applyInstanceTransform(root, instance);

  const parts = climbWallParts(p);
  const holds = parts.filter((x) => x.role === 'hold');
  const wallMat = stripedToon(d, '#a8f0d4', '#c9f8e6', 0.6, 'diagXY', { rimStrength: 0.35 });
  const lipMat = toon(d, { color: PAL.yellow, rimStrength: 0.6 });
  for (const part of parts) {
    if (part.role === 'hold') continue;
    const m = solid(
      roundedBox(d, part.half.x, part.half.y, part.half.z, part.role === 'lip' ? 0.1 : 0.2),
      part.role === 'lip' ? lipMat : wallMat,
    );
    m.position.set(part.pos.x, part.pos.y, part.pos.z);
    m.quaternion.set(part.rot.x, part.rot.y, part.rot.z, part.rot.w);
    root.add(m);
  }

  if (holds.length > 0) {
    const holdGeo = roundedBox(d, 0.5, 0.5, 0.5, 0.22, 3);
    const holdMat = toon(d, { color: '#ffffff', rimStrength: 0.6 });
    const mesh = new InstancedMesh(holdGeo, holdMat, holds.length);
    mesh.castShadow = true;
    const m = new Matrix4();
    const pos = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    const c = new Color();
    holds.forEach((h, i) => {
      pos.set(h.pos.x, h.pos.y, h.pos.z);
      q.set(h.rot.x, h.rot.y, h.rot.z, h.rot.w);
      s.set(h.half.x * 2, h.half.y * 2, h.half.z * 2);
      mesh.setMatrixAt(i, m.compose(pos, q, s));
      mesh.setColorAt(i, c.set(HOLD_COLORS[i % HOLD_COLORS.length]!));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    addOutline(d, mesh, 0.06);
    root.add(mesh);
  }

  return {
    object: root,
    update() {},
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
