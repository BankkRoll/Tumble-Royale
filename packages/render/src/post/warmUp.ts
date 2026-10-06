/**
 * Incremental GPU warm-up of a scene before it is shown.
 *
 * Responsibilities:
 * - renders the scene a batch of objects at a time (everything else hidden,
 *   nothing frustum-culled), building new shader graphs only while a slice's
 *   time budget lasts (see {@link limitShaderBuilds}), so a few hundred
 *   materials never block the main thread in one piece;
 * - routes every render pipeline those renders need through the async
 *   pipeline path (see {@link forceAsyncPipelines}) and lets the caller wait
 *   for them;
 * - grows the batch while slices stay cheap;
 * - restores visibility and culling exactly, also when abandoned midway.
 */
import type { Object3D, Scene, WebGPURenderer } from 'three/webgpu';

/** Longest {@link SceneWarmUp.settle} waits before letting the scene show anyway. */
export const WARM_UP_TIMEOUT_MS = 20_000;

/** The backend surface {@link waitForGpuIdle} uses (`renderer.backend`). */
interface BackendLike {
  isWebGPUBackend?: boolean;
  device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
  gl?: WebGL2RenderingContext;
}

/**
 * Resolves once the GPU has executed everything submitted so far (at most
 * `timeoutMs`), polling without blocking the main thread.
 *
 * PERF: WebGL2 through ANGLE/D3D11 compiles a program's shaders on its first
 * draw, in the GPU process: the warm-up's draws return at once, and the
 * first visible frames then waited on seconds of compiles. Waiting for the
 * GPU while still covered moves that wait under the loading cover.
 *
 * @param renderer - The renderer whose work to wait for.
 * @param timeoutMs - Longest wait (a lost device never signals).
 * @returns Resolves when the GPU caught up, or at the timeout.
 */
export function waitForGpuIdle(renderer: WebGPURenderer, timeoutMs = WARM_UP_TIMEOUT_MS): Promise<void> {
  const backend = (renderer as unknown as { backend?: BackendLike }).backend;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  let idle: Promise<void>;
  const queue = backend?.device?.queue;
  const gl = backend?.gl;
  if (backend?.isWebGPUBackend && queue?.onSubmittedWorkDone) {
    idle = queue.onSubmittedWorkDone();
  } else if (gl && typeof gl.fenceSync === 'function') {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    idle = new Promise<void>((resolve) => {
      const poll = (): void => {
        const status = sync ? gl.clientWaitSync(sync, 0, 0) : gl.ALREADY_SIGNALED;
        if (status === gl.TIMEOUT_EXPIRED) {
          setTimeout(poll, 16);
          return;
        }
        if (sync) gl.deleteSync(sync);
        resolve();
      };
      poll();
    });
  } else {
    idle = Promise.resolve();
  }
  return Promise.race([idle.catch(() => {}), timeout]).finally(() => clearTimeout(timer));
}

/** The slice of three's private pipeline cache that {@link forceAsyncPipelines} redirects. */
interface PipelineCache {
  getForRender(renderObject: unknown, promises?: Promise<void>[] | null): unknown;
  updateForRender(renderObject: unknown): void;
}

/**
 * Makes every render pipeline the renderer creates until the returned
 * function is called compile asynchronously, collecting the promises in
 * `pending`.
 *
 * PERF: a synchronous `createRenderPipeline` compiles on the GPU process's
 * main thread, one pipeline after another: ~280 pipelines for a fresh round
 * held up presentation for 4–8 s after the round was revealed, long after
 * the JS calls returned. `createRenderPipelineAsync` (and
 * KHR_parallel_shader_compile on WebGL2) compiles them in parallel off that
 * thread. `renderer.compileAsync` would too, but it targets the default
 * framebuffer (wrong formats for the MRT scene pass), skips the shadow and
 * post passes, and awaits one pipeline at a time.
 *
 * HACK: three has no public switch for this; it reaches into the private
 * `_pipelines` cache, whose `getForRender(…, promises)` is the async path.
 * When those internals change, this degrades to synchronous compilation.
 *
 * @param renderer - The renderer about to draw the warm-up frames.
 * @param pending - Receives one promise per pipeline being compiled.
 * @returns Restores synchronous pipeline creation.
 */
