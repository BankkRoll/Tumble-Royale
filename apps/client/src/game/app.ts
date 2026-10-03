/**
 * Tumble Royale composition root.
 *
 * Responsibilities:
 * - boot with real progress (UI + fonts, Rapier WASM, WebGPU→WebGL2 renderer,
 *   Tumbler module, first-launch GPU benchmark, menu scene, audio prewarm);
 * - the account: the offline local profile always works; when the account API
 *   answers, the guest signs in and the meta game runs against it
 *   ({@link OnlineAccount}), including `/join/<code>` party deep links;
 * - the app state machine around shows: splash → welcome → tutorial prompt →
 *   menu (3D lobby, idle play, locker/store/pass/settings live) → show
 *   session → rewards → menu. Play matchmakes (API party ticket → matchmaker
 *   → `match_found` → ticketed game server) when signed in and the
 *   matchmaker answers, `?online=1` joins the local game server directly,
 *   otherwise an offline show with bots runs;
 * - custom lobbies through the matchmaker;
 * - the frame loop: show session, active 3D view, post pipeline, audio
 *   listener, adaptive resolution, stats;
 * - settings persistence and live application; debug panel and hooks.
 */
import {
  DEFAULT_KEYBINDS,
  bindUI,
  mountUI,
  ui,
  uiEvents,
  type BindAction,
  type CustomLobbyState,
  type Settings,
} from '@tumble/ui';
import { createRenderer } from '@tumble/render';
import { createPostPipeline, type PostPipeline } from '@tumble/render/post';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import type { MatchDeps } from '@tumble/sim/match';
import type { ShowPlaylist } from '@tumble/sim/show';
import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { InputSystem, type InputAction } from '../input/index.ts';
import { StatsOverlay } from '../debug/stats.ts';
import { checkDeterminism } from '../debug/determinism.ts';
import { ApiClient, ApiError } from './api.ts';
import { AudioBridge } from './audioBridge.ts';
import { installAutoplay } from './autoplay.ts';
import { resolveTumblerFactory, type ResolvedTumblerFactory } from './characters.ts';
import type { GameConfig } from './config.ts';
import { botLoadout, tumblerColors } from './cosmetics.ts';
import { createDebugPanel } from './debugPanel.ts';
import type { TumbleHooks } from './hooks.ts';
import {
  customPlaylist,
  localPlayerCard,
  markNewsRead,
  pushLeaderboard,
  pushMeta,
  pushStaticMeta,
  resolvePlaylist,
} from './meta.ts';
import { OnlineAccount } from './online/account.ts';
import { MatchmakerClient, gameSocketUrl, type Lobby, type MatchFound } from './online/matchmaker.ts';
import { ProfileStore } from './profile.ts';
import { QualityManager } from './quality.ts';
import { ReplayController } from './replay/controller.ts';
import type { GameContext, SessionEnd } from './show/context.ts';
import { OfflineShowSession } from './show/offline.ts';
import { OnlineShowSession, gameServerAvailable } from './show/online.ts';
import type { ShowSession } from './show/session.ts';
import { loadJson, saveJson } from './storage.ts';
import type { CeremonyPost } from './views/ceremonies.ts';
import { MenuView } from './views/menuView.ts';
import { SceneDirector } from './views/sceneDirector.ts';
import { ThumbnailRenderer } from './thumbnails.ts';
import { swapUnderWipe } from './wipe.ts';
import { runTutorial } from './tutorial/index.ts';

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
    controls: {
      ...base.controls,
      ...saved.controls,
      keybinds: { ...base.controls.keybinds, ...saved.controls?.keybinds },
    },
    audio: { ...base.audio, ...saved.audio },
    accessibility: { ...base.accessibility, ...saved.accessibility },
    gameplay: { ...base.gameplay, ...saved.gameplay },
  };
}

