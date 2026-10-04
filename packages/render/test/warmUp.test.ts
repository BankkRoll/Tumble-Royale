import { BoxGeometry, BufferGeometry, Group, Mesh, MeshBasicMaterial, PointLight, Scene } from 'three/webgpu';
import type { Object3D, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  beginSceneWarmUp,
  forceAsyncPipelines,
  limitShaderBuilds,
  waitForGpuIdle,
} from '../src/post/warmUp.ts';

/** The private renderer surface the warm-up touches, recording what it saw. */
class FakePipelines {
  calls: (Promise<void>[] | null | undefined)[] = [];
  getForRender(_ro: unknown, promises?: Promise<void>[] | null): void {
    this.calls.push(promises);
    promises?.push(Promise.resolve());
  }
  updateForRender(ro: unknown): void {
    this.getForRender(ro);
  }
}

function fakeRenderer(): { renderer: WebGPURenderer; pipelines: FakePipelines; frames: () => number } {
  const pipelines = new FakePipelines();
  let frames = 0;
  const renderer = {
    _pipelines: pipelines,
    _nodes: { nodeFrame: { update: () => frames++ } },
  } as unknown as WebGPURenderer;
  return { renderer, pipelines, frames: () => frames };
}

function course(): {
  scene: Scene;
  meshes: Mesh[];
  hidden: Mesh;
  empty: Mesh;
  trail: Mesh;
  light: PointLight;
} {
  const scene = new Scene();
  const geo = new BoxGeometry();
  const meshes: Mesh[] = [];
  for (let b = 0; b < 3; b++) {
    const branch = new Group();
    scene.add(branch);
    for (let i = 0; i < 5; i++) {
      const m = new Mesh(geo, new MeshBasicMaterial());
      branch.add(m);
      meshes.push(m);
    }
  }
  const hidden = new Mesh(geo, new MeshBasicMaterial());
  hidden.visible = false;
  scene.add(hidden);
  const empty = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  empty.visible = false;
  scene.add(empty);
  // A trail before its first emit: buffers allocated, nothing in the draw range yet.
  const trail = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  trail.geometry.setDrawRange(0, 0);
  trail.visible = false;
  scene.add(trail);
  const light = new PointLight();
  scene.add(light);
  return { scene, meshes, hidden, empty, trail, light };
}

