/**
 * Warp Pad visual: sunny-rimmed pads with a swirling TSL portal, rising halo
 * rings and a floating beacon gem; every zap (read from the runtime) fires a
 * flash ring and sparkle burst at both ends. The `sendBack` variant swaps to
 * danger colours.
 */
import { CircleGeometry, CylinderGeometry, Group, Mesh, OctahedronGeometry, TorusGeometry } from 'three/webgpu';
import type { ObstacleRuntime } from '@tumble/sim';
import { TeleporterPairSchema, teleporterPadLocal } from '@tumble/sim/obstacles';
import type { ObstacleVisualFactory } from './types.ts';
import {
  Disposer,
  PAL,
  Sparkles,
  addOutline,
  applyInstanceTransform,
  glowMaterial,
  parseParams,
  portalMaterial,
  rand01,
  solid,
  toon,
  type FloatUniform,
} from './visual-helpers-b.ts';

const RINGS = 2;
const BURST = 18;
const BURST_LIFE = 0.7;

interface PadParts {
  group: Group;
  rings: Mesh[];
  ringGlow: FloatUniform;
  flash: Mesh;
  flashGlow: FloatUniform;
  beacon: Mesh;
  burst: Sparkles;
}

/** Creates the Teleporter Pair visual. */
export const teleporterPairVisual: ObstacleVisualFactory = (instance) => {
  const p = parseParams(TeleporterPairSchema, instance);
  const d = new Disposer();
  const root = new Group();
  root.name = `teleporterPair:${instance.id}`;
  applyInstanceTransform(root, instance);

  const trap = p.variant === 'sendBack';
  const baseGeo = d.track(new CylinderGeometry(p.padRadius, p.padRadius * 1.08, 0.16, 40));
  const rimGeo = d.track(new TorusGeometry(p.padRadius, 0.1, 10, 48));
  const discGeo = d.track(new CircleGeometry(p.padRadius * 0.92, 48));
  discGeo.rotateX(-Math.PI / 2);
  const ringGeo = d.track(new TorusGeometry(p.padRadius * 0.85, 0.05, 8, 40));
  const beaconGeo = d.track(new OctahedronGeometry(0.28, 0));
  const baseMat = toon(d, { color: PAL.ink, rimStrength: 0.4 });
  const rimMat = toon(d, { color: trap ? PAL.orange : PAL.yellow, emissive: trap ? PAL.orange : PAL.yellow, emissiveIntensity: 0.35 });

  const pads: PadParts[] = [];
  const local = { x: 0, y: 0, z: 0 };
  const padCount = p.exits.length + 1;
  for (let i = 0; i < padCount; i++) {
    teleporterPadLocal(p, i, local);
    const g = new Group();
    g.position.set(local.x, local.y, local.z);
    const entrance = i === 0;
    const a = trap ? PAL.magenta : entrance ? PAL.cyan : PAL.mint;
    const b = trap ? PAL.orange : entrance ? PAL.violet : PAL.cyan;

    const base = solid(baseGeo, baseMat);
    base.position.y = 0.08;
    g.add(base);
    const rim = solid(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.17;
    g.add(rim);
    const portal = new Mesh(discGeo, portalMaterial(d, a, b).mat);
    portal.position.y = 0.175;
    portal.renderOrder = 1;
    g.add(portal);

    const ringGlow = glowMaterial(d, a, { additive: true, opacity: 0.8 });
    const rings: Mesh[] = [];
    for (let r = 0; r < RINGS; r++) {
      const ring = new Mesh(ringGeo, ringGlow.mat);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      rings.push(ring);
    }
    const flashGlow = glowMaterial(d, '#ffffff', { additive: true });
    const flash = new Mesh(ringGeo, flashGlow.mat);
    flash.rotation.x = Math.PI / 2;
    flash.position.y = 0.4;
    g.add(flash);

    const beacon = solid(beaconGeo, toon(d, { color: a, emissive: a, emissiveIntensity: 0.6, rimStrength: 0.8 }));
    addOutline(d, beacon, 0.03);
    // Only entrances (and two-way exits) get a beacon: it marks "step here".
    beacon.visible = entrance || p.twoWay;
    g.add(beacon);

    const burst = new Sparkles(d, BURST, '#ffffff', 0.12);
    g.add(burst.mesh);
    root.add(g);
    pads.push({ group: g, rings, ringGlow: ringGlow.intensity, flash, flashGlow: flashGlow.intensity, beacon, burst });
  }

  const readZap = (runtime: ObstacleRuntime | undefined, i: number): number => {
    const z = (runtime as { lastZap?: Float64Array } | undefined)?.lastZap;
    return z && i < z.length ? (z[i] as number) : Number.NaN;
  };

  return {
    object: root,
    update(t, _dt, runtime) {
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i]!;
        for (let r = 0; r < RINGS; r++) {
          const u = (t * 0.7 + r / RINGS) % 1;
          const ring = pad.rings[r]!;
          ring.position.y = 0.2 + u * p.triggerHeight;
          ring.scale.setScalar(1 - u * 0.35);
        }
        pad.ringGlow.value = 0.9;
        pad.beacon.position.y = p.triggerHeight + 0.4 + Math.sin(t * 2.2 + i) * 0.15;
        pad.beacon.rotation.y = t * 1.8;

        const age = t - readZap(runtime, i);
        const on = age >= 0 && age < BURST_LIFE;
        const k = on ? age / BURST_LIFE : 1;
        pad.flashGlow.value = on ? 1 - k : 0;
        pad.flash.scale.setScalar(1 + k * 1.8);
        for (let s = 0; s < BURST; s++) {
          const ang = (s / BURST) * Math.PI * 2 + rand01(s, 1);
          const r = p.padRadius * (0.3 + k * (1.2 + rand01(s, 2)));
          pad.burst.set(s, Math.cos(ang) * r, 0.3 + k * (1 + rand01(s, 3) * 1.6), Math.sin(ang) * r, on ? 1 - k : 0);
        }
        pad.burst.commit();
      }
    },
    dispose() {
      root.removeFromParent();
      d.dispose();
    },
  };
};