export function forceAsyncPipelines(renderer: WebGPURenderer, pending: Promise<void>[]): () => void {
  const cache = (renderer as unknown as { _pipelines?: PipelineCache })._pipelines;
  if (!cache || typeof cache.getForRender !== 'function' || typeof cache.updateForRender !== 'function')
    return () => {};
  cache.updateForRender = (renderObject) => {
    cache.getForRender(renderObject, pending);
  };
  return () => {
    // The override is an own property shadowing the prototype method.
    delete (cache as Partial<PipelineCache>).updateForRender;
  };
}

/** The slice of three's private render-object and node managers {@link limitShaderBuilds} reads. */
interface RendererInternals {
  _objects?: { get(...args: unknown[]): { initialCacheKey: unknown } };
  _nodes?: {
    get(renderObject: unknown): { nodeBuilderState?: unknown };
    nodeBuilderCache?: Map<unknown, unknown>;
  };
  _currentRenderContext?: unknown;
  _renderObjectDirect?: (...args: unknown[]) => void;
}

/**
 * Lets the renderer build new shaders only while `mayBuild()` holds; an
 * object that needs a shader after that is skipped (not drawn, nothing
 * built) and `onSkip` is called, so the caller renders the same batch again
 * in its next slice. Objects whose shaders already exist always draw.
 *
 * PERF: building one shader graph costs 5–70 ms of main thread. A batch of
 * objects can't know up front how many of its shaders are new (variants are
 * shared across materials, and the menu built some already), so the time
 * limit is enforced per object instead.
 *
 * HACK: wraps three's private `_renderObjectDirect` (as an own property, so
 * every scene, shadow and post render started while installed goes through
 * it) and reads the node manager's cache like `NodeManager.getForRender`
 * does. When those internals change, this degrades to building everything.
 *
 * @param renderer - The renderer about to draw a warm-up frame.
 * @param mayBuild - Whether another new shader still fits this slice.
 * @param onSkip - Called for every object left out.
 * @returns Removes the wrapper.
 */
export function limitShaderBuilds(
  renderer: WebGPURenderer,
  mayBuild: () => boolean,
  onSkip: () => void,
): () => void {
  const r = renderer as unknown as RendererInternals;
  const objects = r._objects;
  const nodes = r._nodes;
  const direct = r._renderObjectDirect;
  const cache = nodes?.nodeBuilderCache;
  if (!objects || !nodes || !cache || typeof direct !== 'function') return () => {};
  r._renderObjectDirect = function (this: RendererInternals, ...args: unknown[]): void {
    // (object, material, scene, camera, lightsNode, group, clippingContext, passId), as three calls it.
    const [object, material, scene, camera, lightsNode, , clippingContext, passId] = args;
    const ro = objects.get(
      object,
      material,
      scene,
      camera,
      lightsNode,
      this._currentRenderContext,
      clippingContext,
      passId,
    );
    const built = nodes.get(ro).nodeBuilderState !== undefined || cache.has(ro.initialCacheKey);
    if (!built && !mayBuild()) {
      onSkip();
      return;
    }
    direct.apply(this, args);
  };
  return () => {
    delete r._renderObjectDirect;
  };
}

/**
 * Starts a new node frame. Passes (scene pass, shadow maps, bloom) render
 * once per node frame, which normally advances only with the animation loop;
 * without this every warm-up render after the first in a frame would reuse
 * the first one's scene pass and never reach the newly shown objects.
 *
 * HACK: private `_nodes.nodeFrame`, like {@link forceAsyncPipelines}.
 */
function advanceNodeFrame(renderer: WebGPURenderer): void {
  const frame = (renderer as unknown as { _nodes?: { nodeFrame?: { update?: () => void } } })._nodes
    ?.nodeFrame;
  frame?.update?.();
}

