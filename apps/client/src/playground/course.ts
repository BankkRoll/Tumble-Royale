/**
 * The Tumbler test course: one floating island with a station for every
 * controller feature, plus side routes over the void.
 *
 * Responsibilities:
 * - Build matching visuals and Rapier colliders from simple primitives.
 * - Register gameplay surfaces (ice, conveyor, goo, bounce, slide, grabbable).
 * - Drive kinematic movers from pure pose functions of sim time, like real obstacles.
 * - Expose spawn point, kill plane and the carryable-prop lookup.
 *
 * Layout (top view, +Z away from the spawn camera):
 *   island x∈[-30,30] z∈[-20,40]; slopes + deck + slide ramp west; steps, stairs,
 *   ledge walls and boxes near spawn; ice / conveyor / goo east; bounce pad →
 *   high deck; rotating bar and pendulum mid-island; gaps 2/3.5/4.5/5.5 m off
 *   the west edge; spinning disc off the east edge; moving platform north to a
 *   second island with an elevator.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createToonMaterial } from '@tumble/render';
import {
  InteractionGroups,
  quatFromAxisAngle,
  quatFromYaw,
  quatMul,
  rotateVec,
  type Quat,
  type Vec3,
} from '@tumble/shared';
import type { Rapier, RigidBody, SurfaceInfo, SurfaceRegistry, World } from '@tumble/sim';
import { createLabel } from './labels.ts';

/** A kinematic obstacle whose pose is a pure function of time. */
export interface CourseMover {
  body: RigidBody;
  object: Object3D;
  pose(t: number, pos: Vec3, rot: Quat): void;
}

const COLORS = {
  island: '#8ef0c6',
  islandSide: '#ffb3d9',
  safe: '#5ce1e6',
  interact: '#ffd23f',
  danger: '#ff4f8b',
  dangerAlt: '#ff8a3d',
  purple: '#7c5cff',
  ice: '#d6f4ff',
  goo: '#9be15d',
  slide: '#ffa8e0',
  white: '#fff7fb',
};

const easeInOut = (u: number): number => u * u * (3 - 2 * u);

/** Ping-pong 0→1→0 with `hold` seconds paused at each end. */
function pingPong(t: number, travel: number, hold: number): number {
  const period = 2 * (travel + hold);
  const p = ((t % period) + period) % period;
  if (p < hold) return 0;
  if (p < hold + travel) return easeInOut((p - hold) / travel);
  if (p < 2 * hold + travel) return 1;
  return 1 - easeInOut((p - 2 * hold - travel) / travel);
}

/**
 * Builds and owns the playground course.
 */
export class PlaygroundCourse {
  readonly group = new Group();
  readonly movers: CourseMover[] = [];
  /** Dynamic bodies with their meshes (boxes, props). */
  readonly dynamics: { body: RigidBody; object: Object3D }[] = [];
  /** Feet position of the spawn point. */
  readonly spawn: Vec3 = { x: 0, y: 0, z: -13 };
  readonly spawnYaw = 0;
  /** Falling below this respawns. */
  readonly killY = -18;

