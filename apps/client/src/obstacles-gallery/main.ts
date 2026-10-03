/**
 * Obstacle gallery (`/obstacles.html`): every obstacle from every set,
 * animating on a candy island with a live Rapier world.
 *
 * Responsibilities:
 * - Discover sim modules + visual factories (any `set-*.ts`) and lay them out
 *   in a grid of cells, each with a floating label.
 * - Step all obstacle runtimes with a FixedStepper, route contacts/triggers to
 *   them, and drop demo balls (ObstacleActors) so interactions are visible.
 * - Mirror the sim with the visuals at interpolated match time.
 * - lil-gui: focus an obstacle, live-edit its params (rebuilds it), time scale,
 *   pause, difficulty speed scale; FPS / draw-call overlay; event log.
 */
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import GUI from 'lil-gui';
import { createRenderer, createSkyDome, createToonMaterial } from '@tumble/render';
import {
  EventSink,
  FixedStepper,
  SurfaceRegistry,
  createWorld,
  loadRapier,
  type ObstacleInstance,
  type ObstacleRuntime,
  type ObstacleStepContext,
  type Rapier,
  type SimEvent,
  type World,
} from '@tumble/sim';
import { InteractionGroups, Rng, SIM_DT, hashString, type Vec3 } from '@tumble/shared';
import type { ObstacleVisual } from '../../../../packages/render/src/obstacles/types.ts';
import { StatsOverlay } from '../debug/stats.ts';
import { BALL_RADIUS, BallActor, ContactRouter } from './actors.ts';
import { buildParamControls } from './gui.ts';
import { DEFAULT_PRESET, GALLERY_PRESETS, type GalleryPreset } from './presets.ts';
import { discoverObstacles, type Discovery, type GalleryObstacleDef } from './registry.ts';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CELL = 30;
const SEED = 0x7e57ab1e;
const BALL_LIFETIME = 14;
const KILL_Y = -18;
const BALL_COLORS = ['#ff6fb5', '#ffd23f', '#5ce1e6', '#7c5cff', '#ff8a3d', '#6ee7a8', '#ffffff'];
const OVERVIEW = 'overview';
const LABEL_RANGE = 80;

/** One grid cell: an obstacle type, its live runtime/visual and its demo balls. */
interface Cell {
  def: GalleryObstacleDef;
  id: string;
  center: Vec3;
  preset: GalleryPreset;
  /** Editable params (already schema-parsed). */
  params: Record<string, unknown>;
  runtime: ObstacleRuntime | null;
  visual: ObstacleVisual | null;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  balls: BallActor[];
  step: ObstacleStepContext;
  error: string | null;
  /** Label currently collapsed for distance. */
  far: boolean;
}

// -----------------------------------------------------------------------------
// Gallery
// -----------------------------------------------------------------------------

