/**
 * Signature candy dressing for the main-menu lobby platform.
 *
 * Responsibilities:
 * - Marquee rim bulbs that chase around the platform edge (one instanced,
 *   unlit draw call; they flash faster when someone emotes).
 * - A bounce pad that really launches the Tumbler in idle play (a `bouncy`
 *   surface in the idle-play Rapier world) and squashes when used.
 * - Bumpable candy props (gumdrops, a cupcake, a striped beach ball) as
 *   dynamic Rapier bodies drawn with instanced toon meshes.
 * - A confetti cannon that fires (with a confetti shower over the Tumbler)
 *   whenever an emote plays.
 * - Giant lollipop pinwheels slowly turning in the backdrop.
 *
 * Budget: ~10 draw calls for the dressing plus the VFX pools while they have
 * live particles. Everything is created here and released in `dispose()`.
 */
import {
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Camera,
  type MeshToonNodeMaterial,
  type Node,
  type Scene,
} from 'three/webgpu';
import {
  atan,
  attribute,
  float,
  fract,
  instanceIndex,
  mix,
  positionLocal,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { createToonMaterial } from '@tumble/render';
import { PropBuilder, type PrimitiveKind, type PropBatch } from '@tumble/render/environment';
import { createVfxSystem, type VfxSystem } from '@tumble/render/vfx';
import type { QualityPreset } from '@tumble/render/quality';
import { InteractionGroups } from '@tumble/shared';
import type { Rapier, RigidBody, SimEvent } from '@tumble/sim';
import type { IdlePlay } from './idlePlay.ts';

/** Inner radius of the invisible rim wall (m). The cake top is 6 m. */
export const LOBBY_WALL_RADIUS = 5.7;

const BULBS = 44;
const BULB_RADIUS = 5.86;
const PAD = { x: 3.2, z: -2.6, radius: 0.85 };
const CANNON = { x: -1.9, z: -4.3 };
const CONFETTI = ['#ff4f9a', '#ffd23f', '#3ee6b4', '#5aa9ff', '#8a5cff', '#ff8a3d', '#ffffff'];
/** Matches the platform's rim posts (`createFloatingPlatform`: 5 posts at 0.93 r). */
const POSTS = 5;

interface PropPart {
  kind: PrimitiveKind;
  local: Matrix4;
  index: number;
}

interface DynamicProp {
  body: RigidBody;
  home: Vector3;
  parts: PropPart[];
}

interface PropSpec {
  x: number;
  y: number;
  z: number;
  collider: (R: Rapier) => ReturnType<Rapier['ColliderDesc']['ball']>;
  parts: {
    kind: PrimitiveKind;
    p: [number, number, number];
    s: [number, number, number];
    color: string;
    rot?: [number, number, number];
  }[];
}

const gumdrop = (x: number, z: number, r: number, color: string): PropSpec => ({
  x,
  y: r * 0.65,
  z,
  collider: (R) => R.ColliderDesc.cone(r * 0.65, r * 0.95),
  parts: [{ kind: 'cone', p: [0, 0, 0], s: [r, r * 1.3, r], color }],
});

const PROPS: PropSpec[] = [
  gumdrop(4.3, 0.2, 0.5, '#ff5fa8'),
  gumdrop(-4.4, 0.7, 0.42, '#3ee6b4'),
  gumdrop(1.3, -4.4, 0.36, '#ffd23f'),
  {
    x: -2.7,
    y: 0.48,
    z: 2.9,
    collider: (R) => R.ColliderDesc.cylinder(0.48, 0.42),
    parts: [
      { kind: 'cyl', p: [0, -0.22, 0], s: [0.38, 0.5, 0.38], color: '#8fd3ff' },
      { kind: 'sphere', p: [0, 0.08, 0], s: [0.46, 0.26, 0.46], color: '#fff3f8' },
      { kind: 'cone', p: [0, 0.3, 0], s: [0.28, 0.34, 0.28], color: '#ff9ecb' },
      { kind: 'sphere', p: [0, 0.52, 0], s: [0.1, 0.1, 0.1], color: '#ff3d5e' },
    ],
  },
];
const BALL = { x: 2.5, z: 2.9, r: 0.42 };

/**
 * Builds and runs the lobby set dressing.
 *
 * @example
 * const lobby = new LobbyStage(stage.scene, idle, R, preset);
 * // per frame
 * lobby.update(realDt, camera);
 * lobby.celebrate(playerPos);
 */
export class LobbyStage {
  /** Props that step aside in the dressing room (pad, cannon, bumpables). */
  readonly props = new Group();
  readonly vfx: VfxSystem;
  private readonly root = new Group();
  private readonly time = uniform(0);
  private readonly excite = uniform(0);
  private readonly padPulse = uniform(0);
  private readonly bulbs: InstancedMesh;
  private readonly padTop: Mesh;
  private readonly decor: PropBatch;
  private readonly dynamic: PropBatch;
  private readonly ball: InstancedMesh;
  private readonly ballBody: RigidBody;
  private readonly pinwheels: InstancedMesh;
  private readonly bodies: DynamicProp[] = [];
  private readonly meshByKind = new Map<PrimitiveKind, InstancedMesh>();
  private readonly disposables: { dispose(): void }[] = [];
  private squash = 0;
  private t = 0;
  private readonly m4 = new Matrix4();
  private readonly m4b = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly ballScale = new Vector3(BALL.r, BALL.r, BALL.r);
  private readonly dummy = new Object3D();

  /**
   * @param scene - The menu stage scene.
   * @param idle - Idle-play physics; colliders and bodies are added to its world.
   * @param R - Rapier.
   * @param preset - Quality preset (VFX budget).
   */
  constructor(
    scene: Scene,
    private readonly idle: IdlePlay,
    private readonly R: Rapier,
    preset: QualityPreset,
  ) {
    this.root.name = 'lobby-stage';
    this.props.name = 'lobby-props';
    this.root.add(this.props);
    scene.add(this.root);

    this.bulbs = this.buildBulbs();
    this.root.add(this.bulbs);
    this.decor = this.buildDecor();
    this.padTop = this.buildPad();
    this.dynamic = this.buildDynamicProps();
    const ball = this.buildBall();
    this.ball = ball.mesh;
    this.ballBody = ball.body;
    this.pinwheels = this.buildPinwheels();
    this.root.add(this.pinwheels);

    this.vfx = createVfxSystem({ budget: preset.vfx });
    this.vfx.setShadowCount(0);
    this.root.add(this.vfx.object);
    this.syncProps();
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private buildBulbs(): InstancedMesh {
    const geo = this.track(new IcosahedronGeometry(0.1, 2));
    const mat = this.track(new MeshBasicNodeMaterial());
    const idx = float(instanceIndex).div(BULBS);
    // Three bright packets chase around the rim; an emote speeds them up and lifts the floor level.
    const wave = fract(idx.mul(3).sub(this.time.mul(mix(float(0.22), float(0.9), this.excite))));
    const lit = smoothstep(0.55, 0.95, wave).add(this.excite.mul(0.35));
    const tint = attribute('aTint', 'vec3') as unknown as Node<'vec3'>;
    mat.colorNode = mix(tint.mul(0.55), tint.mul(2.6).add(0.35), lit.clamp(0, 1));
    const mesh = new InstancedMesh(geo, mat, BULBS);
    const tints = new Float32Array(BULBS * 3);
    const palette = [
      [1, 0.86, 0.45],
      [1, 0.45, 0.72],
      [0.55, 0.95, 1],
    ];
    for (let i = 0; i < BULBS; i++) {
      const a = (i / BULBS) * Math.PI * 2;
      this.dummy.position.set(Math.cos(a) * BULB_RADIUS, 0.07, Math.sin(a) * BULB_RADIUS);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      const c = palette[i % 3]!;
      tints.set(c, i * 3);
    }
    geo.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'lobby-bulbs';
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Static candy decor: pad base, the confetti cannon and the pinwheel sticks. */
  private buildDecor(): PropBatch {
    const R = this.R;
    const b = new PropBuilder();
    b.add('cyl', PAD.x, 0.07, PAD.z, PAD.radius + 0.18, 0.16, PAD.radius + 0.18, '#7a5cff');
    b.add('torus', PAD.x, 0.16, PAD.z, PAD.radius + 0.06, PAD.radius + 0.06, 0.55, '#ffd23f', [
      Math.PI / 2,
      0,
      0,
    ]);

    // Cannon: a striped barrel on a gumdrop mount, tilted up toward the stage.
    const cx = CANNON.x;
    const cz = CANNON.z;
    const yaw = Math.atan2(-cx, -cz);
    b.add('cone', cx, 0.28, cz, 0.62, 0.56, 0.62, '#ff5fa8');
    const tilt = 0.55;
    const dir = new Vector3(Math.sin(yaw) * Math.sin(tilt), Math.cos(tilt), Math.cos(yaw) * Math.sin(tilt));
    const base = new Vector3(cx, 0.55, cz);
    for (let i = 0; i < 3; i++) {
      const p = base.clone().addScaledVector(dir, 0.25 + i * 0.32);
      b.add(
        'cyl',
        p.x,
        p.y,
        p.z,
        0.3 - i * 0.015,
        0.3,
        0.3 - i * 0.015,
        i % 2 === 0 ? '#ffffff' : '#5aa9ff',
        [tilt, yaw, 0],
      );
    }
    const mouth = base.clone().addScaledVector(dir, 1.05);
    b.add('torus', mouth.x, mouth.y, mouth.z, 0.29, 0.29, 0.6, '#ffd23f', [tilt + Math.PI / 2, yaw, 0]);
    this.cannonMouth.copy(mouth).addScaledVector(dir, 0.15);
    this.cannonDir.copy(dir);

    const batch = b.build(false);
    for (const m of batch.meshes) {
      m.receiveShadow = true;
      this.props.add(m);
    }

    // Backdrop pinwheel sticks and hubs (the discs are their own instanced mesh).
    const back = new PropBuilder();
    for (const w of PINWHEELS) {
      back.add('cyl', w.x, w.y - w.stick / 2, w.z - 0.1, 0.2, w.stick, 0.2, '#fff3f8');
      back.add(
        'sphere',
        w.x + Math.sin(w.face) * 0.15,
        w.y,
        w.z + Math.cos(w.face) * 0.15,
        0.4,
        0.4,
        0.25,
        '#ffffff',
        [0, w.face, 0],
        0.5,
      );
    }
    this.backdrop = back.build(false);
    for (const m of this.backdrop.meshes) this.root.add(m);

    // Colliders: pad rim, cannon mount and the platform's rim posts.
    const world = this.idle.world;
    const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());
    world.createCollider(
      R.ColliderDesc.cylinder(0.08, PAD.radius + 0.18)
        .setTranslation(PAD.x, 0.06, PAD.z)
        .setCollisionGroups(InteractionGroups.static),
      fixed,
    );
    world.createCollider(
      R.ColliderDesc.cylinder(0.5, 0.6)
        .setTranslation(cx, 0.5, cz)
        .setCollisionGroups(InteractionGroups.static),
      fixed,
    );
    for (let i = 0; i < POSTS; i++) {
      const a = (i / POSTS) * Math.PI * 2 + Math.PI / POSTS;
      world.createCollider(
        R.ColliderDesc.cylinder(0.55, 0.26)
          .setTranslation(Math.cos(a) * 6 * 0.93, 0.55, Math.sin(a) * 6 * 0.93)
          .setCollisionGroups(InteractionGroups.static),
        fixed,
      );
    }
    return batch;
  }

  private backdrop!: PropBatch;
  private readonly cannonMouth = new Vector3();
  private readonly cannonDir = new Vector3();

  private buildPad(): Mesh {
    const R = this.R;
    const geo = this.track(new CylinderGeometry(PAD.radius, PAD.radius, 0.12, 40));
    const mat = this.track(createToonMaterial({ color: '#ffffff', rimStrength: 0.3 }));
    const st = uv().sub(0.5);
    const rings = fract(st.length().mul(7).sub(this.time.mul(0.9)));
    const band = smoothstep(0.42, 0.5, rings).mul(smoothstep(1.0, 0.92, rings));
    mat.colorNode = mix(vec3(1.0, 0.36, 0.66), vec3(1.0, 0.95, 0.98), band);
    const em = (mat as MeshToonNodeMaterial & { emissiveNode: Node<'vec3'> }).emissiveNode;
    (mat as MeshToonNodeMaterial & { emissiveNode: Node<'vec3'> }).emissiveNode = em.add(
      vec3(1.0, 0.45, 0.75).mul(band.mul(0.25).add(this.padPulse.mul(0.9))),
    );
    const mesh = new Mesh(geo, mat);
    mesh.position.set(PAD.x, 0.2, PAD.z);
    mesh.receiveShadow = true;
    mesh.name = 'lobby-pad';
    this.props.add(mesh);

    const body = this.idle.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(PAD.x, 0.18, PAD.z));
    const col = this.idle.world.createCollider(
      R.ColliderDesc.cylinder(0.08, PAD.radius).setCollisionGroups(InteractionGroups.static),
      body,
    );
    // Launch up and a little toward the middle so the Tumbler lands back on the stage.
    const toCentre = Math.hypot(PAD.x, PAD.z);
    this.idle.surfaces.set(col.handle, {
      kind: 'bouncy',
      bounceVelocity: { x: (-PAD.x / toCentre) * 2.6, y: 15, z: (-PAD.z / toCentre) * 2.6 },
      bounceUp: { x: 0, y: 1, z: 0 },
      ownerId: 'lobby-pad',
    });
    return mesh;
  }

  private buildDynamicProps(): PropBatch {
    const R = this.R;
    const b = new PropBuilder();
    const counts = new Map<PrimitiveKind, number>();
    const pending: { spec: PropSpec; parts: PropPart[] }[] = [];
    for (const spec of PROPS) {
      const parts: PropPart[] = [];
      for (const part of spec.parts) {
        const index = counts.get(part.kind) ?? 0;
        counts.set(part.kind, index + 1);
        b.add(part.kind, 0, -100, 0, part.s[0], part.s[1], part.s[2], part.color, part.rot);
        const local = new Matrix4().compose(
          new Vector3(...part.p),
          new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), part.rot?.[1] ?? 0),
          new Vector3(...part.s),
        );
        parts.push({ kind: part.kind, local, index });
      }
      pending.push({ spec, parts });
    }
    const batch = b.build(true);
    for (const m of batch.meshes) {
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.meshByKind.set(m.name.slice('props:'.length) as PrimitiveKind, m);
      this.props.add(m);
    }
    for (const { spec, parts } of pending) {
      const body = this.idle.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(spec.x, spec.y, spec.z)
          .setLinearDamping(0.8)
          .setAngularDamping(1.2),
      );
      this.idle.world.createCollider(
        spec
          .collider(R)
          .setDensity(0.35)
          .setFriction(0.7)
          .setRestitution(0.35)
          .setCollisionGroups(InteractionGroups.prop),
        body,
      );
      this.bodies.push({ body, home: new Vector3(spec.x, spec.y, spec.z), parts });
    }
    return batch;
  }

  private buildBall(): { mesh: InstancedMesh; body: RigidBody } {
    const R = this.R;
    const geo = this.track(new IcosahedronGeometry(1, 4));
    const mat = this.track(createToonMaterial({ color: '#ffffff', rimStrength: 0.4 }));
    const wedge = fract(
      atan(positionLocal.z, positionLocal.x)
        .div(Math.PI * 2)
        .add(0.5)
        .mul(6),
    );
    const white = smoothstep(0.47, 0.53, wedge);
    const which = fract(
      atan(positionLocal.z, positionLocal.x)
        .div(Math.PI * 2)
        .add(0.5)
        .mul(3),
    )
      .mul(3)
      .floor();
    const hue = mix(
      mix(vec3(1.0, 0.3, 0.55), vec3(1.0, 0.82, 0.25), which.clamp(0, 1)),
      vec3(0.35, 0.68, 1.0),
      which.sub(1).clamp(0, 1),
    );
    const cap = smoothstep(0.82, 0.86, positionLocal.y.abs());
    mat.colorNode = mix(mix(hue, vec3(1, 0.98, 0.95), white), vec3(1, 0.98, 0.95), cap);
    const mesh = new InstancedMesh(geo, mat, 1);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'lobby-ball';
    this.props.add(mesh);
    const body = this.idle.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(BALL.x, BALL.r, BALL.z)
        .setLinearDamping(0.35)
        .setAngularDamping(0.4),
    );
    this.idle.world.createCollider(
      R.ColliderDesc.ball(BALL.r)
        .setDensity(0.12)
        .setRestitution(0.7)
        .setFriction(0.6)
        .setCollisionGroups(InteractionGroups.prop),
      body,
    );
    return { mesh, body };
  }

  private buildPinwheels(): InstancedMesh {
    const geo = this.track(new CircleGeometry(1, 64));
    const mat = this.track(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const st = uv().sub(0.5);
    const r = st.length().mul(2);
    const ang = atan(st.y, st.x)
      .div(Math.PI * 2)
      .add(0.5);
    const swirl = fract(ang.mul(5).add(r.mul(1.4)));
    const stripe = smoothstep(0.46, 0.5, swirl).mul(smoothstep(1.0, 0.96, swirl));
    const tint = attribute('aTint', 'vec3') as unknown as Node<'vec3'>;
    const rim = smoothstep(0.93, 0.97, r);
    mat.colorNode = mix(mix(tint, vec3(1, 0.97, 0.98), stripe), vec3(1, 0.97, 0.98), rim);
    const mesh = new InstancedMesh(geo, mat, PINWHEELS.length);
    const tints = new Float32Array(PINWHEELS.length * 3);
    PINWHEELS.forEach((w, i) => tints.set(w.tint, i * 3));
    geo.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    mesh.frustumCulled = false;
    mesh.name = 'lobby-pinwheels';
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------

  /**
   * Feeds one fixed step's sim events (bounce pad squash, dust, landing puffs).
   *
   * @param events - The step's events.
   */
  handleSimEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'bounce') {
        this.squash = 1;
        this.vfx.spawn('bounceRing', { x: PAD.x, y: 0.3, z: PAD.z }, { color: '#ff7fbf' });
        this.vfx.spawn('sparkle', { x: PAD.x, y: 0.5, z: PAD.z }, { color: '#ffd23f', scale: 0.8 });
      } else if (e.type === 'jump' || e.type === 'land' || e.type === 'dive') {
        this.vfx.handleSimEvent(e);
      }
    }
  }

  /**
   * Emote celebration: confetti shower over the Tumbler, a cannon blast and a
   * burst of the rim lights.
   *
   * @param at - Tumbler feet position.
   * @param cannon - Fire the stage cannon too (off in the dressing room).
   */
  celebrate(at: { x: number; y: number; z: number }, cannon = true): void {
    this.vfx.spawn('confetti', { x: at.x, y: at.y + 2.6, z: at.z }, { colors: CONFETTI, intensity: 0.7 });
    this.excite.value = 1;
    if (!cannon) return;
    const m = this.cannonMouth;
    this.vfx.spawn('pop', { x: m.x, y: m.y, z: m.z }, { scale: 0.8 });
    this.vfx.spawn(
      'confetti',
      { x: m.x + this.cannonDir.x * 0.6, y: m.y + 0.8, z: m.z + this.cannonDir.z * 0.6 },
      { colors: CONFETTI, intensity: 1.1, delay: 0.05 },
    );
    this.vfx.spawn(
      'confetti',
      { x: m.x + this.cannonDir.x * 1.6, y: m.y + 2.2, z: m.z + this.cannonDir.z * 1.6 },
      { colors: CONFETTI, intensity: 0.8, delay: 0.18 },
    );
  }

  /** Puff where the Tumbler disappears/appears when idle play ends. */
  poof(at: { x: number; y: number; z: number }): void {
    this.vfx.spawn('teleport', { x: at.x, y: at.y + 0.8, z: at.z }, { color: '#ff9ecb', scale: 0.7 });
  }

  /** Dressing room: the props step out of the close-up. */
  setDressing(on: boolean): void {
    this.props.visible = !on;
  }

  /** Puts any prop that wandered within `radius` of (x, z) back home. */
  clearArea(x: number, z: number, radius: number): void {
    for (const p of this.allBodies()) {
      const t = p.body.translation();
      if (Math.hypot(t.x - x, t.z - z) < radius || t.y < -2) {
        p.body.setTranslation(p.home, true);
        p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  private *allBodies(): Generator<{ body: RigidBody; home: Vector3 }> {
    yield* this.bodies;
    yield { body: this.ballBody, home: new Vector3(BALL.x, BALL.r, BALL.z) };
  }

  /**
   * Advances animation and copies prop bodies into their instances.
   *
   * @param dt - Frame delta (s).
   * @param camera - Active camera (VFX billboards).
   */
  update(dt: number, camera: Camera): void {
    this.t += dt;
    this.time.value = this.t;
    this.excite.value = Math.max(0, this.excite.value - dt * 0.45);
    this.squash = Math.max(0, this.squash - dt * 3.2);
    this.padPulse.value = this.squash;
    // Damped spring wobble: squashes down, overshoots, settles.
    const s = Math.sin((1 - this.squash) * Math.PI * 3) * this.squash;
    this.padTop.scale.set(1 + s * 0.12, 1 - s * 0.55, 1 + s * 0.12);
    this.decor.update(dt);
    this.backdrop.update(dt);
    this.dynamic.update(dt);
    this.syncProps();
    this.spinPinwheels();
    this.vfx.update(dt, camera);
  }

  private syncProps(): void {
    for (const p of this.bodies) {
      const t = p.body.translation();
      const r = p.body.rotation();
      this.m4.compose(this.v.set(t.x, t.y, t.z), this.q.set(r.x, r.y, r.z, r.w), this.one);
      for (const part of p.parts) {
        const mesh = this.meshByKind.get(part.kind);
        if (!mesh) continue;
        this.m4b.multiplyMatrices(this.m4, part.local);
        mesh.setMatrixAt(part.index, this.m4b);
      }
    }
    for (const m of this.meshByKind.values()) m.instanceMatrix.needsUpdate = true;
    const t = this.ballBody.translation();
    const r = this.ballBody.rotation();
    this.m4.compose(this.v.set(t.x, t.y, t.z), this.q.set(r.x, r.y, r.z, r.w), this.ballScale);
    this.ball.setMatrixAt(0, this.m4);
    this.ball.instanceMatrix.needsUpdate = true;
  }

  private spinPinwheels(): void {
    PINWHEELS.forEach((w, i) => {
      const d = this.dummy;
      d.position.set(w.x, w.y, w.z);
      d.rotation.set(0, w.face, this.t * w.spin);
      d.scale.setScalar(w.r);
      d.updateMatrix();
      this.pinwheels.setMatrixAt(i, d.matrix);
    });
    this.pinwheels.instanceMatrix.needsUpdate = true;
  }

  /** Removes every mesh, material, body and effect this stage created. */
  dispose(): void {
    this.root.removeFromParent();
    this.vfx.dispose();
    this.decor.dispose();
    this.backdrop.dispose();
    this.dynamic.dispose();
    for (const d of this.disposables) d.dispose();
    this.bulbs.dispose();
    this.ball.dispose();
    this.pinwheels.dispose();
  }
}

/** Backdrop lollipop pinwheels: position, radius, stick length, facing, spin (rad/s) and swirl tint. */
const PINWHEELS: {
  x: number;
  y: number;
  z: number;
  r: number;
  stick: number;
  face: number;
  spin: number;
  tint: [number, number, number];
}[] = [
  { x: -15, y: 9, z: -26, r: 3.4, stick: 12, face: 0.25, spin: 0.25, tint: [1, 0.36, 0.62] },
  { x: 17, y: 7.5, z: -24, r: 2.8, stick: 10, face: -0.3, spin: -0.32, tint: [0.42, 0.72, 1] },
  { x: 7, y: 13, z: -38, r: 3.8, stick: 15, face: -0.1, spin: 0.2, tint: [1, 0.78, 0.25] },
  { x: -27, y: 5, z: -18, r: 2.4, stick: 8, face: 0.6, spin: -0.28, tint: [0.35, 0.9, 0.72] },
];
