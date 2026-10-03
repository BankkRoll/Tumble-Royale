/**
 * Cannon visual: a chunky cartoon cannon on a candy carriage whose barrel aims
 * and recoils exactly like the sim pose, striped foam cannonballs (instanced,
 * outlined) rolling down their lanes, a muzzle puff on every shot and dust
 * puffs where balls land. The barrel glows hotter while taking aim.
 */
import {
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  SphereGeometry,
  TorusGeometry,
} from 'three/webgpu';
import type { PoseSample } from '@tumble/sim';
import {
  CannonSchema,
  cannonBallAt,
  cannonPoolSize,
  cannonPose,
  cannonShotIndex,
  cannonSlotShot,
  cannonTelegraph,
  type CannonShotInfo,
} from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  addOutline,
  applyInstanceTransform,
  applyPose,
  parseParams,
  rand01,
  roundedBox,
  setGlow,
  setInstancePose,
  setInstanceTRS,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';
import { createOutlineMaterial } from '../materials/outline.ts';

const MUZZLE_PUFFS = 6;
const LAND_PUFFS = 4;
const PUFF_LIFE = 0.7;

/** Creates the Cannon visual. */
export const cannonVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(CannonSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `cannon:${instance.id}`;
  applyInstanceTransform(root, instance);
  const pool = cannonPoolSize(p);
  const L = p.barrelLength;

  // Carriage
  const baseH = Math.max(0.2, p.pivotHeight - 0.5);
  const base = solid(
    d.track(new CylinderGeometry(1.2, 1.45, baseH, 32)),
    stripedToon(d, PAL.pink, PAL.cream, 2.5, 'y'),
  );
  base.position.y = baseH / 2;
  root.add(base);
  const cheekMat = toon(d, { color: PAL.violet, rimStrength: 0.5 });
  for (const side of [-1, 1]) {
    const cheek = solid(roundedBox(d, 0.18, 0.55, 0.7, 0.12), cheekMat);
    cheek.position.set(side * 0.85, p.pivotHeight - 0.25, 0);
    root.add(cheek);
    const wheel = solid(
      d.track(new CylinderGeometry(0.75, 0.75, 0.3, 24)),
      toon(d, { color: PAL.ink, rimStrength: 0.3 }),
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 1.25, 0.75, -0.2);
    const hub = solid(d.track(new CylinderGeometry(0.28, 0.28, 0.34, 16)), toon(d, { color: PAL.yellow }));
    wheel.add(hub);
    root.add(wheel);
  }

  // Barrel (posed from sample 0)
  const barrel = new Group();
  root.add(barrel);
  const barrelMat = toon(d, {
    color: '#4b3a78',
    rimColor: '#ffd6f5',
    rimStrength: 0.7,
    emissive: PAL.orange,
    emissiveIntensity: 0,
  });
  const tubeGeo = d.track(new CylinderGeometry(0.62, 0.78, L, 32));
  tubeGeo.rotateX(Math.PI / 2);
  const tube = solid(tubeGeo, barrelMat);
  tube.position.z = L * 0.35;
  addOutline(d, tube, 0.04);
  barrel.add(tube);
  const rimMat = toon(d, { color: PAL.yellow, rimStrength: 0.6 });
  const rim = solid(d.track(new TorusGeometry(0.66, 0.16, 12, 32)), rimMat);
  rim.position.z = L * 0.85;
  barrel.add(rim);
  const band = solid(d.track(new TorusGeometry(0.74, 0.1, 10, 32)), toon(d, { color: PAL.pink }));
  band.position.z = L * 0.3;
  barrel.add(band);
  const cap = solid(d.track(new SphereGeometry(0.78, 24, 16)), barrelMat);
  cap.position.z = -L * 0.15;
  barrel.add(cap);
  const fuse = new Sparkles(d, 6, '#fff3b0', 0.1);
  barrel.add(fuse.mesh);

  // Balls: instanced pool with a shared-matrix outline twin.
  const ballGeo = d.track(new SphereGeometry(p.ballRadius, 28, 18));
  // Balls are one InstancedMesh: 'local' keeps the stripes in the cannon's space, as they always were.
  const ballMat = stripedToon(
    d,
    PAL.orange,
    PAL.cream,
    1.6 / p.ballRadius,
    'y',
    { rimStrength: 0.6 },
    'local',
  );
  const balls = new InstancedMesh(ballGeo, ballMat, pool);
  balls.castShadow = true;
  balls.frustumCulled = false;
  const ballOutline = new InstancedMesh(ballGeo, d.track(createOutlineMaterial(0.05)), pool);
  ballOutline.instanceMatrix = balls.instanceMatrix;
  ballOutline.frustumCulled = false;
  root.add(balls, ballOutline);

  // Puffs
  const puffMat = toon(d, { color: '#ffffff', rimStrength: 0.2 });
  const puffGeo = d.track(new IcosahedronGeometry(1, 1));
  const puffs = new InstancedMesh(puffGeo, puffMat, MUZZLE_PUFFS + pool * LAND_PUFFS);
  puffs.frustumCulled = false;
  root.add(puffs);

  const samples: PoseSample[] = [];
  const info: CannonShotInfo = { shot: -1, age: 0, lane: 0, active: false };
  const land = { x: 0, y: 0, z: 0 };
  const landQ = { x: 0, y: 0, z: 0, w: 1 };

  return {
    object: root,
    update(t) {
      const ts = t * ctx.speedScale;
      cannonPose(t, p, samples, ctx.speedScale);
      applyPose(barrel, samples[0]!);
      const tele = cannonTelegraph(t, p, ctx.speedScale);
      setGlow(barrelMat, tele * tele * 0.9);

      // Fuse sparks fizz at the breech while aiming.
      for (let i = 0; i < 6; i++) {
        const u = (t * 3 + rand01(i, 1)) % 1;
        fuse.set(i, (rand01(i, 2) - 0.5) * 0.3, 0.75 + u * 0.5, -L * 0.15 - 0.3, tele > 0 ? 1 - u : 0);
      }
      fuse.commit();

      for (let s = 0; s < pool; s++) {
        cannonSlotShot(ts, p, s, info);
        const left = p.flightTime + p.rollTime - info.age;
        const scale = !info.active
          ? 0
          : left < 0.3
            ? Math.max(0, left / 0.3)
            : info.age < 0.05
              ? info.age / 0.05
              : 1;
        setInstancePose(balls, s, samples[s + 1]!, scale);
        for (let j = 0; j < LAND_PUFFS; j++) {
          const idx = MUZZLE_PUFFS + s * LAND_PUFFS + j;
          const a = info.age - p.flightTime;
          if (!info.active || a < 0 || a > PUFF_LIFE) {
            setInstanceTRS(puffs, idx, 0, -1e4, 0, null, 0);
            continue;
          }
          cannonBallAt(p, info.lane, p.flightTime, land, landQ);
          const k = a / PUFF_LIFE;
          const ang = (j / LAND_PUFFS) * Math.PI * 2 + rand01(s, j);
          const r = p.ballRadius * (0.6 + k * 1.6);
          setInstanceTRS(
            puffs,
            idx,
            land.x + Math.cos(ang) * r,
            p.landingHeight + 0.2 + k * 0.4,
            land.z + Math.sin(ang) * r,
            null,
            0.55 * Math.sin(Math.min(1, k * 1.4) * Math.PI) * p.ballRadius,
          );
        }
      }
      balls.instanceMatrix.needsUpdate = true;

      // Muzzle puff, relative to the barrel's current pose.
      const shot = cannonShotIndex(ts, p);
      const age = shot < 0 ? 99 : ts - (p.startDelay + shot * p.period);
      const s0 = samples[0]!;
      const q = s0.rot;
      // Barrel forward = rotate (0,0,1) by q.
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fy = 2 * (q.y * q.z - q.w * q.x);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      for (let j = 0; j < MUZZLE_PUFFS; j++) {
        if (age > PUFF_LIFE) {
          setInstanceTRS(puffs, j, 0, -1e4, 0, null, 0);
          continue;
        }
        const k = age / PUFF_LIFE;
        const dist = L * 0.9 + k * (1.2 + rand01(j, 3) * 1.4);
        const spread = (rand01(j, 4) - 0.5) * 1.2 * k;
        setInstanceTRS(
          puffs,
          j,
          s0.pos.x + fx * dist + spread,
          s0.pos.y + fy * dist + k * 0.6 + (rand01(j, 5) - 0.5) * 0.4 * k,
          s0.pos.z + fz * dist - spread * fx,
          null,
          (0.35 + rand01(j, 6) * 0.35) * Math.sin(Math.min(1, k * 1.3) * Math.PI),
        );
      }
      puffs.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
