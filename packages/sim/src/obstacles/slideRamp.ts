/**
 * Slide Ramp — a long slick incline, optionally a trough, that players ride
 * down on their bellies. Static: everything interesting comes from the `slide`
 * surface kind, which the character controller tunes.
 */
import { InteractionGroups, quatFromAxisAngle, quatMul, rotateVec, vec3, type Quat } from '@tumble/shared';
import { z } from 'zod';
import { DEG, PhysicsBag, frictionFor, instanceFrame, type BoxPart } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime } from './types.ts';

/** Slide Ramp parameters. Lengths in metres, angles in degrees. */
export const SlideRampSchema = z.object({
  /** Length along the slope (local +Z is downhill). */
  length: z.number().positive().default(18),
  /** Width of the riding surface. */
  width: z.number().positive().default(6),
  /** Downhill pitch in degrees (0 = flat, 35 = very steep). */
  angle: z.number().min(-60).max(60).default(18),
  /** Deck thickness. */
  thickness: z.number().positive().default(0.6),
  /** `flat` deck, or `trough` with walls angled inward to keep riders centred. */
  shape: z.enum(['flat', 'trough']).default('flat'),
  /** Trough wall width (slant length) — trough only. */
  wallWidth: z.number().positive().default(2),
  /** Trough wall tilt from horizontal in degrees — trough only. */
  wallAngle: z.number().min(10).max(85).default(40),
  /** Low guard rails along both edges (flat shape only). */
  rails: z.boolean().default(true),
  railHeight: z.number().positive().default(0.8),
  /** Surface kind of the deck. */
  surface: z.enum(['slide', 'ice', 'normal']).default('slide'),
});

/** Validated Slide Ramp parameters. */
export type SlideRampParams = z.output<typeof SlideRampSchema>;

/**
 * Collider/mesh part list for a slide ramp. Origin is the centre of the deck's
 * top surface; the deck is tilted about local X so +Z runs downhill.
 *
 * @param p - Validated params.
 * @returns Box parts in obstacle-local space (build-time allocation).
 */
export function slideRampParts(p: SlideRampParams): BoxPart[] {
  const tilt = quatFromAxisAngle(1, 0, 0, p.angle * DEG);
  const parts: BoxPart[] = [];
  const add = (x: number, y: number, z: number, hx: number, hy: number, hz: number, role: string, local?: Quat): void => {
    const pos = rotateVec(tilt, vec3(x, y, z));
    const rot = local ? quatMul(tilt, local) : { ...tilt };
    parts.push({ pos, rot, half: vec3(hx, hy, hz), role });
  };
  const hw = p.width / 2;
  const hl = p.length / 2;
  const ht = p.thickness / 2;
  add(0, -ht, 0, hw, ht, hl, 'deck');
  if (p.shape === 'trough') {
    const a = p.wallAngle * DEG;
    const hww = p.wallWidth / 2;
    for (const side of [-1, 1]) {
      const roll = quatFromAxisAngle(0, 0, 1, side * a);
      // Wall hinges at the deck's top edge and slants outward/upward.
      const cx = side * (hw + Math.cos(a) * hww + Math.sin(a) * ht);
      const cy = Math.sin(a) * hww - ht * Math.cos(a);
      add(cx, cy, 0, hww, ht, hl, 'wall', roll);
    }
  } else if (p.rails) {
    const rt = 0.2;
    for (const side of [-1, 1]) add(side * (hw + rt), p.railHeight / 2 - ht, 0, rt, p.railHeight / 2 + ht, hl, 'rail');
  }
  return parts;
}

/** Slide Ramp obstacle module. */
export const slideRamp: ObstacleModule<SlideRampParams> = {
  type: 'slideRamp',
  displayName: 'Slide Ramp',
  schema: SlideRampSchema,
  create(instance, ctx): ObstacleRuntime {
    const p = SlideRampSchema.parse(instance.params);
    const { R } = ctx;
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(instanceFrame(instance));
    for (const part of slideRampParts(p)) {
      const kind = part.role === 'rail' ? 'normal' : p.surface;
      bag.collider(
        R.ColliderDesc.cuboid(part.half.x, part.half.y, part.half.z)
          .setTranslation(part.pos.x, part.pos.y, part.pos.z)
          .setRotation(part.rot)
          .setFriction(frictionFor(kind))
          .setCollisionGroups(InteractionGroups.static),
        body,
        { kind, ownerId: instance.id },
      );
    }
    return {
      instance,
      colliders: bag.colliders,
      update() {},
      dispose: () => bag.dispose(),
    };
  },
};
