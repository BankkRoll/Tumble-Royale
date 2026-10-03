/**
 * Door Gauntlet — rows of identical-looking doors across the course (rows
 * advance along local +Z). Some doors are fake and burst when a player runs
 * into them; the rest are solid and bonk players back. The fake/solid layout
 * comes from the instance's seeded Rng, so every machine agrees on it without
 * replication; only "which fake doors are already broken" is replicated.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import { SIM_DT, rotateVec, vec3, type Rng, type Vec3 } from '@tumble/shared';
import { ActorCooldown, ObstacleGroups, RuntimeBase, actorLocal, knockByMotion } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

/** Door gauntlet parameters. */
export const doorGauntletSchema = z.object({
  rows: z.number().int().min(1).max(12).default(4),
  doorsPerRow: z.number().int().min(2).max(12).default(5),
  /** Fake (breakable) doors per row; clamped to [1, doorsPerRow − 1]. */
  fakePerRow: z.number().int().min(1).default(3),
  doorWidth: z.number().positive().default(2.2),
  doorHeight: z.number().positive().default(3.2),
  doorThickness: z.number().positive().default(0.35),
  /** Post width between doors (m). */
  postWidth: z.number().positive().default(0.5),
  /** Distance between rows along +Z (m). */
  rowSpacing: z.number().positive().default(6),
  /** Height of the frame (posts + lintel) (m). */
  wallHeight: z.number().positive().default(4.2),
  /** Bounce-back speed off solid doors (m/s). */
  solidKnock: z.number().min(0).default(4),
  /** Seconds before a broken door reappears; 0 = never. */
  resetAfter: z.number().min(0).default(0),
});

/** Validated door gauntlet params. */
export type DoorGauntletParams = z.output<typeof doorGauntletSchema>;

/** Runtime state the visual reads (no fake/solid info — the look must not leak it). */
export interface DoorGauntletView extends ObstacleRuntime {
  readonly doorCount: number;
  /** 1 = broken (open), per door, row-major. */
  readonly doorBroken: Uint8Array;
  /** Match time each door broke (valid while broken). */
  readonly doorBrokenTime: Float32Array;
}

/** Fake doors actually used per row after clamping. */
export const doorFakeCount = (p: DoorGauntletParams): number => Math.max(1, Math.min(p.doorsPerRow - 1, p.fakePerRow));

/**
 * Chooses which doors are fake. Consumes the Rng in a fixed order, so equal
 * seeds give equal layouts everywhere.
 *
 * @param p - Params.
 * @param rng - The instance's seeded generator.
 * @returns Row-major flags, 1 = fake.
 */
export function doorGauntletLayout(p: DoorGauntletParams, rng: Rng): Uint8Array {
  const out = new Uint8Array(p.rows * p.doorsPerRow);
  const order: number[] = [];
  const fakes = doorFakeCount(p);
  for (let r = 0; r < p.rows; r++) {
    order.length = 0;
    for (let c = 0; c < p.doorsPerRow; c++) order.push(c);
    rng.shuffle(order);
    for (let k = 0; k < fakes; k++) out[r * p.doorsPerRow + order[k]!] = 1;
  }
  return out;
}

/** Local X of door column `col`. */
export const doorX = (col: number, p: DoorGauntletParams): number =>
  (col - (p.doorsPerRow - 1) / 2) * (p.doorWidth + p.postWidth);

/** Local Z of row `row`. */
export const doorRowZ = (row: number, p: DoorGauntletParams): number => row * p.rowSpacing;

/** Ticks-since-break saturate here when packed (≈ 4.5 minutes at 60 Hz). */
const MAX_PACKED_TICKS = 16383;

/** Door gauntlet runtime. `layout` is public for tests and bots. */
export class DoorGauntletRuntime extends RuntimeBase implements DoorGauntletView {
  readonly doorCount: number;
  readonly doorBroken: Uint8Array;
  readonly doorBrokenTime: Float32Array;
  /** 1 = fake door, row-major. */
  readonly layout: Uint8Array;
  private readonly doorColliders: Collider[] = [];
  private readonly doorByCollider = new Map<number, number>();
  private readonly cooldown = new ActorCooldown();
  private readonly forward: Vec3;
  private readonly scratch = vec3();
  private readonly backAxis = vec3();

