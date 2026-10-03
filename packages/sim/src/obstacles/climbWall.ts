/**
 * Climb Wall — a tall grabbable wall studded with chunky handholds. Every
 * collider is tagged `grabbable`, so the character controller's ledge-grab /
 * climb logic works anywhere on it. Static; handhold layout is seeded so round
 * variations can reshuffle routes.
 */
import { InteractionGroups, quatFromAxisAngle, quatMul, rotateVec, vec3 } from '@tumble/shared';
import { z } from 'zod';
import { DEG, PhysicsBag, hash3, instanceFrame, type BoxPart } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime } from './types.ts';

/**
 * Climb Wall parameters. Metres, degrees. Origin = bottom centre of the wall;
 * the climbing face points toward local −Z (players approach from −Z).
 */
export const ClimbWallSchema = z.object({
  width: z.number().positive().default(6),
  height: z.number().positive().default(8),
  thickness: z.number().positive().default(0.8),
  /** Positive leans the top toward the climber (overhang); negative is a slab. */
  lean: z.number().min(-45).max(45).default(0),
  /** Handhold grid (0 rows = bare wall). */
  holdRows: z.number().int().min(0).max(24).default(6),
  holdCols: z.number().int().min(0).max(12).default(4),
  /** Random offset per hold as a fraction of the grid cell. */
  holdJitter: z.number().min(0).max(0.5).default(0.3),
  holdSize: z.number().positive().default(0.4),
  /** How far holds stick out of the face. */
  holdDepth: z.number().positive().default(0.28),
  /** Lowest/highest hold heights as a margin from the wall's base/top. */
  holdMargin: z.number().min(0).default(0.9),
  /** Grab lip along the top edge. */
  topLip: z.boolean().default(true),
  seed: z.number().int().default(1),
});

/** Validated Climb Wall parameters. */
export type ClimbWallParams = z.output<typeof ClimbWallSchema>;

/**
 * Wall, handhold and lip boxes in obstacle-local space (roles: `wall`, `hold`, `lip`).
 * Build-time allocation; the renderer uses the same list.
 */
export function climbWallParts(p: ClimbWallParams): BoxPart[] {
  const tilt = quatFromAxisAngle(1, 0, 0, -p.lean * DEG);
  const parts: BoxPart[] = [];
  const add = (x: number, y: number, z: number, hx: number, hy: number, hz: number, role: string, spin = 0): void => {
    const rot = spin === 0 ? { ...tilt } : quatMul(tilt, quatFromAxisAngle(0, 0, 1, spin));
    parts.push({ pos: rotateVec(tilt, vec3(x, y, z)), rot, half: vec3(hx, hy, hz), role });
  };
  const ht = p.thickness / 2;
  add(0, p.height / 2, 0, p.width / 2, p.height / 2, ht, 'wall');
  const usableH = Math.max(0, p.height - 2 * p.holdMargin);
  const cellW = p.holdCols > 0 ? p.width / p.holdCols : 0;
  const cellH = p.holdRows > 1 ? usableH / (p.holdRows - 1) : 0;
  for (let r = 0; r < p.holdRows; r++) {
    for (let c = 0; c < p.holdCols; c++) {
      const i = r * p.holdCols + c;
      // Offset alternate rows by half a cell so routes zig-zag like a real wall.
      const stagger = r % 2 === 0 ? 0 : 0.5;
      const jx = (hash3(p.seed, i, 1) - 0.5) * 2 * p.holdJitter;
      const jy = (hash3(p.seed, i, 2) - 0.5) * 2 * p.holdJitter;
      let x = (c + 0.5 + stagger * (c === p.holdCols - 1 ? -1 : 1) + jx) * cellW - p.width / 2;
      x = Math.max(-p.width / 2 + p.holdSize, Math.min(p.width / 2 - p.holdSize, x));
      const y = p.holdMargin + r * cellH + jy * cellH;
      const s = p.holdSize * (0.8 + 0.4 * hash3(p.seed, i, 3));
      add(x, y, -ht - p.holdDepth / 2, s / 2, s / 2 * 0.8, p.holdDepth / 2, 'hold', (hash3(p.seed, i, 4) - 0.5) * 1.2);
    }
  }
  if (p.topLip) add(0, p.height + 0.12, -ht - 0.12, p.width / 2, 0.12, 0.24, 'lip');
  return parts;
}

/** Climb Wall obstacle module. */
export const climbWall: ObstacleModule<ClimbWallParams> = {
  type: 'climbWall',
  displayName: 'Climb Wall',
  schema: ClimbWallSchema,
  create(instance, ctx): ObstacleRuntime {
    const p = ClimbWallSchema.parse(instance.params);
    const { R } = ctx;
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(instanceFrame(instance));
    for (const part of climbWallParts(p)) {
      bag.collider(
        R.ColliderDesc.cuboid(part.half.x, part.half.y, part.half.z)
          .setTranslation(part.pos.x, part.pos.y, part.pos.z)
          .setRotation(part.rot)
          .setFriction(1.0)
          .setCollisionGroups(InteractionGroups.static),
        body,
        { kind: 'normal', grabbable: true, ownerId: instance.id },
      );
    }
    return { instance, colliders: bag.colliders, update() {}, dispose: () => bag.dispose() };
  },
};
