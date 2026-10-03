/**
 * The 3D props of one lobby mini-game, built when the game starts and
 * disposed (meshes, materials, textures and Rapier bodies) when it ends.
 *
 * - Goal Rush: two candy goal frames (team-tinted posts and crossbar, a
 *   see-through net, a glowing goal line), with colliders so the beach ball
 *   and Tumblers bounce off the frame and the ball can only enter through
 *   the mouth.
 * - Hot Potato: a glowing potato over the holder's head that pulses faster
 *   as the fuse burns down.
 * - Target Hop: up to three ringed landing pads with light beams, gold for
 *   the 3-point ones, popping in when they respawn.
 *
 * Draw calls: Goal Rush ~5 (posts/caps/bars batch + net + lines), Hot Potato 1,
 * Target Hop 2. Allocation-free per frame.
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { float, fract, max, mix, positionWorld, smoothstep, step, uniform, uv, vec3 } from 'three/tsl';
import { createToonMaterial } from '@tumble/render';
import { PropBuilder, type PropBatch } from '@tumble/render/environment';
import { InteractionGroups, type LobbyGameKind } from '@tumble/shared';
import type { Rapier, RigidBody } from '@tumble/sim';
import type { IdlePlay } from './idlePlay.ts';
import { GOAL, LOBBY_TEAMS, TARGETS } from './lobbyGames.ts';

const POST_R = 0.09;
const GOLD = new Color('#ffd23f');
const MINT = new Color('#3ee6b4');

/**
 * Scene props for the running lobby game.
 *
 * @example
 * const props = new LobbyGameStage(scene, idle, R, 'goal');
 * props.update(dt);
 * props.dispose();
 */
export class LobbyGameStage {
  private readonly root = new Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly batches: PropBatch[] = [];
  private body: RigidBody | null = null;
  private readonly time = uniform(0);
  private t = 0;
  // Hot Potato
  private potato: Mesh | null = null;
  private potatoGlow: { value: number } | null = null;
  // Target Hop
  private pads: InstancedMesh | null = null;
  private beams: InstancedMesh | null = null;
  private readonly gens = [-1, -1, -1];
  private readonly shownAt = [0, 0, 0];
  private readonly values = [0, 0, 0];
  private readonly m4 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly dummy = new Object3D();

