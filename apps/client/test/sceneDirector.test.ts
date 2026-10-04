import { PerspectiveCamera, Scene } from 'three/webgpu';
import type { PostPipeline, SceneWarmUp } from '@tumble/render/post';
import { describe, expect, it, vi } from 'vitest';
import { runLoadPipeline } from '../src/game/round/loadPipeline.ts';
import type { GameView } from '../src/game/views/types.ts';
import { SceneDirector } from '../src/game/views/sceneDirector.ts';

function view(kind = 'round'): GameView & { disposed: number } {
  return {
    kind,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    grade: { exposure: 1 } as GameView['grade'],
    disposed: 0,
    update() {},
    resize() {},
    dispose() {
      this.disposed++;
    },
  };
}

function fakePost(batches = 3, fail = false) {
  const warm = {
    begun: 0,
    nexts: 0,
    cancelled: 0,
    settled: 0,
  };
  const post = {
    renders: 0,
    setView: vi.fn(),
    setGrade: vi.fn(),
    gpuWaits: 0,
    render() {
      post.renders++;
    },
    async gpuIdle() {
      post.gpuWaits++;
    },
    beginWarmUp(): SceneWarmUp {
      warm.begun++;
      let nexts = 0;
      return {
        get progress() {
          return nexts / batches;
        },
        pipelines: 0,
        next() {
          if (fail) throw new Error('boom');
          warm.nexts++;
          nexts++;
          return nexts < batches;
        },
        async settle(onProgress) {
          warm.settled++;
          onProgress?.(1);
        },
        cancel() {
          warm.cancelled++;
        },
      };
    },
  };
  return { post, warm };
}

const quiet = { log: null, yieldToMain: () => Promise.resolve() } as const;

describe('SceneDirector.precompileSteps', () => {
  it('warms, waits for pipelines, then draws the same batches again, all while covered', async () => {
    const { post, warm } = fakePost();
    const d = new SceneDirector(post as unknown as PostPipeline);
    const v = view();
    const handed = vi.fn();
    const steps = d.precompileSteps(v, handed);
    expect(steps.map((s) => s.name)).toEqual(['warm', 'pipelines', 'upload', 'gpu']);
    const progress: number[] = [];
    const t = await runLoadPipeline(steps, { ...quiet, sliceMs: 0, onProgress: (p) => progress.push(p) });
    expect(t.cancelled).toBe(false);
    expect(d.view).toBe(v);
    expect(d.covered).toBe(true);
    expect(handed).toHaveBeenCalledOnce();
    expect(warm.begun).toBe(2);
    expect(warm.nexts).toBe(6);
    expect(warm.settled).toBe(1);
    // The generator's finally restores the scene even after a complete run (cancel is idempotent).
    expect(warm.cancelled).toBe(2);
    expect(post.renders).toBe(0);
    expect(post.gpuWaits).toBe(1);
    expect(progress.at(-1)).toBe(1);
  });

  it('restores the scene when the load is cancelled mid warm-up', async () => {
    const { post, warm } = fakePost(10);
    const d = new SceneDirector(post as unknown as PostPipeline);
    let stop = false;
    const steps = d.precompileSteps(view());
    const t = await runLoadPipeline(steps, {
      ...quiet,
      sliceMs: 0,
      isCancelled: () => stop,
      onProgress: () => {
        stop = warm.nexts >= 2;
      },
    });
    expect(t.cancelled).toBe(true);
    expect(warm.begun).toBe(1);
    expect(warm.cancelled).toBe(1);
    expect(warm.settled).toBe(0);
  });

  it('stops warming once another view replaced this one and skips its upload pass', async () => {
    const { post, warm } = fakePost(10);
    const d = new SceneDirector(post as unknown as PostPipeline);
    const v = view();
    const steps = d.precompileSteps(v);
    const t = runLoadPipeline(steps, {
      ...quiet,
      sliceMs: 0,
      onProgress: () => {
        if (warm.nexts === 2 && d.view === v) d.show(view('menu'));
      },
    });
    await t;
    expect(warm.nexts).toBe(2);
    expect(warm.begun).toBe(1);
    expect(post.gpuWaits).toBe(0);
    expect(v.disposed).toBe(1);
  });

  it('treats a failing warm-up as non-fatal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { post, warm } = fakePost(3, true);
    const d = new SceneDirector(post as unknown as PostPipeline);
    const t = await runLoadPipeline(d.precompileSteps(view()), { ...quiet, sliceMs: 0 });
    expect(t.cancelled).toBe(false);
    expect(warm.begun).toBe(2);
    expect(warm.cancelled).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