describe('beginSceneWarmUp', () => {
  it('draws every object (hidden ones too) in batches and restores the scene exactly', async () => {
    const { renderer, pipelines, frames } = fakeRenderer();
    const { scene, meshes, hidden, empty, trail, light } = course();
    meshes[0]!.frustumCulled = false;
    const seen = new Map<Object3D, number>();
    let renders = 0;
    const w = beginSceneWarmUp(renderer, scene, {
      budgetMs: 6,
      now: () => renders * 1,
      render: () => {
        renders++;
        expect(light.visible).toBe(true);
        expect(scene.matrixWorldAutoUpdate).toBe(false);
        scene.traverseVisible((o) => {
          if ((o as Mesh).isMesh) seen.set(o, (seen.get(o) ?? 0) + 1);
        });
        // Every pipeline created inside a warm render goes through the async path.
        pipelines.updateForRender({});
      },
    });
    let steps = 0;
    while (w.next()) steps++;
    expect(w.progress).toBe(1);
    expect(steps).toBeGreaterThan(0);
    for (const m of [...meshes, hidden, trail]) expect(seen.get(m)).toBe(1);
    expect(seen.has(empty)).toBe(false);
    expect(frames()).toBe(renders);
    expect(pipelines.calls.every((c) => Array.isArray(c))).toBe(true);
    expect(w.pipelines).toBe(renders);

    expect(meshes.every((m) => m.visible)).toBe(true);
    expect(hidden.visible).toBe(false);
    expect(meshes[0]!.frustumCulled).toBe(false);
    expect(meshes.slice(1).every((m) => m.frustumCulled)).toBe(true);
    expect(scene.children.every((c) => c === hidden || c === empty || c === trail || c.visible)).toBe(true);
    expect(trail.visible).toBe(false);
    expect(scene.matrixWorldAutoUpdate).toBe(true);

    const fractions: number[] = [];
    await w.settle((f) => fractions.push(f));
    expect(fractions.at(-1)).toBe(1);
  });

  it('grows batches while renders are cheap and shrinks them when a shader build is slow', () => {
    const { renderer } = fakeRenderer();
    const scene = new Scene();
    const geo = new BoxGeometry();
    for (let i = 0; i < 64; i++) scene.add(new Mesh(geo, new MeshBasicMaterial()));
    let clock = 0;
    const sizes: number[] = [];
    const w = beginSceneWarmUp(renderer, scene, {
      budgetMs: 6,
      now: () => clock,
      render: () => {
        let n = 0;
        scene.traverseVisible((o) => {
          if ((o as Mesh).isMesh) n++;
        });
        sizes.push(n);
        clock += sizes.length === 3 ? 50 : 0.5;
      },
    });
    while (w.next());
    expect(sizes[1]).toBeGreaterThan(sizes[0]!);
    expect(sizes[3]).toBeLessThan(sizes[2]!);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(64);
  });

  it('restores visibility and matrices when cancelled midway', () => {
    const { renderer } = fakeRenderer();
    const { scene, meshes, hidden } = course();
    let clock = 0;
    const w = beginSceneWarmUp(renderer, scene, {
      budgetMs: 1,
      now: () => clock,
      render: () => {
        clock += 10;
      },
    });
    expect(w.next()).toBe(true);
    w.cancel();
    w.cancel();
    expect(w.next()).toBe(false);
    expect(meshes.every((m) => m.visible && m.frustumCulled)).toBe(true);
    expect(hidden.visible).toBe(false);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });

  it('settles at once when nothing compiled', async () => {
    const { renderer } = fakeRenderer();
    const w = beginSceneWarmUp(renderer, new Scene(), { render: () => {} });
    expect(w.next()).toBe(false);
    let last = -1;
    await w.settle((f) => {
      last = f;
    });
    expect(last).toBe(1);
  });
});

describe('forceAsyncPipelines', () => {
  it('routes pipeline creation through the async path until restored', () => {
    const { renderer, pipelines } = fakeRenderer();
    const pending: Promise<void>[] = [];
    const restore = forceAsyncPipelines(renderer, pending);
    pipelines.updateForRender({});
    restore();
    pipelines.updateForRender({});
    expect(pipelines.calls[0]).toBe(pending);
    expect(pipelines.calls[1]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(pipelines, 'updateForRender')).toBe(false);
  });

  it('is a no-op on renderers without the private cache', () => {
    const restore = forceAsyncPipelines({} as WebGPURenderer, []);
    expect(() => restore()).not.toThrow();
  });
});

/**
 * A renderer whose `_renderObjectDirect` "builds" a shader per material the
 * first time it draws it, costing `buildMs` on the shared clock.
 */
function buildingRenderer(buildMs: number) {
  const clock = { t: 0 };
  const cache = new Map<unknown, unknown>();
  const data = new Map<unknown, { nodeBuilderState?: unknown }>();
  const drawn: Object3D[] = [];
  class Renderer {
    _pipelines = new FakePipelines();
    _currentRenderContext = {};
    _objects = {
      get: (object: Mesh) => ({ object, initialCacheKey: (object.material as MeshBasicMaterial).uuid }),
    };
    _nodes = {
      nodeFrame: { update: () => {} },
      nodeBuilderCache: cache,
      get: (ro: unknown) => {
        let d = data.get(ro);
        if (!d) data.set(ro, (d = {}));
        return d;
      },
    };
    _renderObjectDirect(object: Mesh): void {
      const key = (object.material as MeshBasicMaterial).uuid;
      if (!cache.has(key)) {
        clock.t += buildMs;
        cache.set(key, {});
      }
      drawn.push(object);
    }
  }
  const raw = new Renderer();
  const draw = (scene: Scene): void => {
    scene.traverseVisible((o) => {
      if ((o as Mesh).isMesh) raw._renderObjectDirect(o as Mesh);
    });
  };
  return { renderer: raw as unknown as WebGPURenderer, raw, clock, cache, drawn, draw };
}