  private readonly propIds = new Map<number, number>();
  private readonly materials = new Map<string, Material>();
  private readonly geometries: BufferGeometry[] = [];
  private readonly extraMaterials: Material[] = [];
  private readonly chevrons: Mesh[] = [];
  private readonly p = { x: 0, y: 0, z: 0 };
  private readonly q = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    private readonly surfaces: SurfaceRegistry,
  ) {
    this.buildIsland();
    this.buildSlopes();
    this.buildSteps();
    this.buildLedges();
    this.buildSurfaces();
    this.buildBounce();
    this.buildHazards();
    this.buildGaps();
    this.buildDisc();
    this.buildNorth();
    this.buildDynamics();
  }

  /** Carryable prop id for a collider, or undefined. */
  propIdByCollider(handle: number): number | undefined {
    return this.propIds.get(handle);
  }

  /** Sets every mover's next kinematic pose. Call before controllers step. */
  setNextPoses(tNext: number): void {
    for (const m of this.movers) {
      m.pose(tNext, this.p, this.q);
      m.body.setNextKinematicTranslation(this.p);
      m.body.setNextKinematicRotation(this.q);
    }
  }

  /**
   * Updates visuals. Movers are evaluated at the interpolated render time, so
   * they are perfectly smooth regardless of the fixed step.
   */
  syncVisuals(renderTime: number, elapsed: number): void {
    for (const m of this.movers) {
      m.pose(renderTime, this.p, this.q);
      m.object.position.set(this.p.x, this.p.y, this.p.z);
      m.object.quaternion.set(this.q.x, this.q.y, this.q.z, this.q.w);
    }
    for (const d of this.dynamics) {
      const t = d.body.translation();
      const r = d.body.rotation();
      d.object.position.set(t.x, t.y, t.z);
      d.object.quaternion.set(r.x, r.y, r.z, r.w);
    }
    // Conveyor chevrons drift with the belt (visual only).
    for (let i = 0; i < this.chevrons.length; i++) {
      const c = this.chevrons[i]!;
      const u = ((((elapsed * 3.5) / 10 + i / this.chevrons.length) % 1) + 1) % 1;
      c.position.x = 28 - u * 10;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const s = o as { isSprite?: boolean; material?: Material & { map?: { dispose(): void } | null } };
      if (s.isSprite && s.material) {
        s.material.map?.dispose();
        s.material.dispose();
      }
    });
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.extraMaterials) m.dispose();
  }

  // ---------------------------------------------------------------------------
  // Builders
  // ---------------------------------------------------------------------------

  private mat(color: string, emissive?: string): Material {
    const key = color + (emissive ?? '');
    let m = this.materials.get(key);
    if (!m) {
      m = createToonMaterial({ color, emissive, emissiveIntensity: emissive ? 0.18 : 0 });
      this.materials.set(key, m);
    }
    return m;
  }

  private geo<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  /** Fixed box with its top face at `top`. */
  private box(
    x: number,
    top: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: string,
    info?: SurfaceInfo,
    rounded = true,
  ): Mesh {
    const cy = top - sy / 2;
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const col = this.world.createCollider(
      this.R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setTranslation(x, cy, z)
        .setCollisionGroups(InteractionGroups.static),
      body,
    );
    if (info) this.surfaces.set(col.handle, info);
    const r = Math.min(0.12, sx / 4, sy / 4, sz / 4);
    const g = rounded && r > 0.02 ? new RoundedBoxGeometry(sx, sy, sz, 2, r) : new BoxGeometry(sx, sy, sz);
    const mesh = new Mesh(this.geo(g), this.mat(color));
    mesh.position.set(x, cy, z);
    mesh.castShadow = sy > 0.1;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Inclined slab. `from` is the middle of its low (or high) top edge, `yaw`
   * the direction it runs in, `slopeDeg` positive when it rises along `yaw`.
   */
  private slab(
    from: Vec3,
    yaw: number,
    length: number,
    width: number,
    slopeDeg: number,
    color: string,
    info?: SurfaceInfo,
  ): void {
    const hy = 0.25;
    const qYaw = quatFromYaw(yaw);
    const qPitch = quatFromAxisAngle(1, 0, 0, (-slopeDeg * Math.PI) / 180);
    const q = quatMul(qYaw, qPitch);
    // centre = from − q·(0, hy, −L/2), so the top surface's edge lands exactly on `from`.
    const v = rotateVec(q, { x: 0, y: hy, z: -length / 2 });
    const cx = from.x - v.x;
    const cy = from.y - v.y;
    const cz = from.z - v.z;
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const col = this.world.createCollider(
      this.R.ColliderDesc.cuboid(width / 2, hy, length / 2)
        .setTranslation(cx, cy, cz)
        .setRotation(q)
        .setCollisionGroups(InteractionGroups.static),
      body,
    );
    if (info) this.surfaces.set(col.handle, info);
    const mesh = new Mesh(this.geo(new RoundedBoxGeometry(width, hy * 2, length, 2, 0.1)), this.mat(color));
    mesh.position.set(cx, cy, cz);
    mesh.quaternion.set(q.x, q.y, q.z, q.w);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private label(text: string, x: number, y: number, z: number, color = COLORS.white, height = 0.75): void {
    const s = createLabel(text, color, height);
    s.position.set(x, y, z);
    this.group.add(s);
  }

  private kinematic(
    shape: () => InstanceType<Rapier['ColliderDesc']>,
    object: Object3D,
    pose: CourseMover['pose'],
    info?: SurfaceInfo,
  ): CourseMover {
    pose(0, this.p, this.q);
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(this.p.x, this.p.y, this.p.z)
        .setRotation(this.q),
    );
    const col = this.world.createCollider(shape().setCollisionGroups(InteractionGroups.kinematic), body);
    if (info) this.surfaces.set(col.handle, info);
    object.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.group.add(object);
    const mover = { body, object, pose };
    this.movers.push(mover);
    return mover;
  }

  // ---------------------------------------------------------------------------
  // Stations
  // ---------------------------------------------------------------------------

  private buildIsland(): void {
    this.box(0, 0, 10, 60, 1, 60, COLORS.island, undefined, false);
    const under = new Mesh(this.geo(new CylinderGeometry(30, 10, 14, 48)), this.mat(COLORS.islandSide));
    under.position.set(0, -7.6, 10);
    under.scale.z = 1.4;
    this.group.add(under);
    // Spawn marker (visual only; no collider so it never becomes a step)
    const pad = new Mesh(this.geo(new CylinderGeometry(1.8, 1.8, 0.04, 40)), this.mat(COLORS.safe));
    pad.position.set(this.spawn.x, 0.02, this.spawn.z);
    pad.receiveShadow = true;
    this.group.add(pad);
    this.label('TUMBLER PLAYGROUND', 0, 7.5, 6, COLORS.interact, 1.4);
    this.label(
      'WASD move · Space jump · Ctrl/LMB/C dive · Shift/RMB grab · 1-4 emote · R respawn',
      0,
      6.3,
      6,
      COLORS.white,
      0.5,
    );
  }

  private buildSlopes(): void {
    // Three ramps rising toward +Z to a common deck at 4 m.
    const H = 4;
    const zTop = -2;
    const ramps: [number, number, string][] = [
      [-24, 30, COLORS.safe],
      [-19.5, 45, COLORS.interact],
      [-15, 60, COLORS.danger],
    ];
    for (const [x, deg, color] of ramps) {
      const a = (deg * Math.PI) / 180;
      const run = H / Math.tan(a);
      const len = H / Math.sin(a);
      this.slab({ x, y: 0, z: zTop - run }, 0, len, 3.6, deg, color);
      this.label(deg === 60 ? '60° too steep' : `${deg}°`, x, 1.6, zTop - run - 1, COLORS.white, 0.6);
    }
    this.box(-19.5, H, 0, 15, 0.6, 4, COLORS.purple);
    this.label('Slide ramp ↓', -23, H + 1.8, 1.2, COLORS.slide, 0.6);
    // Slide ramp off the deck's north side, down to the island.
    this.slab({ x: -23, y: H, z: 2 }, 0, H / Math.sin((15 * Math.PI) / 180), 5, -15, COLORS.slide, {
      kind: 'slide',
    });
  }

  private buildSteps(): void {
    // Stairs: 8 × 0.25 m rises up to a 2 m landing.
    const x = -7;
    const z0 = -12;
    for (let i = 0; i < 8; i++) {
      this.box(
        x,
        0.25 * (i + 1),
        z0 + i * 0.45 + 0.225,
        3,
        0.25 * (i + 1),
        0.45,
        i % 2 ? COLORS.white : COLORS.safe,
        undefined,
        false,
      );
    }
    this.box(x, 2, z0 + 3.6 + 1.5, 3, 2, 3, COLORS.safe);
    this.label('Stairs', x, 3.6, z0 + 1, COLORS.white, 0.55);
    // Step-ups: the last one is above stepHeight and needs a hop.
    const heights = [0.15, 0.3, 0.35, 0.45];
    heights.forEach((h, i) => {
      const bx = -2.5 + i * 2.2;
      this.box(bx, h, -7.5, 1.8, h, 2.2, i === 3 ? COLORS.dangerAlt : COLORS.interact, undefined, false);
      this.label(i === 3 ? `${h} m hop` : `${h} m`, bx, h + 0.9, -8.8, COLORS.white, 0.45);
    });
  }

  private buildLedges(): void {
    const grab: SurfaceInfo = { kind: 'normal', grabbable: true };
    this.box(9.5, 1.5, -7, 3.5, 1.5, 2, COLORS.interact, grab);
    this.label('Ledge 1.5 m', 9.5, 2.4, -8.3, COLORS.white, 0.5);
    this.box(14, 2.4, -7, 3.5, 2.4, 2, COLORS.interact, grab);
    this.label('Ledge 2.4 m (grab)', 14, 3.3, -8.3, COLORS.white, 0.5);
  }

  private buildSurfaces(): void {
    this.box(23, 0.02, -10, 10, 0.04, 8, COLORS.ice, { kind: 'ice' }, false);
    this.label('ICE', 23, 1.4, -10, COLORS.ice, 0.7);
    this.box(
      23,
      0.02,
      -2,
      10,
      0.04,
      4,
      '#8a8fa8',
      { kind: 'conveyor', conveyorVelocity: { x: -3.5, y: 0, z: 0 } },
      false,
    );
    this.label('Conveyor ←', 23, 1.4, -2, COLORS.white, 0.6);
    const chevGeo = this.geo(new BoxGeometry(0.35, 0.03, 3.4));
    const chevMat = this.mat(COLORS.interact);
    for (let i = 0; i < 8; i++) {
      const c = new Mesh(chevGeo, chevMat);
      c.position.set(28, 0.05, -2);
      this.group.add(c);
      this.chevrons.push(c);
    }
    this.box(23, 0.02, 5, 10, 0.04, 6, COLORS.goo, { kind: 'sticky' }, false);
    this.label('Sticky goo', 23, 1.4, 5, COLORS.goo, 0.6);
  }

  private buildBounce(): void {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const col = this.world.createCollider(
      this.R.ColliderDesc.cylinder(0.1, 1.3)
        .setTranslation(8, 0.1, 6)
        .setCollisionGroups(InteractionGroups.static),
      body,
    );
    this.surfaces.set(col.handle, { kind: 'bouncy', bounceImpulse: 17, ownerId: 'bounce-pad' });
    const pad = new Mesh(
      this.geo(new CylinderGeometry(1.3, 1.4, 0.2, 32)),
      this.mat(COLORS.interact, COLORS.interact),
    );
    pad.position.set(8, 0.1, 6);
    pad.receiveShadow = true;
    this.group.add(pad);
    this.label('Bounce!', 8, 1.6, 6, COLORS.interact, 0.6);
    // Offset north of the pad so the launch arc rises in front of the deck rather than under it.
    this.box(8, 4.5, 14.5, 6, 0.6, 6, COLORS.purple);
    this.label('High deck', 8, 5.9, 14.5, COLORS.white, 0.55);
  }

  private buildHazards(): void {
    // Rotating bar: jump it; the outer half moves fast enough to stun.
    const barGroup = new Group();
    const bar = new Mesh(
      this.geo(new RoundedBoxGeometry(14, 0.5, 0.5, 2, 0.2)),
      this.mat(COLORS.danger, COLORS.danger),
    );
    barGroup.add(bar);
    this.kinematic(
      () => this.R.ColliderDesc.cuboid(7, 0.25, 0.25),
      barGroup,
      (t, p, q) => {
        p.x = -2;
        p.y = 0.55;
        p.z = 25;
        quatFromYaw(t * 1.2, q);
      },
    );
    const hub = new Mesh(this.geo(new CylinderGeometry(0.6, 0.75, 1.2, 24)), this.mat(COLORS.interact));
    hub.position.set(-2, 0.6, 25);
    hub.castShadow = true;
    this.group.add(hub);
    this.box(-2, 1.2, 25, 1.2, 1.2, 1.2, COLORS.interact);
    this.label('Rotating bar — jump it', -2, 2.6, 25, COLORS.white, 0.5);

    // Pendulum swinging along X; the ball is a kinematic compound about the pivot.
    const L = 6.1;
    const pivot = { x: 16, y: 7.5, z: 22 };
    const pend = new Group();
    const arm = new Mesh(this.geo(new CylinderGeometry(0.12, 0.12, L, 10)), this.mat(COLORS.white));
    arm.position.y = -L / 2;
    const ball = new Mesh(this.geo(new SphereGeometry(0.9, 28, 18)), this.mat(COLORS.danger, COLORS.danger));
    ball.position.y = -L;
    pend.add(arm, ball);
    this.kinematic(
      () => this.R.ColliderDesc.ball(0.9).setTranslation(0, -L, 0),
      pend,
      (t, p, q) => {
        p.x = pivot.x;
        p.y = pivot.y;
        p.z = pivot.z;
        const angle = 1.0 * Math.sin((t * Math.PI * 2) / 2.8);
        quatFromAxisAngle(0, 0, 1, angle, q);
      },
    );
    for (const side of [-1, 1])
      this.box(pivot.x, pivot.y + 0.3, pivot.z + side * 1.6, 0.4, pivot.y + 0.3, 0.4, COLORS.purple);
    this.box(pivot.x, pivot.y + 0.6, pivot.z, 0.4, 0.3, 3.6, COLORS.purple);
    this.label('Pendulum (stun test)', pivot.x, pivot.y + 1.6, pivot.z, COLORS.danger, 0.55);
  }

  private buildGaps(): void {
    const gaps: [number, string][] = [
      [2, '#6ee7a8'],
      [3.5, COLORS.interact],
      [4.5, COLORS.dangerAlt],
      [5.5, COLORS.danger],
    ];
    let edge = -30;
    const z = 22;
    for (const [gap, color] of gaps) {
      const near = edge - gap;
      const cx = near - 2;
      this.box(cx, 0, z, 4, 1, 6, color);
      this.label(`${gap} m gap`, edge - gap / 2, 1.8, z, color, 0.6);
      edge = near - 4;
    }
    this.label('Gaps →', -28, 2.2, z, COLORS.white, 0.6);
  }

  private buildDisc(): void {
    const disc = new Group();
    const top = new Mesh(this.geo(new CylinderGeometry(5, 5, 0.5, 48)), this.mat(COLORS.safe));
    const stripe = new Mesh(this.geo(new BoxGeometry(9.6, 0.52, 0.6)), this.mat(COLORS.interact));
    disc.add(top, stripe);
    this.kinematic(
      () => this.R.ColliderDesc.cylinder(0.25, 5),
      disc,
      (t, p, q) => {
        p.x = 36.5;
        p.y = -0.25;
        p.z = 24;
        quatFromYaw(t * 1.0, q);
      },
    );
    this.label('Spinning disc', 36.5, 2.5, 24, COLORS.white, 0.6);
  }

  private buildNorth(): void {
    // Moving platform ferrying to the north island.
    const plat = new Group();
    plat.add(new Mesh(this.geo(new RoundedBoxGeometry(4, 0.5, 4, 2, 0.15)), this.mat(COLORS.safe)));
    this.kinematic(
      () => this.R.ColliderDesc.cuboid(2, 0.25, 2),
      plat,
      (t, p, q) => {
        p.x = 0;
        p.y = -0.25;
        p.z = 43 + pingPong(t, 3, 1.2) * 12;
        q.x = q.y = q.z = 0;
        q.w = 1;
      },
    );
    this.label('Moving platform', 0, 2.2, 40.5, COLORS.white, 0.6);

    this.box(0, 0, 65, 16, 1, 14, COLORS.island, undefined, false);
    const under = new Mesh(this.geo(new CylinderGeometry(8, 3, 8, 32)), this.mat(COLORS.islandSide));
    under.position.set(0, -4.5, 65);
    this.group.add(under);

    // Elevator beside a high, grabbable deck.
    const elev = new Group();
    elev.add(new Mesh(this.geo(new RoundedBoxGeometry(3, 0.4, 3, 2, 0.12)), this.mat(COLORS.interact)));
    this.kinematic(
      () => this.R.ColliderDesc.cuboid(1.5, 0.2, 1.5),
      elev,
      (t, p, q) => {
        p.x = 5;
        p.y = -0.15 + pingPong(t, 2.5, 1.5) * 6.35;
        p.z = 66;
        q.x = q.y = q.z = 0;
        q.w = 1;
      },
    );
    this.box(-2.5, 6.4, 67, 11, 0.8, 8, COLORS.purple, { kind: 'normal', grabbable: true });
    this.label('Elevator', 5, 1.8, 63.8, COLORS.white, 0.6);
  }

  private buildDynamics(): void {
    const boxGeo = this.geo(new RoundedBoxGeometry(1, 1, 1, 2, 0.1));
    const boxMat = this.mat(COLORS.dangerAlt);
    const spots: [number, number, number][] = [
      [3, 0.5, 1],
      [4.2, 0.5, 1],
      [3.6, 1.5, 1],
      [5.5, 0.5, 2.5],
      [2, 0.5, 3],
    ];
    for (const [x, y, z] of spots) {
      const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z));
      this.world.createCollider(
        this.R.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setDensity(0.6)
          .setFriction(0.6)
          .setCollisionGroups(InteractionGroups.prop),
        body,
      );
      const mesh = new Mesh(boxGeo, boxMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.dynamics.push({ body, object: mesh });
    }
    this.label('Push boxes', 4, 2.6, 1, COLORS.white, 0.5);

    const ballGeo = this.geo(new SphereGeometry(0.35, 20, 14));
    const ballMat = this.mat(COLORS.interact, COLORS.interact);
    [
      [-3, -10],
      [-4.2, -11],
    ].forEach(([x, z], i) => {
      const body = this.world.createRigidBody(
        this.R.RigidBodyDesc.dynamic().setTranslation(x!, 0.35, z!).setLinearDamping(0.4),
      );
      const col = this.world.createCollider(
        this.R.ColliderDesc.ball(0.35)
          .setDensity(0.3)
          .setRestitution(0.3)
          .setFriction(0.8)
          .setCollisionGroups(InteractionGroups.prop),
        body,
      );
      this.propIds.set(col.handle, 100 + i);
      const mesh = new Mesh(ballGeo, ballMat);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.dynamics.push({ body, object: mesh });
    });
    this.label('Carry me (hold grab)', -3.6, 1.6, -10.5, COLORS.interact, 0.45);
  }
}
