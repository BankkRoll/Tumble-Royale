/**
 * Rolling Drum visual: a candy-cane spiral roller with sunny end rims and
 * grip ridges, rolled by the sim's exact analytic angle so the stripes move at
 * the same surface speed riders feel.
 */
import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import type { PoseSample } from '@tumble/sim';
import { RollingDrumSchema, rollingDrumPose } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  applyPose,
  parseParams,
  roundedBox,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

/** Creates the Rolling Drum visual. */
export const rollingDrumVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(RollingDrumSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `rollingDrum:${instance.id}`;
  applyInstanceTransform(root, instance);

  const drum = new Group();
  root.add(drum);
  const geo = d.track(new CylinderGeometry(p.radius, p.radius, p.length, 72, 1));
  // Bake the X axis into the geometry so the spiral stripes live in the rolling frame.
  geo.rotateZ(Math.PI / 2);
  const body = solid(geo, stripedToon(d, PAL.pink, PAL.cream, 8, 'spiralX', { rimStrength: 0.55 }));
  drum.add(body);

  const rimMat = toon(d, { color: PAL.yellow, rimStrength: 0.6 });
  const rimGeo = d.track(new TorusGeometry(p.radius, 0.22, 12, 64));
  const capGeo = d.track(new CylinderGeometry(p.radius * 0.35, p.radius * 0.35, 0.3, 24));
  capGeo.rotateZ(Math.PI / 2);
  for (const side of [-1, 1]) {
    const rim = solid(rimGeo, rimMat);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = (side * p.length) / 2;
    drum.add(rim);
    const cap = solid(capGeo, toon(d, { color: PAL.violet }));
    cap.position.x = side * (p.length / 2 + 0.1);
    drum.add(cap);
  }

  if (p.ridges > 0 && p.ridgeHeight > 0) {
    const ridgeMat = toon(d, { color: PAL.mint, rimStrength: 0.5 });
    const ridges = new InstancedMesh(
      roundedBox(d, p.length / 2 - 0.1, p.ridgeHeight / 2 + 0.05, 0.12, 0.06),
      ridgeMat,
      p.ridges,
    );
    ridges.castShadow = true;
    const m = new Matrix4();
    const pos = new Vector3();
    const q = new Quaternion();
    const one = new Vector3(1, 1, 1);
    const ax = new Vector3(1, 0, 0);
    for (let i = 0; i < p.ridges; i++) {
      const a = (i / p.ridges) * Math.PI * 2;
      const rr = p.radius + p.ridgeHeight / 2 - 0.05;
      pos.set(0, Math.cos(a) * rr, Math.sin(a) * rr);
      q.setFromAxisAngle(ax, a);
      ridges.setMatrixAt(i, m.compose(pos, q, one));
    }
    ridges.instanceMatrix.needsUpdate = true;
    drum.add(ridges);
  }

  const samples: PoseSample[] = [];

  return {
    object: root,
    update(t) {
      rollingDrumPose(t, p, samples, ctx.speedScale);
      applyPose(drum, samples[0]!);
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
