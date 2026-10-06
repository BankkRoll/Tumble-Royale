/**
 * The round editor's document model: pure operations on a round definition.
 *
 * Every operation takes the current round and returns a new one (the input is
 * never mutated), so undo/redo can keep plain snapshots and React can compare
 * by reference. Items are addressed by {@link ItemRef}: static pieces by index,
 * obstacles and triggers by id, plus the spawn.
 */
import {
  CUSTOM_MODE_BY_TYPE,
  CUSTOM_ROUND_PLAYERS,
  LEVEL_PARTS,
  autoFlyover,
  type CustomRoundType,
} from '@tumble/content/custom';
import { RoundDefinitionSchema, type RoundDefinitionInput, type Vec3 } from '@tumble/shared';
/** Static piece as stored. */
export type Piece = RoundDefinitionInput['geometry'][number];
/** Obstacle as stored. */
export type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];
/** Trigger as stored. */
export type Trigger = NonNullable<RoundDefinitionInput['triggers']>[number];

/** What a selection or issue points at. */
export type ItemRef =
  | { kind: 'geometry'; index: number }
  | { kind: 'obstacle'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'spawn' };

/** Stable string form of a ref (selection sets, React keys). */
export function refKey(ref: ItemRef): string {
  switch (ref.kind) {
    case 'geometry':
      return `g:${ref.index}`;
    case 'obstacle':
      return `o:${ref.id}`;
    case 'trigger':
      return `t:${ref.id}`;
    case 'spawn':
      return 'spawn';
  }
}

/** True when two refs name the same item. */
export const sameRef = (a: ItemRef, b: ItemRef): boolean => refKey(a) === refKey(b);

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const addV = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const r2 = (n: number) => Math.round(n * 100) / 100;
const roundV = (p: Vec3): Vec3 => v(r2(p.x), r2(p.y), r2(p.z));

/**
 * Snaps a value to a grid step (0 = no snapping).
 *
 * @example
 * snap(3.4, 0.5); // 3.5
 */
export function snap(value: number, step: number): number {
  return step > 0 ? r2(Math.round(value / step) * step) : r2(value);
}

/** Position of an item (the spawn's origin for the spawn). */
export function itemPosition(round: RoundDefinitionInput, ref: ItemRef): Vec3 | null {
  switch (ref.kind) {
    case 'geometry':
      return round.geometry[ref.index]?.position ?? null;
    case 'obstacle':
      return round.obstacles?.find((o) => o.id === ref.id)?.position ?? null;
    case 'trigger':
      return round.triggers?.find((t) => t.id === ref.id)?.position ?? null;
    case 'spawn':
      return round.spawn.origin;
  }
}

/** Whether a ref still names something in the round. */
export function refExists(round: RoundDefinitionInput, ref: ItemRef): boolean {
  return itemPosition(round, ref) !== null;
}

