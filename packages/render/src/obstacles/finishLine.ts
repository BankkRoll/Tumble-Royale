/**
 * Finish Arch visual: a big festive arch — candy-striped pillars, a checkered
 * banner beam, a "FINISH" sign board, balloon bunches bobbing on top, a
 * checkered floor strip — plus a confetti blast for every finisher (read
 * from the runtime's `lastFinishTime`).
 */
import { Color, CylinderGeometry, DoubleSide, Group, InstancedMesh, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SphereGeometry } from 'three/webgpu';
import { FinishLineSchema, archParts } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  addOutline,
  applyInstanceTransform,
  checkerToon,
  labelTexture,
  parseParams,
  rand01,
  roundedBox,
  runtimeNumber,
  setGlow,
  setInstanceTRS,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

const BALLOONS_PER_SIDE = 5;
const CONFETTI = 140;
const CONFETTI_LIFE = 2.6;
const BALLOON_COLORS = [PAL.pink, PAL.yellow, PAL.cyan, PAL.mint, PAL.violet, PAL.orange];

/** Creates the Finish Line visual. */
export const finishLineVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(FinishLineSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `finishLine:${instance.id}`;
  applyInstanceTransform(root, instance);

  const pillarMat = stripedToon(d, PAL.yellow, PAL.pink, 1.2, 'diagXY', { rimStrength: 0.6 });
  const beamMat = checkerToon(d, '#ffffff', PAL.ink, 0.5, 'xy');
  const strip = solid(d.track(new PlaneGeometry(p.width, 1.2)), checkerToon(d, '#ffffff', PAL.ink, 0.6, 'xy'));
  strip.rotation.x = -Math.PI / 2;
  strip.position.y = 0.02;
  strip.receiveShadow = true;
  strip.castShadow = false;
  root.add(strip);

  const balloonGeo = d.track(new SphereGeometry(0.42, 20, 14));
  const stringGeo = d.track(new CylinderGeometry(0.012, 0.012, 1, 4));
  const balloons = new InstancedMesh(balloonGeo, toon(d, { color: '#ffffff', rimStrength: 0.8, rimColor: '#ffffff' }), BALLOONS_PER_SIDE * 2);
  const strings = new InstancedMesh(stringGeo, toon(d, { color: '#ffffff' }), BALLOONS_PER_SIDE * 2);
  balloons.frustumCulled = false;
  strings.frustumCulled = false;
  const c = new Color();
  for (let i = 0; i < BALLOONS_PER_SIDE * 2; i++) balloons.setColorAt(i, c.set(BALLOON_COLORS[i % BALLOON_COLORS.length]!));
  if (balloons.instanceColor) balloons.instanceColor.needsUpdate = true;
  addOutline(d, balloons, 0.03);

  const signMat = toon(d, { color: PAL.magenta, rimStrength: 0.6, emissive: PAL.pink, emissiveIntensity: 0 });
  if (p.arch) {
    for (const part of archParts(p.width, p.height, p.pillarSize, p.pillarSize)) {
      const m = solid(roundedBox(d, part.half.x, part.half.y, part.half.z, 0.22), part.role === 'beam' ? beamMat : pillarMat);
      m.position.set(part.pos.x, part.pos.y, part.pos.z);
      root.add(m);
    }
    const bw = Math.min(p.width * 0.6, 8);
    const bh = bw / 3.2;
    const signBoard = solid(roundedBox(d, bw / 2, bh / 2, 0.2, 0.25), signMat);
    signBoard.position.set(0, p.height + p.pillarSize + bh / 2 + 0.1, 0);
    root.add(signBoard);
    const tex = labelTexture(d, 'FINISH', { fill: '#ffffff', stroke: '#7a1048' });
    if (tex) {
      const labelMat = d.track(new MeshBasicNodeMaterial({ map: tex, transparent: true }));
      const geo = d.track(new PlaneGeometry(bw * 0.95, bw * 0.95 / 4));
      for (const side of [-1, 1]) {
        const label = new Mesh(geo, labelMat);
        label.position.set(0, 0, side * 0.21);
        label.rotation.y = side < 0 ? Math.PI : 0;
        signBoard.add(label);
      }
    }
    root.add(balloons, strings);
  }

  const confettiGeo = d.track(new PlaneGeometry(0.14, 0.24));
  const confettiMat = toon(d, { color: '#ffffff', rimStrength: 0 });
  confettiMat.side = DoubleSide;
  const confetti = new InstancedMesh(confettiGeo, confettiMat, CONFETTI);
  confetti.frustumCulled = false;
  for (let i = 0; i < CONFETTI; i++) confetti.setColorAt(i, c.set(BALLOON_COLORS[i % BALLOON_COLORS.length]!));
  if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
  root.add(confetti);

  const q = { x: 0, y: 0, z: 0, w: 1 };
  const topY = p.height + p.pillarSize;
  const px = p.width / 2 + p.pillarSize / 2;

  return {
    object: root,
    update(t, _dt, runtime) {
      if (p.arch) {
        for (let i = 0; i < BALLOONS_PER_SIDE * 2; i++) {
          const side = i < BALLOONS_PER_SIDE ? -1 : 1;
          const j = i % BALLOONS_PER_SIDE;
          const a = (j / BALLOONS_PER_SIDE) * Math.PI * 2;
          const sway = Math.sin(t * 1.3 + i) * 0.12;
          const bx = side * px + Math.cos(a) * 0.55 + sway;
          const by = topY + 1.6 + (j % 2) * 0.45 + Math.sin(t * 2 + i * 0.7) * 0.08;
          const bz = Math.sin(a) * 0.55;
          setInstanceTRS(balloons, i, bx, by, bz, null, 1, 1.15, 1);
          const sx = side * px;
          setInstanceTRS(strings, i, (sx + bx) / 2, (topY + by - 0.45) / 2, bz / 2, null, 1, by - 0.45 - topY, 1);
        }
        balloons.instanceMatrix.needsUpdate = true;
        strings.instanceMatrix.needsUpdate = true;
      }

      const age = t - runtimeNumber(runtime, 'lastFinishTime');
      const on = age >= 0 && age < CONFETTI_LIFE;
      setGlow(signMat, on ? Math.max(0, 1 - age) * 0.8 : 0.05 + 0.05 * Math.sin(t * 3));
      for (let i = 0; i < CONFETTI; i++) {
        if (!on) {
          setInstanceTRS(confetti, i, 0, -1e4, 0, null, 0);
          continue;
        }
        const side = i % 2 === 0 ? -1 : 1;
        const vx = -side * (2 + rand01(i, 1) * 5);
        const vy = 7 + rand01(i, 2) * 6;
        const vz = (rand01(i, 3) - 0.5) * 6;
        // Drag-limited fall: confetti flutters down slower than gravity would drop it.
        const fall = Math.min(age, 0.5) * vy - 4 * age * age * 0.5 - Math.max(0, age - 0.5) * 2.2;
        const x = side * px + vx * Math.min(age, 1.2) + Math.sin(age * 6 + i) * 0.3;
        const y = topY + fall;
        const z = vz * Math.min(age, 1.2);
        const ang = age * (4 + rand01(i, 4) * 8);
        q.x = Math.sin(ang) * 0.7;
        q.y = Math.cos(ang * 0.7) * 0.5;
        q.z = 0;
        q.w = 1;
        const len = Math.hypot(q.x, q.y, q.w);
        q.x /= len;
        q.y /= len;
        q.w /= len;
        setInstanceTRS(confetti, i, x, y, z, q, age > CONFETTI_LIFE - 0.4 ? (CONFETTI_LIFE - age) / 0.4 : 1);
      }
      confetti.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
