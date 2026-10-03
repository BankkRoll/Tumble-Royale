/**
 * Authoring kit for the group-4 rounds (Egg Heist, Bounce Ball Blitz, Paint the
 * Plaza, Tail Chase, Pattern Panic).
 *
 * Responsibilities:
 * - Symmetry helpers: rotate pieces, obstacles, triggers and points about the
 *   arena centre (team rounds author team 0 and derive the rest), so layouts
 *   are symmetric by construction.
 * - Team identity: team colours always travel with the team crest shape
 *   (ART_DIRECTION §10.3: ▲ ● ■ ◆) on banners and boards.
 * - Small decor builders (crowd stands, lanterns) for set dressing.
 */
import { TEAM_COLORS, type RoundDefinitionInput } from '@tumble/shared';

type Piece = RoundDefinitionInput['geometry'][number];
type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];
type Trigger = NonNullable<RoundDefinitionInput['triggers']>[number];

/** Plain 3-vector. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
/** Rounds away float noise so authored data stays readable in diffs and tests. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/** Shorthand vector. */
export const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/**
 * Rotates a point about the Y axis through the origin by `deg`, in the yaw
 * sense (yaw +90 turns +Z toward +X), so a rotated piece's yaw is `yaw + deg`.
 */
export function rotPoint(p: V3, deg: number): V3 {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: r3(p.x * c + p.z * s), y: p.y, z: r3(-p.x * s + p.z * c) };
}

/** Normalises an angle in degrees into (-180, 180]. */
export const wrapDeg = (d: number): number => {
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w + 0;
};

/** Rotated copy of a static piece. */
export function rotPiece(p: Piece, deg: number): Piece {
  return {
    ...p,
    position: rotPoint(p.position, deg),
    rotation: { ...p.rotation, yaw: wrapDeg((p.rotation?.yaw ?? 0) + deg) },
  };
}

/** Rotated copy of an obstacle instance with a new id. */
export function rotObstacle(o: Obstacle, deg: number, id: string): Obstacle {
  return {
    ...o,
    id,
    position: rotPoint(o.position, deg),
    rotation: { ...o.rotation, yaw: wrapDeg((o.rotation?.yaw ?? 0) + deg) },
  };
}

/** Rotated copy of a trigger (respawn points and yaw follow). */
export function rotTrigger(t: Trigger, deg: number, id: string, index?: number): Trigger {
  return {
    ...t,
    id,
    index: index ?? t.index,
    position: rotPoint(t.position, deg),
    rotation: { ...t.rotation, yaw: wrapDeg((t.rotation?.yaw ?? 0) + deg) },
    respawn: (t.respawn ?? []).map((p) => rotPoint(p, deg)),
    respawnYaw: wrapDeg((t.respawnYaw ?? 0) + deg),
  };
}

/** `count` copies of a piece list rotated by `360 / count` steps (copy 0 is the original). */
export function radial(pieces: Piece[], count: number, start = 0): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < count; k++) for (const p of pieces) out.push(rotPiece(p, start + (360 / count) * k));
  return out;
}

/** Team colour hex. */
export const team = (t: number): string => TEAM_COLORS[t % TEAM_COLORS.length]!;

/** Crest shape per team (ART_DIRECTION §10.3). */
export const CREST_SHAPES = ['triangle', 'circle', 'square', 'diamond'] as const;

/**
 * A team crest emblem facing `yaw`: a white crest shape (▲ ● ■ ◆) on a
 * team-coloured board. Decorative.
 *
 * @param t - Team index.
 * @param at - Centre of the board.
 * @param yaw - Direction the board faces (degrees, 0 = +Z).
 * @param size - Board edge (m).
 */
