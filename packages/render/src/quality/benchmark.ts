import {
  Color,
  DirectionalLight,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RenderTarget,
  Scene,
  TorusKnotGeometry,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { createToonMaterial } from '../materials/toon.ts';
import { DecorRandom, disposeObject } from '../level/toolkit.ts';
import { tierFromFrameTime, type QualityTier } from './presets.ts';

/**
 * Silent GPU benchmark: renders a representative stress scene (instanced toon
 * geometry, shadow map, fill-rate heavy overdraw) into an offscreen 720p target
 * for a fixed time budget, timing batches of frames with a 1-pixel readback as a
 * GPU fence. Nothing touches the visible canvas.
 */

/** Benchmark result. */
export interface BenchmarkResult {
  tier: QualityTier;
  /** Mean ms per frame across measured batches. */
  avgFrameMs: number;
  /** 90th percentile batch frame time. */
  p90FrameMs: number;
  frames: number;
  /** True when the device looks touch-first (tier capped at medium). */
  mobile: boolean;
}

/** Options for {@link runBenchmark}. */
export interface BenchmarkOptions {
  /** Total time budget. Default 3000 ms. */
  durationMs?: number;
  /** Frames rendered between fences. Default 4. */
  batch?: number;
  /** Treat as mobile (default: coarse pointer + small screen). */
  mobile?: boolean;
}

function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.screen.width, window.screen.height) < 900;
}

/**
 * Runs the silent benchmark and maps the result to a quality tier.
 *
 * @param renderer - An initialised renderer (any backend).
 * @param opts - Duration/batch overrides.
 * @returns Timing summary and the recommended tier.
 * @example
 * const { tier } = await runBenchmark(renderer);
 * applyQualityToRenderer(renderer, getQualityPreset(tier));
 */
export async function runBenchmark(
  renderer: WebGPURenderer,
  opts: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const duration = opts.durationMs ?? 3000;
  const batch = opts.batch ?? 4;
  const mobile = opts.mobile ?? detectMobile();

  const scene = new Scene();
  scene.background = new Color('#7ab8ff');
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 400);
  camera.position.set(0, 18, 42);
  camera.lookAt(0, 0, 0);
  scene.add(new HemisphereLight('#dff1ff', '#ffc9e6', 1.3));
  const sun = new DirectionalLight('#fff3dc', 2.4);
  sun.position.set(20, 40, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
  scene.add(sun);

  const floor = new Mesh(new PlaneGeometry(120, 120), createToonMaterial({ color: '#8ef0c6' }));
  floor.rotateX(-Math.PI / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const rng = new DecorRandom(1234);
  const count = 1600;
  const inst = new InstancedMesh(
    new IcosahedronGeometry(0.6, 3),
    createToonMaterial({ color: '#ffffff' }),
    count,
  );
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3(1, 1, 1);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    p.set(rng.range(-35, 35), rng.range(0.6, 10), rng.range(-35, 35));
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, c.setHSL(rng.next(), 0.75, 0.65));
  }
  inst.castShadow = true;
  inst.receiveShadow = true;
  scene.add(inst);
  for (let i = 0; i < 12; i++) {
    const k = new Mesh(
      new TorusKnotGeometry(1.6, 0.5, 160, 24),
      createToonMaterial({ color: '#ff6fb5', rimStrength: 0.6 }),
    );
    k.position.set(rng.range(-25, 25), 4, rng.range(-25, 25));
    k.castShadow = true;
    scene.add(k);
  }

  const target = new RenderTarget(1280, 720, { samples: 0 });
  const pixel = new Uint8Array(4);
  const prevTarget = renderer.getRenderTarget();
  const samples: number[] = [];
  let frames = 0;

  try {
    renderer.setRenderTarget(target);
    // Warm-up: pipeline compilation would otherwise dominate the first batch.
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);

    const start = performance.now();
    while (performance.now() - start < duration) {
      const t0 = performance.now();
      for (let i = 0; i < batch; i++) {
        inst.rotation.y += 0.01;
        camera.position.x = Math.sin(frames * 0.02) * 10;
        camera.lookAt(0, 0, 0);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        frames++;
      }
      const read = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
      pixel.set((read as Uint8Array).subarray(0, 4));
      samples.push((performance.now() - t0) / batch);
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    target.dispose();
    disposeObject(scene);
  }

  samples.sort((a, b) => a - b);
  // Trimmed mean: drop the best/worst 10% so a GC pause or tab switch doesn't decide the tier.
  const lo = Math.floor(samples.length * 0.1);
  const hi = Math.max(lo + 1, Math.ceil(samples.length * 0.9));
  const trimmed = samples.slice(lo, hi);
  const avg = trimmed.reduce((a, b) => a + b, 0) / Math.max(trimmed.length, 1);
  const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))] ?? avg;

  return { tier: tierFromFrameTime(avg, mobile), avgFrameMs: avg, p90FrameMs: p90, frames, mobile };
}
