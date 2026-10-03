/**
 * World Lab (`/world.html`): environment, level, VFX, post and quality test bench.
 *
 * Responsibilities: theme/weather switching over a hand-made course that uses
 * every static piece shape/surface/pattern, VFX buttons for every effect, post
 * and quality presets with the silent benchmark and adaptive resolution, and
 * launchers for every menu/ceremony scene including a full 40-player wall recap.
 */
import GUI from 'lil-gui';
import type { Camera, Scene } from 'three/webgpu';
import { createRenderer, type BackendPreference } from '@tumble/render';
import { THEME_IDS, type Weather } from '@tumble/content/themes';
import type { ThemeId } from '@tumble/shared';
import { createPostPipeline, PHOTO_FILTERS, type PhotoFilter } from '@tumble/render/post';
import {
  AdaptiveResolution,
  QUALITY_TIERS,
  applyQualityToRenderer,
  getQualityPreset,
  runBenchmark,
  type QualityPreset,
  type QualityTier,
} from '@tumble/render/quality';
import { getTheme } from '@tumble/content/themes';
import { VFX_KINDS } from '@tumble/render/vfx';
import {
  createMainMenuStage,
  createPlayerWallScene,
  createPreShowArena,
  createResultsBackdrop,
  createVictoryPodium,
  defaultLoadout,
  type MenuScene,
} from '@tumble/render/scenes';
import { StatsOverlay } from '../debug/stats.ts';
import { createMockShow } from './mockShow.ts';
import { LevelView } from './levelView.ts';
import { SAMPLE_ROUND } from './sampleRound.ts';

