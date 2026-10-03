/**
 * Level-authoring kit shared by the group-1 rounds (Gumdrop Gauntlet, Conveyor
 * Chaos, Tilt Town, Slip 'n' Spiral, Crown Climb).
 *
 * Responsibilities:
 * - Terse constructors for static pieces that follow LEVELS.md §1 conventions
 *   (floors by top height, arches by floor base, decorative variants).
 * - The standard checkpoint bundle: trigger, `checkpointGate` arch, checker pad
 *   and six respawn points past the trigger.
 * - A small waypoint-graph builder so bot routes read like the design tables.
 */
import type { z } from 'zod';
import type {
  ObstacleInstanceSchema,
  RoundDefinitionInput,
  StaticPieceSchema,
  TriggerSchema,
  Vec3,
  WaypointSchema,
} from '@tumble/shared';

/** Static piece as authored (schema defaults optional). */
export type Piece = z.input<typeof StaticPieceSchema>;
/** Obstacle instance as authored. */
export type Obstacle = z.input<typeof ObstacleInstanceSchema>;
/** Trigger as authored. */
export type Trigger = z.input<typeof TriggerSchema>;
/** Waypoint as authored. */
export type WaypointInput = z.input<typeof WaypointSchema>;
/** Seeded variation as authored. */
export type Variation = NonNullable<RoundDefinitionInput['variations']>[number];

/** Optional styling/behaviour fields shared by every piece constructor. */
export type PieceOpts = Partial<Omit<Piece, 'shape' | 'position' | 'size'>>;

/**
 * Shorthand vector.
 *
 * @example
 * v(0, 1.2, 40) // { x: 0, y: 1.2, z: 40 }
 */
export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Rounds to centimetres so generated data stays readable in diffs and tooling. */
export const cm = (n: number): number => Math.round(n * 100) / 100;

/**
 * Box by centre and full extents.
 *
 * @param x - Centre X. @param y - Centre Y. @param z - Centre Z.
 * @param sx - Width. @param sy - Height. @param sz - Depth.
 */
export function box(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  o: PieceOpts = {},
): Piece {
  return { shape: 'box', position: v(x, y, z), size: v(sx, sy, sz), ...o };
}

/**
 * Floor slab addressed by its walkable top (LEVELS.md §1.1: floors are 1 m thick
 * unless `thickness` says otherwise).
 *
 * @param top - Y of the walking surface.
 * @param z0 - Near edge Z. @param z1 - Far edge Z.
 * @param width - Full width along X.
 */
export function floor(
  x: number,
  top: number,
  z0: number,
  z1: number,
  width: number,
  o: PieceOpts = {},
  thickness = 1,
): Piece {
  return box(x, top - thickness / 2, (z0 + z1) / 2, width, thickness, z1 - z0, { bevel: 0.3, ...o });
}

/**
 * Thin painted strip lying on a floor (decorative, no collider).
 *
 * @param top - Floor top it sits on.
 */
export function paint(x: number, top: number, z: number, sx: number, sz: number, o: PieceOpts = {}): Piece {
  return box(x, top + 0.015, z, sx, 0.03, sz, { decorative: true, bevel: 0, ...o });
}

/**
 * Ramp by bounding-box centre; the top rises toward local +Z (yaw 180 descends toward +Z).
 */
export function ramp(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  o: PieceOpts = {},
): Piece {
  return { shape: 'ramp', position: v(x, y, z), size: v(sx, sy, sz), ...o };
}

/** Upright cylinder by centre. */
export function cyl(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  o: PieceOpts = {},
): Piece {
  return { shape: 'cylinder', position: v(x, y, z), size: v(radius, height, radius), ...o };
}

/** Cylinder addressed by its top surface (pads, stools, turrets). */
export function pillar(
  x: number,
  top: number,
  z: number,
  radius: number,
  height: number,
  o: PieceOpts = {},
): Piece {
  return cyl(x, top - height / 2, z, radius, height, o);
}

/** Sphere by centre. */
export function sphere(x: number, y: number, z: number, radius: number, o: PieceOpts = {}): Piece {
  return { shape: 'sphere', position: v(x, y, z), size: v(radius, radius, radius), ...o };
}

/** Flat torus by centre (major radius, tube radius). */
export function torus(
  x: number,
  y: number,
  z: number,
  major: number,
  tube: number,
  o: PieceOpts = {},
): Piece {
  return { shape: 'torus', position: v(x, y, z), size: v(major, tube, major), ...o };
}

/**
 * Arch placed by the floor point under its centre (LEVELS.md convention). The
 * schema positions arches by bounding-box centre, so half the height is added.
 */
export function arch(
  x: number,
  baseY: number,
  z: number,
  w: number,
  h: number,
  d: number,
  o: PieceOpts = {},
): Piece {
  return { shape: 'arch', position: v(x, baseY + h / 2, z), size: v(w, h, d), ...o };
}