describe('limitShaderBuilds', () => {
  it('skips objects that need a new shader once the slice may not build any more', () => {
    const { renderer, raw, cache, drawn } = buildingRenderer(10);
    const a = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const b = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const c = new Mesh(new BoxGeometry(), a.material);
    let budget = 1;
    let skips = 0;
    const restore = limitShaderBuilds(
      renderer,
      () => budget-- > 0,
      () => skips++,
    );
    for (const m of [a, b, c]) raw._renderObjectDirect(m);
    restore();
    // a builds, b would need a second build and is left out, c shares a's shader and draws.
    expect(drawn).toEqual([a, c]);
    expect(skips).toBe(1);
    expect(cache.size).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(raw, '_renderObjectDirect')).toBe(false);
  });

  it('is a no-op on renderers without the private managers', () => {
    const restore = limitShaderBuilds(
      {} as WebGPURenderer,
      () => false,
      () => {},
    );
    expect(() => restore()).not.toThrow();
  });
});

describe('beginSceneWarmUp with a build budget', () => {
  it('renders a batch again until every shader in it is built, a few per slice', () => {
    const { renderer, clock, cache, draw } = buildingRenderer(10);
    const scene = new Scene();
    const geo = new BoxGeometry();
    const meshes: Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const m = new Mesh(geo, new MeshBasicMaterial());
      scene.add(m);
      meshes.push(m);
    }
    const builtPerSlice: number[] = [];
    const w = beginSceneWarmUp(renderer, scene, {
      budgetMs: 16,
      now: () => clock.t,
      render: () => {
        const before = cache.size;
        draw(scene);
        builtPerSlice.push(cache.size - before);
      },
    });
    while (w.next());
    expect(cache.size).toBe(6);
    // The first build always fits; a second while the slice is under budget (10 < 16), a third doesn't.
    expect(builtPerSlice).toEqual([2, 2, 2]);
    expect(meshes.every((m) => m.visible)).toBe(true);
  });
});

describe('waitForGpuIdle', () => {
  it('waits for the WebGPU queue', async () => {
    let done = false;
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        device: { queue: { onSubmittedWorkDone: () => Promise.resolve().then(() => (done = true)) } },
      },
    } as unknown as WebGPURenderer;
    await waitForGpuIdle(renderer);
    expect(done).toBe(true);
  });

  it('polls a WebGL2 fence until it signals, without blocking', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const deleted: unknown[] = [];
    const gl = {
      SYNC_GPU_COMMANDS_COMPLETE: 1,
      TIMEOUT_EXPIRED: 2,
      ALREADY_SIGNALED: 3,
      fenceSync: () => ({}),
      flush: () => {},
      clientWaitSync: (_s: unknown, _f: number, timeout: number) => {
        expect(timeout).toBe(0);
        return ++polls < 3 ? 2 : 3;
      },
      deleteSync: (s: unknown) => deleted.push(s),
    };
    const idle = waitForGpuIdle({ backend: { gl } } as unknown as WebGPURenderer);
    await vi.advanceTimersByTimeAsync(100);
    await idle;
    vi.useRealTimers();
    expect(polls).toBe(3);
    expect(deleted).toHaveLength(1);
  });

  it('gives up at the timeout when the GPU never answers', async () => {
    vi.useFakeTimers();
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        device: { queue: { onSubmittedWorkDone: () => new Promise(() => {}) } },
      },
    } as unknown as WebGPURenderer;
    let resolved = false;
    const idle = waitForGpuIdle(renderer, 500).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await idle;
    vi.useRealTimers();
    expect(resolved).toBe(true);
  });
});
