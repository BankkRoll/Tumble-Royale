/**
 * Seeded round layout: variation choice, effective obstacle list and spawn
 * grid placement. Pure functions of (round, seed, players) so the server and
 * every client derive the same layout without sending it.
 */
import { Rng, hashString, type RoundDefinition, type Vec3 } from '@tumble/shared';
import type { ObstacleInstance, ObstacleType } from '../obstacles/types.ts';

type Variation = RoundDefinition['variations'][number];

/** Seed salt so variation picks never correlate with other per-round streams. */
const VARIATION_SALT = 0x5eed_7a1e;
const SPAWN_SALT = 0x5a3d_0b1e;

/**
 * Picks the round's variation by weight, seeded by `seed ⊕ hashString(round.id)`.
 *
 * @param round - Validated round.
 * @param seed - Show seed.
 * @param forcedId - Explicit variation id (custom lobbies, tests); unknown ids fall back to the seeded pick.
 * @returns The chosen variation, or null if the round has none.
 */
export function chooseVariation(round: RoundDefinition, seed: number, forcedId?: string): Variation | null {
  if (round.variations.length === 0) return null;
  if (forcedId !== undefined) {
    const v = round.variations.find((x) => x.id === forcedId);
    if (v) return v;
  }
  const rng = new Rng((seed ^ hashString(round.id) ^ VARIATION_SALT) >>> 0);
  const weights = round.variations.map((v) => Math.max(0, v.weight));
  if (!weights.some((w) => w > 0)) return round.variations[0] ?? null;
  return round.variations[rng.weightedIndex(weights)] ?? null;
}

/**
 * Applies a variation to the round's obstacle list: removals, param overrides
 * (shallow-merged over authored params) and additions.
 *
 * @returns Fresh instances; the round definition is never mutated.
 */
export function resolveObstacles(round: RoundDefinition, variation: Variation | null): ObstacleInstance[] {
  const removed = new Set(variation?.removeObstacles ?? []);
  const out: ObstacleInstance[] = [];
  const all = variation ? [...round.obstacles, ...variation.addObstacles] : round.obstacles;
  for (const o of all) {
    if (removed.has(o.id)) continue;
    const override = variation?.obstacleParams[o.id];
    out.push({
      id: o.id,
      type: o.type as ObstacleType,
      position: { ...o.position },
      rotation: o.rotation ? { ...o.rotation } : undefined,
      params: override ? { ...o.params, ...override } : { ...o.params },
    });
  }
  return out;
}

/** One spawn slot. */
export interface SpawnSlot {
  pos: Vec3;
  /** Facing yaw in radians. */
  yaw: number;
}

/**
 * Spawn positions for each player, in the order of `teams`. Players fill a
 * centred grid (`cols` wide, `spacing` apart) facing the spawn yaw (team grids
 * face the spawn origin instead); slot order
 * is shuffled with the round seed so nobody always gets pole position. Team
 * rounds use one grid per `teamOrigins` entry.
 *
 * @param round - Validated round.
 * @param seed - Show seed.
 * @param teams - Team index per player (-1 for none), in player order.
 * @returns One slot per player.
 */
export function spawnSlots(round: RoundDefinition, seed: number, teams: readonly number[]): SpawnSlot[] {
  const sp = round.spawn;
  const yaw = (sp.yaw * Math.PI) / 180;
  const rng = new Rng((seed ^ hashString(round.id) ^ SPAWN_SALT) >>> 0);
  const groups = new Map<number, number[]>();
  teams.forEach((t, i) => {
    const key = sp.teamOrigins.length > 0 && t >= 0 ? t % sp.teamOrigins.length : -1;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(i);
  });
  const out: SpawnSlot[] = teams.map(() => ({ pos: { ...sp.origin }, yaw }));
  for (const [key, members] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const origin = key >= 0 ? (sp.teamOrigins[key] as Vec3) : sp.origin;
    // The schema has one spawn yaw, so team grids face the spawn origin (the arena centre).
    const dx = sp.origin.x - origin.x;
    const dz = sp.origin.z - origin.z;
    const gridYaw = key >= 0 && dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : yaw;
    const sin = Math.sin(gridYaw);
    const cos = Math.cos(gridYaw);
    const cols = Math.max(1, Math.min(sp.cols, members.length));
    const rows = Math.ceil(members.length / cols);
    const order = rng.shuffle(members.map((_, k) => k));
    members.forEach((playerIndex, k) => {
      const slot = order[k] as number;
      const c = slot % cols;
      const r = Math.floor(slot / cols);
      // Local grid: x across, z back from the front row (players face +Z locally).
      const lx = (c - (cols - 1) / 2) * sp.spacing;
      const lz = -(r - (rows - 1) / 2) * sp.spacing;
      const s = out[playerIndex] as SpawnSlot;
      s.pos.x = origin.x + lx * cos + lz * sin;
      s.pos.y = origin.y;
      s.pos.z = origin.z - lx * sin + lz * cos;
      s.yaw = gridYaw;
    });
  }
  return out;
}