/** Party invite code from a `/join/<code>` deep link, or null. */
function deepLinkCode(): string | null {
  const m = /\/join\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** Human message for an API/matchmaker error. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 ? 'The server could not be reached.' : err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
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
  private readonly account: OnlineAccount | null;
  private readonly mm: MatchmakerClient | null;
  private partyLooks: TumblerLoadout[] = [];
  private queued = false;
  private pendingJoin: string | null = deepLinkCode();
  private lobby: Lobby | null = null;
  private readonly thumbs: ThumbnailRenderer;
  private readonly replays: ReplayController;

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
    this.thumbs = new ThumbnailRenderer(renderer, tumblers.create);
    this.account = cfg.api
      ? new OnlineAccount(api, {
          onLookChanged: () => this.menu?.setLoadout(this.look()),
          onPartyChanged: (members) => {
            this.partyLooks = members.map((m) => m.loadout);
            this.menu?.setParty(this.partyLooks);
          },
        })
      : null;
    this.mm = cfg.api && cfg.matchmaking ? new MatchmakerClient(cfg.mmUrl, api) : null;
    if (this.pendingJoin) {
      // Keep the query string (test flags) but drop the invite path so a reload doesn't rejoin.
      history.replaceState(null, '', `/${location.search}`);
    }
    const matchDeps: MatchDeps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
    const filteredPost: CeremonyPost = {
      punch: (s) => post.punch(ui.getState().settings.accessibility.reduceFlashing ? (s ?? 1) * 0.35 : s),
      flash: (s) => {
        if (!ui.getState().settings.accessibility.reduceFlashing) post.flash(s);
      },
      setFocusVignette: (a) => post.setFocusVignette(a),
    };
    this.replays = new ReplayController({
      R,
      matchDeps,
      director,
      post: filteredPost,
      preset: () => quality.preset,
      createTumbler: tumblers.create,
      input,
      canvas: renderer.domElement,
      logMemory: (label) => {
        const m = renderer.info.memory;
        this.memoryLog.push({ round: label, geometries: m.geometries, textures: m.textures });
      },
    });
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
      account: this.account,
      look: () => this.look(),
      playerName: () => (this.account?.active ? this.account.name : profile.name),
      crowns: () => (this.account?.active ? this.account.crowns : profile.crowns),
      tumblers,
      matchDeps,
      fps: () => this.fpsSmooth,
      settings: () => ui.getState().settings,
      onEnd: (reason) => this.onSessionEnd(reason),
      replays: this.replays.live,
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
      memory: () => ({
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      }),
      drawCalls: () => renderer.info.render.drawCalls,
      tumblers: () => this.session?.visibleTumblers() ?? 0,
      tier: () => quality.tier,
      memoryLog: this.memoryLog,
      account: () => {
        const a = this.account;
        if (!a?.active || !a.userId) return null;
        return {
          userId: a.userId,
          name: a.name,
          partyCode: a.party?.code ?? null,
          partySize: a.party?.members.length ?? 1,
          leader: a.isLeader,
        };
      },
      queued: () => this.queued,
      lobbyState: () => (this.menu && this.director.view === this.menu ? this.menu.debugState() : null),
      ui,
      emit: (name, payload) => uiEvents.emit(name, payload as never),
    };
    window.__tumble = this.hooks;
  }

  private lastSummary: unknown = null;

  /** The local look: the account's loadout online, the local profile's offline. */
  private look(): TumblerLoadout {
    return this.account?.active ? this.account.tumblerLoadout() : this.profile.tumblerLoadout();
  }

  /** Pushes menu data: the account's when signed in, else the local profile's. */
  private pushMeta(): void {
    if (this.account?.active) pushStaticMeta();
    else pushMeta(this.profile);
  }

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
    const progress: Progress = (f, label) =>
      ui.getState().setBoot({ progress: Math.max(ui.getState().boot.progress, f), label });

    progress(0.1, 'Teaching physics to behave…');
    const fonts = Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((r) => window.setTimeout(r, 2500)),
    ]);
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
    const app = new GameApp(
      cfg,
      R,
      renderer,
      backend,
      post,
      quality,
      director,
      audio,
      input,
      profile,
      api,
      tumblers,
      stats,
    );
    progress(0.85, 'Building the lobby…');
    app.applySettings(ui.getState().settings);
    app.showMenuScene();
    app.pushMeta();

    // Let the SFX bank render in idle time for a moment so the first clicks have sound.
    const t0 = performance.now();
    while (prewarmed < 0.35 && performance.now() - t0 < 1200) {
      progress(0.85 + prewarmed * 0.4, 'Tuning the kazoos…');
      await new Promise((r) => window.setTimeout(r, 60));
    }
    progress(1, 'Almost tumbling…');

    app.bindIntents();
    app.start();
    if (cfg.debug)
      createDebugPanel({ renderer, quality, stats, session: () => app.session, timeScale: app.timeScale });
    if (cfg.autoplay) installAutoplay(cfg.autoShows);
    if (cfg.api) void app.connectAccount(null).finally(() => void app.refreshOnlineStatus());
    else void app.refreshOnlineStatus();
    window.setTimeout(() => ui.getState().setScreen('splash', { transition: 'wipe' }), 350);
    return app;
  }

  /**
   * Signs in (resume, or a fresh guest after the welcome screen) and loads the
   * account. Offline play continues untouched when anything fails.
   *
   * @param welcome - Name and colours from the welcome screen for a brand new guest.
   */
  private async connectAccount(
    welcome: { name: string; colors: Parameters<ProfileStore['create']>[1] } | null,
  ): Promise<void> {
    const account = this.account;
    if (!account || account.active) return;
    if (!(await this.api.probe())) return;
    const fresh = !this.api.signedIn;
    // A returning player whose first launch was offline gets their guest account now.
    const ok = welcome
      ? await this.api.signInGuest(welcome.name)
      : !this.profile.exists
        ? false
        : fresh
          ? await this.api.signInGuest(this.profile.name)
          : await this.api.resume(this.profile.name);
    if (!ok || !(await account.load())) return;
    if (welcome && fresh) await account.adoptWelcomeColors(welcome.colors);
    account.startRealtime();
    if (this.mm) {
      void this.mm.probe().then((up) => {
        if (up) this.mm?.socket.start();
      });
      this.bindMatchmaker();
    }
    // The boot-time check ran before this sign-in (welcome screen); publish the real online state now.
    void this.refreshOnlineStatus();
    ui.getState().pushToast({
      kind: 'success',
      title: `Signed in as ${account.name}`,
      body: 'Progress now saves to your account.',
      icon: '☁️',
    });
    if (this.pendingJoin) {
      const code = this.pendingJoin;
      this.pendingJoin = null;
      await account.joinParty(code);
    }
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
    if (cap > 0) {
      const interval = 1000 / cap;
      if (now - this.lastRender < interval - 1.5) return;
      // Advance on the cap's own grid: resetting to `now` drops a frame every time
      // the display's refresh beats against the cap (144 Hz capped to 60 ran at ~48).
      this.lastRender = now - this.lastRender > interval * 2 ? now : this.lastRender + interval;
    } else {
      this.lastRender = now;
    }
    const realDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const dt = realDt * this.timeScale.value;
    if (realDt > 0) this.fpsSmooth += (1 / realDt - this.fpsSmooth) * 0.05;

    // An offline show is only this player: it waits while they watch a replay. Online shows run on.
    const held = this.replays.active && this.session instanceof OfflineShowSession;
    try {
      if (!held) this.session?.frame(dt, realDt);
    } catch (err) {
      console.error('[game] show frame failed', err);
    }
    this.replays.frame(realDt);
    const warp = this.session?.timeWarp ?? 1;
    this.director.update(dt * warp, realDt);
    const d = this.director;
    this.audio.setListener(d.listenerPos, d.listenerFwd, d.listenerUp);
    this.audio.update();
    this.post.update(realDt);
    this.post.render();
    // Thumbnails only render in the menus, one per frame, so shows never hitch.
    if (!this.session) this.thumbs.pump(realDt * 1000);
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
      loadout: this.look(),
      input: this.input,
      audio: this.audio.game,
      party: this.partyLooks,
    });
    this.director.show(this.menu);
  }

  /**
   * Forgets this device's Tumbler and session, then reloads into the welcome
   * screen. A reload drops every live socket, scene and cached account view
   * in one go instead of unwinding each by hand.
   */
  private async signOut(): Promise<void> {
    await this.api.signOut();
    this.profile.clear();
    window.location.reload();
  }

  private goMenu(): void {
    // Nothing reaches the menu without a named Tumbler.
    if (!this.profile.exists) {
      ui.getState().setScreen('welcome', { transition: 'wipe' });
      return;
    }
    swapUnderWipe('menu', { transition: 'wipe' }, () => {
      this.showMenuScene();
      this.pushMeta();
    });
  }

  // ---------------------------------------------------------------------------
  // Shows
  // ---------------------------------------------------------------------------

  /** The player picked a Play mode themselves (don't auto-switch it). */
  private modePicked = false;

  /**
   * Probes whether Play Online can work (account signed in and the
   * matchmaker reachable, or the direct game server with `?online=1`) and
   * publishes it to the Play tab's mode tiles.
   */
  async refreshOnlineStatus(): Promise<void> {
    const s = ui.getState();
    if (!this.cfg.api && !this.cfg.online) {
      s.setOnlineStatus({ state: 'disabled', message: 'Online play is turned off for this session.' });
      return;
    }
    s.setOnlineStatus({ state: 'checking' });
    let up = false;
    if (this.cfg.online) up = await gameServerAvailable();
    else if (this.account?.active && this.mm) up = await this.mm.probe();
    s.setOnlineStatus(
      up
        ? {
            state: 'online',
            ...(this.mm && this.mm.searching > 0 ? { playersOnline: this.mm.searching } : {}),
          }
        : { state: 'offline', message: 'The game servers are offline right now.' },
    );
    if (up && !this.modePicked) s.setPlayMode('online');
    if (!up && s.playMode === 'online') ui.setState({ playMode: 'offline' });
  }

  /** Starts an offline show vs bots right away (Vs Bots, private show with bots). */
  private startOfflineShow(playlist: ShowPlaylist): void {
    if (this.session) return;
    this.menu?.setIdlePlay(false);
    this.lastSummary = null;
    const seed = this.cfg.seed ?? (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
    const session = new OfflineShowSession(this.ctx, playlist, seed);
    this.session = session;
    session.start();
  }

  /** True when Play should go through the matchmaker. */
  private get canMatchmake(): boolean {
    return !this.cfg.online && !!this.mm?.online && !!this.account?.active;
  }

  private async startShow(playlistId: string | null): Promise<void> {
    if (this.session) return;
    this.menu?.setIdlePlay(false);
    this.lastPlaylist = playlistId;
    this.lastSummary = null;
    if (this.canMatchmake) {
      await this.queue(playlistId ?? ui.getState().selectedPlaylist);
      return;
    }
    let session: ShowSession | null = null;
    if (this.cfg.online) {
      if (await gameServerAvailable()) session = new OnlineShowSession(this.ctx);
      else
        ui.getState().pushToast({
          kind: 'warning',
          title: 'Game server unreachable',
          body: 'Playing an offline show with bots instead.',
          icon: '🤖',
        });
    } else if (this.account?.active && this.mm && !this.mm.online) {
      ui.getState().pushToast({
        kind: 'info',
        title: 'Matchmaking is offline',
        body: 'Playing a show with bots — progress stays on this device.',
        icon: '🤖',
      });
    }
    if (!session) {
      const playlist = resolvePlaylist(
        this.cfg.playlist ?? playlistId,
        this.profile.showsPlayed === 0 && !this.cfg.playlist && !this.account?.active,
      );
      const seed = this.cfg.seed ?? (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
      session = new OfflineShowSession(this.ctx, playlist, seed);
    }
    this.session = session;
    session.start();
  }

  /** Party leader: API queue ticket → matchmaker queue. Members follow via the status stream. */
  private async queue(playlistId: string): Promise<void> {
    const account = this.account;
    const mm = this.mm;
    if (!account || !mm || this.queued) return;
    const s = ui.getState();
    if (!account.isLeader) {
      s.pushToast({
        kind: 'info',
        title: 'The party leader starts the show',
        body: 'Hit Ready and hang tight!',
        icon: '👑',
      });
      return;
    }
    this.showSearching(account.party?.members.length ?? 1);
    try {
      const { ticket } = await this.api.queueTicket(playlistId);
      await mm.queue(ticket);
      this.queued = true;
      account.setPresence('in_queue');
    } catch (err) {
      this.queued = false;
      const notReady = err instanceof ApiError && err.code === 'not_ready';
      s.showDialog({
        id: 'queue-failed',
        kind: 'error',
        title: notReady ? 'Not everyone is ready' : "Couldn't start matchmaking",
        body: notReady ? 'Wait for every party member to hit Ready.' : errorText(err),
        ...(err instanceof ApiError ? { code: err.code } : {}),
      });
      s.setQueue({ status: 'idle' });
      this.goMenu();
    }
  }

  private showSearching(partySize: number): void {
    const s = ui.getState();
    s.setQueue({
      status: 'searching',
      startedAt: Date.now(),
      playersFound: partySize,
      playersNeeded: 40,
      etaSec: -1,
      region: (this.account?.me?.region ?? 'na').toUpperCase(),
    });
    if (s.screen !== 'matchmaking') s.setScreen('matchmaking');
  }

  /** Subscribes to the matchmaker stream (queue status, match found, custom lobbies). */
  private bindMatchmaker(): void {
    const mm = this.mm;
    if (!mm) return;
    mm.on('queued', () => {
      this.queued = true;
      if (!this.session) this.showSearching(this.account?.party?.members.length ?? 1);
    });
    mm.on('status', (m) => {
      if (this.session) return;
      ui.getState().setQueue({
        playersFound: Math.max(1, Number(m.searching ?? 1)),
        etaSec: Number(m.etaSec ?? -1),
      });
    });
    mm.on('waiting_for_server', () =>
      ui.getState().pushToast({ kind: 'info', title: 'Finding a game server…', icon: '🛰️' }),
    );
    mm.on('queue_cancelled', (m) => {
      this.queued = false;
      if (this.session) return;
      ui.getState().setQueue({ status: 'idle' });
      if (ui.getState().screen === 'matchmaking') this.goMenu();
      if (m.reason && m.reason !== 'cancelled')
        ui.getState().pushToast({
          kind: 'warning',
          title: 'Matchmaking stopped',
          body: String(m.reason),
          icon: '⏹️',
        });
    });
    mm.on('match_found', (m) => this.startMatchmadeShow(m as unknown as MatchFound));
    mm.on('lobby_update', (m) => this.applyLobby(m.lobby as Lobby));
    mm.on('lobby_closed', () => {
      this.applyLobby(null);
      ui.getState().pushToast({ kind: 'info', title: 'The custom lobby closed', icon: '🚪' });
    });
    mm.on('lobby_kicked', () => {
      this.applyLobby(null);
      ui.getState().pushToast({ kind: 'warning', title: 'You were removed from the lobby', icon: '👋' });
    });
  }

  private startMatchmadeShow(m: MatchFound): void {
    this.queued = false;
    if (this.session) return;
    this.menu?.setIdlePlay(false);
    this.lastSummary = null;
    this.lastPlaylist = m.playlistId;
    this.applyLobby(null);
    const session = new OnlineShowSession(this.ctx, {
      url: gameSocketUrl(m.server.url),
      ticket: m.ticket,
      matchId: m.matchId,
      playlistId: m.playlistId,
    });
    this.session = session;
    this.account?.setPresence('in_match');
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
    this.pushMeta();
    if (this.account?.active) {
      this.account.setPresence('in_menu');
      void this.account.refreshProgress();
    }
    if (reason === 'rewards') {
      swapUnderWipe('rewards', { transition: 'wipe' }, () => this.showMenuScene());
    } else if (reason === 'playAgain') {
      this.showMenuScene();
      void this.startShow(this.lastPlaylist);
    } else this.goMenu();
  }

  // ---------------------------------------------------------------------------
  // Custom lobbies
  // ---------------------------------------------------------------------------

  private applyLobby(lobby: Lobby | null): void {
    this.lobby = lobby;
    const me = this.account?.userId;
    if (!lobby || lobby.status === 'started') {
      ui.getState().setCustomLobby(null);
      return;
    }
    const state: CustomLobbyState = {
      code: lobby.code,
      isHost: lobby.hostId === me,
      players: lobby.players.map((p) => ({
        id: p.userId,
        name: p.name.replace(/#\d+$/, ''),
        colors:
          p.userId === me
            ? (ui.getState().profile?.colors ?? tumblerColors(this.look()))
            : tumblerColors(botLoadout(1, p.name.length, p.name)),
      })),
      options: {
        rounds: lobby.settings.rounds,
        bots: lobby.settings.bots,
        maxPlayers: lobby.settings.maxPlayers,
        timerScale: lobby.settings.roundTimeScale,
        spectators: lobby.settings.spectatorSlots > 0,
        isPrivate: true,
      },
    };
    ui.getState().setCustomLobby(state);
    if (ui.getState().screen === 'menu') ui.getState().setOverlay('privateShow');
  }

  private customUnavailable(): boolean {
    if (this.mm?.online && this.account?.active) return false;
    ui.getState().showDialog({
      id: 'custom-offline',
      kind: 'error',
      title: 'Invite codes need the online servers',
      body: 'Sign in and make sure matchmaking is reachable.',
      code: 'E-LOBBY-503',
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // UI intents
  // ---------------------------------------------------------------------------

  private bindIntents(): void {
    const s = (): ReturnType<typeof ui.getState> => ui.getState();
    const refreshLook = (): void => this.menu?.setLoadout(this.look());
    const online = (): OnlineAccount | null => (this.account?.active ? this.account : null);
    bindUI({
      onStart: () => {
        this.audio.unlock();
        if (!this.profile.exists) s().setScreen('welcome', { transition: 'wipe' });
        else this.goMenu();
      },
      onPreviewColors: ({ colors, pattern }) =>
        this.menu?.setLoadout(this.profile.previewLoadout({ ...colors, pattern })),
      onWelcomeDone: ({ name, colors }) => {
        this.profile.create(name, colors);
        this.pushMeta();
        refreshLook();
        if (this.cfg.api) void this.connectAccount({ name, colors });
        if (!this.profile.tutorialAnswered) s().setScreen('tutorialPrompt', { transition: 'fade' });
        else this.goMenu();
      },
      onTutorialChoice: ({ accept }) => {
        this.profile.answerTutorial();
        if (accept && !this.session) {
          this.menu?.setIdlePlay(false);
          this.session = runTutorial(this.ctx);
        } else {
          this.goMenu();
        }
      },
      onMenuTab: ({ tab }) => {
        if (tab !== 'play') this.menu?.setIdlePlay(false);
      },
      onOverlay: ({ overlay }) => {
        if (overlay === 'friends') void online()?.ensureParty();
      },
      onTryOn: ({ slot, itemId }) => {
        this.menu?.setLoadout(
          online()?.tryOnLoadout(slot, itemId) ?? this.profile.tryOnLoadout(slot, itemId),
        );
        // Emotes, celebrations and victory poses are previewed by playing them.
        if (itemId && (slot === 'emote' || slot === 'celebration' || slot === 'victory'))
          this.menu?.emote(itemId);
      },
      onTryOnBundle: ({ items }) => {
        this.menu?.setLoadout(
          items.length === 0 ? this.look() : (online()?.tryOnMany(items) ?? this.profile.tryOnMany(items)),
        );
      },
      onDressingRoom: ({ active }) => {
        this.menu?.setDressingRoom(active);
        // Leaving the Store/Locker drops any preview: the equipped (or just bought and equipped) look returns.
        if (!active) this.menu?.setLoadout(this.look());
      },
      onTurntable: ({ rotate, zoom }) => this.menu?.turntable(rotate, zoom),
      onNeedThumbnails: ({ ids }) => this.thumbs.request(ids),
      onEquip: ({ slot, itemId }) => {
        const a = online();
        if (a) {
          void a.equip(slot, itemId).then((ok) => {
            if (ok && slot === 'emote') this.menu?.emote(itemId);
          });
          return;
        }
        if (this.profile.equip(slot, itemId)) {
          this.pushMeta();
          refreshLook();
          if (slot === 'emote') this.menu?.emote(itemId);
        }
      },
      onSelectLoadout: ({ index }) => {
        const a = online();
        if (a) {
          void a.selectLoadout(index);
          return;
        }
        this.profile.selectLoadout(index);
        this.pushMeta();
        refreshLook();
      },
      onCustomizeColors: ({ colors }) => {
        const a = online();
        if (a) {
          void a.setColors(colors);
          return;
        }
        this.profile.setColors(colors);
        this.pushMeta();
        refreshLook();
      },
      onRandomizeOutfit: () => {
        const a = online();
        if (a) void a.randomize();
        else {
          this.profile.randomize();
          this.pushMeta();
          refreshLook();
        }
        this.menu?.emote('emote.flex');
      },
      onPurchase: ({ offerId }) => {
        const a = online();
        if (a) {
          void a.purchase(offerId);
          return;
        }
        const r = this.profile.purchase(offerId);
        if ('item' in r) {
          s().pushToast({ kind: 'reward', title: `${r.item.name} is yours!`, icon: r.item.icon });
          this.pushMeta();
        } else {
          const msg =
            r.error === 'funds'
              ? 'Not enough currency — play a few shows!'
              : r.error === 'owned'
                ? 'You already own that.'
                : 'That offer is gone.';
          s().showDialog({ id: 'purchase-failed', kind: 'error', title: 'Purchase failed', body: msg });
        }
      },
      onBuyGems: ({ packId }) => {
        const a = online();
        if (a) void a.buyGems(packId);
        else s().pushToast({ kind: 'info', title: 'Gems need an online account', icon: '💎' });
      },
      onClaimPassTier: ({ tier, track }) => {
        const a = online();
        if (a) {
          void a.claimPassTier(tier, track);
          return;
        }
        if (this.profile.claimPassTier(tier, track)) {
          this.pushMeta();
          s().pushToast({ kind: 'reward', title: `Tier ${tier} claimed!`, icon: '🎁' });
        }
      },
      onBuyPremiumPass: () => {
        const a = online();
        if (a) {
          void a.buyPremiumPass();
          return;
        }
        if (this.profile.buyPremiumPass()) this.pushMeta();
        else
          s().showDialog({
            id: 'pass-funds',
            kind: 'error',
            title: 'Not enough Gems',
            body: 'Gems come from the store and the pass.',
          });
      },
      onClaimChallenge: ({ id }) => {
        const a = online();
        if (a) void a.claimChallenge(id);
        else if (this.profile.claimChallenge(id)) this.pushMeta();
      },
      onRerollChallenge: ({ id }) => {
        const a = online();
        if (a) void a.rerollChallenge(id);
        else s().pushToast({ kind: 'info', title: 'Rerolls need an online account', icon: '🎲' });
      },
      onPlayMode: () => {
        this.modePicked = true;
      },
      onRetryOnline: () => {
        void (this.account && !this.account.active ? this.connectAccount(null) : Promise.resolve()).finally(
          () => void this.refreshOnlineStatus(),
        );
      },
      onPlayCustomOffline: ({ options }) => {
        if (options.rounds.length === 0) return;
        this.lastPlaylist = null;
        this.startOfflineShow(customPlaylist(options));
      },
      onInspectPlayer: ({ playerId, name }) => {
        const local = localPlayerCard(this.profile, playerId);
        if (local) {
          s().setInspectedProfile(local);
          return;
        }
        if (!online() || playerId.startsWith('faced:')) {
          s().pushToast({ kind: 'info', title: `${name ?? 'That Tumbler'} has no public card yet` });
          return;
        }
        void online()!
          .inspect(playerId)
          .then((card) => {
            if (card) s().setInspectedProfile(card);
            else s().pushToast({ kind: 'info', title: "Couldn't load that profile" });
          });
      },
      onNewsRead: ({ ids }) => markNewsRead(ids),
      onLeaderboardQuery: ({ board, scope }) => {
        const a = online();
        if (a) void a.leaderboard(board, scope);
        else pushLeaderboard(this.profile, board);
      },
      onRequestMatchHistory: () => {
        const a = online();
        if (a) void a.history();
        else s().setMatchHistory(this.profile.uiHistory());
      },
      onSettingsChange: ({ settings }) => {
        saveJson('settings', settings);
        this.applySettings(settings);
      },
      onAccountAction: ({ action, value }) => {
        const a = online();
        if (action === 'signOut' || action === 'deleteAccount') {
          void this.signOut();
          return;
        }
        if (action === 'rename' && value) {
          this.profile.rename(value);
          if (a) void a.rename(value);
          else this.pushMeta();
        } else if (a && (action === 'link-discord' || action === 'link-google')) {
          const provider = action === 'link-discord' ? 'discord' : 'google';
          void this.api.request<{ url: string }>('POST', `/auth/${provider}/start`).then(
            (r) => window.location.assign(r.url),
            (err) =>
              s().pushToast({
                kind: 'info',
                title:
                  err instanceof ApiError && err.code === 'provider_disabled'
                    ? `${provider === 'discord' ? 'Discord' : 'Google'} sign-in isn't set up on this server`
                    : "Couldn't start sign-in",
                body:
                  err instanceof ApiError && err.code === 'provider_disabled'
                    ? 'Your guest account keeps saving progress.'
                    : errorText(err),
                icon: '🔒',
              }),
          );
        } else
          s().pushToast({
            kind: 'info',
            title: a ? 'That needs a linked account' : 'Accounts are offline right now',
            body: 'Your guest Tumbler is saved.',
            icon: '🔒',
          });
      },
      onPlay: ({ playlistId, mode }) => {
        if (mode === 'offline' && !this.cfg.online) {
          this.lastPlaylist = playlistId;
          this.startOfflineShow(
            resolvePlaylist(
              this.cfg.playlist ?? playlistId,
              this.profile.showsPlayed === 0 && !this.cfg.playlist && !this.account?.active,
            ),
          );
          return;
        }
        void this.startShow(playlistId);
      },
      onSelectPlaylist: ({ playlistId }) => void online()?.setPlaylist(playlistId),
      onReady: ({ ready }) => void online()?.setReady(ready),
      onCancelQueue: () => {
        if (this.queued && this.mm) {
          this.queued = false;
          void this.mm.cancel().catch(() => undefined);
          this.account?.setPresence('in_menu');
        }
        if (this.session) {
          this.session.quit();
          this.session = null;
        }
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
      onPhotoMode: () =>
        s().pushToast({
          kind: 'info',
          title: 'Say cheese!',
          body: 'Press F12 for a screenshot — photo mode controls are coming soon.',
          icon: '📸',
        }),
      onCreateCustom: ({ options }) => {
        if (this.customUnavailable() || !this.mm) return;
        void this.mm
          .createLobby({
            rounds: options.rounds,
            bots: options.bots,
            maxPlayers: options.maxPlayers,
            roundTimeScale: Math.min(2, Math.max(0.5, options.timerScale)),
            spectatorSlots: options.spectators ? 2 : 0,
          })
          .then(
            ({ lobby }) => this.applyLobby(lobby),
            (err) =>
              s().showDialog({
                id: 'custom-failed',
                kind: 'error',
                title: "Couldn't create the lobby",
                body: errorText(err),
              }),
          );
      },
      onJoinCode: ({ code }) => {
        if (this.customUnavailable() || !this.mm) return;
        void this.mm.joinLobby(code.toUpperCase()).then(
          ({ lobby }) => this.applyLobby(lobby),
          (err) =>
            s().showDialog({
              id: 'badcode',
              kind: 'error',
              title: 'No show with that code',
              body: errorText(err),
              code: 'E-LOBBY-404',
            }),
        );
      },
      onStartCustom: () => {
        const lobby = this.lobby;
        if (!lobby || !this.mm) return;
        void this.mm.startLobby(lobby.code).catch((err) =>
          s().showDialog({
            id: 'custom-start-failed',
            kind: 'error',
            title: "Couldn't start the show",
            body: errorText(err),
          }),
        );
      },
      onLeaveCustom: () => {
        const lobby = this.lobby;
        this.applyLobby(null);
        if (lobby && this.mm) void this.mm.leaveLobby(lobby.code).catch(() => undefined);
      },
      onInviteFriend: ({ friendId }) => {
        const a = online();
        if (a) void a.invite(friendId);
        else s().pushToast({ kind: 'social', title: 'Invites need an online account', icon: '💌' });
      },
      onAddFriend: ({ nameTag }) => {
        const a = online();
        if (a) void a.addFriend(nameTag);
        else s().pushToast({ kind: 'social', title: 'Friends need an online account', icon: '👥' });
      },
      onKickPartyMember: ({ memberId }) => void online()?.kick(memberId),
      onLeaveParty: () => void online()?.leaveParty(),
      onToastAction: ({ actionId }) => {
        online()?.handleToastAction(actionId);
      },
      onCopyInvite: ({ code }) => {
        const url = online()?.party?.inviteUrl ?? `${location.origin}/join/${code}`;
        void navigator.clipboard?.writeText(url).catch(() => undefined);
        s().pushToast({ kind: 'success', title: 'Invite link copied!', body: url, icon: '📋' });
      },
      onNavUnhandled: ({ dir }) => {
        if (dir === 'back' && s().screen === 'menu' && s().overlay === 'none') s().setOverlay('settings');
      },
      onRetryConnection: () => s().setConnection({ status: 'connecting' }),
    });

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', () => {
      const st = s();
      if (
        this.session ||
        st.screen !== 'menu' ||
        st.menuTab !== 'play' ||
        st.overlay !== 'none' ||
        !this.menu
      )
        return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      canvas.focus({ preventScroll: true });
      this.menu.setIdlePlay(true);
    });
    // Capture phase + preventDefault: Esc only leaves idle play; menu navigation must not also treat it as Back.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape' || !this.menu?.idlePlaying) return;
        e.preventDefault();
        this.menu.setIdlePlay(false);
      },
      true,
    );
  }

  private leaveToMenu(): void {
    if (this.session) {
      this.session.quit();
      this.session = null;
    }
    if (this.account?.active) this.account.setPresence('in_menu');
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
      this.input.setBinding(
        action,
        codes.filter((c) => c !== ''),
      );
    }
    const view = this.session?.roundView;
    view?.setAccessibility(st.accessibility.reduceShake, st.gameplay.nameplates, st.gameplay.streamerMode);
    if (view) view.setPreset(this.quality.preset);
    this.stats.setVisible(this.cfg.debug || st.graphics.showFps);
  }
}