export function crestBoard(t: number, at: V3, yaw: number, size = 2.4): Piece[] {
  const face = (local: V3): V3 => {
    const p = rotPoint(local, yaw);
    return v(r3(at.x + p.x), r3(at.y + p.y), r3(at.z + p.z));
  };
  const s = size * 0.62;
  const out: Piece[] = [
    {
      shape: 'box',
      position: face(v(0, 0, 0)),
      size: v(size, size, 0.3),
      rotation: { yaw },
      color: team(t),
      bevel: 0.12,
      decorative: true,
    },
  ];
  const front = face(v(0, 0, 0.22));
  switch (CREST_SHAPES[t % 4]) {
    case 'triangle':
      out.push({
        shape: 'wedge',
        position: front,
        size: v(s * 1.1, s, 0.2),
        rotation: { yaw },
        color: '#ffffff',
        bevel: 0.04,
        decorative: true,
      });
      break;
    case 'circle':
      out.push({
        shape: 'cylinder',
        position: front,
        size: v(s / 2, 0.2, 0),
        rotation: { yaw, pitch: 90 },
        color: '#ffffff',
        decorative: true,
      });
      break;
    case 'square':
      out.push({
        shape: 'box',
        position: front,
        size: v(s * 0.85, s * 0.85, 0.2),
        rotation: { yaw },
        color: '#ffffff',
        bevel: 0.06,
        decorative: true,
      });
      break;
    default:
      out.push({
        shape: 'box',
        position: front,
        size: v(s * 0.66, s * 0.66, 0.2),
        rotation: { yaw, roll: 45 },
        color: '#ffffff',
        bevel: 0.06,
        decorative: true,
      });
  }
  return out;
}

/**
 * A team banner on a pole: neutral pole, team-coloured flag with the crest.
 *
 * @param t - Team index.
 * @param base - Floor point of the pole.
 * @param yaw - Direction the flag faces.
 * @param height - Pole height (m).
 */
export function teamBanner(t: number, base: V3, yaw: number, height = 6): Piece[] {
  return [
    {
      shape: 'cylinder',
      position: v(base.x, base.y + height / 2, base.z),
      size: v(0.14, height, 0),
      color: 'neutral',
      decorative: true,
    },
    {
      shape: 'sphere',
      position: v(base.x, base.y + height + 0.15, base.z),
      size: v(0.3, 0, 0),
      color: team(t),
      decorative: true,
    },
    ...crestBoard(t, v(base.x, base.y + height - 1.4, base.z), yaw, 2.2),
  ];
}

/**
 * Rows of spectator "heads" (spheres) on a stepped stand. Decorative.
 *
 * @param at - Front-bottom centre of the stand.
 * @param yaw - Direction the crowd faces.
 * @param width - Stand width (m).
 * @param rows - Tiers.
 * @param colors - Head colours, cycled.
 * @param seed - Varies the spacing jitter.
 */
export function crowdStand(
  at: V3,
  yaw: number,
  width: number,
  rows: number,
  colors: readonly string[],
  seed = 1,
): Piece[] {
  const out: Piece[] = [];
  const put = (local: V3): V3 => {
    const p = rotPoint(local, yaw);
    return v(r3(at.x + p.x), r3(at.y + p.y), r3(at.z + p.z));
  };
  for (let r = 0; r < rows; r++) {
    out.push({
      shape: 'box',
      position: put(v(0, r * 0.9 + 0.45, -r * 1.2)),
      size: v(width, 0.9, 1.2),
      rotation: { yaw },
      color: 'neutral',
      decorative: true,
      pattern: r % 2 === 0 ? 'stripes' : 'none',
    });
    const n = Math.max(1, Math.floor(width / 1.6));
    for (let k = 0; k < n; k++) {
      const jitter = ((Math.sin((k + 1) * 12.9898 + (r + seed) * 78.233) * 43758.5453) % 1) * 0.3;
      out.push({
        shape: 'sphere',
        position: put(v(-width / 2 + 0.8 + k * 1.6 + jitter, r * 0.9 + 1.25, -r * 1.2)),
        size: v(0.42, 0, 0),
        color: colors[(k + r * 3 + seed) % colors.length]!,
        decorative: true,
      });
    }
  }
  return out;
}
