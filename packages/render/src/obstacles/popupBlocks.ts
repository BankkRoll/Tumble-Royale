/**
 * Pop-up Foam Blocks visual: one InstancedMesh of squishy foam blocks posed
 * from the sim's pure schedule. Warning blocks glow orange per instance and
 * squash-and-stretch as they punch up.
 */
import { Color, Group, InstancedMesh } from 'three/webgpu';
import {
  PopupBlocksSchema,
  PopupPhase,
  popupBlockActive,
  popupBlockTelegraph,
  popupBlocksPose,
  popupCycle,
  popupPhaseAt,
} from '@tumble/sim/obstacles';
import type { PoseSample } from '@tumble/sim';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  instanceGlow,
  parseParams,
  roundedBox,
  setInstancePose,
  solid,
  toon,
} from './visual-helpers-b.ts';

const FOAM = ['#fff1b8', '#ffd0e8', '#c9f3ff', '#d8ffe6'];

/** Creates the Pop-up Blocks visual. */
export const popupBlocksVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(PopupBlocksSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `popupBlocks:${instance.id}`;
  applyInstanceTransform(root, instance);

  const n = p.cols * p.rows;
  const half = Math.max(0.05, (p.cellSize - p.gap) / 2);
  const mat = toon(d, { color: '#ffffff', rimStrength: 0.55 });
  const glow = instanceGlow(mat, n, PAL.orange);
  const blocks = new InstancedMesh(roundedBox(d, half, p.blockHeight / 2, half, 0.22, 3), mat, n);
  blocks.castShadow = true;
  blocks.receiveShadow = true;
  blocks.frustumCulled = false;
  const c = new Color();
  for (let i = 0; i < n; i++) {
    const col = i % p.cols;
    const row = Math.floor(i / p.cols);
    blocks.setColorAt(i, c.set(FOAM[(col + row * 2) % FOAM.length]!));
  }
  if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  root.add(blocks);

  // Candy frame around the grid so the play area reads at a glance.
  const fw = (p.cols * p.cellSize) / 2;
  const fd = (p.rows * p.cellSize) / 2;
  const frameMat = toon(d, { color: PAL.violet, rimStrength: 0.4 });
  for (const [x, z, hx, hz] of [
    [0, fd + 0.2, fw + 0.4, 0.2],
    [0, -fd - 0.2, fw + 0.4, 0.2],
    [fw + 0.2, 0, 0.2, fd],
    [-fw - 0.2, 0, 0.2, fd],
  ] as const) {
    const m = solid(roundedBox(d, hx, 0.25, hz, 0.1), frameMat);
    m.position.set(x, -0.2, z);
    root.add(m);
  }

  const samples: PoseSample[] = [];
  const glowArr = glow.attr.array as Float32Array;

  return {
    object: root,
    update(t) {
      popupBlocksPose(t, p, samples, ctx.speedScale);
      const ts = t * ctx.speedScale;
      const k = popupCycle(ts, p);
      const tau = ts - p.startDelay - k * p.period;
      const phase = popupPhaseAt(tau, p);
      for (let i = 0; i < n; i++) {
        const g = popupBlockTelegraph(t, p, i, ctx.speedScale);
        glowArr[i] = g;
        let sxz = 1;
        let sy = 1;
        if (popupBlockActive(p, i, k)) {
          if (phase === PopupPhase.Warn) {
            // Anticipation squash while charging.
            sy = 1 - 0.04 * g;
            sxz = 1 + 0.03 * g;
          } else if (phase === PopupPhase.Rise) {
            sy = 1.08;
            sxz = 0.95;
          }
        }
        setInstancePose(blocks, i, samples[i]!, sxz, sy, sxz);
      }
      blocks.instanceMatrix.needsUpdate = true;
      glow.attr.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