/** Anything three draws (meshes, instanced/batched meshes, points, lines, sprites). */
function isRenderable(o: Object3D): boolean {
  const r = o as Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return r.isMesh === true || r.isPoints === true || r.isLine === true || r.isSprite === true;
}

type WithGeometry = Object3D & {
  geometry?: {
    attributes?: { position?: { count: number } };
    index?: { count: number } | null;
    drawRange?: { count: number };
  };
};

/**
 * A hidden placeholder may not have geometry yet (pooled decals); drawing it
 * only warns. An empty draw range is fine: trails start with one and fill it
 * as they emit, and three still builds their pipeline (it just draws nothing),
 * which would otherwise compile on the frame a trail first shows, mid-round.
 */
function hasPositions(o: Object3D): boolean {
  const g = (o as WithGeometry).geometry;
  if ((g?.attributes?.position?.count ?? 0) === 0) return false;
  return !(g?.index && g.index.count === 0);
}

/**
 * Renderables of `root` that a render can reach (every ancestor visible),
 * including ones hidden themselves: pooled VFX, spare cosmetics and other
 * parts that only appear mid-round need their pipelines too.
 */
function collectRenderables(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  const walk = (o: Object3D): void => {
    if (isRenderable(o)) out.push(o);
    for (const c of o.children) if (c.visible) walk(c);
    // Hidden renderable leaves are still collected; hidden subtrees are not.
    for (const c of o.children)
      if (!c.visible && isRenderable(c) && c.children.length === 0 && hasPositions(c)) out.push(c);
  };
  walk(root);
  return out;
}

type Drawable = Object3D & {
  material?: { uuid: string } | { uuid: string }[];
  geometry?: { attributes?: Record<string, unknown>; morphAttributes?: Record<string, unknown> };
  isInstancedMesh?: boolean;
  isSkinnedMesh?: boolean;
  isBatchedMesh?: boolean;
};

/** Roughly what decides whether two objects can share a compiled shader. */
function shaderKey(o: Object3D): string {
  const d = o as Drawable;
  const mats = Array.isArray(d.material) ? d.material : d.material ? [d.material] : [];
  const attrs = d.geometry?.attributes ? Object.keys(d.geometry.attributes).join(',') : '';
  const morph = d.geometry?.morphAttributes ? Object.keys(d.geometry.morphAttributes).join(',') : '';
  return `${o.type}|${mats.map((m) => m.uuid).join(',')}|${attrs}|${morph}|${d.isInstancedMesh ? 'i' : ''}${d.isSkinnedMesh ? 's' : ''}${d.isBatchedMesh ? 'b' : ''}`;
}

/**
 * Puts the first object of every shader variant first. The warm-up then
 * spends its first, small batches on the objects that actually build
 * shaders, and the rest (which only need cheap per-object setup) fly by in
 * large batches.
 */
function firstOfEachShaderFirst(objects: Object3D[]): Object3D[] {
  const seen = new Set<string>();
  const first: Object3D[] = [];
  const rest: Object3D[] = [];
  for (const o of objects) {
    const k = shaderKey(o);
    if (seen.has(k)) rest.push(o);
    else {
      seen.add(k);
      first.push(o);
    }
  }
  return first.concat(rest);
}

type Countable = Object3D & {
  isInstancedMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  count?: number;
  geometry?: {
    drawRange: { start: number; count: number };
    setDrawRange(start: number, count: number): void;
  };
};

/** What {@link forceNonEmptyDraws} changed, to put back. */
type EmptyDrawPatch = [o: Countable, count: number | undefined, rangeStart: number, rangeCount: number][];

/**
 * Makes every object in `objects` issue a real draw: an instanced mesh with
 * no instances draws one, a geometry with an empty draw range draws one
 * primitive. Nothing shows: the warm-up runs under the loading cover.
 *
 * PERF: three skips empty draws, and ANGLE (WebGL2 on D3D11) builds a
 * program's driver shaders for the real vertex layout and render targets on
 * its first actual draw. Batches, trails, particle pools and LOD meshes are
 * often empty while the warm-up runs, so their first visible draw after the
 * reveal stalled the GPU process for seconds.
 */
