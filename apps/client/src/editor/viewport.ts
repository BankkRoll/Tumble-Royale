/**
 * The editor's 3D view: the round drawn with the game's own level, obstacle
 * and environment visuals, plus editing aids (grid, trigger volumes, spawn
 * grid, selection boxes) and the move/rotate/scale gizmo.
 *
 * Responsibilities:
 * - rebuild visuals when the store's round changes (whole level, obstacles
 *   individually by content, aids every time; all cheap at editor budgets);
 * - click to place the palette item or to select (Shift adds/removes);
 * - gizmo drags preview live and commit one undo step on release, snapped
 *   to the store's grid and rotation steps.
 */
import {
  AxesHelper,
  BoxGeometry,
  Box3,
  Clock,
  Color,
  EdgesGeometry,
  Euler,
  GridHelper,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  CylinderGeometry,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { spawnGrid } from '@tumble/content/custom';
import { getTheme } from '@tumble/content/themes';
import { createRenderer, type BackendPreference } from '@tumble/render';
import { createEnvironment, type Environment } from '@tumble/render/environment';
import { buildLevelVisuals, type LevelVisuals } from '@tumble/render/level';
import { getObstacleVisual, type ObstacleVisual } from '@tumble/render/obstacles';
import {
  MAX_PLAYERS,
  RoundDefinitionSchema,
  type RoundDefinition,
  type RoundDefinitionInput,
} from '@tumble/shared';
import { getObstacleModule, type ObstacleInstance } from '@tumble/sim/obstacles';
import type { StoreApi } from 'zustand/vanilla';
import { refKey, type ItemRef } from './model.ts';
import type { EditorState } from './store.ts';

const DEG = Math.PI / 180;
const TRIGGER_COLORS: Record<string, string> = { checkpoint: '#3fd2ff', finish: '#ffd23f', void: '#ff4f6d' };

interface ObstacleEntry {
  json: string;
  visual: ObstacleVisual | null;
  object: Object3D;
}

/** Debug hooks for browser checks. */
export interface EditorDebug {
  ready: boolean;
  backend: string;
  /** Objects drawn for the round (level meshes, obstacles, aids). */
  counts(): { obstacles: number; proxies: number; selected: number };
}

declare global {
  interface Window {
    __editor?: EditorDebug;
  }
}

/** The editor's 3D view. */
export class EditorViewport {
  private renderer!: WebGPURenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(55, 1, 0.1, 3000);
  private orbit!: OrbitControls;
  private gizmo!: TransformControls;
  private readonly pivot = new Object3D();
  private readonly world = new Group();
  private readonly aids = new Group();
  private readonly proxies = new Group();
  private readonly highlight = new Group();
  private env: Environment | null = null;
  private envTheme = '';
  private level: LevelVisuals | null = null;
  private levelKey: unknown = null;
  private readonly obstacles = new Map<string, ObstacleEntry>();
  private rebuildTimer = 0;
  private readonly clock = new Clock();
  private readonly ray = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private down: { x: number; y: number } | null = null;
  private drag: { start: Vector3; rot: number; scale: Vector3; moved: Map<Object3D, Vector3> } | null = null;
  private readonly unsub: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: StoreApi<EditorState>,
  ) {}

  /** Creates the renderer and starts drawing. */
  async init(backend: BackendPreference = 'auto'): Promise<EditorDebug> {
    const info = await createRenderer(this.canvas, backend);
    this.renderer = info.renderer;
    this.scene.add(this.world, this.aids, this.proxies, this.highlight, this.pivot);
    const grid = new GridHelper(400, 200, new Color('#ffffff'), new Color('#9fb6d8'));
    (grid.material as LineBasicMaterial).transparent = true;
    (grid.material as LineBasicMaterial).opacity = 0.35;
    grid.position.y = 0.01;
    this.scene.add(grid, new AxesHelper(3));

    this.camera.position.set(28, 26, -26);
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 0, 20);

    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setSpace('world');
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener('mouseDown', () => this.beginDrag());
    this.gizmo.addEventListener('objectChange', () => this.previewDrag());
    this.gizmo.addEventListener('mouseUp', () => this.endDrag());

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.resize);
    this.resize();

    this.unsub.push(
      this.store.subscribe((s, prev) => {
        if (s.round !== prev.round) this.scheduleRebuild();
        if (s.selection !== prev.selection || s.round !== prev.round) this.syncSelection();
        if (s.gizmo !== prev.gizmo || s.snapStep !== prev.snapStep || s.rotateStep !== prev.rotateStep)
          this.syncGizmo();
      }),
    );
    this.rebuild();
    this.syncGizmo();
    this.focusOn(this.store.getState().round.spawn.origin, 40);
    this.renderer.setAnimationLoop(() => this.frame());

    const debug: EditorDebug = {
      ready: true,
      backend: info.backend,
      counts: () => ({
        obstacles: this.obstacles.size,
        proxies: this.proxies.children.length,
        selected: this.store.getState().selection.length,
      }),
    };
    window.__editor = debug;
    return debug;
  }

  /** Points the camera at a spot from a comfortable distance. */
  focusOn(p: { x: number; y: number; z: number }, distance = 25): void {
    this.orbit.target.set(p.x, p.y, p.z);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.6, 0.6, -0.5).normalize();
    this.camera.position.copy(this.orbit.target).addScaledVector(dir, distance);
  }

  /** Frames the current selection (or the spawn). */
  focusSelection(): void {
    const s = this.store.getState();
    const box = new Box3();
    for (const p of this.proxies.children)
      if (s.selection.some((r) => refKey(r) === p.userData.key)) box.expandByObject(p);
    if (box.isEmpty()) this.focusOn(s.round.spawn.origin, 40);
    else this.focusOn(box.getCenter(new Vector3()), Math.max(12, box.getSize(new Vector3()).length() * 1.4));
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.rebuildTimer);
    for (const u of this.unsub) u();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.resize);
    this.renderer?.setAnimationLoop(null);
    this.gizmo?.dispose();
    this.orbit?.dispose();
    this.level?.dispose();
    for (const o of this.obstacles.values()) o.visual?.dispose();
    this.env?.dispose();
    this.renderer?.dispose();
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private readonly resize = (): void => {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  private frame(): void {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.orbit.update();
    this.env?.update(dt, this.camera, this.orbit.target);
    this.level?.update(0, dt);
    for (const o of this.obstacles.values()) o.visual?.update(0, dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------
  // Building the round
  // ---------------------------------------------------------------------------

  private scheduleRebuild(): void {
    window.clearTimeout(this.rebuildTimer);
    // Dragging a slider fires many edits; rebuild once it settles.
    this.rebuildTimer = window.setTimeout(() => this.rebuild(), 90);
  }

  private rebuild(): void {
    if (this.disposed) return;
    const input = this.store.getState().round;
    const parsed = RoundDefinitionSchema.safeParse(input);
    if (!parsed.success) return;
    const round = parsed.data;
    this.rebuildEnvironment(round);
    this.rebuildLevel(input, round);
    this.rebuildObstacles(round);
    this.rebuildAids(round);
    this.syncSelection();
  }

  private rebuildEnvironment(round: RoundDefinition): void {
    if (this.env && this.envTheme === round.theme) return;
    this.env?.dispose();
    this.env = createEnvironment(getTheme(round.theme), {
      seed: round.decorSeed,
      courseBounds: { min: { x: -60, y: -4, z: -40 }, max: { x: 60, y: 30, z: 160 } },
    });
    this.env.attach(this.scene);
    this.envTheme = round.theme;
  }

  private rebuildLevel(input: RoundDefinitionInput, round: RoundDefinition): void {
    const key = `${round.theme}|${JSON.stringify(input.geometry)}`;
    if (key === this.levelKey) return;
    this.levelKey = key;
    if (this.level) {
      this.world.remove(this.level.object);
      this.level.dispose();
    }
    this.level = buildLevelVisuals(round, getTheme(round.theme));
    this.world.add(this.level.object);
  }

  private rebuildObstacles(round: RoundDefinition): void {
    const seen = new Set<string>();
    for (const o of round.obstacles) {
      seen.add(o.id);
      const json = JSON.stringify([o, round.theme]);
      const cur = this.obstacles.get(o.id);
      if (cur?.json === json) continue;
      if (cur) this.removeObstacle(o.id, cur);
      this.obstacles.set(o.id, { json, ...this.buildObstacle(o, round) });
    }
    for (const [id, entry] of this.obstacles) if (!seen.has(id)) this.removeObstacle(id, entry);
  }

  private buildObstacle(
    o: RoundDefinition['obstacles'][number],
    round: RoundDefinition,
  ): { visual: ObstacleVisual | null; object: Object3D } {
    const mod = getObstacleModule(o.type);
    const params = mod?.schema.safeParse(o.params);
    const factory = getObstacleVisual(o.type);
    if (mod && params?.success && factory) {
      try {
        const instance = { ...o, params: params.data } as ObstacleInstance;
        const visual = factory(instance, { theme: round.theme, speedScale: 1, seed: 1 });
        visual.update(0, 0);
        this.world.add(visual.object);
        return { visual, object: visual.object };
      } catch {
        // Falls through to the placeholder: an obstacle whose params build nothing still needs a handle.
      }
    }
    const box = new Mesh(
      new BoxGeometry(2, 2, 2),
      new MeshBasicMaterial({ color: '#ff4f6d', wireframe: true }),
    );
    box.position.set(o.position.x, o.position.y + 1, o.position.z);
    this.world.add(box);
    return { visual: null, object: box };
  }

  private removeObstacle(id: string, entry: ObstacleEntry): void {
    this.world.remove(entry.object);
    entry.visual?.dispose();
    this.obstacles.delete(id);
  }

  /** Trigger volumes, spawn grid and the invisible pick boxes. */
  private rebuildAids(round: RoundDefinition): void {
    for (const g of [this.aids, this.proxies]) {
      for (const c of [...g.children]) {
        g.remove(c);
        c.traverse((x) => {
          const m = x as Mesh;
          m.geometry?.dispose();
        });
      }
    }
    const pickMat = new MeshBasicMaterial({ visible: false });
    const addProxy = (ref: ItemRef, size: Vector3, pos: Vector3, rot?: Euler) => {
      const m = new Mesh(
        new BoxGeometry(Math.max(size.x, 0.3), Math.max(size.y, 0.3), Math.max(size.z, 0.3)),
        pickMat,
      );
      m.position.copy(pos);
      if (rot) m.rotation.copy(rot);
      m.userData.ref = ref;
      m.userData.key = refKey(ref);
      this.proxies.add(m);
    };
    round.geometry.forEach((g, index) => {
      const s = g.size;
      const size =
        g.shape === 'cylinder' || g.shape === 'hexPrism'
          ? new Vector3(s.x * 2, s.y, s.x * 2)
          : g.shape === 'sphere'
            ? new Vector3(s.x * 2, s.x * 2, s.x * 2)
            : g.shape === 'torus'
              ? new Vector3((s.x + s.y) * 2, s.y * 2, (s.x + s.y) * 2)
              : new Vector3(s.x, s.y, s.z);
      const r = g.rotation;
      addProxy(
        { kind: 'geometry', index },
        size,
        new Vector3(g.position.x, g.position.y, g.position.z),
        new Euler((r?.pitch ?? 0) * DEG, (r?.yaw ?? 0) * DEG, (r?.roll ?? 0) * DEG, 'YXZ'),
      );
    });
    for (const o of round.obstacles) {
      const entry = this.obstacles.get(o.id);
      const box = entry ? new Box3().setFromObject(entry.object) : new Box3();
      if (box.isEmpty() || !Number.isFinite(box.min.x))
        box.setFromCenterAndSize(
          new Vector3(o.position.x, o.position.y + 1, o.position.z),
          new Vector3(2, 2, 2),
        );
      addProxy({ kind: 'obstacle', id: o.id }, box.getSize(new Vector3()), box.getCenter(new Vector3()));
    }
    for (const t of round.triggers) {
      const color = TRIGGER_COLORS[t.kind] ?? '#ffffff';
      const geo = new BoxGeometry(t.size.x, t.size.y, t.size.z);
      const vol = new Mesh(
        geo,
        new MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
      );
      const edges = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color }));
      const rot = new Euler(
        (t.rotation?.pitch ?? 0) * DEG,
        (t.rotation?.yaw ?? 0) * DEG,
        (t.rotation?.roll ?? 0) * DEG,
        'YXZ',
      );
      for (const m of [vol, edges]) {
        m.position.set(t.position.x, t.position.y, t.position.z);
        m.rotation.copy(rot);
        this.aids.add(m);
      }
      for (const p of t.respawn) {
        const dot = new Mesh(new CylinderGeometry(0.35, 0.35, 0.1, 10), new MeshBasicMaterial({ color }));
        dot.position.set(p.x, p.y + 0.05, p.z);
        this.aids.add(dot);
      }
      addProxy(
        { kind: 'trigger', id: t.id },
        new Vector3(t.size.x, t.size.y, t.size.z),
        vol.position.clone(),
        rot,
      );
    }
    const slots = spawnGrid(round.spawn, MAX_PLAYERS);
    const marks = new InstancedMesh(
      new CylinderGeometry(0.3, 0.3, 0.12, 8),
      new MeshBasicMaterial({ color: '#6ee7a8' }),
      slots.length,
    );
    const mtx = new Matrix4();
    slots.forEach((p, i) => marks.setMatrixAt(i, mtx.makeTranslation(p.x, p.y + 0.06, p.z)));
    marks.instanceMatrix.needsUpdate = true;
    this.aids.add(marks);
    const box = new Box3();
    for (const p of slots) box.expandByPoint(new Vector3(p.x, p.y, p.z));
    box.expandByScalar(0.5);
    addProxy(
      { kind: 'spawn' },
      box.getSize(new Vector3()).setY(1),
      box.getCenter(new Vector3()).setY(round.spawn.origin.y + 0.5),
    );
  }

  // ---------------------------------------------------------------------------
  // Selection and the gizmo
  // ---------------------------------------------------------------------------

  private syncSelection(): void {
    for (const c of [...this.highlight.children]) {
      this.highlight.remove(c);
      (c as LineSegments).geometry.dispose();
    }
    const keys = new Set(this.store.getState().selection.map(refKey));
    const picked = this.proxies.children.filter((p) => keys.has(p.userData.key as string)) as Mesh[];
    const mat = new LineBasicMaterial({ color: '#ffe14d' });
    for (const p of picked) {
      const outline = new LineSegments(new EdgesGeometry(p.geometry), mat);
      outline.position.copy(p.position);
      outline.rotation.copy(p.rotation);
      outline.scale.setScalar(1.02);
      outline.userData.key = p.userData.key;
      this.highlight.add(outline);
    }
    if (picked.length === 0 || this.store.getState().viewing) {
      this.gizmo.detach();
      return;
    }
    const c = new Vector3();
    for (const p of picked) c.add(p.position);
    c.divideScalar(picked.length);
    this.pivot.position.copy(c);
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.scale.set(1, 1, 1);
    this.gizmo.attach(this.pivot);
  }

  private syncGizmo(): void {
    const s = this.store.getState();
    this.gizmo.setMode(s.gizmo === 'move' ? 'translate' : s.gizmo);
    this.gizmo.setTranslationSnap(s.snapStep > 0 ? s.snapStep : null);
    this.gizmo.setRotationSnap(s.rotateStep * DEG);
    this.gizmo.setScaleSnap(0.25);
    // Turning happens about the vertical axis only (pieces keep pitch/roll from the inspector).
    this.gizmo.showX = s.gizmo !== 'rotate';
    this.gizmo.showZ = s.gizmo !== 'rotate';
    this.gizmo.showY = true;
  }

  private beginDrag(): void {
    const moved = new Map<Object3D, Vector3>();
    const keys = new Set(this.store.getState().selection.map(refKey));
    for (const g of [this.proxies, this.highlight])
      for (const p of g.children) if (keys.has(p.userData.key as string)) moved.set(p, p.position.clone());
    this.drag = {
      start: this.pivot.position.clone(),
      rot: this.pivot.rotation.y,
      scale: this.pivot.scale.clone(),
      moved,
    };
  }

  private previewDrag(): void {
    if (!this.drag || this.gizmo.mode !== 'translate') return;
    const d = this.pivot.position.clone().sub(this.drag.start);
    for (const [o, p] of this.drag.moved) o.position.copy(p).add(d);
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const st = this.store.getState();
    if (this.gizmo.mode === 'translate') {
      const d = this.pivot.position.clone().sub(drag.start);
      if (d.lengthSq() > 1e-6) st.moveSelection({ x: d.x, y: d.y, z: d.z });
    } else if (this.gizmo.mode === 'rotate') {
      const deg = (this.pivot.rotation.y - drag.rot) / DEG;
      if (Math.abs(deg) > 0.01) st.rotateSelection(Math.round(deg * 100) / 100);
    } else {
      const f = this.pivot.scale;
      if (Math.abs(f.x - 1) + Math.abs(f.y - 1) + Math.abs(f.z - 1) > 1e-3)
        st.scaleSelection({ x: f.x / drag.scale.x, y: f.y / drag.scale.y, z: f.z / drag.scale.z });
    }
    this.syncSelection();
  }

  // ---------------------------------------------------------------------------
  // Picking and placing
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    // A drag orbits the camera; only a click picks or places.
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || this.gizmo.dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(ndc, this.camera);
    const st = this.store.getState();
    const hits = this.ray.intersectObjects(this.proxies.children, false);
    if (st.placing) {
      const solid = hits.find((h) => (h.object.userData.ref as ItemRef).kind === 'geometry');
      const at = solid?.point ?? this.ray.ray.intersectPlane(this.ground, new Vector3());
      if (at) st.placeAt({ x: at.x, y: Math.max(0, at.y), z: at.z });
      if (!e.shiftKey) st.setPlacing(null);
      return;
    }
    const hit = hits[0]?.object.userData.ref as ItemRef | undefined;
    if (!hit) {
      if (!e.shiftKey) st.select([]);
      return;
    }
    st.select([hit], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
  };
}
