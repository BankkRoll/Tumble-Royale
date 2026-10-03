/**
 * Crumble Bridge visual: instanced candy planks posed from the sim's pure
 * schedule. Warning planks glow hot orange and grow dark noise cracks (driven
 * by the same per-instance value), wobble with the sim, then tumble away.
 */
import { Color, Group, InstancedMesh } from 'three/webgpu';
import { abs, color, float, mx_noise_float, positionLocal, smoothstep } from 'three/tsl';
import type { PoseSample } from '@tumble/sim';
import { BridgePhase, CollapsingBridgeSchema, bridgeSegmentState, collapsingBridgePose, type BridgeSegmentState } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import { Disposer, PAL, applyInstanceTransform, instanceGlow, parseParams, pulse, roundedBox, setInstancePose, solid, toon } from './visual-helpers-b.ts';

const PLANKS = ['#ffe2a8', '#ffc4de'];

/** Creates the Collapsing Bridge visual. */
export const collapsingBridgeVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(CollapsingBridgeSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `collapsingBridge:${instance.id}`;
  applyInstanceTransform(root, instance);

  const n = p.segments;
  const hl = Math.max(0.05, (p.segmentLength - p.gap) / 2);
  const mat = toon(d, { color: '#ffffff', rimStrength: 0.5 });
  const glow = instanceGlow(mat, n, '#ff5a1f');
  // Cracks: dark veins along noise zero-crossings, widening with the warning glow.
  const vein = float(1).sub(smoothstep(float(0), float(0.06), abs(mx_noise_float(positionLocal.mul(1.7)))));
  mat.colorNode = color(new Color('#ffffff')).mul(float(1).sub(vein.mul(glow.node.mul(1.4).min(0.85))));
  const planks = new InstancedMesh(roundedBox(d, p.width / 2, p.thickness / 2, hl, 0.14), mat, n);
  planks.castShadow = true;
  planks.receiveShadow = true;
  planks.frustumCulled = false;
  const c = new Color();
  for (let i = 0; i < n; i++) planks.setColorAt(i, c.set(PLANKS[i % PLANKS.length]!));
  if (planks.instanceColor) planks.instanceColor.needsUpdate = true;
  root.add(planks);

  // Fixed abutments at both ends so the span visibly "hangs" between landings.
  const postMat = toon(d, { color: PAL.violet, rimStrength: 0.5 });
  const total = p.segments * p.segmentLength;
  for (const z of [-0.25, total + 0.25]) {
    for (const side of [-1, 1]) {
      const post = solid(roundedBox(d, 0.18, 0.6, 0.18, 0.08), postMat);
      post.position.set(side * (p.width / 2 + 0.25), 0.3, z);
      root.add(post);
    }
  }

  const samples: PoseSample[] = [];
  const st: BridgeSegmentState = { phase: 0, time: 0, cycle: 0 };
  const glowArr = glow.attr.array as Float32Array;

  return {
    object: root,
    update(t) {
      collapsingBridgePose(t, p, samples, ctx.speedScale);
      const ts = t * ctx.speedScale;
      for (let i = 0; i < n; i++) {
        bridgeSegmentState(ts, p, i, st);
        let g = 0;
        let s = 1;
        if (st.phase === BridgePhase.Warn) {
          const k = st.time / Math.max(p.warnTime, 1e-3);
          g = k * (0.5 + 0.5 * pulse(st.time, 2 + 4 * k));
        } else if (st.phase === BridgePhase.Falling) {
          g = Math.max(0, 1 - st.time * 2);
          s = Math.max(0.2, 1 - st.time / p.fallTime);
        } else if (st.phase === BridgePhase.Gone) s = 0;
        else if (st.phase === BridgePhase.Rising) s = Math.min(1, 0.4 + st.time / p.riseTime);
        glowArr[i] = g;
        setInstancePose(planks, i, samples[i]!, s);
      }
      planks.instanceMatrix.needsUpdate = true;
      glow.attr.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
