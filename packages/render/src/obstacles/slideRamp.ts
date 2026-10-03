/**
 * Slide Ramp visual: candy-striped slick deck (lanes run downhill), sunny
 * rails or trough walls, and glowing chevrons that chase downhill.
 */
import { Group, InstancedMesh, Shape, ShapeGeometry } from 'three/webgpu';
import { float, fract, positionWorld, time } from 'three/tsl';
import { SlideRampSchema, slideRampParts } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  glowMaterial,
  iceMaterial,
  parseParams,
  roundedBox,
  setInstanceTRS,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

/** Creates the Slide Ramp visual. */
export const slideRampVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(SlideRampSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `slideRamp:${instance.id}`;
  applyInstanceTransform(root, instance);

  const deckMat =
    p.surface === 'ice'
      ? iceMaterial(d)
      : p.surface === 'slide'
        ? stripedToon(d, PAL.pink, PAL.cream, 1 / 1.1, 'x', { rimStrength: 0.75, rimColor: '#ffffff' })
        : toon(d, { color: PAL.lilac });
  const railMat = toon(d, { color: PAL.yellow, rimStrength: 0.55 });
  const wallMat = stripedToon(d, PAL.mint, PAL.white, 1 / 1.1, 'x');

  for (const part of slideRampParts(p)) {
    const mat = part.role === 'deck' ? deckMat : part.role === 'rail' ? railMat : wallMat;
    const m = solid(roundedBox(d, part.half.x, part.half.y, part.half.z, part.role === 'deck' ? 0.18 : 0.12), mat);
    m.position.set(part.pos.x, part.pos.y, part.pos.z);
    m.quaternion.set(part.rot.x, part.rot.y, part.rot.z, part.rot.w);
    root.add(m);
  }

  // Downhill chevrons: a world-space wave travelling along the slope tells riders "go".
  const deck = slideRampParts(p)[0]!;
  const chev = new Shape();
  chev.moveTo(-0.9, 0);
  chev.lineTo(0, 0.7);
  chev.lineTo(0.9, 0);
  chev.lineTo(0.9, 0.35);
  chev.lineTo(0, 1.05);
  chev.lineTo(-0.9, 0.35);
  chev.closePath();
  const chevGeo = d.track(new ShapeGeometry(chev));
  chevGeo.rotateX(Math.PI / 2);
  const { mat: chevMat } = glowMaterial(d, PAL.white, { opacity: 0.55, additive: true, doubleSide: true });
  const wave = fract(positionWorld.y.mul(0.25).add(time.mul(1.4)));
  chevMat.opacityNode = float(0.15).add(wave.pow(3).mul(0.65));
  const count = Math.max(1, Math.floor(p.length / 3));
  const chevrons = new InstancedMesh(chevGeo, chevMat, count);
  const cosA = Math.cos(p.angle * (Math.PI / 180));
  const sinA = Math.sin(p.angle * (Math.PI / 180));
  for (let i = 0; i < count; i++) {
    const z = (i + 0.5) * (p.length / count) - p.length / 2;
    // Chevrons sit 2 cm above the tilted deck, pointing downhill (+Z).
    setInstanceTRS(chevrons, i, 0, -sinA * z + 0.02 * cosA, cosA * z + 0.02 * sinA, deck.rot, 1);
  }
  chevrons.instanceMatrix.needsUpdate = true;
  if (p.surface !== 'normal') root.add(chevrons);

  return {
    object: root,
    update() {},
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};

