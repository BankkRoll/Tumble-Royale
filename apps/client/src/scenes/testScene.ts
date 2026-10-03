import {
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusKnotGeometry,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createOutlineMaterial, createSkyDome, createToonMaterial } from '@tumble/render';
import { createWorld, type Rapier } from '@tumble/sim';
import { InteractionGroups, Rng, SIM_DT, quatFromYaw } from '@tumble/shared';
import type { RigidBody, World } from '@tumble/sim';

const PALETTE = ['#ff6fb5', '#ffd23f', '#5ce1e6', '#7c5cff', '#ff8a3d', '#6ee7a8'];
const BODY_COUNT = 90;

/**
 * Phase 0 showcase: a floating candy island with spinning toon shapes and a
 * live Rapier pile swept by a kinematic spinner. Exercises renderer parity,
 * instancing, shadows, and client-side physics in one view.
 */
export class TestScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(55, 1, 0.1, 1000);
  private readonly spinners: Mesh[] = [];
  private readonly world: World;
  private readonly bodies: { body: RigidBody; mesh: InstancedMesh; index: number }[] = [];
  private readonly bar: RigidBody;
  private readonly barMesh: Mesh;
  private readonly rng = new Rng(42);
  private simTime = 0;
  private orbit = 0;

  private readonly m4 = new Matrix4();
  private readonly v3 = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);
  private readonly pq = { x: 0, y: 0, z: 0, w: 1 };

  constructor(R: Rapier) {
    this.scene.add(createSkyDome());
    this.scene.fog = new Fog(new Color('#ffd6f2'), 60, 220);

    const hemi = new HemisphereLight('#dff1ff', '#ffc9e6', 1.4);
    this.scene.add(hemi);
    const sun = new DirectionalLight('#fff3dc', 2.6);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -22;
    sc.right = 22;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 1;
    sc.far = 90;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    this.world = createWorld(R);

    // Island
    const island = new Group();
    const top = new Mesh(new CylinderGeometry(14, 14, 1.2, 64), createToonMaterial({ color: '#8ef0c6' }));
    top.position.y = -0.6;
    top.receiveShadow = true;
    island.add(top);
    const underside = new Mesh(new CylinderGeometry(14, 6, 6, 64), createToonMaterial({ color: '#ffb3d9' }));
    underside.position.y = -4.2;
    island.add(underside);
    this.scene.add(island);
    const floor = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.world.createCollider(
      R.ColliderDesc.cylinder(0.6, 14)
        .setTranslation(0, -0.6, 0)
        .setCollisionGroups(InteractionGroups.static),
      floor,
    );

    // Spinning showcase shapes around the rim
    const showcase: [BufferGeometry, string][] = [
      [new TorusKnotGeometry(0.9, 0.32, 160, 24), '#7c5cff'],
      [new IcosahedronGeometry(1.1, 0), '#ffd23f'],
      [new CapsuleGeometry(0.7, 1.0, 8, 24), '#ff6fb5'],
      [new RoundedBoxGeometry(1.6, 1.6, 1.6, 4, 0.3), '#5ce1e6'],
      [new SphereGeometry(1.0, 48, 24), '#ff8a3d'],
      [new TorusKnotGeometry(0.7, 0.25, 128, 16, 3, 5), '#6ee7a8'],
    ];
    showcase.forEach(([geo, color], i) => {
      const a = (i / showcase.length) * Math.PI * 2;
      const m = new Mesh(geo, createToonMaterial({ color, rimStrength: 0.55 }));
      m.position.set(Math.cos(a) * 11, 2.6, Math.sin(a) * 11);
      m.castShadow = true;
      const outline = new Mesh(geo, createOutlineMaterial(0.04));
      m.add(outline);
      this.scene.add(m);
      this.spinners.push(m);
    });

    // Kinematic spinner bar — same idea as the "Spinwheel" obstacle
    this.bar = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.7, 0));
    this.world.createCollider(
      R.ColliderDesc.cuboid(8, 0.3, 0.3).setCollisionGroups(InteractionGroups.kinematic),
      this.bar,
    );
    const hazard = createToonMaterial({ color: '#ff4f8b', emissive: '#ff2a6d', emissiveIntensity: 0.15 });
    this.barMesh = new Mesh(new RoundedBoxGeometry(16, 0.6, 0.6, 3, 0.25), hazard);
    this.barMesh.position.set(0, 0.7, 0);
    this.barMesh.castShadow = true;
    this.scene.add(this.barMesh);
    const hub = new Mesh(new CylinderGeometry(0.8, 1, 1.6, 32), createToonMaterial({ color: '#ffd23f' }));
    hub.position.y = 0.2;
    hub.castShadow = true;
    this.scene.add(hub);

    // Physics pile, one InstancedMesh per shape so the whole pile is ~3 draw calls.
    const perShape = Math.ceil(BODY_COUNT / 3);
    const shapes = [
      { geo: new SphereGeometry(0.4, 24, 12), col: () => R.ColliderDesc.ball(0.4) },
      {
        geo: new RoundedBoxGeometry(0.7, 0.7, 0.7, 2, 0.12),
        col: () => R.ColliderDesc.cuboid(0.35, 0.35, 0.35),
      },
      { geo: new CapsuleGeometry(0.3, 0.5, 4, 12), col: () => R.ColliderDesc.capsule(0.25, 0.3) },
    ];
    const tint = new Color();
    for (const shape of shapes) {
      const mesh = new InstancedMesh(
        shape.geo,
        createToonMaterial({ color: '#ffffff', rimStrength: 0.4 }),
        perShape,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < perShape; i++) {
        const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic());
        this.world.createCollider(
          shape.col().setRestitution(0.35).setFriction(0.6).setCollisionGroups(InteractionGroups.prop),
          body,
        );
        this.respawn(body, i * 0.35);
        mesh.setColorAt(i, tint.set(this.rng.pick(PALETTE)));
        this.bodies.push({ body, mesh, index: i });
      }
      this.scene.add(mesh);
    }
  }

  private respawn(body: RigidBody, heightOffset = 0): void {
    body.setTranslation({ x: this.rng.range(-6, 6), y: 6 + heightOffset, z: this.rng.range(-6, 6) }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: this.rng.range(-3, 3), y: this.rng.range(-3, 3), z: this.rng.range(-3, 3) }, true);
  }

  /** Advances physics by one fixed step. */
  fixedStep(): void {
    this.simTime += SIM_DT;
    this.bar.setNextKinematicRotation(quatFromYaw(this.simTime * 1.6, this.pq));
    this.world.step();
    for (const b of this.bodies) {
      if (b.body.translation().y < -25) this.respawn(b.body);
    }
  }

  /** Syncs visuals to physics and animates decorative motion. */
  render(dt: number, elapsed: number): void {
    for (let i = 0; i < this.spinners.length; i++) {
      const m = this.spinners[i]!;
      m.rotation.x += dt * (0.4 + i * 0.07);
      m.rotation.y += dt * (0.9 + i * 0.11);
      m.position.y = 2.6 + Math.sin(elapsed * 1.7 + i) * 0.35;
    }

    const r = this.bar.rotation();
    this.barMesh.quaternion.set(r.x, r.y, r.z, r.w);

    let lastMesh: InstancedMesh | null = null;
    for (const b of this.bodies) {
      const p = b.body.translation();
      const rot = b.body.rotation();
      this.v3.set(p.x, p.y, p.z);
      this.q.set(rot.x, rot.y, rot.z, rot.w);
      this.m4.compose(this.v3, this.q, this.s);
      b.mesh.setMatrixAt(b.index, this.m4);
      if (b.mesh !== lastMesh) {
        b.mesh.instanceMatrix.needsUpdate = true;
        lastMesh = b.mesh;
      }
    }

    this.orbit += dt * 0.12;
    this.camera.position.set(Math.cos(this.orbit) * 26, 13, Math.sin(this.orbit) * 26);
    this.camera.lookAt(0, 1.5, 0);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Number of live physics bodies, for the stats overlay. */
  get bodyCount(): number {
    return this.world.bodies.len();
  }

  dispose(): void {
    this.world.free();
    this.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
}