/** Anything the lab can render. */
interface LabView {
  readonly scene: Scene;
  readonly camera: Camera;
  update(dt: number): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

const WEATHERS: Weather[] = ['clear', 'windy', 'night', 'sunset', 'snow', 'stormy'];

declare global {
  interface Window {
    __worldLab?: {
      ready: boolean;
      frames: number;
      draws: () => number;
      set: (k: string, v: unknown) => void;
      /** Moves the level camera (used by screenshot tooling). */
      look: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void;
      /** Runs a named lab action (scene launchers, VFX). */
      run: (name: string) => void;
    };
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const { renderer, backend } = await createRenderer(canvas, (params.get('backend') ?? 'auto') as BackendPreference);

  const state = {
    theme: (params.get('theme') ?? 'candy') as ThemeId,
    weather: (params.get('weather') ?? 'clear') as Weather,
    tier: (params.get('tier') ?? 'medium') as QualityTier,
    filter: 'none' as PhotoFilter,
    adaptive: false,
    benchmark: 'not run',
  };
  let preset: QualityPreset = getQualityPreset(state.tier);
  applyQualityToRenderer(renderer, preset);

  const levelView = new LevelView(SAMPLE_ROUND, renderer);
  levelView.build(state.theme, state.weather, preset);
  let view: LabView = levelView;

  const post = createPostPipeline(renderer, view.scene, view.camera, preset.post, levelView.grade);
  const adaptive = new AdaptiveResolution({
    targetMs: preset.targetFrameMs,
    min: preset.minRenderScale,
    onChange: (s) => post.setSettings({ resolutionScale: s }),
  });
  adaptive.enabled = false;

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    view.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  const stats = new StatsOverlay(document.body);
  stats.set('gpu', backend);

  const rebuildLevel = (): void => {
    levelView.build(state.theme, state.weather, preset);
    post.setGrade(levelView.grade);
    if (view === levelView) post.setView(levelView.scene, levelView.camera);
  };

  const setView = (next: LabView, grade = levelView.grade): void => {
    if (view !== levelView) view.dispose();
    view = next;
    post.setView(view.scene, view.camera);
    post.setGrade(grade);
    resize();
  };

  const gui = new GUI({ title: 'World Lab' });
  const world = gui.addFolder('World');
  world.add(state, 'theme', [...THEME_IDS]).onChange(rebuildLevel);
  world
    .add(state, 'weather', WEATHERS)
    .onChange((w: Weather) => levelView.env?.setWeather(w));

  const q = gui.addFolder('Quality & post');
  q.add(state, 'tier', [...QUALITY_TIERS]).onChange((t: QualityTier) => {
    preset = getQualityPreset(t);
    applyQualityToRenderer(renderer, preset);
    post.setSettings(preset.post);
    adaptive.setTarget(preset.targetFrameMs, preset.minRenderScale);
    rebuildLevel();
  });
  q.add(state, 'filter', [...PHOTO_FILTERS]).onChange((f: PhotoFilter) => post.setFilter(f));
  q.add(state, 'adaptive').onChange((v: boolean) => {
    adaptive.enabled = v;
  });
  const benchCtrl = q.add(state, 'benchmark').disable();
  q.add(
    {
      run: async (): Promise<void> => {
        state.benchmark = 'running…';
        benchCtrl.updateDisplay();
        const r = await runBenchmark(renderer);
        state.benchmark = `${r.tier} (${r.avgFrameMs.toFixed(2)} ms)`;
        benchCtrl.updateDisplay();
      },
    },
    'run',
  ).name('run benchmark → auto');
  q.add({ punch: () => post.punch(1) }, 'punch').name('hit punch');
  q.add({ flash: () => post.flash(1) }, 'flash').name('flash');

  const actions: Record<string, () => void> = {};
  const vfxFolder = gui.addFolder('VFX');
  const vfxTarget = (): { x: number; y: number; z: number } => {
    const tgt = levelView.controls.target;
    return { x: tgt.x, y: tgt.y + 0.5, z: tgt.z };
  };
  for (const kind of VFX_KINDS) {
    actions['vfx:' + kind] = (): void => {
      if (view !== levelView) setView(levelView);
      levelView.vfx.spawn(kind, vfxTarget(), { direction: { x: 0, y: 0, z: 1 }, team: 1, playerId: 0, duration: 3 });
      if (kind === 'eliminationPoof' || kind === 'bounceRing') post.punch(0.5);
    };
    vfxFolder.add(actions, 'vfx:' + kind).name(kind);
  }
  vfxFolder.close();

  const toast = document.getElementById('toast')!;
  let toastTimer = 0;
  const showToast = (text: string): void => {
    toast.textContent = text;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1600);
  };

  const sceneOpts = () => ({ theme: getTheme(state.theme), weather: state.weather, detail: preset.environment });
  const launch = (make: () => MenuScene, after?: (s: MenuScene) => void): void => {
    const sc = make();
    setView(sc, sc.grade);
    after?.(sc);
  };
  const scenes = gui.addFolder('Scenes');
  actions['scene:level'] = () => setView(levelView);
  actions['scene:menu'] = () =>
    launch(
      () => createMainMenuStage({ ...sceneOpts(), player: defaultLoadout('#ff6fb5', '#ffd23f') }),
      (sc) => (sc as ReturnType<typeof createMainMenuStage>).playEmote(0, 'wave', 3),
    );
  actions['scene:menuPlayable'] = () =>
    launch(
      () => createMainMenuStage({ ...sceneOpts(), player: defaultLoadout('#ff6fb5', '#ffd23f') }),
      (sc) => (sc as ReturnType<typeof createMainMenuStage>).setPlayable(true),
    );
  actions['scene:preshow'] = () =>
    launch(() => createPreShowArena({ ...sceneOpts(), players: createMockShow(40).players, localPlayerId: 'p0' }));
  actions['scene:wall'] = () =>
    launch(
      () => createPlayerWallScene({ ...sceneOpts() }),
      (sc) => {
        const wall = sc as ReturnType<typeof createPlayerWallScene>;
        wall.attachPost(post);
        wall.playRecap(createMockShow(40), {
          onRoundStart: (i, r) => showToast('Round ' + (i + 1) + ': ' + r.name),
          onWinner: () => showToast('WINNER!'),
          onDone: () => showToast('Recap done'),
        });
      },
    );
  actions['scene:wallSkip'] = () => {
    const w = view as Partial<ReturnType<typeof createPlayerWallScene>>;
    w.skip?.();
  };
  actions['scene:podium'] = () =>
    launch(
      () => {
        const show = createMockShow(40);
        return createVictoryPodium({
          ...sceneOpts(),
          winner: { name: 'SprinkleBop', loadout: show.players[0]!.loadout },
          runnersUp: [show.players[1]!, show.players[2]!],
        });
      },
      (sc) => (sc as ReturnType<typeof createVictoryPodium>).attachPost(post),
    );
  actions['scene:podiumPose'] = () => {
    const p = view as Partial<ReturnType<typeof createVictoryPodium>>;
    const pose = p.cyclePose?.();
    if (pose) showToast('pose: ' + pose);
  };
  actions['scene:results'] = () => launch(() => createResultsBackdrop({ ...sceneOpts(), mood: 'qualified' }));
  const sceneNames: Record<string, string> = {
    'scene:level': '← back to level',
    'scene:menu': 'Main menu stage',
    'scene:menuPlayable': 'Main menu (idle play)',
    'scene:preshow': 'Pre-show arena (40)',
    'scene:wall': 'PLAYER WALL recap (40 × 4 rounds)',
    'scene:wallSkip': '  ↳ skip recap',
    'scene:podium': 'Victory podium',
    'scene:podiumPose': '  ↳ cycle pose',
    'scene:results': 'Results backdrop',
  };
  for (const [k, label] of Object.entries(sceneNames)) scenes.add(actions, k).name(label);
  const autoScene = params.get('scene');
  if (autoScene) actions['scene:' + autoScene]?.();
  // Lets screenshot tooling fast-forward long sequences like the wall recap.
  const timeScale = Number(params.get('ts') ?? 1) || 1;

  let frames = 0;
  window.__worldLab = {
    ready: false,
    frames: 0,
    draws: () => renderer.info.render.drawCalls,
    set: (k: string, v: unknown): void => {
      (state as Record<string, unknown>)[k] = v;
      if (k === 'theme') rebuildLevel();
      if (k === 'weather') levelView.env?.setWeather(v as Weather);
      if (k === 'tier') {
        preset = getQualityPreset(v as QualityTier);
        applyQualityToRenderer(renderer, preset);
        post.setSettings(preset.post);
        rebuildLevel();
      }
    },
    look: (x, y, z, tx, ty, tz): void => {
      levelView.camera.position.set(x, y, z);
      levelView.controls.target.set(tx, ty, tz);
    },
    run: (name: string): void => {
      actions[name]?.();
    },
  };

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    view.update(dt * timeScale);
    post.update(dt);
    post.render();
    adaptive.sample(dt * 1000);
    stats.set('scale', adaptive.scale.toFixed(2));
    stats.update(dt, renderer);
    frames++;
    window.__worldLab!.frames = frames;
    window.__worldLab!.ready = frames > 5;
  });
}

void boot();