class ObstacleGallery {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, 0.1, 900);
  private readonly world: World;
  private readonly surfaces = new SurfaceRegistry();
  private readonly events = new EventSink();
  private readonly router: ContactRouter;
  private readonly cells: Cell[] = [];
  private readonly runtimeByCollider = new Map<number, ObstacleRuntime>();
  private readonly allBalls: BallActor[] = [];
  private readonly ballMesh: InstancedMesh;
  private readonly rng = new Rng(SEED);
  private readonly stepper: FixedStepper;
  private readonly controls: OrbitControls;
  private readonly labels: CSS2DRenderer;
  private readonly sun: DirectionalLight;
  private readonly focusTarget = new Vector3();
  private readonly focusEye = new Vector3();
  private focusing = false;
  private readonly log: HTMLDivElement;
  private readonly logLines: string[] = [];
  private paramsFolder: GUI | null = null;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly one = new Vector3(1, 1, 1);
  private readonly span: number;

  readonly settings = {
    focus: OVERVIEW,
    timeScale: 1,
    paused: false,
    speedScale: 1,
    labels: true,
    balls: true,
  };

  constructor(
    private readonly R: Rapier,
    private readonly renderer: WebGPURenderer,
    private readonly gui: GUI,
    discovery: Discovery,
  ) {
    this.world = createWorld(R);
    this.router = new ContactRouter(this.world, this.surfaces);

    this.scene.add(createSkyDome());
    this.scene.fog = new Fog(new Color('#ffd6f2'), 140, 420);
    this.scene.add(new HemisphereLight('#dff1ff', '#ffc9e6', 1.35));
    this.sun = new DirectionalLight('#fff3dc', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -36;
    sc.right = 36;
    sc.top = 36;
    sc.bottom = -36;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    const defs = discovery.defs;
    const cols = Math.max(1, Math.ceil(Math.sqrt(defs.length)));
    const rows = Math.max(1, Math.ceil(defs.length / cols));
    this.span = Math.max(cols, rows) * CELL;
    this.buildIsland(cols * CELL, rows * CELL);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    document.body.appendChild(this.labels.domElement);

    defs.forEach((def, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const center = { x: (c - (cols - 1) / 2) * CELL, y: 0, z: (r - (rows - 1) / 2) * CELL };
      this.cells.push(this.createCell(def, center));
    });

    const totalBalls = this.cells.reduce((n, cell) => n + (cell.preset.balls ?? DEFAULT_PRESET.balls), 0);
    this.ballMesh = new InstancedMesh(
      new SphereGeometry(BALL_RADIUS, 20, 12),
      createToonMaterial({ color: '#ffffff', rimStrength: 0.5 }),
      Math.max(1, totalBalls),
    );
    this.ballMesh.castShadow = true;
    this.ballMesh.frustumCulled = false;
    this.scene.add(this.ballMesh);
    const tint = new Color();
    for (const cell of this.cells) {
      const n = cell.preset.balls ?? DEFAULT_PRESET.balls;
      for (let k = 0; k < n; k++) {
        const ball = new BallActor(R, this.world, this.allBalls.length);
        this.ballMesh.setColorAt(ball.id, tint.set(BALL_COLORS[ball.id % BALL_COLORS.length]!));
        this.router.addBall(ball);
        cell.balls.push(ball);
        this.allBalls.push(ball);
        this.respawnBall(cell, ball, k * 0.9);
      }
    }

    for (const cell of this.cells) this.buildObstacle(cell);

    this.stepper = new FixedStepper((tick) => this.fixedStep(tick));
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('start', () => (this.focusing = false));
    this.focus(OVERVIEW, true);

    this.log = document.createElement('div');
    this.log.className = 'event-log';
    document.body.appendChild(this.log);

    this.buildGui();
    for (const f of discovery.failures) this.logLines.push(`set failed: ${f.file} — ${f.error}`);
    this.log.textContent = this.logLines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Scene dressing
  // ---------------------------------------------------------------------------

  private buildIsland(w: number, d: number): void {
    const radius = Math.hypot(w, d) / 2 + 8;
    const top = createToonMaterial({ color: '#8ef0c6', rimStrength: 0.2 });
    const ground = new Object3D();
    const slab = new Mesh(new CylinderGeometry(radius, radius, 1.2, 96), top);
    slab.position.y = -0.6;
    slab.receiveShadow = true;
    const under = new Mesh(
      new CylinderGeometry(radius, radius * 0.35, 18, 64),
      createToonMaterial({ color: '#ffb3d9' }),
    );
    under.position.y = -10.2;
    ground.add(slab, under);
    this.scene.add(ground);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    this.world.createCollider(
      this.R.ColliderDesc.cylinder(0.6, radius)
        .setTranslation(0, -0.6, 0)
        .setCollisionGroups(InteractionGroups.static),
      body,
    );

    // Cell rings so each exhibit reads as its own stage.
    const rings = new InstancedMesh(
      new TorusGeometry(CELL * 0.46, 0.18, 8, 96),
      createToonMaterial({ color: '#ffffff', rimStrength: 0 }),
      64,
    );
    rings.count = 0;
    this.scene.add(rings);
    this.cellRings = rings;

    // Drifting background puffs (one draw call).
    const puffs = new InstancedMesh(
      new IcosahedronGeometry(1, 2),
      createToonMaterial({ color: '#ffffff', rimStrength: 0.2 }),
      40,
    );
    const m = new Matrix4();
    const p = new Vector3();
    const s = new Vector3();
    const q = new Quaternion();
    for (let i = 0; i < 40; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = radius + this.rng.range(40, 140);
      p.set(Math.cos(a) * r, this.rng.range(-30, 40), Math.sin(a) * r);
      const k = this.rng.range(5, 14);
      s.set(k * 1.6, k, k);
      puffs.setMatrixAt(i, m.compose(p, q, s));
    }
    this.scene.add(puffs);
  }

  private cellRings: InstancedMesh | null = null;

  // ---------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------

  private createCell(def: GalleryObstacleDef, center: Vec3): Cell {
    const preset = GALLERY_PRESETS[def.type] ?? {};
    const id = `${def.type}-gallery`;
    let params: Record<string, unknown> = {};
    let error: string | null = null;
    try {
      params = def.module.schema.parse({ ...(preset.params ?? {}) }) as Record<string, unknown>;
    } catch (e) {
      error = `params: ${(e as Error).message}`;
    }
    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    const label = new CSS2DObject(labelEl);
    label.position.set(center.x, 9, center.z - CELL * 0.3);
    this.scene.add(label);
    labelEl.addEventListener('click', () => {
      this.settings.focus = id;
      this.focus(id);
      this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    });
    if (this.cellRings) {
      const i = this.cellRings.count++;
      this.cellRings.setMatrixAt(i, this.m.makeRotationX(Math.PI / 2).setPosition(center.x, 0.02, center.z));
    }
    const step: ObstacleStepContext = { t: 0, dt: SIM_DT, tick: 0, events: this.events, actors: [] };
    return {
      def,
      id,
      center,
      preset,
      params,
      runtime: null,
      visual: null,
      label,
      labelEl,
      balls: [],
      step,
      error,
      far: false,
    };
  }

  private instanceOf(cell: Cell): ObstacleInstance {
    const o = cell.preset.offset ?? { x: 0, y: 0, z: 0 };
    return {
      id: cell.id,
      type: cell.def.type,
      position: { x: cell.center.x + o.x, y: cell.center.y + o.y, z: cell.center.z + o.z },
      rotation: { yaw: cell.preset.yaw ?? 0 },
      params: cell.params,
    };
  }

  /** (Re)creates a cell's runtime and visual from its current params. */
  private buildObstacle(cell: Cell): void {
    this.disposeObstacle(cell);
    if (cell.error?.startsWith('params')) {
      this.updateLabel(cell);
      return;
    }
    cell.error = null;
    try {
      cell.params = cell.def.module.schema.parse(cell.params) as Record<string, unknown>;
      const instance = this.instanceOf(cell);
      cell.runtime = cell.def.module.create(instance, {
        R: this.R,
        world: this.world,
        surfaces: this.surfaces,
        events: this.events,
        rng: new Rng((SEED ^ hashString(instance.id)) >>> 0),
        speedScale: this.settings.speedScale,
      });
      for (const c of cell.runtime.colliders) this.runtimeByCollider.set(c.handle, cell.runtime);
      if (cell.def.visual) {
        cell.visual = cell.def.visual(instance, {
          theme: 'candy',
          speedScale: this.settings.speedScale,
          seed: SEED,
        });
        this.scene.add(cell.visual.object);
      }
    } catch (e) {
      cell.error = (e as Error).message;
      console.error(`[gallery] ${cell.def.type}`, e);
      this.disposeObstacle(cell);
    }
    cell.step.actors = cell.balls;
    this.updateLabel(cell);
  }

  private disposeObstacle(cell: Cell): void {
    if (cell.runtime) {
      for (const c of cell.runtime.colliders) this.runtimeByCollider.delete(c.handle);
      cell.runtime.dispose();
      cell.runtime = null;
    }
    if (cell.visual) {
      cell.visual.dispose();
      cell.visual = null;
    }
  }

  private updateLabel(cell: Cell): void {
    const name = cell.def.module.displayName;
    cell.labelEl.innerHTML = '';
    const title = document.createElement('b');
    title.textContent = name;
    const sub = document.createElement('span');
    sub.textContent = `${cell.def.type} · ${cell.def.source}${cell.def.visual ? '' : ' · no visual'}`;
    cell.labelEl.append(title, sub);
    if (cell.error) {
      const err = document.createElement('em');
      err.textContent = cell.error;
      cell.labelEl.append(err);
    }
    cell.labelEl.classList.toggle('error', cell.error !== null);
  }

  private respawnBall(cell: Cell, ball: BallActor, extraHeight = 0): void {
    const s = cell.preset.spawn ?? DEFAULT_PRESET.spawn;
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * s.radius;
    const vel = cell.preset.ballVelocity ?? { x: 0, y: 0, z: 0 };
    ball.spawn(
      {
        x: cell.center.x + s.x + Math.cos(a) * r,
        y: s.height + extraHeight + this.rng.range(0, 2),
        z: cell.center.z + s.z + Math.sin(a) * r,
      },
      { x: vel.x + this.rng.range(-0.5, 0.5), y: vel.y, z: vel.z + this.rng.range(-0.5, 0.5) },
      { x: this.rng.range(-2, 2), y: this.rng.range(-2, 2), z: this.rng.range(-2, 2) },
    );
    ball.age = -this.rng.range(0, 4);
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  private fixedStep(tick: number): void {
    const t = (tick + 1) * SIM_DT;
    for (const cell of this.cells) {
      if (!cell.runtime) continue;
      cell.step.t = t;
      cell.step.tick = tick + 1;
      try {
        cell.runtime.update(cell.step);
      } catch (e) {
        cell.error = `update: ${(e as Error).message}`;
        console.error(`[gallery] ${cell.def.type}`, e);
        this.disposeObstacle(cell);
        this.updateLabel(cell);
      }
    }
    this.world.step();
    for (const cell of this.cells) if (cell.runtime) this.router.route(cell.runtime, cell.step);
    const any = this.cells[0]?.step;
    if (any) this.router.flushExits(tick + 1, this.runtimeByCollider, any);

    for (const cell of this.cells) {
      for (const ball of cell.balls) {
        ball.age += SIM_DT;
        if (ball.doomed || ball.age > BALL_LIFETIME || ball.body.translation().y < KILL_Y)
          this.respawnBall(cell, ball);
      }
    }
    const drained = this.events.drain();
    if (drained.length) this.logEvents(drained, t);
  }

  private logEvents(events: SimEvent[], t: number): void {
    for (const e of events) {
      let line: string;
      switch (e.type) {
        case 'obstacleCue':
          line = `${e.obstacle} ♪ ${e.cue}`;
          break;
        case 'bounce':
          line = `ball ${e.player} bounced on ${e.obstacle ?? '?'}`;
          break;
        case 'tileWarn':
        case 'tileFell':
          line = `${e.obstacle} ${e.type} #${e.tile}`;
          break;
        default:
          line = e.type;
      }
      this.logLines.push(`${t.toFixed(2).padStart(7)}  ${line}`);
    }
    if (this.logLines.length > 9) this.logLines.splice(0, this.logLines.length - 9);
    this.log.textContent = this.logLines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Camera & GUI
  // ---------------------------------------------------------------------------

  private focus(id: string, snap = false): void {
    const cell = this.cells.find((c) => c.id === id);
    if (!cell) {
      this.focusTarget.set(0, 0, 0);
      this.focusEye.set(0, this.span * 0.8, this.span * 0.6);
    } else {
      this.focusTarget.set(cell.center.x, 2.5, cell.center.z);
      this.focusEye.set(cell.center.x + 15, 13, cell.center.z + 20);
    }
    if (snap) {
      this.controls.target.copy(this.focusTarget);
      this.camera.position.copy(this.focusEye);
    }
    this.focusing = !snap;
    this.rebuildParamsFolder(cell ?? null);
  }

  private rebuildParamsFolder(cell: Cell | null): void {
    this.paramsFolder?.destroy();
    this.paramsFolder = null;
    if (!cell) return;
    const folder = this.gui.addFolder(`Params · ${cell.def.module.displayName}`);
    buildParamControls(folder, cell.def.module.schema, cell.params, () => this.buildObstacle(cell));
    folder.add({ rebuild: () => this.buildObstacle(cell) }, 'rebuild').name('rebuild obstacle');
    folder.add({ reset: () => this.resetParams(cell) }, 'reset').name('reset params');
    this.paramsFolder = folder;
  }

  private resetParams(cell: Cell): void {
    cell.params = cell.def.module.schema.parse({ ...(cell.preset.params ?? {}) }) as Record<string, unknown>;
    this.buildObstacle(cell);
    this.rebuildParamsFolder(cell);
  }

  private buildGui(): void {
    const s = this.settings;
    const ids = [OVERVIEW, ...this.cells.map((c) => c.id)];
    this.gui
      .add(s, 'focus', ids)
      .name('focus')
      .onChange((id: string) => this.focus(id));
    this.gui.add(s, 'timeScale', 0, 3, 0.05).name('time scale');
    this.gui.add(s, 'paused');
    this.gui
      .add(s, 'speedScale', 0.5, 2, 0.05)
      .name('difficulty speed')
      .onFinishChange(() => this.rebuildAll());
    this.gui
      .add(s, 'labels')
      .onChange((v: boolean) => (this.labels.domElement.style.display = v ? '' : 'none'));
    this.gui.add(s, 'balls').name('demo balls');
    this.gui.add({ drop: () => this.dropAllBalls() }, 'drop').name('drop balls now');
    this.gui.add({ reset: () => this.resetTime() }, 'reset').name('restart clock');
  }

  private rebuildAll(): void {
    for (const cell of this.cells) this.buildObstacle(cell);
  }

  private dropAllBalls(): void {
    for (const cell of this.cells) cell.balls.forEach((b, k) => this.respawnBall(cell, b, k * 0.6));
  }

  private resetTime(): void {
    this.stepper.reset(0);
    this.rebuildAll();
    this.dropAllBalls();
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  /** Advances the sim by scaled wall time and renders. */
  frame(dt: number): void {
    const s = this.settings;
    const simDt = s.paused ? 0 : dt * s.timeScale;
    this.stepper.advance(simDt);
    const t = (this.stepper.tick + this.stepper.alpha) * SIM_DT;
    for (const cell of this.cells) cell.visual?.update(t, simDt, cell.runtime ?? undefined);

    for (const ball of this.allBalls) {
      const p = ball.body.translation();
      const r = ball.body.rotation();
      this.v.set(p.x, p.y, p.z);
      this.q.set(r.x, r.y, r.z, r.w);
      this.m.compose(this.v, this.q, this.one);
      if (!s.balls) this.m.makeScale(0, 0, 0);
      this.ballMesh.setMatrixAt(ball.id, this.m);
    }
    this.ballMesh.instanceMatrix.needsUpdate = true;

    if (this.focusing) {
      const k = 1 - Math.pow(0.02, dt);
      this.controls.target.lerp(this.focusTarget, k);
      this.camera.position.lerp(this.focusEye, k);
      if (this.camera.position.distanceToSquared(this.focusEye) < 0.05) this.focusing = false;
    }
    this.controls.update();
    // Distant labels collapse to just the name so the overview stays readable.
    for (const cell of this.cells) {
      const far = this.camera.position.distanceTo(cell.label.position) > LABEL_RANGE;
      if (far !== cell.far) {
        cell.far = far;
        cell.labelEl.classList.toggle('far', far);
      }
    }
    const tgt = this.controls.target;
    this.sun.position.set(tgt.x + 30, 55, tgt.z + 22);
    this.sun.target.position.copy(tgt);

    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.labels.setSize(w, h);
  }

  /** Live physics bodies, for the stats overlay. */
  get bodyCount(): number {
    return this.world.bodies.len();
  }

  /** Obstacles currently built. */
  get liveObstacles(): number {
    return this.cells.filter((c) => c.runtime).length;
  }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

async function boot(): Promise<void> {
  const canvas = document.getElementById('gallery') as HTMLCanvasElement;
  const status = document.getElementById('status') as HTMLDivElement;
  const backendPref = new URLSearchParams(location.search).get('backend') === 'webgl' ? 'webgl' : 'auto';
  const [{ renderer, backend }, R] = await Promise.all([createRenderer(canvas, backendPref), loadRapier()]);
  const gui = new GUI({ title: 'Obstacle Gallery' });
  const discovery = await discoverObstacles();
  for (const f of discovery.failures) console.warn(`[gallery] could not load ${f.file}: ${f.error}`);
  const gallery = new ObstacleGallery(R, renderer, gui, discovery);
  // Dev handle for e2e screenshots and console poking.
  (window as unknown as { __gallery: ObstacleGallery }).__gallery = gallery;
  const stats = new StatsOverlay(document.body);
  stats.set('gpu', backend);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    gallery.resize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();
  status.remove();

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    gallery.frame(dt);
    stats.set('obst', gallery.liveObstacles);
    stats.set('body', gallery.bodyCount);
    stats.update(dt, renderer);
  });
}

boot().catch((e: unknown) => {
  const status = document.getElementById('status');
  if (status) status.textContent = `Gallery failed to start: ${(e as Error).message}`;
  console.error(e);
});