  /**
   * @param parent - Where the props go (the menu scene).
   * @param idle - Idle-play physics; goal colliders join its world.
   * @param R - Rapier.
   * @param kind - Which game.
   */
  constructor(
    parent: Object3D,
    private readonly idle: IdlePlay,
    private readonly R: Rapier,
    readonly kind: LobbyGameKind,
  ) {
    this.root.name = `lobby-game-${kind}`;
    parent.add(this.root);
    if (kind === 'goal') this.buildGoals();
    else if (kind === 'potato') this.buildPotato();
    else this.buildTargets();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Goal Rush
  // ---------------------------------------------------------------------------

  private buildGoals(): void {
    const { lineX, back, halfWidth: hw, height: h } = GOAL;
    const depth = back - lineX;
    const b = new PropBuilder();
    const lines = new PropBuilder();
    for (let goal = 0; goal < 2; goal++) {
      const sx = goal === 0 ? -1 : 1;
      const x = sx * lineX;
      const xb = sx * back;
      const team = LOBBY_TEAMS[goal]!.color;
      const pz = hw + POST_R;
      for (const sz of [-1, 1]) {
        b.add('cyl', x, h / 2, sz * pz, POST_R, h, POST_R, team);
        b.add('cyl', xb, (h * 0.8) / 2, sz * pz, POST_R * 0.7, h * 0.8, POST_R * 0.7, '#fff3f8');
        b.add('cyl', (x + xb) / 2, h, sz * pz, POST_R * 0.8, depth, POST_R * 0.8, '#fff3f8', [
          0,
          0,
          Math.PI / 2,
        ]);
        b.add('sphere', x, h, sz * pz, POST_R * 1.6, POST_R * 1.6, POST_R * 1.6, '#ffffff', undefined, 0.6);
      }
      b.add('cyl', x, h, 0, POST_R, pz * 2, POST_R, team, [Math.PI / 2, 0, 0]);
      // Glowing goal line and a tinted goal-mouth floor.
      lines.add('box', x, 0.012, 0, 0.1, 0.02, hw * 2, '#ffffff', undefined, 1);
      lines.add('box', (x + xb) / 2, 0.008, 0, depth, 0.012, hw * 2, team, undefined, 0.5);
    }
    const frame = b.build(true);
    const floor = lines.build(false);
    this.batches.push(frame, floor);
    for (const m of frame.meshes) this.root.add(m);
    for (const m of floor.meshes) {
      m.receiveShadow = true;
      this.root.add(m);
    }

    // Net: back, two sides and a roof per goal, as one instanced draw.
    const net = new InstancedMesh(this.track(new PlaneGeometry(1, 1)), this.track(this.netMaterial()), 8);
    net.name = 'lobby-goal-nets';
    net.frustumCulled = false;
    let i = 0;
    const place = (x: number, y: number, z: number, sx: number, sy: number, rx: number, ry: number): void => {
      const d = this.dummy;
      d.position.set(x, y, z);
      d.rotation.set(rx, ry, 0);
      d.scale.set(sx, sy, 1);
      d.updateMatrix();
      net.setMatrixAt(i++, d.matrix);
    };
    for (let goal = 0; goal < 2; goal++) {
      const sx = goal === 0 ? -1 : 1;
      const xm = (sx * (lineX + back)) / 2;
      place(sx * back, h * 0.4, 0, hw * 2, h * 0.8, 0, Math.PI / 2);
      place(xm, h / 2, -hw - POST_R, depth, h, 0, 0);
      place(xm, h / 2, hw + POST_R, depth, h, 0, 0);
      place(xm, h, 0, depth, hw * 2, -Math.PI / 2, 0);
    }
    net.instanceMatrix.needsUpdate = true;
    this.root.add(net);
    this.disposables.push(net);

    // Colliders: posts, crossbars and the closed net box around each goal mouth.
    const R = this.R;
    const world = this.idle.world;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    this.body = body;
    const add = (desc: ReturnType<Rapier['ColliderDesc']['cuboid']>): void => {
      world.createCollider(desc.setRestitution(0.5).setCollisionGroups(InteractionGroups.static), body);
    };
    for (let goal = 0; goal < 2; goal++) {
      const sx = goal === 0 ? -1 : 1;
      const x = sx * lineX;
      const xm = (sx * (lineX + back)) / 2;
      for (const sz of [-1, 1]) {
        add(R.ColliderDesc.cylinder(h / 2, POST_R).setTranslation(x, h / 2, sz * (hw + POST_R)));
        add(
          R.ColliderDesc.cuboid(depth / 2, h / 2, 0.06).setTranslation(xm, h / 2, sz * (hw + POST_R + 0.06)),
        );
      }
      add(R.ColliderDesc.cuboid(0.06, h / 2, hw + POST_R).setTranslation(sx * (back + 0.06), h / 2, 0));
      add(R.ColliderDesc.cuboid(depth / 2 + 0.05, 0.06, hw + POST_R).setTranslation(xm, h + 0.06, 0));
    }
  }

  /** A white mesh drawn only along a grid in world space, so every panel shows square holes. */
  private netMaterial(): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide, depthWrite: false });
    const cells = 5;
    const lineA = step(0.86, fract(positionWorld.y.mul(cells)));
    const lineB = step(0.86, fract(positionWorld.x.add(positionWorld.z).mul(cells)));
    mat.colorNode = vec3(1, 1, 1);
    mat.opacityNode = max(lineA, lineB).mul(0.8).add(0.06);
    return mat;
  }

  // ---------------------------------------------------------------------------
  // Hot Potato
  // ---------------------------------------------------------------------------

  private buildPotato(): void {
    const mat = this.track(
      createToonMaterial({ color: '#d98a3a', rimStrength: 0.5, emissive: '#ff4a1c', emissiveIntensity: 0 }),
    );
    const mesh = new Mesh(this.track(new IcosahedronGeometry(0.3, 2)), mat);
    mesh.scale.set(1.15, 0.85, 0.9);
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.name = 'lobby-potato';
    this.potato = mesh;
    this.potatoGlow = (mat.userData.uniforms as { emissiveIntensity: { value: number } }).emissiveIntensity;
    this.root.add(mesh);
  }

  /**
   * Puts the potato over a head, or hides it.
   *
   * @param heat - Fuse burnt, 0 (fresh) to 1 (about to pop).
   */
  setPotato(visible: boolean, x = 0, y = 0, z = 0, heat = 0): void {
    const p = this.potato;
    if (!p) return;
    p.visible = visible;
    if (!visible) return;
    const rate = 4 + heat * heat * 26;
    const beat = 0.5 + 0.5 * Math.sin(this.t * rate);
    p.position.set(x, y + Math.sin(this.t * 5) * 0.06, z);
    p.rotation.set(Math.sin(this.t * 3) * 0.3, this.t * 2.4, 0);
    const swell = 1 + beat * (0.06 + heat * 0.18);
    p.scale.set(1.15 * swell, 0.85 * swell, 0.9 * swell);
    if (this.potatoGlow) this.potatoGlow.value = 0.25 + beat * (0.4 + heat * 1.6);
  }

  // ---------------------------------------------------------------------------
  // Target Hop
  // ---------------------------------------------------------------------------

  private buildTargets(): void {
    const n = TARGETS.count;
    const padMat = this.track(new MeshBasicNodeMaterial());
    const st = uv().sub(0.5);
    const rings = fract(st.length().mul(5).sub(this.time.mul(1.2)));
    const band = smoothstep(0.35, 0.5, rings).mul(smoothstep(1, 0.85, rings));
    padMat.colorNode = mix(vec3(0.75, 0.75, 0.75), vec3(1.4, 1.4, 1.4), band);
    const pads = new InstancedMesh(
      this.track(new CylinderGeometry(TARGETS.radius, TARGETS.radius * 1.05, 0.08, 40)),
      padMat,
      n,
    );
    pads.name = 'lobby-targets';
    pads.frustumCulled = false;
    pads.receiveShadow = true;

    const beamMat = this.track(
      new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    );
    beamMat.colorNode = vec3(1, 1, 1);
    // Fades out toward the top of the beam.
    beamMat.opacityNode = float(1).sub(uv().y).mul(0.35);
    const beams = new InstancedMesh(
      this.track(new CylinderGeometry(TARGETS.radius * 0.7, TARGETS.radius * 0.95, 3, 24, 1, true)),
      beamMat,
      n,
    );
    beams.name = 'lobby-target-beams';
    beams.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      pads.setColorAt(i, MINT);
      beams.setColorAt(i, MINT);
    }
    this.pads = pads;
    this.beams = beams;
    this.disposables.push(pads, beams);
    this.root.add(pads, beams);
    this.writeTargets();
  }

  /**
   * Shows the targets from a snapshot (`[x, z, value, gen]` per slot).
   * Allocation-free; a new generation pops in.
   */
  setTargets(targets: readonly number[]): void {
    if (!this.pads) return;
    for (let s = 0; s < TARGETS.count; s++) {
      const i = s * 4;
      const value = i + 3 < targets.length ? targets[i + 2]! : 0;
      const gen = i + 3 < targets.length ? targets[i + 3]! : -1;
      if (gen !== this.gens[s] || value > 0 !== this.values[s]! > 0) {
        if (value > 0 && (gen !== this.gens[s] || this.values[s] === 0)) this.shownAt[s] = this.t;
        this.gens[s] = gen;
        this.values[s] = value;
        const c = value >= 3 ? GOLD : MINT;
        this.pads.setColorAt(s, c);
        this.beams!.setColorAt(s, c);
        if (this.pads.instanceColor) this.pads.instanceColor.needsUpdate = true;
        if (this.beams!.instanceColor) this.beams!.instanceColor.needsUpdate = true;
      }
      this.posX[s] = value > 0 ? targets[i]! : 0;
      this.posZ[s] = value > 0 ? targets[i + 1]! : 0;
    }
  }

  private readonly posX = [0, 0, 0];
  private readonly posZ = [0, 0, 0];

  private writeTargets(): void {
    const pads = this.pads;
    const beams = this.beams;
    if (!pads || !beams) return;
    for (let s = 0; s < TARGETS.count; s++) {
      const live = this.values[s]! > 0;
      // Spring pop-in over ~0.35 s after a (re)spawn.
      const age = this.t - this.shownAt[s]!;
      const k = live ? Math.min(1, age / 0.35) : 0;
      const pop = live ? 1 + Math.sin(k * Math.PI) * 0.25 : 0.0001;
      const bob = live ? 1 + Math.sin(this.t * 4 + s) * 0.04 : 0.0001;
      const x = this.posX[s]!;
      const z = this.posZ[s]!;
      this.q.identity();
      this.m4.compose(this.v.set(x, 0.05, z), this.q, this.s.set(pop * bob, 1, pop * bob));
      pads.setMatrixAt(s, this.m4);
      this.m4.compose(this.v.set(x, 1.55, z), this.q, this.s.set(pop, live ? k : 0.0001, pop));
      beams.setMatrixAt(s, this.m4);
    }
    pads.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------

  /** Shows or hides every prop of the game (the Locker and Store close-ups hide them). */
  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  /** Advances animation. */
  update(dt: number): void {
    this.t += dt;
    this.time.value = this.t;
    for (const b of this.batches) b.update(dt);
    if (this.pads) this.writeTargets();
  }

  /** Removes every mesh, material, texture and collider this game added. */
  dispose(): void {
    this.root.removeFromParent();
    for (const b of this.batches) b.dispose();
    for (const d of this.disposables) d.dispose();
    if (this.body) this.idle.world.removeRigidBody(this.body);
    this.body = null;
  }
}
