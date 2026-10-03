/**
 * Tumble Royale composition root.
 *
 * Responsibilities:
 * - boot with real progress (UI + fonts, Rapier WASM, WebGPU→WebGL2 renderer,
 *   Tumbler module, first-launch GPU benchmark, menu scene, audio prewarm);
 * - the app state machine around shows: splash → welcome → tutorial prompt →
 *   menu (3D lobby, idle play, locker/store/pass/settings live) → show
 *   session (offline by default, online with `?online=1`) → rewards → menu;
 * - the frame loop: show session, active 3D view, post pipeline, audio
 *   listener, adaptive resolution, stats;
 * - settings persistence and live application; debug panel and hooks.
 */
import { DEFAULT_KEYBINDS, bindUI, mountUI, ui, type BindAction, type Settings } from '@tumble/ui';
import { createRenderer } from '@tumble/render';
import { createPostPipeline, type PostPipeline } from '@tumble/render/post';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import type { MatchDeps } from '@tumble/sim/match';
import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { InputSystem, type InputAction } from '../input/index.ts';
import { StatsOverlay } from '../debug/stats.ts';
import { checkDeterminism } from '../debug/determinism.ts';
import { ApiClient } from './api.ts';
import { AudioBridge } from './audioBridge.ts';
import { installAutoplay } from './autoplay.ts';
import { resolveTumblerFactory, type ResolvedTumblerFactory } from './characters.ts';
import type { GameConfig } from './config.ts';
import { createDebugPanel } from './debugPanel.ts';
import type { TumbleHooks } from './hooks.ts';
import { pushLeaderboard, pushMeta, resolvePlaylist } from './meta.ts';
import { ProfileStore } from './profile.ts';
import { QualityManager } from './quality.ts';
import type { GameContext, SessionEnd } from './show/context.ts';
import { OfflineShowSession } from './show/offline.ts';
import { OnlineShowSession, gameServerAvailable } from './show/online.ts';
import type { ShowSession } from './show/session.ts';
import { loadJson, saveJson } from './storage.ts';
import type { CeremonyPost } from './views/ceremonies.ts';
import { MenuView } from './views/menuView.ts';
import { SceneDirector } from './views/sceneDirector.ts';
import { swapUnderWipe } from './wipe.ts';

/** UI rebindable action → input system action. */
const BIND_TO_INPUT: Partial<Record<BindAction, InputAction>> = {
  moveForward: 'forward',
  moveBack: 'back',
  moveLeft: 'left',
  moveRight: 'right',
  jump: 'jump',
  dive: 'dive',
  grab: 'grab',
  emoteWheel: 'emoteWheel',
  emote1: 'emote1',
  emote2: 'emote2',
  emote3: 'emote3',
  emote4: 'emote4',
};

/** Merges saved settings over defaults so new fields always exist. */
function mergeSettings(base: Settings, saved: Partial<Settings> | null): Settings {
  if (!saved) return base;
  return {
    graphics: { ...base.graphics, ...saved.graphics },
    controls: { ...base.controls, ...saved.controls, keybinds: { ...base.controls.keybinds, ...saved.controls?.keybinds } },
    audio: { ...base.audio, ...saved.audio },
    accessibility: { ...base.accessibility, ...saved.accessibility },
    gameplay: { ...base.gameplay, ...saved.gameplay },
  };
}

/** Boot progress reporter (static loader first, then the UI's boot screen). */
type Progress = (fraction: number, label: string) => void;

/** The running game. */
export class GameApp {
  private session: ShowSession | null = null;
  private menu: MenuView | null = null;
  private lastPlaylist: string | null = null;
  private fpsSmooth = 60;
  private last = performance.now();
  private lastRender = 0;
  private readonly timeScale: { value: number };
  private readonly hooks: TumbleHooks;
  private readonly memoryLog: { round: string; geometries: number; textures: number }[] = [];
  private lastMemoryView: object | null = null;
  private readonly ctx: GameContext;

