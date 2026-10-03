/**
 * Conveyor belt visual: a mint belt with scrolling yellow chevrons that move
 * exactly with the sim's belt travel (`conveyorTravel`) and flip to point the
 * way the belt is running, plus rolling end drums and candy side rails.
 */
import type { Mesh } from 'three/webgpu';
import { Color, CylinderGeometry, PlaneGeometry, type MeshToonNodeMaterial } from 'three/webgpu';
import { abs, float, fract, mix, smoothstep, uniform, uv } from 'three/tsl';
import type { ObstacleInstance } from '@tumble/sim';
import {
  conveyorBeltSchema,
  conveyorTelegraph,
  conveyorTravel,
  conveyorVelocity,
  type ConveyorBeltParams,
} from '../../../sim/src/obstacles/conveyorBelt.ts';
import { createToonMaterial } from '../materials/toon.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  createPatternMaterial,
  roundedBox,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

/** Chevron spacing along the belt (m). */
const CHEVRON_SPACING = 1.6;

class ConveyorBeltVisual extends VisualBase<ConveyorBeltParams> {
  private readonly beltMat: MeshToonNodeMaterial;
  private readonly travel = uniform(0);
  private readonly dir = uniform(1);
  private readonly drums: Mesh[] = [];

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, conveyorBeltSchema.parse(instance.params));
    const p = this.params;

    const slab = this.add(
      shadedMesh(roundedBox(p.width, p.thickness, p.length, 0.1), createPatternMaterial({ a: C.ink })),
    );
    slab.position.y = -p.thickness / 2 - 0.01;

    this.beltMat = createToonMaterial({
      color: C.mint,
      emissive: C.glowWarn,
      emissiveIntensity: 0,
      rimStrength: 0.2,
    });
    const u = uv();
    const along = float(0.5).sub(u.y).mul(p.length);
    const across = abs(u.x.sub(0.5)).mul(p.width);
    const phase = fract(along.sub(this.travel).mul(this.dir).add(across.mul(0.55)).div(CHEVRON_SPACING));
    const chevron = smoothstep(0.42, 0.47, phase).mul(float(1).sub(smoothstep(0.7, 0.75, phase)));
    const edge = smoothstep(0.44, 0.47, abs(u.x.sub(0.5)));
    const base = mix(uniform(new Color(C.mint)), uniform(new Color(C.safe)), edge);
    this.beltMat.colorNode = mix(base, uniform(new Color(C.interact)), chevron.mul(float(1).sub(edge)));
    const top = this.add(shadedMesh(new PlaneGeometry(p.width, p.length, 1, 1), this.beltMat, false, true));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.004;

    const r = p.thickness / 2;
    const drumGeo = new CylinderGeometry(r, r, p.width, 24);
    const drumMat = createPatternMaterial({ a: C.interact, b: C.dangerAlt, pattern: 'pie', scale: 6 });
    for (const side of [-1, 1]) {
      const drum = this.add(shadedMesh(drumGeo, drumMat));
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -r, side * (p.length / 2));
      this.drums.push(drum);
    }

    if (p.rails) {
      const railMat = createPatternMaterial({ a: C.interact, b: C.cream, pattern: 'stripes', scale: 1.5 });
      const railGeo = roundedBox(p.railWidth, p.railHeight + p.thickness, p.length, p.railWidth * 0.45);
      for (const side of [-1, 1]) {
        const rail = this.add(shadedMesh(railGeo, railMat));
        rail.position.set(side * (p.width / 2 + p.railWidth / 2), (p.railHeight - p.thickness) / 2, 0);
      }
    }
  }

  update(t: number): void {
    const s = this.ctx.speedScale;
    const d = conveyorTravel(t, this.params, s);
    this.travel.value = d;
    const v = conveyorVelocity(t, this.params, s);
    if (Math.abs(v) > 0.05) this.dir.value = Math.sign(v);
    const angle = d / (this.params.thickness / 2);
    for (const drum of this.drums) drum.rotation.x = angle;
    setGlow(this.beltMat, conveyorTelegraph(t, this.params) * 0.9);
  }
}

/** Conveyor belt visual factory. */
export const conveyorBeltVisual: ObstacleVisualFactory = (instance, ctx) =>
  new ConveyorBeltVisual(instance, ctx);
