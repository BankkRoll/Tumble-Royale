/**
 * `tutorial.html`: boots just enough of the game (UI, Rapier, renderer,
 * quality, audio, input, profile) to run Practice Island directly, without
 * the splash/welcome/menu flow. Query knobs match the game (`?autoplay=1`,
 * `?ts=2`, `?tier=high`, `?backend=webgl`, `?fresh=1`, `?seed=N`).
 *
 * `window.__tumble` (ready/screen/fps) and `window.__tutorial` (stage,
 * station, completed, race result) are exposed for Playwright; when the
 * tutorial ends, `window.__tutorialEnd` holds the reason.
 */
import '../styles.css';
import { mountUI, ui, type Settings } from '@tumble/ui';
import { createRenderer } from '@tumble/render';
import { createPostPipeline } from '@tumble/render/post';
import { loadRapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { PerspectiveCamera, Scene } from 'three/webgpu';
import { checkDeterminism } from '../debug/determinism.ts';
import { InputSystem } from '../input/index.ts';
import { AudioBridge } from '../game/audioBridge.ts';
import { resolveTumblerFactory } from '../game/characters.ts';
import { readConfig } from '../game/config.ts';
import '../game/hooks.ts';
import { pushMeta } from '../game/meta.ts';
import { ProfileStore } from '../game/profile.ts';
import { QualityManager } from '../game/quality.ts';
import type { GameContext, SessionEnd } from '../game/show/context.ts';
import { loadJson } from '../game/storage.ts';
import { runTutorial, type TutorialSession } from '../game/tutorial/index.ts';
import type { CeremonyPost } from '../game/views/ceremonies.ts';
import { SceneDirector } from '../game/views/sceneDirector.ts';

declare global {
  interface Window {
    /** Why the last tutorial run ended (dev page only). */
    __tutorialEnd?: SessionEnd | null;
  }
}

const bootLabel = document.getElementById('boot-label');
const setBoot = (label: string): void => {
  if (bootLabel) bootLabel.textContent = label;
};

async function boot(): Promise<void> {
  const cfg = readConfig();
  const s = ui.getState();
  const saved = cfg.fresh ? null : loadJson<Partial<Settings>>('settings');
  if (saved) {
    const d = s.settings;
    s.setSettings({
      graphics: { ...d.graphics, ...saved.graphics },
      controls: {
        ...d.controls,
        ...saved.controls,
        keybinds: { ...d.controls.keybinds, ...saved.controls?.keybinds },
      },
      audio: { ...d.audio, ...saved.audio },
      accessibility: { ...d.accessibility, ...saved.accessibility },
      gameplay: { ...d.gameplay, ...saved.gameplay },
    });
  }
  mountUI(document.getElementById('ui') as HTMLElement);

  setBoot('Teaching physics to behave…');
  const R = await loadRapier();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  setBoot('Waking up the GPU…');
  const { renderer, backend } = await createRenderer(canvas, cfg.backend);
  const tumblers = await resolveTumblerFactory();
  const quality = new QualityManager(renderer);
  await quality.init(cfg.tier, ui.getState().settings.graphics.quality, setBoot);
  const audio = new AudioBridge();
  void audio.prewarm();
  audio.applySettings(ui.getState().settings);
  const input = new InputSystem({ element: canvas, settings: { pointerLock: false } });
  input.settings.sensitivity = ui.getState().settings.controls.mouseSensitivity;
  const profile = new ProfileStore(cfg.fresh);
  if (!profile.exists)
    profile.create('Rookie', { primary: '#ff6fb5', secondary: '#ffd23f', pattern: 'dots' });
  pushMeta(profile);

  const post = createPostPipeline(renderer, new Scene(), new PerspectiveCamera(), quality.preset.post);
  quality.attachPost(post);
  quality.applySettings(ui.getState().settings.graphics);
  const director = new SceneDirector(post);
  const filteredPost: CeremonyPost = {
    punch: (p) => post.punch(p),
    flash: (p) => post.flash(p),
    setFocusVignette: (a) => post.setFocusVignette(a),
  };

  let fps = 60;
  let session: TutorialSession | null = null;
  const ended = document.getElementById('ended') as HTMLElement;
  const endedLabel = document.getElementById('ended-label') as HTMLElement;
  const ctx: GameContext = {
    R,
    cfg,
    renderer,
    director,
    post: filteredPost,
    quality,
    audio,
    input,
    profile,
    tumblers,
    account: null,
    look: () => profile.tumblerLoadout(),
    playerName: () => profile.name,
    crowns: () => profile.crowns,
    matchDeps: { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY },
    fps: () => fps,
    settings: () => ui.getState().settings,
    onEnd: (reason) => {
      window.__tutorialEnd = reason;
      session?.dispose();
      session = null;
      endedLabel.textContent =
        reason === 'playAgain'
          ? 'Tutorial done: the game would start your first show now.'
          : 'Tutorial over: back to the menu in the real game.';
      ended.style.display = 'grid';
    },
  };
  const run = (): void => {
    ended.style.display = 'none';
    window.__tutorialEnd = null;
    session = runTutorial(ctx);
  };
  document.getElementById('again')?.addEventListener('click', run);

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    director.resize(window.innerWidth, window.innerHeight);
  };
  resize();
  window.addEventListener('resize', resize);

  let frames = 0;
  window.__tumble = {
    ready: false,
    backend,
    fps: () => fps,
    frames: 0,
    determinism: () => checkDeterminism(600),
    screen: () => ui.getState().screen,
    roundId: () => session?.roundId() ?? null,
    roundPhase: () => session?.roundPhase() ?? null,
    memory: () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    drawCalls: () => renderer.info.render.drawCalls,
    tumblers: () => session?.visibleTumblers() ?? 0,
    tier: () => quality.tier,
  };
  const hooks = window.__tumble;

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (realDt > 0) fps += (1 / realDt - fps) * 0.05;
    const dt = realDt * cfg.timeScale;
    try {
      session?.frame(dt, realDt);
    } catch (err) {
      console.error('[tutorial] frame failed', err);
    }
    director.update(dt * (session?.timeWarp ?? 1), realDt);
    audio.setListener(director.listenerPos, director.listenerFwd, director.listenerUp);
    audio.update();
    post.update(realDt);
    post.render();
    quality.sample(realDt * 1000);
    hooks.frames = ++frames;
  });

  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.style.opacity = '0';
    window.setTimeout(() => bootEl.remove(), 450);
  }
  hooks.ready = true;
  run();
}

boot().catch((err: unknown) => {
  console.error(err);
  setBoot(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
});