function forceNonEmptyDraws(objects: readonly Object3D[], from: number, to: number): EmptyDrawPatch {
  const patch: EmptyDrawPatch = [];
  for (let i = from; i < to; i++) {
    const o = objects[i] as Countable;
    const g = o.geometry;
    if (!g?.drawRange) continue;
    const instanced = o.isInstancedMesh === true && o.count === 0;
    const empty = g.drawRange.count === 0;
    if (!instanced && !empty) continue;
    patch.push([o, o.count, g.drawRange.start, g.drawRange.count]);
    if (instanced) o.count = 1;
    if (empty) g.setDrawRange(0, o.isPoints ? 1 : o.isLine ? 2 : 3);
  }
  return patch;
}

function restoreDraws(patch: EmptyDrawPatch): void {
  for (const [o, count, start, n] of patch) {
    if (count !== undefined) o.count = count;
    o.geometry?.setDrawRange(start, n);
  }
}

/** For each warmed object, the scene child it hangs under (null if it is one). */
interface Branches {
  owner: (Object3D | null)[];
  /** Visible scene children without lights: the ones a batch may hide. */
  prunable: Object3D[];
}

function branchesOf(scene: Scene, objects: Object3D[]): Branches {
  const owner = objects.map((o) => {
    let b: Object3D = o;
    while (b.parent && b.parent !== scene) b = b.parent;
    return b.parent === scene ? b : null;
  });
  const prunable = scene.children.filter((c) => {
    if (!c.visible) return false;
    let light = false;
    c.traverse((o) => {
      if ((o as Object3D & { isLight?: boolean }).isLight) light = true;
    });
    return !light;
  });
  return { owner, prunable };
}

/**
 * Hides the scene's branches that hold nothing of the current batch, so a
 * render (and each shadow cascade) does not walk the whole scene graph to
 * find a handful of objects. Branches with lights stay: the light set is part
 * of every shader's cache key.
 *
 * @returns The branches hidden; the caller shows them again.
 */
function pruneBranches(b: Branches, objects: Object3D[], from: number, to: number): Object3D[] {
  const keep = new Set<Object3D>();
  for (let i = from; i < to; i++) {
    const o = b.owner[i];
    if (o) keep.add(o);
    else if (objects[i]) keep.add(objects[i] as Object3D);
  }
  const hidden: Object3D[] = [];
  for (const c of b.prunable) {
    if (keep.has(c)) continue;
    c.visible = false;
    hidden.push(c);
  }
  return hidden;
}

/** Options for {@link beginSceneWarmUp}. */
export interface SceneWarmUpOptions {
  /** Draws one frame of the scene (the full post stack, so every pass warms). */
  render: () => void;
  /** Clock in ms (default `performance.now`). */
  now?: () => number;
  /** Target main-thread time per {@link SceneWarmUp.next} (ms). */
  budgetMs?: number;
}

/** A warm-up in progress. */
export interface SceneWarmUp {
  /** Objects warmed so far, 0..1. */
  readonly progress: number;
  /** Pipelines started so far (each compiles asynchronously). */
  readonly pipelines: number;
  /**
   * Renders the next batch of objects.
   *
   * @returns False once every object has been rendered (state is restored then).
   */
  next(): boolean;
  /**
   * Waits for every pipeline started by the warm-up (at most
   * {@link WARM_UP_TIMEOUT_MS}).
   *
   * @param onProgress - Fraction of pipelines ready (0..1).
   */
  settle(onProgress?: (fraction: number) => void): Promise<void>;
  /** Stops early and restores visibility and culling. Safe to call twice. */
  cancel(): void;
}

const FIRST_BATCH = 8;
const MAX_BATCH = 256;
/**
 * Shader builds one object can need (scene pass, shadow pass, back and front
 * side): a batch renders at most this many times per object plus a few
 * before moving on regardless, so an object whose shader key never settles
 * can't stall the load. Every render builds at least one shader.
 */
const BUILDS_PER_OBJECT = 4;