  private constructor(
    private readonly cfg: GameConfig,
    private readonly R: Rapier,
    private readonly renderer: WebGPURenderer,
    backend: string,
    private readonly post: PostPipeline,
    private readonly quality: QualityManager,
    private readonly director: SceneDirector,
    private readonly audio: AudioBridge,
    private readonly input: InputSystem,
    private readonly profile: ProfileStore,
    private readonly api: ApiClient,
    private readonly tumblers: ResolvedTumblerFactory,
    private readonly stats: StatsOverlay,
  ) {
    this.timeScale = { value: cfg.timeScale };
    const matchDeps: MatchDeps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
    const filteredPost: CeremonyPost = {
      punch: (s) => post.punch(ui.getState().settings.accessibility.reduceFlashing ? (s ?? 1) * 0.35 : s),
      flash: (s) => {
        if (!ui.getState().settings.accessibility.reduceFlashing) post.flash(s);
      },
      setFocusVignette: (a) => post.setFocusVignette(a),
    };
    this.ctx = {
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
      matchDeps,
      fps: () => this.fpsSmooth,
      settings: () => ui.getState().settings,
      onEnd: (reason) => this.onSessionEnd(reason),
    };
    this.hooks = {
      ready: false,
      backend,
      fps: () => this.fpsSmooth,
      frames: 0,
      determinism: () => checkDeterminism(600),
      screen: () => ui.getState().screen,
      showPhase: () => this.session?.showPhaseName() ?? 'none',
      roundId: () => this.session?.roundId() ?? null,
      roundPhase: () => this.session?.roundPhase() ?? null,
      summary: () => this.lastSummary,
      memory: () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
      drawCalls: () => renderer.info.render.drawCalls,
      tumblers: () => this.session?.visibleTumblers() ?? 0,
      tier: () => quality.tier,
      memoryLog: this.memoryLog,
    };
    window.__tumble = this.hooks;
  }

