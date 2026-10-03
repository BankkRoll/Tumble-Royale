/**
 * Prop Spawner — replicated gameplay props: eggs, beach balls, tails, the
 * Crown, keys and blocks.
 *
 * Responsibilities:
 * - Spawn props at authored points (dynamic Rapier bodies; floating kinds such
 *   as the Crown hover on a pure bob/spin pose until someone takes them).
 * - Ownership: a prop is carried by at most one player (`carrier`, which is the
 *   character's `grabTarget`). Carried props become kinematic sensors glued to
 *   the carrier so they never shove their owner, yet stay grabbable (tail steals).
 * - Respawn props that fall out of the world or sit abandoned too long.
 * - Replicate compactly via `getNetState`/`setNetState` (floats; the netcode
 *   quantises positions).
 *
 * Pickup is requested by the character/round code through
 * {@link PropSpawnerRuntime.pickup}; `autoPickup` kinds (keys) also pick up on touch.
 */
import type { Collider, ColliderDesc, RigidBody } from '@dimforge/rapier3d-compat';
import {
  InteractionGroups,
  quatFromYaw,
  quatIdentity,
  quatMul,
  rotateVec,
  vec3,
  type Quat,
  type Vec3,
} from '@tumble/shared';
import { z } from 'zod';
import type { EventSink } from '../events.ts';
import type { Rapier } from '../physics/rapier.ts';
import {
  DEG,
  PARK_Y,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  instanceFrame,
  toWorld,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleActor, ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

const LocalPoint = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Prop kinds. */
export const PROP_KINDS = ['egg', 'ball', 'tail', 'crown', 'key', 'block'] as const;

/** One prop kind. */
export type PropKind = (typeof PROP_KINDS)[number];

/** First prop id when `idBase` is left at its default; player ids stay below this. */
export const PROP_ID_BASE = 1000;

/** Prop Spawner parameters. Metres, seconds, degrees. Origin = spawner reference point. */
export const PropSpawnerSchema = z.object({
  kind: z.enum(PROP_KINDS).default('egg'),
  /** Spawn points, local space (prop rests/floats here). */
  points: z
    .array(LocalPoint)
    .min(1)
    .default([{ x: 0, y: 0, z: 0 }]),
  /** Props per point, arranged in a small ring around it. */
  perPoint: z.number().int().min(1).max(32).default(1),
  /**
   * Prop id of prop 0 (ids are `idBase + index`). Must be unique per round and
   * ≥ {@link PROP_ID_BASE} so ids never collide with player ids in `grabTarget`.
   */
  idBase: z.number().int().min(PROP_ID_BASE).default(PROP_ID_BASE),
  /** Team index for team-coloured props (eggs), -1 = neutral. */
  team: z.number().int().min(-1).max(3).default(-1),
  /** Size multiplier on the kind's default dimensions. */
  scale: z.number().positive().default(1),
  /** Hover + spin at the spawn point until taken (default: crown and key). */
  floating: z.boolean().optional(),
  bobHeight: z.number().min(0).default(0.3),
  bobPeriod: z.number().positive().default(2.4),
  /** Hover spin in degrees/second. */
  spinSpeed: z.number().default(70),
  /** Pick up on touch instead of needing a grab (default: key only). */
  autoPickup: z.boolean().optional(),
  /** Props below this local Y respawn. */
  respawnBelow: z.number().default(-25),
  /** Seconds hidden before a respawning prop reappears. */
  respawnDelay: z.number().min(0).default(2),
  /** Respawn props left uncarried away from home this long (0 = never). */
  idleRespawn: z.number().min(0).default(0),
});

/** Validated Prop Spawner parameters. */
export type PropSpawnerParams = z.output<typeof PropSpawnerSchema>;

/** Per-kind physical and carry defaults. Dimensions are multiplied by `scale`. */
export interface PropKindSpec {
  /** Characteristic radius / half-size used by visuals and colliders. */
  size: number;
  density: number;
  restitution: number;
  /** Carry offset from the carrier's body centre, carrier-local (+Z forward). */
  carry: Vec3;
  carryable: boolean;
  floating: boolean;
  autoPickup: boolean;
}

/** Defaults per prop kind. */
export const PROP_SPECS: Readonly<Record<PropKind, PropKindSpec>> = {
  egg: {
    size: 0.42,
    density: 0.6,
    restitution: 0.3,
    carry: vec3(0, 1.35, 0.2),
    carryable: true,
    floating: false,
    autoPickup: false,
  },
  ball: {
    size: 1.6,
    density: 0.04,
    restitution: 0.75,
    carry: vec3(0, 2.4, 0),
    carryable: false,
    floating: false,
    autoPickup: false,
  },
  tail: {
    size: 0.5,
    density: 0.3,
    restitution: 0.2,
    carry: vec3(0, 0.15, -0.55),
    carryable: true,
    floating: false,
    autoPickup: false,
  },
  crown: {
    size: 0.55,
    density: 0.5,
    restitution: 0.2,
    carry: vec3(0, 1.55, 0),
    carryable: true,
    floating: true,
    autoPickup: false,
  },
  key: {
    size: 0.45,
    density: 0.5,
    restitution: 0.3,
    carry: vec3(0, 1.45, 0),
    carryable: true,
    floating: true,
    autoPickup: true,
  },
  block: {
    size: 0.6,
    density: 0.4,
    restitution: 0.1,
    carry: vec3(0, 1.6, 0.25),
    carryable: true,
    floating: false,
    autoPickup: false,
  },
};

/** Prop lifecycle modes (replicated). */
export const PropMode = { Home: 0, Free: 1, Carried: 2, Respawning: 3 } as const;

/** Numeric prop mode id. */
export type PropModeId = (typeof PropMode)[keyof typeof PropMode];

/**
 * Floats per prop in the net state: mode, carrier, timer, px, py, pz, qx, qy,
 * qz, qw, vx, vy, vz. The array starts with the prop count.
 */
export const PROP_NET_STRIDE = 13;

/** Total props a spawner creates. */
export const propCount = (p: PropSpawnerParams): number => p.points.length * p.perPoint;

/** Resolved `floating` flag. */
export const propFloats = (p: PropSpawnerParams): boolean => p.floating ?? PROP_SPECS[p.kind].floating;

/** Local home position of prop `i` (ring around its point; floating props hover 1 m up). */
export function propHomeLocal(p: PropSpawnerParams, i: number, out: Vec3): Vec3 {
  const pt = p.points[Math.floor(i / p.perPoint)]!;
  const j = i % p.perPoint;
  const spec = PROP_SPECS[p.kind];
  const ring = p.perPoint > 1 ? spec.size * p.scale * 1.4 * Math.max(1, p.perPoint / 4) : 0;
  const a = (j / p.perPoint) * Math.PI * 2;
  out.x = pt.x + Math.cos(a) * ring;
  out.y = pt.y + (propFloats(p) ? 1 : spec.size * p.scale + 0.05);
  out.z = pt.z + Math.sin(a) * ring;
  return out;
}

const qSpin = quatIdentity();

/**
 * Pure pose of props sitting at home: floating kinds bob and spin; others rest.
 * One sample per prop, local space.
 */
export function propSpawnerPose(
  t: number,
  p: PropSpawnerParams,
  out: PoseSample[],
  _speedScale: number,
): void {
  const n = propCount(p);
  ensurePoseSamples(out, n);
  const floats = propFloats(p);
  for (let i = 0; i < n; i++) {
    const s = out[i] as PoseSample;
    propHomeLocal(p, i, s.pos);
    if (floats) {
      // Per-prop phase offset keeps a pile of keys from bobbing in lockstep.
      const ph = i * 1.7;
      s.pos.y += p.bobHeight * Math.sin((t * Math.PI * 2) / p.bobPeriod + ph);
      quatFromYaw((p.spinSpeed * t + i * 40) * DEG, qSpin);
      writeSample(s, s.pos.x, s.pos.y, s.pos.z, qSpin);
    } else {
      s.rot.x = 0;
      s.rot.y = 0;
      s.rot.z = 0;
      s.rot.w = 1;
    }
  }
}

/** Collider for a prop kind at a scale. */
export function propColliderDesc(R: Rapier, kind: PropKind, scale: number): ColliderDesc {
  const s = PROP_SPECS[kind].size * scale;
  switch (kind) {
    case 'egg':
      return R.ColliderDesc.capsule(s * 0.3, s * 0.85);
    case 'ball':
      return R.ColliderDesc.ball(s);
    case 'tail':
      return R.ColliderDesc.capsule(s * 0.5, s * 0.3);
    case 'crown':
      return R.ColliderDesc.cylinder(s * 0.45, s);
    case 'key':
      return R.ColliderDesc.cuboid(s * 0.3, s, s * 0.12);
    default:
      return R.ColliderDesc.cuboid(s, s, s);
  }
}

/** Live prop spawner, with the ownership API used by characters and round rules. */
export interface PropSpawnerRuntime extends ObstacleRuntime {
  readonly kind: PropKind;
  readonly propCount: number;
  /** Prop id (for `grabTarget`, events) of prop index `i`. */
  propId(i: number): number;
  /** Index of a prop id owned by this spawner, or -1. */
  indexOfPropId(id: number): number;
  /** Index of the prop owning a collider handle, or -1 (grab queries hit colliders). */
  indexOfCollider(handle: number): number;
  mode(i: number): PropModeId;
  /** Player id carrying prop `i`, or -1. */
  carrier(i: number): number;
  /** Index of the prop a player carries here, or -1. */
  carriedBy(playerId: number): number;
  /**
   * Gives prop `i` to `actor`.
   *
   * @param steal - Take it even if someone else carries it (tail grabs).
   * @returns True if the actor now carries it.
   */
  pickup(i: number, actor: ObstacleActor, events: EventSink, steal?: boolean): boolean;
  /**
   * Releases prop `i` where it is, optionally throwing it.
   *
   * @param velocity - World velocity to launch with (defaults to the carrier's).
   */
  drop(i: number, events: EventSink, velocity?: Vec3): void;
  /** Drops whatever `playerId` carries (stunned, eliminated, disconnected). */
  dropAllFrom(playerId: number, events: EventSink): void;
  /** Sends prop `i` back home immediately (or after the respawn delay when `delayed`). */
  respawn(i: number, delayed: boolean): void;
  /** World transform of prop `i` right now. */
  getTransform(i: number, outPos: Vec3, outRot: Quat): void;
}

/** Prop Spawner obstacle module. */
export const propSpawner: ObstacleModule<PropSpawnerParams> = {
  type: 'propSpawner',
  displayName: 'Prop Spawner',
  schema: PropSpawnerSchema,
  audioCues: ['propPickup', 'propDrop', 'propRespawn', 'crownGrab'],
  pose: propSpawnerPose,
  create(instance, ctx): PropSpawnerRuntime {
    const p = PropSpawnerSchema.parse(instance.params);
    const { R, world } = ctx;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const spec = PROP_SPECS[p.kind];
    const n = propCount(p);
    const floats = propFloats(p);
    const auto = p.autoPickup ?? spec.autoPickup;
    const carryOffset = vec3(spec.carry.x * p.scale, spec.carry.y, spec.carry.z * p.scale);
    const killY = frame.pos.y + p.respawnBelow;

    const bodies: RigidBody[] = [];
    const colliders: Collider[] = [];
    const indexByHandle = new Map<number, number>();
    const modes = new Uint8Array(n);
    const carriers = new Int32Array(n).fill(-1);
    const timers = new Float64Array(n);
    const home: Vec3[] = [];
    const homeSamples: PoseSample[] = [];
    ensurePoseSamples(homeSamples, n);
    const wp = vec3();
    const wq = quatIdentity();

    for (let i = 0; i < n; i++) {
      const h = propHomeLocal(p, i, vec3());
      const w = vec3();
      toWorld(frame, h, null, w, null);
      home.push(w);
      const body = bag.adoptBody(
        world.createRigidBody(
          (floats ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic())
            .setTranslation(w.x, w.y, w.z)
            .setRotation(frame.rot)
            .setLinearDamping(p.kind === 'ball' ? 0.15 : 0.4)
            .setAngularDamping(0.6),
        ),
      );
      const c = bag.collider(
        propColliderDesc(R, p.kind, p.scale)
          .setDensity(spec.density)
          .setRestitution(spec.restitution)
          .setFriction(0.7)
          .setCollisionGroups(InteractionGroups.prop)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        body,
        { kind: p.kind === 'ball' ? 'bouncy' : 'normal', grabbable: spec.carryable, ownerId: instance.id },
      );
      bodies.push(body);
      colliders.push(c);
      indexByHandle.set(c.handle, i);
      modes[i] = floats ? PropMode.Home : PropMode.Free;
    }

    const setMode = (i: number, m: PropModeId): void => {
      const b = bodies[i]!;
      const c = colliders[i]!;
      modes[i] = m;
      const kinematic = m !== PropMode.Free;
      const want = kinematic ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Dynamic;
      if (b.bodyType() !== want) b.setBodyType(want, true);
      // Carried/hidden props must not shove their carrier; sensors stay grabbable.
      c.setSensor(m === PropMode.Carried || m === PropMode.Respawning);
      if (m !== PropMode.Carried) carriers[i] = -1;
    };

    const placeHome = (i: number, t: number): void => {
      propSpawnerPose(t, p, homeSamples, 1);
      const s = homeSamples[i]!;
      toWorld(frame, s.pos, s.rot, wp, wq);
      const b = bodies[i]!;
      b.setTranslation(wp, true);
      b.setRotation(wq, true);
      b.setLinvel(ZERO, true);
      b.setAngvel(ZERO, true);
      timers[i] = 0;
      setMode(i, floats ? PropMode.Home : PropMode.Free);
    };

    const findActor = (actors: readonly ObstacleActor[], id: number): ObstacleActor | undefined => {
      for (const a of actors) if (a.id === id) return a;
      return undefined;
    };

    const runtime: PropSpawnerRuntime = {
      instance,
      colliders: bag.colliders,
      kind: p.kind,
      propCount: n,
      propId: (i) => p.idBase + i,
      indexOfPropId: (id) => (id >= p.idBase && id < p.idBase + n ? id - p.idBase : -1),
      indexOfCollider: (h) => indexByHandle.get(h) ?? -1,
      mode: (i) => modes[i] as PropModeId,
      carrier: (i) => carriers[i] ?? -1,
      carriedBy(id) {
        for (let i = 0; i < n; i++) if (carriers[i] === id) return i;
        return -1;
      },
      pickup(i, actor, events, steal = false) {
        if (i < 0 || i >= n || !spec.carryable) return false;
        const m = modes[i];
        if (m === PropMode.Respawning) return false;
        const prev = carriers[i]!;
        if (m === PropMode.Carried) {
          if (prev === actor.id) return true;
          if (!steal) return false;
          events.push({ type: 'propDrop', player: prev, prop: p.idBase + i });
        }
        // One prop per hand: drop anything else this spawner gave the actor.
        const other = runtime.carriedBy(actor.id);
        if (other >= 0 && other !== i) runtime.drop(other, events);
        setMode(i, PropMode.Carried);
        carriers[i] = actor.id;
        timers[i] = 0;
        events.push({ type: 'propPickup', player: actor.id, prop: p.idBase + i });
        const pos = bodies[i]!.translation();
        emitCue(events, instance.id, p.kind === 'crown' ? 'crownGrab' : 'propPickup', pos);
        return true;
      },
      drop(i, events, velocity) {
        if (modes[i] !== PropMode.Carried) return;
        const who = carriers[i]!;
        setMode(i, PropMode.Free);
        const b = bodies[i]!;
        if (velocity) b.setLinvel(velocity, true);
        events.push({ type: 'propDrop', player: who, prop: p.idBase + i });
        emitCue(events, instance.id, 'propDrop', b.translation());
      },
      dropAllFrom(id, events) {
        for (let i = 0; i < n; i++) if (carriers[i] === id) runtime.drop(i, events);
      },
      respawn(i, delayed) {
        if (delayed && p.respawnDelay > 0) {
          setMode(i, PropMode.Respawning);
          timers[i] = p.respawnDelay;
          const b = bodies[i]!;
          wp.x = home[i]!.x;
          wp.y = PARK_Y - i * 3;
          wp.z = home[i]!.z;
          b.setTranslation(wp, true);
        } else placeHome(i, 0);
      },
      getTransform(i, outPos, outRot) {
        const b = bodies[i]!;
        const t = b.translation();
        const r = b.rotation();
        outPos.x = t.x;
        outPos.y = t.y;
        outPos.z = t.z;
        outRot.x = r.x;
        outRot.y = r.y;
        outRot.z = r.z;
        outRot.w = r.w;
      },
      update(sctx) {
        let homePosed = false;
        for (let i = 0; i < n; i++) {
          const b = bodies[i]!;
          switch (modes[i]) {
            case PropMode.Home: {
              if (!homePosed) {
                propSpawnerPose(sctx.t, p, homeSamples, 1);
                homePosed = true;
              }
              const s = homeSamples[i]!;
              toWorld(frame, s.pos, s.rot, wp, wq);
              b.setNextKinematicTranslation(wp);
              b.setNextKinematicRotation(wq);
              break;
            }
            case PropMode.Carried: {
              const a = findActor(sctx.actors, carriers[i]!);
              if (!a) {
                runtime.drop(i, sctx.events);
                break;
              }
              const cp = a.body.translation();
              const cr = a.body.rotation();
              rotateVec(cr, carryOffset, wp);
              wp.x += cp.x;
              wp.y += cp.y;
              wp.z += cp.z;
              b.setNextKinematicTranslation(wp);
              quatMul(cr, frame.rot, wq);
              b.setNextKinematicRotation(wq);
              break;
            }
            case PropMode.Respawning:
              timers[i] = (timers[i] ?? 0) - sctx.dt;
              if ((timers[i] ?? 0) <= 0) {
                placeHome(i, sctx.t);
                emitCue(sctx.events, instance.id, 'propRespawn', home[i]!);
              }
              break;
            default: {
              const pos = b.translation();
              if (pos.y < killY) {
                runtime.respawn(i, true);
                break;
              }
              if (p.idleRespawn > 0) {
                const h = home[i]!;
                const away =
                  Math.abs(pos.x - h.x) + Math.abs(pos.z - h.z) > 1.5 || Math.abs(pos.y - h.y) > 1.5;
                timers[i] = away ? (timers[i] ?? 0) + sctx.dt : 0;
                if ((timers[i] ?? 0) >= p.idleRespawn) runtime.respawn(i, true);
              }
            }
          }
        }
      },
      onContact(actor, collider, sctx) {
        if (!auto || actor.isGhost) return;
        const i = indexByHandle.get(collider.handle);
        if (i === undefined || modes[i] === PropMode.Carried) return;
        runtime.pickup(i, actor, sctx.events);
      },
      getNetState() {
        const out = new Array<number>(1 + n * PROP_NET_STRIDE);
        out[0] = n;
        for (let i = 0; i < n; i++) {
          const b = bodies[i]!;
          const o = 1 + i * PROP_NET_STRIDE;
          const t = b.translation();
          const r = b.rotation();
          const v = b.linvel();
          out[o] = modes[i]!;
          out[o + 1] = carriers[i]!;
          out[o + 2] = timers[i]!;
          out[o + 3] = t.x;
          out[o + 4] = t.y;
          out[o + 5] = t.z;
          out[o + 6] = r.x;
          out[o + 7] = r.y;
          out[o + 8] = r.z;
          out[o + 9] = r.w;
          out[o + 10] = v.x;
          out[o + 11] = v.y;
          out[o + 12] = v.z;
        }
        return out;
      },
      setNetState(state) {
        const count = Math.min(n, state[0] ?? 0);
        for (let i = 0; i < count; i++) {
          const o = 1 + i * PROP_NET_STRIDE;
          const m = (state[o] ?? 0) as PropModeId;
          setMode(i, m);
          carriers[i] = state[o + 1] ?? -1;
          timers[i] = state[o + 2] ?? 0;
          const b = bodies[i]!;
          wp.x = state[o + 3] ?? 0;
          wp.y = state[o + 4] ?? 0;
          wp.z = state[o + 5] ?? 0;
          wq.x = state[o + 6] ?? 0;
          wq.y = state[o + 7] ?? 0;
          wq.z = state[o + 8] ?? 0;
          wq.w = state[o + 9] ?? 1;
          b.setTranslation(wp, true);
          b.setRotation(wq, true);
          if (m === PropMode.Free) {
            wp.x = state[o + 10] ?? 0;
            wp.y = state[o + 11] ?? 0;
            wp.z = state[o + 12] ?? 0;
            b.setLinvel(wp, true);
          }
        }
      },
      dispose: () => bag.dispose(),
    };
    return runtime;
  },
};

const ZERO = { x: 0, y: 0, z: 0 };
