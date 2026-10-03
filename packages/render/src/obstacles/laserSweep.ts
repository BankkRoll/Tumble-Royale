/**
 * Laser Sweep visual: a chunky emitter post with soft additive beams (white
 * core + magenta halo) on a rotor that mirrors the sim pose, sparkles drifting
 * along the beams, and a flicker telegraph before relighting.
 */
import { CylinderGeometry, Group, Mesh, SphereGeometry } from 'three/webgpu';
import type { PoseSample } from '@tumble/sim';
import { LaserSweepSchema, laserBeamYaw, laserLit, laserSweepPose, laserTelegraph } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  addOutline,
  applyInstanceTransform,
  applyPose,
  beamMaterial,
  parseParams,
  rand01,
  setGlow,
  solid,
  stripedToon,
  toon,
} from './visual-helpers-b.ts';

const SPARKS_PER_BEAM = 14;

/** Creates the Laser Sweep visual. */
export const laserSweepVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(LaserSweepSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `laserSweep:${instance.id}`;
  applyInstanceTransform(root, instance);

  const postH = Math.max(0.4, p.height + Math.max(0, p.bobAmplitude) + 0.4);
  const post = solid(d.track(new CylinderGeometry(0.42, 0.6, postH, 24)), stripedToon(d, PAL.ink, PAL.violet, 2.2, 'y'));
  post.position.y = postH / 2;
  root.add(post);

  const rotor = new Group();
  root.add(rotor);
  const orbMat = toon(d, { color: PAL.magenta, emissive: PAL.pink, emissiveIntensity: 0.8, rimStrength: 0.8 });
  const orb = solid(d.track(new SphereGeometry(0.55, 24, 16)), orbMat);
  addOutline(d, orb, 0.04);
  rotor.add(orb);

  const core = beamMaterial(d, '#fff0fb', 0.95);
  const halo = beamMaterial(d, PAL.magenta, 0.45);
  const hl = p.mode === 'arm' ? p.length / 2 : p.length;
  const coreGeo = d.track(new CylinderGeometry(p.radius * 0.38, p.radius * 0.38, hl * 2, 12, 1, true));
  const haloGeo = d.track(new CylinderGeometry(p.radius * 1.5, p.radius * 1.5, hl * 2, 16, 1, true));
  coreGeo.rotateZ(Math.PI / 2);
  haloGeo.rotateZ(Math.PI / 2);
  const capMat = toon(d, { color: PAL.ink, emissive: PAL.magenta, emissiveIntensity: 0.4 });
  const capGeo = d.track(new SphereGeometry(0.3, 16, 10));
  for (let i = 0; i < p.beams; i++) {
    const beam = new Group();
    beam.rotation.y = laserBeamYaw(p, i);
    const offset = p.mode === 'arm' ? hl : 0;
    const c = new Mesh(coreGeo, core.mat);
    const h = new Mesh(haloGeo, halo.mat);
    c.position.x = offset;
    h.position.x = offset;
    c.renderOrder = 2;
    h.renderOrder = 1;
    beam.add(h, c);
    const tip = solid(capGeo, capMat);
    tip.position.x = offset + hl;
    beam.add(tip);
    if (p.mode === 'full') {
      const tip2 = solid(capGeo, capMat);
      tip2.position.x = -hl;
      beam.add(tip2);
    }
    rotor.add(beam);
  }

  const sparks = new Sparkles(d, SPARKS_PER_BEAM * p.beams, '#ffd6f5', 0.07);
  rotor.add(sparks.mesh);

  const samples: PoseSample[] = [];

  return {
    object: root,
    update(t) {
      laserSweepPose(t, p, samples, ctx.speedScale);
      applyPose(rotor, samples[0]!);
      const lit = laserLit(t, p, ctx.speedScale);
      const warn = laserTelegraph(t, p, ctx.speedScale);
      const k = lit ? 1 : warn > 0 ? 0.1 + 0.5 * warn : 0.04;
      core.intensity.value = k;
      halo.intensity.value = k;
      setGlow(orbMat, lit ? 0.9 : 0.25 + warn);
      for (let b = 0; b < p.beams; b++) {
        const yaw = laserBeamYaw(p, b);
        const cy = Math.cos(yaw);
        const sy = -Math.sin(yaw);
        for (let j = 0; j < SPARKS_PER_BEAM; j++) {
          const i = b * SPARKS_PER_BEAM + j;
          const life = 0.8 + rand01(i, 1) * 0.9;
          const u = ((t + rand01(i, 2) * life) % life) / life;
          const along = p.mode === 'arm' ? rand01(i, 3) * p.length : (rand01(i, 3) * 2 - 1) * p.length;
          const drift = (rand01(i, 4) - 0.5) * 0.5 * u;
          sparks.set(i, cy * along - sy * drift, (rand01(i, 5) - 0.5) * 0.4 + u * 0.35, sy * along + cy * drift, lit ? Math.sin(u * Math.PI) : 0);
        }
      }
      sparks.commit();
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