  private lastSummary: unknown = null;

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /**
   * Boots everything and shows the splash.
   *
   * @param cfg - Launch config.
   * @param staticProgress - Updates the static HTML loader until the UI mounts.
   */
  static async boot(cfg: GameConfig, staticProgress: (pct: number, label: string) => void): Promise<GameApp> {
    const uiRoot = document.getElementById('ui') as HTMLElement;
    const s = ui.getState();
    const defaults = s.settings;
    s.setSettings(cfg.fresh ? defaults : mergeSettings(defaults, loadJson<Partial<Settings>>('settings')));
    mountUI(uiRoot);
    s.setBoot({ progress: 0.04, label: 'Inflating Tumblers…' });
    s.setScreen('boot', { transition: 'none' });
    staticProgress(5, 'Inflating Tumblers…');
    // The React boot screen is visually identical; drop the static one once it painted.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById('boot');
        if (el) {
          el.style.opacity = '0';
          window.setTimeout(() => el.remove(), 450);
        }
      }),
    );
    const progress: Progress = (f, label) => ui.getState().setBoot({ progress: Math.max(ui.getState().boot.progress, f), label });

    progress(0.1, 'Teaching physics to behave…');
    const fonts = Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => window.setTimeout(r, 2500))]);
    const R = await loadRapier();
    progress(0.3, 'Waking up the GPU…');

    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const { renderer, backend } = await createRenderer(canvas, cfg.backend);
    progress(0.45, 'Inflating Tumblers…');

    const tumblers = await resolveTumblerFactory();
    await fonts;
    progress(0.55, 'Waxing the slides…');

    const quality = new QualityManager(renderer);
    await quality.init(cfg.tier, ui.getState().settings.graphics.quality, (label) => progress(0.62, label));
    progress(0.75, 'Polishing the Crown…');

    const audio = new AudioBridge();
    let prewarmed = 0;
    void audio.prewarm((done, total) => {
      prewarmed = total > 0 ? done / total : 1;
    });

    const input = new InputSystem({ element: canvas, settings: { pointerLock: false } });
    const profile = new ProfileStore(cfg.fresh);
    const api = new ApiClient(cfg.apiUrl);
    const stats = new StatsOverlay(document.body);
    stats.setVisible(cfg.debug);
    stats.set('gpu', backend);
    stats.set('tumbler', tumblers.name);

    const post = createPostPipeline(renderer, new Scene(), new PerspectiveCamera(), quality.preset.post);
    quality.attachPost(post);
    const director = new SceneDirector(post);
    const app = new GameApp(cfg, R, renderer, backend, post, quality, director, audio, input, profile, api, tumblers, stats);
    progress(0.85, 'Building the lobby…');
    app.applySettings(ui.getState().settings);
    app.showMenuScene();
    pushMeta(profile);

    // Let the SFX bank render in idle time for a moment so the first clicks have sound.
    const t0 = performance.now();
    while (prewarmed < 0.35 && performance.now() - t0 < 1200) {
      progress(0.85 + prewarmed * 0.4, 'Tuning the kazoos…');
      await new Promise((r) => window.setTimeout(r, 60));
    }
    progress(1, 'Almost tumbling…');

    app.bindIntents();
    app.start();
    if (cfg.debug) createDebugPanel({ renderer, quality, stats, session: () => app.session, timeScale: app.timeScale });
    if (cfg.autoplay) installAutoplay(1);
    if (cfg.api) void api.probe().then((ok) => (ok && profile.exists ? api.resume(profile.name) : false));
    window.setTimeout(() => ui.getState().setScreen('splash', { transition: 'wipe' }), 350);
    return app;
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private start(): void {
    const resize = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.director.resize(w, h);
    };
    resize();
    window.addEventListener('resize', resize);
    this.renderer.setAnimationLoop(() => this.frame());
    this.hooks.ready = true;
  }

  private frame(): void {
    const now = performance.now();
    const cap = ui.getState().settings.graphics.fpsCap;
    if (cap > 0 && now - this.lastRender < 1000 / cap - 1.5) return;
    this.lastRender = now;
    const realDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const dt = realDt * this.timeScale.value;
    if (realDt > 0) this.fpsSmooth += (1 / realDt - this.fpsSmooth) * 0.05;

    try {
      this.session?.frame(dt, realDt);
    } catch (err) {
      console.error('[game] show frame failed', err);
    }
    const warp = this.session?.timeWarp ?? 1;
    this.director.update(dt * warp, realDt);
    const d = this.director;
    this.audio.setListener(d.listenerPos, d.listenerFwd, d.listenerUp);
    this.audio.update();
    this.post.update(realDt);
    this.post.render();
    this.quality.sample(realDt * 1000);
    this.stats.set('view', `${d.kind} · ${this.quality.tier} · ${this.quality.adaptive.scale.toFixed(2)}x`);
    this.stats.update(realDt, this.renderer);
    this.hooks.frames++;
    this.trackMemory();
  }

  /** Logs GPU memory once per round, after the previous round's view was disposed. */
  private trackMemory(): void {
    const view = this.session?.roundView ?? null;
    if (!view || view === this.lastMemoryView || this.director.view !== view) return;
    this.lastMemoryView = view;
    const key = `${this.session?.roundId() ?? '?'}#${this.memoryLog.length}`;
    const m = this.renderer.info.memory;
    this.memoryLog.push({ round: key, geometries: m.geometries, textures: m.textures });
    if (this.cfg.debug) console.info(`[memory] ${key}: geometries ${m.geometries}, textures ${m.textures}`);
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private showMenuScene(): void {
    if (this.menu && this.director.view === this.menu) return;
    this.menu = new MenuView({
      R: this.R,
      preset: this.quality.preset,
      createTumbler: this.tumblers.create,
      loadout: this.profile.tumblerLoadout(),
      input: this.input,
      audio: this.audio.game,
    });
    this.director.show(this.menu);
  }

  private goMenu(): void {
    swapUnderWipe('menu', { transition: 'wipe' }, () => {
      this.showMenuScene();
      pushMeta(this.profile);
    });
  }

  // ---------------------------------------------------------------------------
  // Shows
  // ---------------------------------------------------------------------------

  private async startShow(playlistId: string | null): Promise<void> {
    if (this.session) return;
    this.menu?.setIdlePlay(false);
    this.lastPlaylist = playlistId;
    this.lastSummary = null;
    let session: ShowSession | null = null;
    if (this.cfg.online) {
      if (await gameServerAvailable()) session = new OnlineShowSession(this.ctx);
      else ui.getState().pushToast({ kind: 'warning', title: 'Game server unreachable', body: 'Playing an offline show with bots instead.', icon: '🤖' });
    }
    if (!session) {
      const playlist = resolvePlaylist(this.cfg.playlist ?? playlistId, this.profile.showsPlayed === 0 && !this.cfg.playlist);
      const seed = this.cfg.seed ?? (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
      session = new OfflineShowSession(this.ctx, playlist, seed);
    }
    this.session = session;
    session.start();
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    this.lastSummary = s.uiShowSummary();
    s.dispose();
    this.session = null;
  }

  private onSessionEnd(reason: SessionEnd): void {
    this.endSession();
    pushMeta(this.profile);
    if (reason === 'rewards') {
      swapUnderWipe('rewards', { transition: 'wipe' }, () => this.showMenuScene());
    } else if (reason === 'playAgain') {
      this.showMenuScene();
      void this.startShow(this.lastPlaylist);
    } else this.goMenu();
  }

  // ---------------------------------------------------------------------------
  // UI intents
  // ---------------------------------------------------------------------------

  private bindIntents(): void {
    const s = (): ReturnType<typeof ui.getState> => ui.getState();
    const refreshLook = (): void => this.menu?.setLoadout(this.profile.tumblerLoadout());
    bindUI({
      onStart: () => {
        this.audio.unlock();
        if (!this.profile.exists) s().setScreen('welcome', { transition: 'wipe' });
        else this.goMenu();
      },
      onPreviewColors: ({ colors, pattern }) => this.menu?.setLoadout(this.profile.previewLoadout({ ...colors, pattern })),
      onWelcomeDone: ({ name, colors }) => {
        this.profile.create(name, colors);
        pushMeta(this.profile);
        refreshLook();
        if (this.api.online || this.cfg.api) void this.api.probe().then((ok) => ok && this.api.signInGuest(name));
        if (!this.profile.tutorialAnswered) s().setScreen('tutorialPrompt', { transition: 'fade' });
        else this.goMenu();
      },
      onTutorialChoice: ({ accept }) => {
        this.profile.answerTutorial();
        this.goMenu();
        if (accept) {
          s().pushToast({ kind: 'info', title: 'Practice Island is still being inflated!', body: 'Your first show is extra gentle — dive in.', icon: '🏝️' });
        }
      },
      onMenuTab: ({ tab }) => {
        if (tab !== 'play') this.menu?.setIdlePlay(false);
      },
      onTryOn: ({ slot, itemId }) => this.menu?.setLoadout(this.profile.tryOnLoadout(slot, itemId)),
      onEquip: ({ slot, itemId }) => {
        if (this.profile.equip(slot, itemId)) {
          pushMeta(this.profile);
          refreshLook();
          if (slot === 'emote') this.menu?.emote(itemId);
        }
      },
      onSelectLoadout: ({ index }) => {
        this.profile.selectLoadout(index);
        pushMeta(this.profile);
        refreshLook();
      },
      onCustomizeColors: ({ colors }) => {
        this.profile.setColors(colors);
        pushMeta(this.profile);
        refreshLook();
      },
      onRandomizeOutfit: () => {
        this.profile.randomize();
        pushMeta(this.profile);
        refreshLook();
        this.menu?.emote('emote.flex');
      },
      onPurchase: ({ offerId }) => {
        const r = this.profile.purchase(offerId);
        if ('item' in r) {
          s().pushToast({ kind: 'reward', title: `${r.item.name} is yours!`, icon: r.item.icon });
          pushMeta(this.profile);
        } else {
          const msg = r.error === 'funds' ? 'Not enough currency — play a few shows!' : r.error === 'owned' ? 'You already own that.' : 'That offer is gone.';
          s().showDialog({ id: 'purchase-failed', kind: 'error', title: 'Purchase failed', body: msg });
        }
      },
      onClaimPassTier: ({ tier, track }) => {
        if (this.profile.claimPassTier(tier, track)) {
          pushMeta(this.profile);
          s().pushToast({ kind: 'reward', title: `Tier ${tier} claimed!`, icon: '🎁' });
        }
      },
      onBuyPremiumPass: () => {
        if (this.profile.buyPremiumPass()) pushMeta(this.profile);
        else s().showDialog({ id: 'pass-funds', kind: 'error', title: 'Not enough Gems', body: 'Gems come from the store and the pass.' });
      },
      onClaimChallenge: ({ id }) => {
        if (this.profile.claimChallenge(id)) pushMeta(this.profile);
      },
      onRerollChallenge: () => s().pushToast({ kind: 'info', title: 'Rerolls need an online account', icon: '🎲' }),
      onLeaderboardQuery: ({ board }) => pushLeaderboard(this.profile, board),
      onRequestMatchHistory: () => s().setMatchHistory(this.profile.uiHistory()),
      onSettingsChange: ({ settings }) => {
        saveJson('settings', settings);
        this.applySettings(settings);
      },
      onAccountAction: ({ action, value }) => {
        if (action === 'rename' && value) {
          this.profile.rename(value);
          pushMeta(this.profile);
        } else s().pushToast({ kind: 'info', title: 'Accounts are offline right now', body: 'Your guest Tumbler is saved on this device.', icon: '🔒' });
      },
      onPlay: ({ playlistId }) => void this.startShow(playlistId),
      onCancelQueue: () => {
        this.session?.quit();
        this.session = null;
        s().setQueue({ status: 'idle' });
        this.goMenu();
      },
      onPlayAgain: () => {
        if (this.session) {
          this.session.quit();
          this.session = null;
        }
        void this.startShow(this.lastPlaylist);
      },
      onBackToLobby: () => this.leaveToMenu(),
      onLeaveShow: () => this.leaveToMenu(),
      onEmote: ({ id }) => {
        if (!this.session) this.menu?.emote(id);
      },
      onPhotoMode: () => s().pushToast({ kind: 'info', title: 'Say cheese!', body: 'Press F12 for a screenshot — photo mode controls are coming soon.', icon: '📸' }),
      onCreateCustom: () => s().pushToast({ kind: 'info', title: 'Custom shows need the online server', icon: '🛠️' }),
      onJoinCode: () => s().showDialog({ id: 'badcode', kind: 'error', title: 'No show with that code', body: 'Custom lobbies need the online server.', code: 'E-LOBBY-404' }),
      onInviteFriend: () => s().pushToast({ kind: 'social', title: 'Invites need an online account', icon: '💌' }),
      onAddFriend: () => s().pushToast({ kind: 'social', title: 'Friends need an online account', icon: '👥' }),
      onCopyInvite: ({ code }) => {
        void navigator.clipboard?.writeText(`${location.origin}/join/${code}`).catch(() => undefined);
        s().pushToast({ kind: 'success', title: 'Invite link copied!', icon: '📋' });
      },
      onNavUnhandled: ({ dir }) => {
        if (dir === 'back' && s().screen === 'menu' && s().overlay === 'none') s().setOverlay('settings');
      },
      onRetryConnection: () => s().setConnection({ status: 'connecting' }),
    });

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', () => {
      const st = s();
      if (this.session || st.screen !== 'menu' || st.menuTab !== 'play' || st.overlay !== 'none' || !this.menu) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      canvas.focus({ preventScroll: true });
      this.menu.setIdlePlay(true);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.menu?.idlePlaying) this.menu.setIdlePlay(false);
    });
  }

  private leaveToMenu(): void {
    if (this.session) {
      this.session.quit();
      this.session = null;
    }
    this.goMenu();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private applySettings(st: Settings): void {
    this.quality.applySettings(st.graphics);
    this.audio.applySettings(st);
    this.input.settings.sensitivity = st.controls.mouseSensitivity;
    this.input.settings.invertY = st.controls.invertY;
    for (const [bind, action] of Object.entries(BIND_TO_INPUT) as [BindAction, InputAction][]) {
      const codes = st.controls.keybinds[bind];
      const defaults = DEFAULT_KEYBINDS[bind];
      // Untouched defaults keep the input layer's richer bindings (e.g. C and Right Ctrl for dive).
      if (!codes || (codes[0] === defaults[0] && codes[1] === defaults[1])) continue;
      this.input.setBinding(action, codes.filter((c) => c !== ''));
    }
    const view = this.session?.roundView;
    view?.setAccessibility(st.accessibility.reduceShake, st.gameplay.nameplates, st.gameplay.streamerMode);
    if (view) view.setPreset(this.quality.preset);
    this.stats.setVisible(this.cfg.debug || st.graphics.showFps);
  }
}