/** A fresh id with `prefix`, unique among obstacles and triggers. */
export function uniqueId(round: RoundDefinitionInput, prefix: string): string {
  const taken = new Set([
    ...(round.obstacles ?? []).map((o) => o.id),
    ...(round.triggers ?? []).map((t) => t.id),
  ]);
  for (let i = 1; ; i++) {
    const id = `${prefix}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Adds a level part (static piece preset) whose top sits at `at.y`.
 *
 * @returns The new round and the new piece's ref.
 */
export function addPart(
  round: RoundDefinitionInput,
  partId: string,
  at: Vec3,
): { round: RoundDefinitionInput; ref: ItemRef } {
  const part = LEVEL_PARTS.find((p) => p.id === partId) ?? LEVEL_PARTS[0]!;
  const h = part.piece.shape === 'sphere' ? part.piece.size.x : part.piece.size.y / 2;
  const piece: Piece = { ...structuredClone(part.piece), position: roundV(v(at.x, at.y - h, at.z)) };
  return {
    round: { ...round, geometry: [...round.geometry, piece] },
    ref: { kind: 'geometry', index: round.geometry.length },
  };
}

/** Adds an obstacle with default params at a floor point. */
export function addObstacle(
  round: RoundDefinitionInput,
  type: string,
  at: Vec3,
): { round: RoundDefinitionInput; ref: ItemRef } {
  const id = uniqueId(
    round,
    type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
  );
  const o: Obstacle = { id, type, position: roundV(at), params: {} };
  return { round: { ...round, obstacles: [...(round.obstacles ?? []), o] }, ref: { kind: 'obstacle', id } };
}

/** Course markers the palette places. */
export type MarkerKind = 'checkpoint' | 'finish' | 'void';

/**
 * Places a course marker: a checkpoint (trigger, gate arch and respawn row),
 * a finish (trigger and arch) or a fall-out void volume.
 *
 * @returns The new round and refs of everything placed (selected together so they move as one).
 */
export function addMarker(
  round: RoundDefinitionInput,
  kind: MarkerKind,
  at: Vec3,
): { round: RoundDefinitionInput; refs: ItemRef[] } {
  const triggers = round.triggers ?? [];
  const obstacles = round.obstacles ?? [];
  const p = roundV(at);
  if (kind === 'void') {
    const id = uniqueId(round, 'void');
    const t: Trigger = { id, kind: 'void', position: v(p.x, p.y, p.z), size: v(20, 4, 20) };
    return { round: { ...round, triggers: [...triggers, t] }, refs: [{ kind: 'trigger', id }] };
  }
  if (kind === 'finish') {
    const id = uniqueId(round, 'finish');
    const arch = uniqueId({ ...round, triggers: [...triggers, { id } as Trigger] }, 'finish-arch');
    const t: Trigger = { id, kind: 'finish', position: v(p.x, p.y + 2, p.z), size: v(14, 4, 3) };
    const o: Obstacle = { id: arch, type: 'finishLine', position: p, params: { width: 14 } };
    return {
      round: { ...round, triggers: [...triggers, t], obstacles: [...obstacles, o] },
      refs: [
        { kind: 'trigger', id },
        { kind: 'obstacle', id: arch },
      ],
    };
  }
  const index =
    triggers.filter((t) => t.kind === 'checkpoint').reduce((m, t) => Math.max(m, t.index ?? 0), 0) + 1;
  const id = uniqueId(round, 'cp');
  const gate = `${id}-gate`;
  const t: Trigger = {
    id,
    kind: 'checkpoint',
    index,
    position: v(p.x, p.y + 2, p.z),
    size: v(10, 4, 2),
    respawn: [-3, 0, 3].map((dx) => v(r2(p.x + dx), r2(p.y + 0.1), r2(p.z + 2.5))),
  };
  const o: Obstacle = { id: gate, type: 'checkpointGate', position: p, params: { index, width: 10 } };
  return {
    round: { ...round, triggers: [...triggers, t], obstacles: [...obstacles, o] },
    refs: [
      { kind: 'trigger', id },
      { kind: 'obstacle', id: gate },
    ],
  };
}

/** Moves items by `delta` (checkpoint respawn points travel with their trigger). */
export function moveItems(
  round: RoundDefinitionInput,
  refs: readonly ItemRef[],
  delta: Vec3,
): RoundDefinitionInput {
  const keys = new Set(refs.map(refKey));
  const has = (r: ItemRef) => keys.has(refKey(r));
  return {
    ...round,
    geometry: round.geometry.map((g, index) =>
      has({ kind: 'geometry', index }) ? { ...g, position: roundV(addV(g.position, delta)) } : g,
    ),
    obstacles: (round.obstacles ?? []).map((o) =>
      has({ kind: 'obstacle', id: o.id }) ? { ...o, position: roundV(addV(o.position, delta)) } : o,
    ),
    triggers: (round.triggers ?? []).map((t) =>
      has({ kind: 'trigger', id: t.id })
        ? {
            ...t,
            position: roundV(addV(t.position, delta)),
            respawn: (t.respawn ?? []).map((p) => roundV(addV(p, delta))),
          }
        : t,
    ),
    spawn: has({ kind: 'spawn' })
      ? { ...round.spawn, origin: roundV(addV(round.spawn.origin, delta)) }
      : round.spawn,
  };
}

const wrapDeg = (d: number) => {
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : r2(w);
};

/**
 * Turns items about the vertical axis through `pivot` by `deg`: positions
 * orbit the pivot and each item's yaw turns with it.
 */
export function rotateItems(
  round: RoundDefinitionInput,
  refs: readonly ItemRef[],
  deg: number,
  pivot: Vec3,
): RoundDefinitionInput {
  const keys = new Set(refs.map(refKey));
  const has = (r: ItemRef) => keys.has(refKey(r));
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // Yaw turns +Z toward +X, so a point turns the same way.
  const orbit = (p: Vec3): Vec3 => {
    const dx = p.x - pivot.x;
    const dz = p.z - pivot.z;
    return roundV(v(pivot.x + dx * c + dz * s, p.y, pivot.z - dx * s + dz * c));
  };
  const turn = <T extends { position: Vec3; rotation?: { yaw?: number; pitch?: number; roll?: number } }>(
    x: T,
  ): T => ({
    ...x,
    position: orbit(x.position),
    rotation: { ...x.rotation, yaw: wrapDeg((x.rotation?.yaw ?? 0) + deg) },
  });
  return {
    ...round,
    geometry: round.geometry.map((g, index) => (has({ kind: 'geometry', index }) ? turn(g) : g)),
    obstacles: (round.obstacles ?? []).map((o) => (has({ kind: 'obstacle', id: o.id }) ? turn(o) : o)),
    triggers: (round.triggers ?? []).map((t) =>
      has({ kind: 'trigger', id: t.id })
        ? {
            ...turn(t),
            respawn: (t.respawn ?? []).map(orbit),
            respawnYaw: wrapDeg((t.respawnYaw ?? 0) + deg),
          }
        : t,
    ),
    spawn: has({ kind: 'spawn' })
      ? { ...round.spawn, origin: orbit(round.spawn.origin), yaw: wrapDeg((round.spawn.yaw ?? 0) + deg) }
      : round.spawn,
  };
}

/** Scales the size of pieces and triggers by per-axis factors (obstacles size through their params). */
export function scaleItems(
  round: RoundDefinitionInput,
  refs: readonly ItemRef[],
  factor: Vec3,
): RoundDefinitionInput {
  const keys = new Set(refs.map(refKey));
  const has = (r: ItemRef) => keys.has(refKey(r));
  const scale = (s: Vec3): Vec3 =>
    v(
      Math.max(0.1, r2(s.x * factor.x)),
      Math.max(0.1, r2(s.y * factor.y)),
      Math.max(0.1, r2(s.z * factor.z)),
    );
  return {
    ...round,
    geometry: round.geometry.map((g, index) =>
      has({ kind: 'geometry', index }) ? { ...g, size: scale(g.size) } : g,
    ),
    triggers: (round.triggers ?? []).map((t) =>
      has({ kind: 'trigger', id: t.id }) ? { ...t, size: scale(t.size) } : t,
    ),
  };
}

/** Removes items (the spawn cannot be removed). */
export function deleteItems(round: RoundDefinitionInput, refs: readonly ItemRef[]): RoundDefinitionInput {
  const keys = new Set(refs.map(refKey));
  return {
    ...round,
    geometry: round.geometry.filter((_, index) => !keys.has(refKey({ kind: 'geometry', index }))),
    obstacles: (round.obstacles ?? []).filter((o) => !keys.has(refKey({ kind: 'obstacle', id: o.id }))),
    triggers: (round.triggers ?? []).filter((t) => !keys.has(refKey({ kind: 'trigger', id: t.id }))),
  };
}

/** Copied items, positions kept (paste offsets them). */
export interface Clipboard {
  pieces: Piece[];
  obstacles: Obstacle[];
  triggers: Trigger[];
}

/** Copies the selected items (the spawn is not copyable). */
export function copyItems(round: RoundDefinitionInput, refs: readonly ItemRef[]): Clipboard {
  const keys = new Set(refs.map(refKey));
  return structuredClone({
    pieces: round.geometry.filter((_, index) => keys.has(refKey({ kind: 'geometry', index }))),
    obstacles: (round.obstacles ?? []).filter((o) => keys.has(refKey({ kind: 'obstacle', id: o.id }))),
    triggers: (round.triggers ?? []).filter((t) => keys.has(refKey({ kind: 'trigger', id: t.id }))),
  });
}

/**
 * Pastes a clipboard with fresh ids, offset by `offset`. Checkpoints get the
 * next free numbers, and a gate pasted with its checkpoint follows it.
 *
 * @returns The new round and refs of the pasted items.
 */
export function pasteItems(
  round: RoundDefinitionInput,
  clip: Clipboard,
  offset: Vec3,
): { round: RoundDefinitionInput; refs: ItemRef[] } {
  let next: RoundDefinitionInput = { ...round };
  const refs: ItemRef[] = [];
  const geometry = [...next.geometry];
  for (const p of clip.pieces) {
    geometry.push({ ...structuredClone(p), position: roundV(addV(p.position, offset)) });
    refs.push({ kind: 'geometry', index: geometry.length - 1 });
  }
  next = { ...next, geometry };
  const renamed = new Map<string, string>();
  const indexMap = new Map<number, number>();
  let cpIndex = (next.triggers ?? [])
    .filter((t) => t.kind === 'checkpoint')
    .reduce((m, t) => Math.max(m, t.index ?? 0), 0);
  for (const t of clip.triggers) {
    const id = uniqueId(next, t.kind === 'checkpoint' ? 'cp' : t.kind);
    renamed.set(t.id, id);
    const copy: Trigger = {
      ...structuredClone(t),
      id,
      position: roundV(addV(t.position, offset)),
      respawn: (t.respawn ?? []).map((p) => roundV(addV(p, offset))),
    };
    if (t.kind === 'checkpoint') {
      indexMap.set(t.index ?? 0, ++cpIndex);
      copy.index = cpIndex;
    }
    next = { ...next, triggers: [...(next.triggers ?? []), copy] };
    refs.push({ kind: 'trigger', id });
  }
  for (const o of clip.obstacles) {
    const id = uniqueId(
      next,
      o.type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    );
    const params = structuredClone(o.params ?? {}) as Record<string, unknown>;
    if (o.type === 'checkpointGate' && typeof params.index === 'number' && indexMap.has(params.index))
      params.index = indexMap.get(params.index);
    next = {
      ...next,
      obstacles: [
        ...(next.obstacles ?? []),
        { ...structuredClone(o), id, params, position: roundV(addV(o.position, offset)) },
      ],
    };
    refs.push({ kind: 'obstacle', id });
  }
  return { round: next, refs };
}

/** Replaces one static piece's fields. */
export function updatePiece(
  round: RoundDefinitionInput,
  index: number,
  patch: Partial<Piece>,
): RoundDefinitionInput {
  return { ...round, geometry: round.geometry.map((g, i) => (i === index ? { ...g, ...patch } : g)) };
}

/** Replaces one obstacle's fields. */
export function updateObstacle(
  round: RoundDefinitionInput,
  id: string,
  patch: Partial<Obstacle>,
): RoundDefinitionInput {
  return { ...round, obstacles: (round.obstacles ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

/**
 * Sets (or with `undefined`, resets to its default) one obstacle param.
 * Only changed params are stored, so files stay small and pick up module
 * default changes.
 */
export function setObstacleParam(
  round: RoundDefinitionInput,
  id: string,
  key: string,
  value: unknown,
): RoundDefinitionInput {
  return {
    ...round,
    obstacles: (round.obstacles ?? []).map((o) => {
      if (o.id !== id) return o;
      const params = { ...(o.params ?? {}) } as Record<string, unknown>;
      if (value === undefined) delete params[key];
      else params[key] = value;
      return { ...o, params };
    }),
  };
}

/** Replaces one trigger's fields. */
export function updateTrigger(
  round: RoundDefinitionInput,
  id: string,
  patch: Partial<Trigger>,
): RoundDefinitionInput {
  return { ...round, triggers: (round.triggers ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/**
 * Switches the round type, keeping the qualification mode, fall behaviour
 * and score target consistent with it.
 */
export function setRoundType(round: RoundDefinitionInput, type: CustomRoundType): RoundDefinitionInput {
  const mode = CUSTOM_MODE_BY_TYPE[type];
  const { scoreGoal: _goal, ...q } = round.qualification;
  return {
    ...round,
    type,
    qualification: {
      ...q,
      mode,
      teams: 0,
      ...(type === 'hunt' ? { scoreGoal: round.qualification.scoreGoal ?? 5 } : {}),
    },
    fallBehavior:
      type === 'race'
        ? 'respawnCheckpoint'
        : type === 'hunt'
          ? (round.fallBehavior ?? 'respawnCheckpoint')
          : 'eliminate',
  };
}

/**
 * Fields the editor keeps in step with the content: `bounds` around
 * everything (with the margins LEVELS.md §1.6 asks for), the intro flyover,
 * the player range and the custom-round invariants.
 *
 * @param round - Round as edited.
 * @returns The round to validate, save, test play or publish.
 */
export function finalizeRound(round: RoundDefinitionInput): RoundDefinitionInput {
  const pts: Vec3[] = [round.spawn.origin];
  const grow = (p: Vec3, h: Vec3) => {
    pts.push(v(p.x - h.x, p.y - h.y, p.z - h.z), v(p.x + h.x, p.y + h.y, p.z + h.z));
  };
  for (const g of round.geometry) grow(g.position, v(g.size.x, g.size.y, g.size.z));
  for (const o of round.obstacles ?? []) grow(o.position, v(12, 6, 12));
  for (const t of round.triggers ?? [])
    if (t.kind !== 'void') grow(t.position, v(t.size.x / 2, t.size.y / 2, t.size.z / 2));
  const half = ((round.spawn.cols ?? 8) * (round.spawn.spacing ?? 1.4)) / 2 + 2;
  grow(round.spawn.origin, v(half, 2, half * 1.5));
  const min = v(
    Math.min(...pts.map((p) => p.x)),
    Math.min(...pts.map((p) => p.y)),
    Math.min(...pts.map((p) => p.z)),
  );
  const max = v(
    Math.max(...pts.map((p) => p.x)),
    Math.max(...pts.map((p) => p.y)),
    Math.max(...pts.map((p) => p.z)),
  );
  const killY = round.killY ?? -20;
  const bounds = {
    min: v(Math.floor(min.x - 10), Math.floor(Math.min(min.y, killY) - 5), Math.floor(min.z - 10)),
    max: v(Math.ceil(max.x + 10), Math.ceil(max.y + 25), Math.ceil(max.z + 10)),
  };
  const next: RoundDefinitionInput = {
    ...round,
    players: { ...CUSTOM_ROUND_PLAYERS },
    bounds,
    variations: [],
  };
  delete next.rulesCard;
  const parsed = RoundDefinitionSchema.safeParse(next);
  return parsed.success ? { ...next, flyover: autoFlyover(parsed.data) } : next;
}