  constructor(
    instance: ObstacleInstance<DoorGauntletParams>,
    ctx: ObstacleBuildContext,
    private readonly p: DoorGauntletParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.layout = doorGauntletLayout(p, ctx.rng);
    this.doorCount = p.rows * p.doorsPerRow;
    this.doorBroken = new Uint8Array(this.doorCount);
    this.doorBrokenTime = new Float32Array(this.doorCount);
    this.forward = rotateVec(this.frame.rot, vec3(0, 0, 1), vec3());

    const body = this.addBody(R.RigidBodyDesc.fixed());
    const pitch = p.doorWidth + p.postWidth;
    const lintelH = p.wallHeight - p.doorHeight;
    for (let r = 0; r < p.rows; r++) {
      const z = doorRowZ(r, p);
      for (let c = 0; c <= p.doorsPerRow; c++) {
        const x = (c - p.doorsPerRow / 2) * pitch;
        this.addCollider(
          R.ColliderDesc.cuboid(p.postWidth / 2, p.wallHeight / 2, p.doorThickness / 2 + 0.1)
            .setTranslation(x, p.wallHeight / 2, z)
            .setCollisionGroups(ObstacleGroups.static),
          body,
        );
      }
      if (lintelH > 0.01) {
        this.addCollider(
          R.ColliderDesc.cuboid((p.doorsPerRow * pitch + p.postWidth) / 2, lintelH / 2, p.doorThickness / 2 + 0.1)
            .setTranslation(0, p.doorHeight + lintelH / 2, z)
            .setCollisionGroups(ObstacleGroups.static),
          body,
        );
      }
      for (let c = 0; c < p.doorsPerRow; c++) {
        const door = this.addCollider(
          R.ColliderDesc.cuboid(p.doorWidth / 2, p.doorHeight / 2, p.doorThickness / 2)
            .setTranslation(doorX(c, p), p.doorHeight / 2, z)
            .setCollisionGroups(ObstacleGroups.static),
          body,
        );
        this.doorByCollider.set(door.handle, this.doorColliders.length);
        this.doorColliders.push(door);
      }
    }
  }

  update(ctx: ObstacleStepContext): void {
    if (this.p.resetAfter > 0) {
      for (let i = 0; i < this.doorCount; i++) {
        if (this.doorBroken[i] && ctx.t - this.doorBrokenTime[i]! >= this.p.resetAfter) this.setBroken(i, false, 0);
      }
    }
    this.endStep(ctx);
  }

  /** Breaks fake door `i` (no-op for solid or already broken doors). */
  breakDoor(i: number, t: number, ctx?: ObstacleStepContext): boolean {
    if (!this.layout[i] || this.doorBroken[i]) return false;
    this.setBroken(i, true, t);
    if (ctx) {
      const row = Math.floor(i / this.p.doorsPerRow);
      const col = i % this.p.doorsPerRow;
      this.cue(ctx.events, 'doorBreak', doorX(col, this.p), this.p.doorHeight / 2, doorRowZ(row, this.p));
    }
    return true;
  }

  private setBroken(i: number, broken: boolean, t: number): void {
    this.doorBroken[i] = broken ? 1 : 0;
    this.doorBrokenTime[i] = t;
    this.doorColliders[i]?.setEnabled(!broken);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const i = this.doorByCollider.get(collider.handle);
    if (i === undefined || actor.isGhost) return;
    if (this.breakDoor(i, ctx.t, ctx)) return;
    if (this.layout[i] || this.p.solidKnock <= 0) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.6)) return;
    const row = Math.floor(i / this.p.doorsPerRow);
    const local = actorLocal(this.frame, actor, this.scratch);
    const side = local.z < doorRowZ(row, this.p) ? -1 : 1;
    this.backAxis.x = this.forward.x * side;
    this.backAxis.y = 0;
    this.backAxis.z = this.forward.z * side;
    knockByMotion(actor, collider.parent()!, { speed: this.p.solidKnock, lift: 2, stun: false, axis: this.backAxis });
    this.cue(ctx.events, 'doorBonk', local.x, local.y, local.z);
  }

  /** One int per door: 0 intact, else `1 + 2·ticksSinceBreak` (saturating). */
  getNetState(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.doorCount; i++) {
      if (!this.doorBroken[i]) {
        out[i] = 0;
        continue;
      }
      const ticks = Math.min(MAX_PACKED_TICKS, Math.max(0, Math.round((this.lastT - this.doorBrokenTime[i]!) / SIM_DT)));
      out[i] = 1 + 2 * ticks;
    }
    return out;
  }

  setNetState(state: readonly number[]): void {
    for (let i = 0; i < this.doorCount; i++) {
      const v = state[i] ?? 0;
      const broken = (v & 1) === 1;
      if (broken) {
        const t = (Number.isNaN(this.lastT) ? 0 : this.lastT) - (v >>> 1) * SIM_DT;
        if (!this.doorBroken[i]) this.setBroken(i, true, t);
        else this.doorBrokenTime[i] = t;
      } else if (this.doorBroken[i]) {
        this.setBroken(i, false, 0);
      }
    }
  }
}

/** Door gauntlet obstacle module. */
export const doorGauntlet: ObstacleModule<DoorGauntletParams> = {
  type: 'doorGauntlet',
  displayName: 'Door Dash',
  schema: doorGauntletSchema,
  create: (instance, ctx) => new DoorGauntletRuntime(instance, ctx, doorGauntletSchema.parse(instance.params)),
  audioCues: ['doorBreak', 'doorBonk'],
};
