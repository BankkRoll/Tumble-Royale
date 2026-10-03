/**
 * Ice Floor — a frictionless slab (box, disc or hex) with the `ice` surface
 * kind. Static; the character controller's ice tuning does the sliding.
 */
import { InteractionGroups } from '@tumble/shared';
import { z } from 'zod';
import { PhysicsBag, frictionFor, instanceFrame } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime } from './types.ts';

/** Ice Floor parameters. Metres. Origin is the centre of the top surface. */
export const IceFloorSchema = z.object({
  shape: z.enum(['box', 'disc', 'hex']).default('box'),
  /** Box extents (box only). */
  sizeX: z.number().positive().default(12),
  sizeZ: z.number().positive().default(12),
  /** Circumradius (disc and hex). */
  radius: z.number().positive().default(6),
  thickness: z.number().positive().default(0.5),
  /** `ice` by default; `slide` gives a slicker downhill-style feel. */
  surface: z.enum(['ice', 'slide']).default('ice'),
});

/** Validated Ice Floor parameters. */
export type IceFloorParams = z.output<typeof IceFloorSchema>;

/**
 * Hex prism hull points (pointy side along ±X), top at y = 0.
 *
 * @returns Interleaved xyz for 12 vertices.
 */
export function iceHexHull(radius: number, thickness: number): Float32Array {
  const pts = new Float32Array(36);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    pts.set([x, 0, z, x, -thickness, z], i * 6);
  }
  return pts;
}

/** Ice Floor obstacle module. */
export const iceFloor: ObstacleModule<IceFloorParams> = {
  type: 'iceFloor',
  displayName: 'Ice Floor',
  schema: IceFloorSchema,
  create(instance, ctx): ObstacleRuntime {
    const p = IceFloorSchema.parse(instance.params);
    const { R } = ctx;
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(instanceFrame(instance));
    const ht = p.thickness / 2;
    let desc;
    if (p.shape === 'box')
      desc = R.ColliderDesc.cuboid(p.sizeX / 2, ht, p.sizeZ / 2).setTranslation(0, -ht, 0);
    else if (p.shape === 'hex') desc = R.ColliderDesc.convexHull(iceHexHull(p.radius, p.thickness));
    // NOTE: convexHull returns null for degenerate input; a disc is the closest safe stand-in.
    desc ??= R.ColliderDesc.cylinder(ht, p.radius).setTranslation(0, -ht, 0);
    bag.collider(
      desc.setFriction(frictionFor(p.surface)).setCollisionGroups(InteractionGroups.static),
      body,
      { kind: p.surface, ownerId: instance.id },
    );
    return { instance, colliders: bag.colliders, update() {}, dispose: () => bag.dispose() };
  },
};
