/**
 * Client entry point.
 *
 * Responsibilities: boot sequence (WASM + renderer), render loop with a fixed
 * simulation step, debug panel and stats overlay.
 */
import GUI from 'lil-gui';
import { createRenderer, type BackendPreference } from '@tumble/render';
import { FixedStepper, loadRapier, rapierVersion } from '@tumble/sim';
import { StatsOverlay } from './debug/stats.ts';
import { checkDeterminism, type DeterminismReport } from './debug/determinism.ts';
import { TestScene } from './scenes/testScene.ts';

/** Debug hooks exposed for Playwright and the browser console. */
interface TumbleDebug {
  ready: boolean;
  backend: string;
  fps: () => number;
  frames: number;
  determinism: () => Promise<DeterminismReport>;
}

declare global {
  interface Window {
    __tumble?: TumbleDebug;
  }
}

const bootLabel = document.getElementById('boot-label');
const bootBar = document.getElementById('boot-progress');
const setBoot = (pct: number, label: string): void => {
  if (bootBar) bootBar.style.width = `${pct}%`;
  if (bootLabel) bootLabel.textContent = label;
};

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const preference = (params.get('backend') ?? 'auto') as BackendPreference;

  setBoot(15, 'Warming up physics…');
  const R = await loadRapier();

  setBoot(55, 'Waking up the GPU…');
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const { renderer, backend } = await createRenderer(canvas, preference);

  setBoot(80, 'Building the island…');
  const scene = new TestScene(R);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    scene.resize(w, h);
  };
  resize();
  window.addEventListener('resize', resize);

  const stats = new StatsOverlay(document.body);
  stats.set('gpu', backend);
  stats.set('wasm', `rapier ${rapierVersion()}`);

  const stepper = new FixedStepper(() => scene.fixedStep());

  const gui = new GUI({ title: 'Debug' });
  const settings = {
    backend: preference,
    showStats: true,
    timeScale: 1,
    determinism: 'not run',
    runDeterminism: async (): Promise<void> => {
      settings.determinism = 'running…';
      detCtrl.updateDisplay();
      const r = await checkDeterminism(600);
      settings.determinism = r.summary;
      stats.set('det', r.summary);
      detCtrl.updateDisplay();
    },
  };
  gui
    .add(settings, 'backend', ['auto', 'webgpu', 'webgl'])
    .name('GPU backend')
    .onChange((v: string) => {
      params.set('backend', v);
      location.search = params.toString();
    });
  gui.add(settings, 'showStats').name('Stats overlay').onChange((v: boolean) => stats.setVisible(v));
  gui.add(settings, 'timeScale', 0, 2, 0.05).name('Time scale');
  const detCtrl = gui.add(settings, 'determinism').name('Determinism').disable();
  gui.add(settings, 'runDeterminism').name('Run client↔server check');
  if (params.get('debug') !== '1') gui.close();

  const debug: TumbleDebug = {
    ready: false,
    backend,
    fps: () => stats.fps,
    frames: 0,
    determinism: () => checkDeterminism(600),
  };
  window.__tumble = debug;

  let last = performance.now();
  let elapsed = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const scaled = dt * settings.timeScale;
    elapsed += scaled;

    stepper.advance(scaled);
    scene.render(scaled, elapsed);
    renderer.render(scene.scene, scene.camera);

    stats.set('phys', `${scene.bodyCount} bodies`);
    stats.update(dt, renderer);
    debug.frames++;
  });

  setBoot(100, 'Ready!');
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.style.opacity = '0';
    setTimeout(() => bootEl.remove(), 450);
  }
  debug.ready = true;

  void settings.runDeterminism();
}

boot().catch((err: unknown) => {
  console.error(err);
  setBoot(100, `Failed to start: ${err instanceof Error ? err.message : String(err)}`);
});
