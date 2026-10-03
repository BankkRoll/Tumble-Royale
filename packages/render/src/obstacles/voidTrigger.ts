/**
 * Void visual: an optional, mostly transparent sheet of drifting pink fog on
 * the void's top face so falls read as "into the clouds". The sensor itself
 * is invisible.
 */
import { Group, Mesh, PlaneGeometry } from 'three/webgpu';
import { VoidTriggerSchema } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import { Disposer, applyInstanceTransform, fogSheetMaterial, parseParams } from './visual-helpers-b.ts';

/** Creates the Void Trigger visual. */
export const voidTriggerVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(VoidTriggerSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `voidTrigger:${instance.id}`;
  applyInstanceTransform(root, instance);

  if (p.fog) {
    const geo = d.track(new PlaneGeometry(p.sizeX, p.sizeZ, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const sheet = new Mesh(geo, fogSheetMaterial(d, '#ffe3f4'));
    sheet.position.y = p.sizeY / 2;
    sheet.renderOrder = -1;
    sheet.frustumCulled = false;
    root.add(sheet);
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
