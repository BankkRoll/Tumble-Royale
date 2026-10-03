/**
 * Skip Sweeper visual: a candy hub with neon foam bars at jump/duck heights
 * and fan-shaped motion trails whose brightness tracks the current angular
 * speed, all rotated by the sim's exact closed-form angle.
 */
import { CapsuleGeometry, CylinderGeometry, Group, Mesh, RingGeometry, SphereGeometry } from 'three/webgpu';
import { atan, float, positionLocal, uniform } from 'three/tsl';
import type { PoseSample } from '@tumble/sim';
import { JumpRopeBeamSchema, jumpRopeBeamPose, jumpRopeLayers, jumpRopeSpeed } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import { Disposer, PAL, addOutline, applyInstanceTransform, applyPose, glowMaterial, parseParams, solid, stripedToon, toon } from './visual-helpers-b.ts';

/** Angular extent of a motion trail (radians). */
const TRAIL = 0.55;

/** Creates the Jump Rope Beam visual. */
export const jumpRopeBeamVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(JumpRopeBeamSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `jumpRopeBeam:${instance.id}`;
  applyInstanceTransform(root, instance);

  const layers = jumpRopeLayers(p);
  const hubH = Math.max(p.lowHeight, p.layers === 'low' ? p.lowHeight : p.highHeight) + 0.6;
  const hub = solid(d.track(new CylinderGeometry(p.hubRadius, p.hubRadius * 1.1, hubH, 32)), stripedToon(d, PAL.yellow, PAL.pink, 2, 'y'));
  hub.position.y = hubH / 2;
  root.add(hub);
  const dome = solid(d.track(new SphereGeometry(p.hubRadius, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2)), toon(d, { color: PAL.pink }));
  dome.position.y = hubH;
  root.add(dome);

  const reach = p.radius - p.hubRadius;
  const beamGeo = d.track(new CapsuleGeometry(p.beamRadius, Math.max(0.05, reach - 2 * p.beamRadius), 6, 16));
  beamGeo.rotateZ(Math.PI / 2);
  // Trail fan in the XY plane from angle 0 to TRAIL; laid flat it spans yaw [0, TRAIL].
  const trailGeo = d.track(new RingGeometry(p.hubRadius, p.radius, 24, 1, 0, TRAIL));
  trailGeo.rotateX(-Math.PI / 2);

  const rotors: Group[] = [];
  const speedU = uniform(0);
  layers.forEach((layer, li) => {
    const rotor = new Group();
    const neon = li === 0 ? PAL.cyan : PAL.magenta;
    const beamMat = toon(d, { color: neon, emissive: neon, emissiveIntensity: 0.55, rimColor: '#ffffff', rimStrength: 0.8 });
    // The trail trails BEHIND the beam, so its bright edge depends on spin direction.
    const trail = glowMaterial(d, neon, { additive: true, doubleSide: true });
    const ang = atan(positionLocal.z.negate(), positionLocal.x).div(TRAIL).clamp(0, 1);
    const lead = layer.sign > 0 ? ang : float(1).sub(ang);
    trail.mat.opacityNode = lead.pow(2.5).mul(speedU).mul(0.55);
    for (let b = 0; b < p.beamsPerLayer; b++) {
      const yaw = (b / p.beamsPerLayer) * Math.PI * 2;
      for (const side of p.mode === 'full' ? [0, Math.PI] : [0]) {
        const arm = new Group();
        arm.rotation.y = yaw + side;
        const beam = solid(beamGeo, beamMat);
        beam.position.x = p.hubRadius + reach / 2;
        addOutline(d, beam, 0.035);
        arm.add(beam);
        const fan = new Mesh(trailGeo, trail.mat);
        fan.rotation.y = layer.sign > 0 ? -TRAIL : 0;
        fan.renderOrder = 1;
        arm.add(fan);
        rotor.add(arm);
      }
    }
    root.add(rotor);
    rotors.push(rotor);
  });

  const samples: PoseSample[] = [];

  return {
    object: root,
    update(t) {
      jumpRopeBeamPose(t, p, samples, ctx.speedScale);
      for (let i = 0; i < rotors.length; i++) applyPose(rotors[i]!, samples[i]!);
      speedU.value = Math.min(1, jumpRopeSpeed(t, p, ctx.speedScale) / 140);
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