/**
 * Starts warming `scene` up. Call {@link SceneWarmUp.next} once per slice
 * until it returns false, then await {@link SceneWarmUp.settle}. While it runs
 * the scene's visibility and culling flags are modified, so it must not be
 * rendered for display.
 *
 * @param renderer - Renderer the scene will be shown with.
 * @param scene - The scene to warm.
 * @param opts - How to render and how much time each slice may take.
 * @returns The warm-up handle.
 *
 * @example
 * const w = beginSceneWarmUp(renderer, scene, { render: () => post.render() });
 * while (w.next()) await yieldToMain();
 * await w.settle();
 */
export function beginSceneWarmUp(
  renderer: WebGPURenderer,
  scene: Scene,
  opts: SceneWarmUpOptions,
): SceneWarmUp {
  const now = opts.now ?? (() => performance.now());
  const budget = opts.budgetMs ?? 16;
  const pending: Promise<void>[] = [];
  const objects = firstOfEachShaderFirst(collectRenderables(scene));
  const saved = objects.map((o) => [o.visible, o.frustumCulled] as const);
  // Nothing moves while hidden: one world-matrix pass instead of one per scene, shadow and cascade render.
  scene.updateMatrixWorld(true);
  const autoUpdate = scene.matrixWorldAutoUpdate;
  scene.matrixWorldAutoUpdate = false;
  const branches = branchesOf(scene, objects);
  let index = 0;
  let batch = FIRST_BATCH;
  let retries = 0;
  let active = true;
  for (const o of objects) {
    o.visible = false;
    o.frustumCulled = false;
  }
  const restore = (): void => {
    if (!active) return;
    active = false;
    scene.matrixWorldAutoUpdate = autoUpdate;
    objects.forEach((o, i) => {
      const s = saved[i];
      if (!s) return;
      o.visible = s[0];
      o.frustumCulled = s[1];
    });
  };
  return {
    get progress(): number {
      return objects.length === 0 ? 1 : index / objects.length;
    },
    get pipelines(): number {
      return pending.length;
    },
    next(): boolean {
      if (!active) return false;
      const end = Math.min(objects.length, index + batch);
      for (let i = index; i < end; i++) (objects[i] as Object3D).visible = true;
      const pruned = pruneBranches(branches, objects, index, end);
      const patched = forceNonEmptyDraws(objects, index, end);
      const t0 = now();
      let skipped = false;
      let builds = 0;
      advanceNodeFrame(renderer);
      const unforce = forceAsyncPipelines(renderer, pending);
      // At least one new shader per slice, so the warm-up always advances.
      const unlimit = limitShaderBuilds(
        renderer,
        () => builds++ === 0 || now() - t0 < budget,
        () => {
          skipped = true;
        },
      );
      try {
        opts.render();
      } finally {
        unlimit();
        unforce();
        restoreDraws(patched);
        for (const b of pruned) b.visible = true;
        for (let i = index; i < end; i++) (objects[i] as Object3D).visible = false;
      }
      const ms = now() - t0;
      // A batch that left objects out renders again: they draw (and build) next time.
      if (skipped && ++retries < (end - index) * BUILDS_PER_OBJECT + 8) return true;
      retries = 0;
      index = end;
      if (ms < budget / 3) batch = Math.min(MAX_BATCH, batch * 2);
      else if (ms > budget * 2) batch = Math.max(1, batch >> 1);
      if (index >= objects.length) {
        restore();
        return false;
      }
      return true;
    },
    async settle(onProgress?: (fraction: number) => void): Promise<void> {
      if (pending.length === 0) {
        onProgress?.(1);
        return;
      }
      let ready = 0;
      const total = pending.length;
      const all = Promise.all(
        pending.map((p) =>
          p.then(() => {
            ready++;
            onProgress?.(ready / total);
          }),
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A lost device never settles its pipeline promises; the round must still start.
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WARM_UP_TIMEOUT_MS);
      });
      await Promise.race([all, timeout]);
      clearTimeout(timer);
    },
    cancel: restore,
  };
}