/** Marks pieces decorative (rendered, no collider). */
export function deco(...pieces: Piece[]): Piece[] {
  return pieces.map((p) => ({ ...p, decorative: true }));
}

/**
 * Mirrors pieces across X = 0 (negates x and yaw). Returns originals + mirrors.
 */
export function mirrorX(...pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    out.push(p);
    const r = p.rotation;
    out.push({
      ...p,
      position: v(-p.position.x, p.position.y, p.position.z),
      ...(r ? { rotation: { ...r, yaw: -(r.yaw ?? 0), roll: -(r.roll ?? 0) } } : {}),
    });
  }
  return out;
}

/** Options for {@link checkpoint}. */
export interface CheckpointSpec {
  /** Checkpoint order (1 = first after the start). */
  index: number;
  /** Floor top under the checkpoint. */
  top: number;
  /** Trigger centre Z (the pad stripe sits here). */
  z: number;
  /** Full course width at the checkpoint. */
  width: number;
  x?: number;
  /** Distance past the trigger where respawn points sit (design: 1.5–2.5 m). */
  respawnAhead?: number;
  /** Respawn X offsets; defaults to ±1.5/±4.5/±7.5 clipped to the width. */
  respawnXs?: number[];
  /** Add the `checkpointGate` arch (visual + trigger flash). */
  gate?: boolean;
  /** Add the checker pad stripe. */
  pad?: boolean;
}

/** Everything a standard checkpoint contributes to a round. */
export interface CheckpointBundle {
  trigger: Trigger;
  obstacles: Obstacle[];
  geometry: Piece[];
}

/**
 * Standard checkpoint (LEVELS.md §1.5): a 2 m checker stripe, a gate arch over
 * it, a 4 m tall full-width trigger 1 m above the floor and six respawn points
 * on the safe pad past it.
 */
export function checkpoint(spec: CheckpointSpec): CheckpointBundle {
  const x = spec.x ?? 0;
  const ahead = spec.respawnAhead ?? 2.5;
  const half = spec.width / 2 - 1;
  const xs = spec.respawnXs ?? [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5].filter((dx) => Math.abs(dx) <= half);
  const trigger: Trigger = {
    id: `cp-${spec.index}`,
    kind: 'checkpoint',
    index: spec.index,
    position: v(x, spec.top + 2, spec.z),
    size: v(spec.width, 4, 2),
    respawn: xs.map((dx) => v(x + dx, spec.top + 0.1, spec.z + ahead)),
    respawnYaw: 0,
  };
  const obstacles: Obstacle[] =
    spec.gate === false
      ? []
      : [
          {
            id: `cp-${spec.index}-gate`,
            type: 'checkpointGate',
            position: v(x, spec.top, spec.z),
            params: { index: spec.index, width: spec.width, height: 5, respawnDistance: ahead },
          },
        ];
  const geometry =
    spec.pad === false
      ? []
      : [paint(x, spec.top, spec.z, spec.width, 2, { color: 'safe', pattern: 'checker' })];
  return { trigger, obstacles, geometry };
}

/** Per-waypoint options for {@link NavBuilder.add}. */
export interface WaypointOpts {
  r?: number;
  action?: WaypointInput['action'];
  timeAgainst?: string;
}

/**
 * Accumulates a bot waypoint graph. Ids follow LEVELS.md §1.7 (hundreds per section).
 *
 * @example
 * const nav = new NavBuilder();
 * nav.add(0, [0, 0, 4], [10], { r: 3 });
 * nav.add(10, [0, 0, 22], [11], { action: 'jump' });
 */
export class NavBuilder {
  private readonly nodes: WaypointInput[] = [];

  /**
   * Adds one waypoint.
   *
   * @param id - Unique integer id.
   * @param pos - Ground position `[x, y, z]` (y = walking surface).
   * @param next - Successor id(s); empty for the goal.
   */
  add(
    id: number,
    pos: readonly [number, number, number],
    next: number | number[],
    o: WaypointOpts = {},
  ): this {
    this.nodes.push({
      id,
      position: v(cm(pos[0]), cm(pos[1]), cm(pos[2])),
      radius: o.r ?? 1.5,
      next: Array.isArray(next) ? next : [next],
      action: o.action ?? 'run',
      ...(o.timeAgainst ? { timeAgainst: o.timeAgainst } : {}),
    });
    return this;
  }

  /** @returns The authored waypoint list. */
  build(): WaypointInput[] {
    return this.nodes;
  }
}

/**
 * Applies the same param overrides to several obstacle ids (variation helper).
 *
 * @example
 * same(['s4-ham-1', 's4-ham-2'], { period: 2.6 })
 */
export function same(
  ids: readonly string[],
  params: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(ids.map((id) => [id, params]));
}
