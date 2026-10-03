/**
 * Checkpoint Arch visual: mint-striped pillars, a cyan crossbeam with a
 * "CHECKPOINT" banner, waving flags on top, and a glow + sparkle shower each
 * time someone passes (read from the runtime's `lastTriggerTime`).
 */
import { CylinderGeometry, Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { CheckpointGateSchema, archParts } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  applyInstanceTransform,
  glowMaterial,
  labelTexture,
  parseParams,
  rand01,
  roundedBox,
  runtimeNumber,
  setGlow,
  solid,
  stripedToon,
  toon,
  wavingToon,
} from './visual-helpers-b.ts';

const SHOWER = 40;
const FLASH_LIFE = 1.1;

/** Creates the Checkpoint Gate visual. */
export const checkpointGateVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(CheckpointGateSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `checkpointGate:${instance.id}`;
  applyInstanceTransform(root, instance);

  const pillarMat = stripedToon(d, PAL.mint, PAL.white, 1.4, 'y', { emissive: PAL.mint, emissiveIntensity: 0 });
  const beamMat = toon(d, { color: PAL.cyan, rimStrength: 0.6, emissive: '#bffcff', emissiveIntensity: 0 });
  const shower = new Sparkles(d, SHOWER, '#e9fff6', 0.12);

  if (p.arch) {
    for (const part of archParts(p.width, p.height, p.pillarSize, p.pillarSize)) {
      const m = solid(roundedBox(d, part.half.x, part.half.y, part.half.z, 0.2), part.role === 'beam' ? beamMat : pillarMat);
      m.position.set(part.pos.x, part.pos.y, part.pos.z);
      root.add(m);
    }
    const tex = labelTexture(d, p.index > 0 ? `CHECKPOINT ${p.index}` : 'CHECKPOINT', { fill: '#ffffff', stroke: '#1d6e7a' });
    if (tex) {
      const signMat = d.track(new MeshBasicNodeMaterial({ map: tex, transparent: true }));
      const sign = new Mesh(d.track(new PlaneGeometry(Math.min(p.width, 7), Math.min(p.width, 7) / 4)), signMat);
      sign.position.set(0, p.height + p.pillarSize / 2, -p.pillarSize / 2 - 0.03);
      sign.rotation.y = Math.PI;
      root.add(sign);
      const back = sign.clone();
      back.position.z = p.pillarSize / 2 + 0.03;
      back.rotation.y = 0;
      root.add(back);
    }
    const poleGeo = d.track(new CylinderGeometry(0.06, 0.06, 1.6, 8));
    const flagGeo = d.track(new PlaneGeometry(1.2, 0.7, 12, 4));
    flagGeo.translate(0.6, 0, 0);
    const flagMat = wavingToon(d, { color: PAL.mint, rimStrength: 0.4 });
    const poleMat = toon(d, { color: PAL.white });
    for (const side of [-1, 1]) {
      const x = side * (p.width / 2 + p.pillarSize / 2);
      const pole = solid(poleGeo, poleMat);
      pole.position.set(x, p.height + p.pillarSize + 0.8, 0);
      root.add(pole);
      const flag = solid(flagGeo, flagMat);
      flag.position.set(x, p.height + p.pillarSize + 1.25, 0);
      flag.rotation.y = side < 0 ? Math.PI : 0;
      root.add(flag);
    }
  } else {
    const { mat } = glowMaterial(d, PAL.mint, { opacity: 0.35, additive: true, doubleSide: true });
    const line = new Mesh(d.track(new PlaneGeometry(p.width, 0.5)), mat);
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.03;
    root.add(line);
  }
  root.add(shower.mesh);

  return {
    object: root,
    update(t, _dt, runtime) {
      const age = t - runtimeNumber(runtime, 'lastTriggerTime');
      const on = age >= 0 && age < FLASH_LIFE;
      const k = on ? age / FLASH_LIFE : 1;
      const glow = on ? (1 - k) * (0.6 + 0.4 * Math.sin(age * 30)) : 0;
      setGlow(pillarMat, glow);
      setGlow(beamMat, glow * 1.2);
      for (let i = 0; i < SHOWER; i++) {
        const x = (rand01(i, 1) - 0.5) * p.width;
        const fall = k * (p.height + 0.5) * (0.6 + rand01(i, 2) * 0.6);
        shower.set(i, x, p.height - fall, (rand01(i, 3) - 0.5) * 1.2, on ? 1 - k * 0.7 : 0);
      }
      shower.commit();
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
