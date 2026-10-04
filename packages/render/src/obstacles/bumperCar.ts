/**
 * Bumper Cart visual: cute rounded carts with rubber bumper rings, glowing
 * headlights, a seat, a wheel and a bobbing antenna flag, driven by the sim's
 * pure track pose. Dashed lane markings trace the closed track.
 */
import {
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  SphereGeometry,
  TorusGeometry,
} from 'three/webgpu';
import type { PoseSample } from '@tumble/sim';
import { BumperCarSchema, bumperCarPose, bumperTrackLut, sampleTrack } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  addOutline,
  applyInstanceTransform,
  applyPose,
  glowMaterial,
  parseParams,
  roundedBox,
  setGlow,
  setInstanceTRS,
  solid,
  toon,
} from './visual-helpers-b.ts';

const BODY_COLORS = [PAL.pink, PAL.cyan, PAL.yellow, PAL.mint, PAL.violet, PAL.orange];

/** Creates the Bumper Car visual. */
export const bumperCarVisual: ObstacleVisualFactory = (instance, ctx) => {
  const p = parseParams(BumperCarSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `bumperCar:${instance.id}`;
  applyInstanceTransform(root, instance);

  const W = p.carWidth;
  const H = p.carHeight;
  const Lc = p.carLength;
  const bodyGeo = roundedBox(d, W / 2 - 0.08, H * 0.32, Lc / 2 - 0.12, 0.28, 4);
  const seatGeo = roundedBox(d, W * 0.3, H * 0.3, 0.16, 0.12);
  const bumperGeo = d.track(new TorusGeometry(1, 0.16, 10, 40));
  const wheelGeo = d.track(new TorusGeometry(0.22, 0.06, 8, 20));
  const lampGeo = d.track(new SphereGeometry(0.13, 14, 10));
  const poleGeo = d.track(new CylinderGeometry(0.025, 0.025, 1, 6));
  const flagGeo = d.track(new ConeGeometry(0.16, 0.36, 3));
  const rubber = toon(d, { color: PAL.ink, rimStrength: 0.3 });
  const headMat = toon(d, { color: '#fff7c2', emissive: '#fff1a0', emissiveIntensity: 1.2 });
  const tailMat = toon(d, { color: '#ff5a7a', emissive: '#ff2a50', emissiveIntensity: 0.6 });
  const trimMat = toon(d, { color: PAL.white });

  const mounts: Group[] = [];
  const carts: Group[] = [];
  for (let i = 0; i < p.cars; i++) {
    const cart = new Group();
    const bodyMat = toon(d, { color: BODY_COLORS[i % BODY_COLORS.length]!, rimStrength: 0.65 });
    const body = solid(bodyGeo, bodyMat);
    body.position.y = -H * 0.1;
    addOutline(d, body, 0.04);
    cart.add(body);
    const bumper = solid(bumperGeo, rubber);
    bumper.rotation.x = Math.PI / 2;
    bumper.scale.set(W / 2 + 0.05, Lc / 2 + 0.05, 1);
    bumper.position.y = -H * 0.32;
    cart.add(bumper);
    const seat = solid(seatGeo, trimMat);
    seat.position.set(0, H * 0.35, -Lc * 0.22);
    cart.add(seat);
    const wheel = solid(wheelGeo, rubber);
    wheel.position.set(0, H * 0.38, Lc * 0.12);
    wheel.rotation.x = -0.9;
    cart.add(wheel);
    for (const side of [-1, 1]) {
      const head = solid(lampGeo, headMat);
      head.position.set(side * W * 0.3, 0, Lc / 2 - 0.05);
      cart.add(head);
      const tail = solid(lampGeo, tailMat);
      tail.scale.setScalar(0.7);
      tail.position.set(side * W * 0.32, 0, -Lc / 2 + 0.05);
      cart.add(tail);
    }
    const pole = solid(poleGeo, trimMat);
    pole.scale.y = 1.1;
    pole.position.set(W * 0.3, H * 0.6 + 0.45, -Lc * 0.38);
    cart.add(pole);
    const flag = solid(flagGeo, bodyMat);
    flag.rotation.z = -Math.PI / 2;
    flag.position.set(W * 0.3 + 0.18, H * 0.6 + 0.9, -Lc * 0.38);
    cart.add(flag);
    // The mount carries the sim pose exactly; the suspension bounce lives on the cart inside it.
    const mount = new Group();
    mount.add(cart);
    root.add(mount);
    mounts.push(mount);
    carts.push(cart);
  }

  // Lane dashes along the track centre line.
  const lut = bumperTrackLut(p);
  const dashCount = Math.max(8, Math.floor(lut.length / 1.6));
  const { mat: dashMat } = glowMaterial(d, PAL.white, { opacity: 0.55, additive: false, doubleSide: true });
  const dashGeo = d.track(new CircleGeometry(0.22, 12));
  dashGeo.rotateX(-Math.PI / 2);
  const dashes = new InstancedMesh(dashGeo, dashMat, dashCount);
  const pt = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < dashCount; i++) {
    const yaw = sampleTrack(lut, (i / dashCount) * lut.length, pt);
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    setInstanceTRS(dashes, i, pt.x, 0.03, pt.z, q, 1, 1, 2.2);
  }
  dashes.instanceMatrix.needsUpdate = true;
  root.add(dashes);

  const samples: PoseSample[] = [];

  return {
    object: root,
    update(t) {
      bumperCarPose(t, p, samples, ctx.speedScale);
      for (let i = 0; i < p.cars; i++) {
        applyPose(mounts[i]!, samples[i]!);
        carts[i]!.position.y = Math.abs(Math.sin(t * 9 + i * 1.7)) * 0.05;
      }
      setGlow(headMat, 1 + 0.2 * Math.sin(t * 12));
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
