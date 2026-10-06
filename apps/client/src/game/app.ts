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
 * - parties: the leader queues once every member is ready and in the menu;
 *   anyone may play Vs Bots or Practice Island on their own (confirmed, and
 *   the party is told);
 * - rejoining a running online show after a reload, and never re-entering
 *   one that ended;
 * - custom lobbies through the matchmaker, one Join dialog for show and
 *   party codes, and Play again back into the same private show;
 * - the frame loop: show session, active 3D view, post pipeline, audio
 *   listener, adaptive resolution, stats;
 * - settings persistence and live application; debug panel and hooks.
 */
import {
  analyticsAllowed,
  bindUI,
  keyboardBusy,
  mountUI,
  social,
  ui,
  uiEvents,
  type CustomLobbyOptions,
  type CustomLobbyState,
  type DialogSpec,
  type PrivacyNavigator,
  type Settings,
  type UIState,
} from '@tumble/ui';
import { bindChatRouter } from './social/chatRouter.ts';
import { loadMutes, publishSocialAvailability, socialIntents } from './social/intents.ts';
import { onLobbyChat, onLobbyChatError, syncLobbyChat } from './social/lobbyChat.ts';
import { maskedProfile, streamerMode } from './social/streamerNames.ts';
import { createRenderer, setTeamColorMode } from '@tumble/render';
import { createPostPipeline, type PostPipeline } from '@tumble/render/post';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import type { MatchDeps } from '@tumble/sim/match';
import type { ShowPlaylist } from '@tumble/sim/show';
import { getPlaylist } from '@tumble/content/shows';
import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { InputSystem } from '../input/index.ts';
import { keymapFromKeybinds, padMenuButtons, padmapFromPadBinds } from './bindings.ts';
import { GamepadNavigator, firstStandardPad } from '../input/gamepadNav.ts';
import { StatsOverlay } from '../debug/stats.ts';
import { checkDeterminism } from '../debug/determinism.ts';
import { drawBreakdown } from '../debug/drawBreakdown.ts';
import { DEV_TOOLS } from '../devTools.ts';
import { ApiClient, ApiError } from './api.ts';
import { AudioBridge } from './audioBridge.ts';
import { startVoice, type VoiceHandle } from './voice/voiceWiring.ts';
import { installAutoplay } from './autoplay.ts';
import { resolveTumblerFactory, type ResolvedTumblerFactory } from './characters.ts';
import type { GameConfig } from './config.ts';
import { botLoadout, tumblerColors } from './cosmetics.ts';
import { createDebugPanel } from './debugPanel.ts';
import type { TumbleHooks } from './hooks.ts';
import { customRoundId, normalizeShareCode } from '@tumble/content/custom';
import { defaultDrafts } from '../customRounds/drafts.ts';
import { loadPlaytest } from '../customRounds/playtest.ts';
import { registerCustomRound } from '../customRounds/registry.ts';
import { playAgainAction, type LastShow } from './lastShow.ts';
import {
  localPlayerCard,
  markNewsRead,
  pushLeaderboard,
  pushLiveNews,
  pushMeta,
  pushPlaylists,
  pushStaticMeta,
} from './meta.ts';
import { playlistIdForPlay, privateShow, resolvePlaylist } from './playlists.ts';
import { Analytics, setAnalytics, track } from './liveOps/analytics.ts';
import { LiveOpsController } from './liveOps/controller.ts';
import { flag, gatedReplays, liveFlags } from './liveOps/flags.ts';
import { isPlaylistLive } from './liveOps/schedule.ts';
import { OnlineAccount } from './online/account.ts';
import { PhotoMode } from './photo/photoMode.ts';
import { AccountAuth } from './online/auth.ts';
import { finishCheckoutReturn } from './online/checkout.ts';
import { joinWithCode, partyOwnerLabel, watchStartedShow } from './online/joinCode.ts';
import {
  liveStartedLobby,
  lobbyOptions,
  optionsToSettings,
  reduceLobbyEvent,
  toCustomLobbyState,
  type LobbyEvent,
} from './online/lobbyState.ts';
import { queueRefusal, routePlay, type PlayKind } from './online/partyPlay.ts';
import { RejoinStore, planRejoin, sessionStore, type RejoinPlan } from './online/rejoin.ts';
import { onlineCounts, queueTarget } from './online/playerCounts.ts';
import { MatchmakerClient, gameSocketUrl, type Lobby, type MatchFound } from './online/matchmaker.ts';
import {
  chooseRegion,
  deviceTimezoneRegion,
  probeRegions,
  type Region,
  type RegionProbe,
} from './online/region.ts';
import { ProfileStore } from './profile.ts';
import { QualityManager } from './quality.ts';
import { ReplayController } from './replay/controller.ts';
import { ShareController } from './share/shareController.ts';
import type { GameContext, SessionEnd } from './show/context.ts';
import { OfflineShowSession } from './show/offline.ts';
import { OnlineShowSession, gameServerAvailable } from './show/online.ts';
import type { ShowSession } from './show/session.ts';
import { loadJson, saveJson } from './storage.ts';
import type { CeremonyPost } from './views/ceremonies.ts';
import { MenuView } from './views/menuView.ts';
import { loadTimingsLog } from './round/loadPipeline.ts';
import { rosterFromParty, type PartyRoster } from './views/partyLobby.ts';
import { SceneDirector } from './views/sceneDirector.ts';
import { ThumbnailRenderer } from './thumbnails.ts';
import { swapUnderWipe } from './wipe.ts';
import { runTutorial } from './tutorial/index.ts';
import { shouldOfferTutorial, tutorialAnswer } from './tutorial/prompt.ts';
import { menuOwnsPad, padStartAction, showMenuKeyAction, type RoutingContext } from './inputRouting.ts';

/** Merges saved settings over defaults so new fields always exist. */
function mergeSettings(base: Settings, saved: Partial<Settings> | null): Settings {
  if (!saved) return base;
  return {
    graphics: { ...base.graphics, ...saved.graphics },
    controls: {
      ...base.controls,
      ...saved.controls,
      keybinds: { ...base.controls.keybinds, ...saved.controls?.keybinds },
      padBinds: { ...base.controls.padBinds, ...saved.controls?.padBinds },
    },
    audio: { ...base.audio, ...saved.audio },
    accessibility: { ...base.accessibility, ...saved.accessibility },
    gameplay: { ...base.gameplay, ...saved.gameplay },
    voice: { ...base.voice, ...saved.voice },
  };
}

/** Extra wiring from `main.ts`. */
export interface BootOptions {
  /** Uncaught errors captured so far this page load (reported as `error_count`). */
  errorCount?: () => number;
}

/**
 * Installs the game's analytics: batched to `<api>/events` while the API is
 * reachable, gated by the player's setting (and browser privacy signals) and
 * the `analytics.sample` flag. The session's new error count goes out with
 * the last batch when the page hides.
 */
function installAnalytics(cfg: GameConfig, api: ApiClient, errorCount?: () => number): void {
  const analytics = new Analytics({
    endpoint: () => (cfg.api && api.online ? `${cfg.apiUrl}/events` : null),
    allowed: () => analyticsAllowed(ui.getState().settings.gameplay.analytics, navigator as PrivacyNavigator),
    sampleRate: () => liveFlags.sampleRate(),
    token: () => api.accessToken(),
    tokenSync: () => api.currentAccessToken(),
    ...(typeof navigator.sendBeacon === 'function'
      ? { sendBeacon: (url: string, data: Blob) => navigator.sendBeacon(url, data) }
      : {}),
  });
  let reported = 0;
  analytics.install(window, document, () => {
    const n = errorCount?.() ?? 0;
    if (n > reported) analytics.track('error_count', { count: n - reported });
    reported = n;
  });
  setAnalytics(analytics);
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
  /** How the last show was started, for Play again. */
  private lastShow: LastShow | null = null;
  private fpsSmooth = 60;
  private last = performance.now();
  private lastRender = 0;
  private readonly timeScale: { value: number };
  private readonly hooks: TumbleHooks;
  private readonly memoryLog: { round: string; geometries: number; textures: number }[] = [];
  private lastMemoryView: object | null = null;
  private readonly ctx: GameContext;
  private readonly account: OnlineAccount | null;
  /** Voice chat, wired once an online account is signed in (off until the player opts in). */
  private voice: VoiceHandle | null = null;
  private readonly mm: MatchmakerClient | null;
  private partyLooks: TumblerLoadout[] = [];
  private partyMembers: { userId: string; loadout: TumblerLoadout }[] = [];
  private partyRoster: PartyRoster | null = null;
  private queued = false;
  private pendingJoin: string | null = deepLinkCode();
  private lobby: Lobby | null = null;
  /** A lobby arrived (e.g. restored after a reload) before the menu was up; open it there. */
  private lobbyRevealPending = false;
  /** The private show the local player hosts after it moved to the game server (in-show kicks). */
  private startedLobby: Lobby | null = null;
  private readonly thumbs: ThumbnailRenderer;
  private readonly padNav = new GamepadNavigator();
  private readonly photo: PhotoMode;
  /** The running online show kept for a rejoin after a reload, and matches already over. */
  private readonly rejoin = new RejoinStore(sessionStore());
  /** The private show that just started (its code and settings), until its `match_found` arrives. */
  private lobbyMatch: { matchId: string; code: string; host: boolean; options: CustomLobbyOptions } | null =
    null;
  /** Humans the game server has in the running show; null before its first roster. */
  private showHumans: ReadonlySet<string> | null = null;
  /** The party was told this player is in a solo show (tell them again when it ends). */
  private soloAnnounced = false;
  /** The Practice Island prompt showed in this launch. */
  private tutorialAsked = false;
  private regionProbe: RegionProbe = { pings: {}, available: [], matchmakerMs: null };
  private regionProbing: Promise<void> | null = null;
  private regionProbedAt = -Infinity;
  private readonly auth: AccountAuth;
  private readonly replays: ReplayController;
  /** Share cards and replay clips for the show just played. */
  private readonly share: ShareController;
  /** Flags, maintenance and playlist schedules from the API. */
  private readonly liveOps: LiveOpsController;

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
    this.photo = new PhotoMode(renderer.domElement as HTMLCanvasElement, post, director);
    this.account = cfg.api
      ? new OnlineAccount(api, {
          onLookChanged: () => {
            this.menu?.setLoadout(this.look());
            this.menu?.setEquippedLook(this.look());
          },
          onPartyChanged: (members) => {
            this.partyMembers = members;
            this.partyLooks = members.map((m) => m.loadout);
            this.menu?.setPartyLooks(members);
            this.menu?.setParty(this.partyLooks);
          },
          onPartyRoster: (party, selfId) => {
            this.partyRoster = rosterFromParty(party, selfId);
            this.menu?.setPartyRoster(this.partyRoster);
          },
        })
      : null;
    this.mm = cfg.api && cfg.matchmaking ? new MatchmakerClient(cfg.mmUrl, api) : null;
    this.liveOps = new LiveOpsController({
      api: cfg.api ? api : null,
      onPlaylists: () => pushPlaylists(this.showsPlayed()),
      onMaintenance: () => void this.refreshOnlineStatus(),
    });
    this.auth = new AccountAuth({
      api,
      profile,
      account: this.account,
      onLocalProfileChanged: () => this.pushMeta(),
    });
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
      replaysEnabled: () => flag('replays.enabled'),
      eliminationReplay: () => ui.getState().settings.gameplay.eliminationReplay,
      track: (name, props) => track(name, props),
    });
    this.share = new ShareController({
      renderer,
      createTumbler: tumblers.create,
      look: () => this.look(),
      playerName: () => (this.account?.active ? this.account.name : profile.name),
      library: this.replays.library,
      createReplayView: (data, viewPost) => this.replays.createView(data, viewPost),
      tier: () => quality.tier,
      toneMapping: () => quality.preset.post.toneMapping ?? 'neutral',
      replaysEnabled: () => flag('replays.enabled'),
      onFlagsChanged: (fn) => liveFlags.subscribe(fn),
      track: (name, props) => track(name, props),
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
      replays: gatedReplays(this.replays.live, () => flag('replays.enabled')),
      eliminations: this.replays.eliminations,
      onShowResult: (facts) => this.share.showFinished(facts),
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
      ...(DEV_TOOLS
        ? {
            drawBreakdown: () => {
              const v = this.director.view;
              return v ? drawBreakdown(v.scene, v.camera) : {};
            },
          }
        : {}),
      simStepMs: () => (this.session instanceof OfflineShowSession ? this.session.stepMs : 0),
      tumblers: () => this.session?.visibleTumblers() ?? 0,
      localPlayer: () => this.session?.localDebug() ?? null,
      tier: () => quality.tier,
      memoryLog: this.memoryLog,
      loadTimings: loadTimingsLog,
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
    if (this.account?.active) pushStaticMeta(this.showsPlayed());
    else pushMeta(this.profile);
  }

  /** Whether to show the Practice Island prompt now (at most once per launch). */
  private offerTutorial(): boolean {
    const offer = shouldOfferTutorial({
      dontAsk: this.profile.tutorialAnswered,
      completed: this.profile.tutorialCompleted,
      askedThisLaunch: this.tutorialAsked,
    });
    if (offer) this.tutorialAsked = true;
    return offer;
  }

  /** Finished shows for First Show selection: the account's when signed in, else this device's; null while unknown. */
  private showsPlayed(): number | null {
    if (this.account?.active) return ui.getState().profile?.stats.shows ?? null;
    return this.profile.showsPlayed;
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
  static async boot(
    cfg: GameConfig,
    staticProgress: (pct: number, label: string) => void,
    opts: BootOptions = {},
  ): Promise<GameApp> {
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
    app.watchConnectivity();
    if (cfg.debug)
      createDebugPanel({ renderer, quality, stats, session: () => app.session, timeScale: app.timeScale });
    if (cfg.autoplay) installAutoplay(cfg.autoShows);
    app.liveOps.start(window);
    installAnalytics(cfg, api, opts.errorCount);
    if (cfg.api) void pushLiveNews(api.news);
    loadMutes();
    if (cfg.api) {
      // OAuth/email returns settle which session to resume before the normal connect.
      void app.auth
        .boot()
        .then(() => app.connectAccount(null))
        .finally(() => {
          app.auth.publishSession();
          publishSocialAvailability(app.account?.active ?? false);
          void app.refreshOnlineStatus();
          void finishCheckoutReturn(app.auth.bootReturn, api, app.account?.active ? app.account : null);
        });
    } else {
      publishSocialAvailability(false);
      void app.refreshOnlineStatus();
    }
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
    this.voice ??= startVoice({
      realtime: account.socket,
      api: this.api,
      selfId: () => account.userId,
      engine: this.audio.engine,
    });
    // Rollouts are per account, and an offline boot may have skipped the first fetch.
    void this.liveOps.refresh();
    publishSocialAvailability(true);
    void this.probeRegions();
    if (this.mm) {
      void this.mm.probe().then((up) => {
        if (up) this.mm?.socket.start();
      });
      this.bindMatchmaker();
    }
    void this.offerRejoin();
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

    this.pollPadNav(now);
    const device = this.input.lastDevice;
    if (ui.getState().hud.device !== device) ui.getState().setHud({ device });

    // An offline show is only this player: it waits while they watch a replay. Online shows run on.
    const held = this.replays.active && this.session instanceof OfflineShowSession;
    try {
      if (!held) this.session?.frame(dt, realDt);
    } catch (err) {
      console.error('[game] show frame failed', err);
    }
    this.replays.frame(realDt);
    const warp = this.session?.timeWarp ?? 1;
    const d = this.director;
    // PERF: an opaque loading screen hides the canvas; drawing it would only steal frame time from the build.
    if (!d.covered) d.update(dt * warp, realDt);
    this.photo.update(realDt);
    this.voice?.tick(now);
    this.audio.setListener(d.listenerPos, d.listenerFwd, d.listenerUp);
    this.audio.update();
    this.post.update(realDt);
    if (!d.covered) {
      this.post.render();
      this.photo.afterRender();
    }
    // Thumbnails only render in the menus, one per frame, so shows never hitch.
    if (!this.session) this.thumbs.pump(realDt * 1000);
    // Build slices stretch frames while covered; they say nothing about render cost.
    const lowered = d.covered ? null : this.quality.sample(realDt * 1000);
    if (lowered) {
      ui.getState().pushToast({
        kind: 'info',
        title: `Graphics lowered to ${lowered[0]?.toUpperCase()}${lowered.slice(1)}`,
        body: 'Auto quality stepped down to keep the game smooth.',
      });
    }
    this.stats.set('view', `${d.kind} · ${this.quality.tier} · ${this.quality.adaptive.scale.toFixed(2)}x`);
    this.stats.update(realDt, this.renderer);
    this.hooks.frames++;
    this.trackMemory();
  }

  /**
   * Gamepad menu navigation (SCREENS.md §1.1). Whenever a menu owns the pad
   * (menu screens, overlays, dialogs, the watch choice; see `menuOwnsPad`)
   * the D-pad/stick, A, B, LB and RB drive `navigate` and gameplay ignores
   * the pad; Start toggles the in-game menu or Settings. Spectate cycling on
   * LB/RB lives in the show session; the replay viewer reads the pad itself
   * while it is open.
   */
  private pollPadNav(now: number): void {
    const s = ui.getState();
    const photo = s.photo.active;
    // The elimination replay reads the pad itself (any button skips it).
    const replay = s.replay !== null || s.elimReplay !== null;
    const padToMenu = menuOwnsPad(s, this.menu?.idlePlaying ?? false);
    this.input.setGamepadGameplay(!padToMenu);
    const pad =
      typeof navigator.getGamepads === 'function' ? firstStandardPad(navigator.getGamepads()) : null;
    // Edges are tracked even during a replay so its buttons never fire here afterwards.
    const actions = this.padNav.update(pad, now, true);
    // Settings → Controller is listening for a button to bind; it must not also navigate.
    if (replay || s.padCapture) return;
    for (const a of actions) {
      this.input.lastDevice = 'gamepad';
      if (a === 'start') this.onPadStart();
      // Photo mode flies the camera with the sticks and bumpers; only A (Take photo) and B (Exit) navigate.
      else if (photo) {
        if (a === 'accept' || a === 'back') ui.getState().navigate(a);
      } else if (padToMenu) ui.getState().navigate(a);
    }
  }

  /** Facts the pad / Menu key routing needs from the game side. */
  private routingContext(): RoutingContext {
    return {
      idlePlaying: this.menu?.idlePlaying ?? false,
      inShow: this.session !== null,
      sessionOwnsMenu: this.session?.ownsMenuKey ?? false,
    };
  }

  /** Start: the in-game menu on every show screen, Settings elsewhere; leaves idle play first. */
  private onPadStart(): void {
    const s = ui.getState();
    switch (padStartAction(s, this.routingContext())) {
      case 'exitPhoto':
        this.photo.exit();
        break;
      case 'leaveIdlePlay':
        this.menu?.setIdlePlay(false);
        break;
      case 'openShowMenu':
        s.setOverlay('inGameMenu');
        break;
      case 'closeOverlay':
        s.setOverlay('none');
        break;
      case 'openSettings':
        s.setOverlay('settings');
        break;
      case 'none':
        break;
    }
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
      lobbyLink: this.account?.lobbyLink ?? null,
      roster: this.partyRoster,
    });
    this.menu.setPartyLooks(this.partyMembers);
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

  /**
   * Back from the queue card to the menu. The menu never left the screen
   * (matchmaking only swaps the start card), so there is nothing to cover
   * with a wipe.
   */
  private leaveQueueScreen(): void {
    if (ui.getState().screen === 'matchmaking') ui.getState().setScreen('menu', { transition: 'none' });
    else this.goMenu();
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
      if (this.lobbyRevealPending && this.lobby) {
        this.lobbyRevealPending = false;
        ui.getState().setOverlay('privateShow');
      }
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
    // NOTE: `onLine === false` is reliable (no network at all); `true` only means "maybe", so probe then.
    if (!navigator.onLine) {
      s.setOnlineStatus({
        state: 'offline',
        noNetwork: true,
        message: "You're offline. Shows against bots still work.",
      });
      if (s.playMode === 'online') ui.setState({ playMode: 'offline' });
      return;
    }
    if (!this.cfg.online && this.liveOps.maintenanceActive()) {
      // Shown on the Play Online tile; Vs Bots stays available.
      s.setOnlineStatus({ state: 'offline', message: this.liveOps.maintenance().message });
      if (s.playMode === 'online') ui.setState({ playMode: 'offline' });
      return;
    }
    s.setOnlineStatus({ state: 'checking' });
    let up = false;
    if (this.cfg.online) up = await gameServerAvailable();
    else if (this.account?.active && this.mm) up = await this.mm.probe();
    const mm = up && !this.cfg.online ? this.mm : null;
    const counts = mm ? onlineCounts(await mm.stats(), mm.searching) : {};
    s.setOnlineStatus(
      up
        ? { state: 'online', ...counts }
        : { state: 'offline', message: 'The game servers are offline right now.' },
    );
    if (up && !this.modePicked) s.setPlayMode('online');
    if (!up && s.playMode === 'online') ui.setState({ playMode: 'offline' });
  }

  /**
   * Follows the device's network: offline, the Play tab says so and bot shows
   * carry on; back online, the account reconnects and Play Online is re-probed.
   */
  private watchConnectivity(): void {
    const tellOffline = (): void => {
      // A running show handles its own connection (the reconnect curtain online; nothing to lose offline).
      if (this.session) return;
      ui.getState().pushToast({
        kind: 'info',
        title: "You're offline",
        body: 'Shows against bots work without a connection. Online play comes back when you reconnect.',
        durationMs: 6000,
      });
    };
    window.addEventListener('offline', () => {
      void this.refreshOnlineStatus();
      tellOffline();
    });
    window.addEventListener('online', () => uiEvents.emit('retryOnline'));
    if (!navigator.onLine) tellOffline();
  }

  /** Starts an offline show vs bots right away (Vs Bots, private show with bots). */
  private startOfflineShow(playlist: ShowPlaylist, roundTimeScale?: number): void {
    if (this.session) return;
    this.beginShow();
    this.menu?.setIdlePlay(false);
    this.lastSummary = null;
    const seed = this.cfg.seed ?? (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
    const session = new OfflineShowSession(this.ctx, playlist, seed, roundTimeScale);
    this.session = session;
    session.start();
    this.markPlayingSolo(playlist.id);
  }

  /** Clears what the last show left behind before the next one starts. */
  private beginShow(): void {
    this.account?.cancelRewardWait();
    ui.getState().setRewardsPending(null);
  }

  /**
   * A solo show (Vs Bots, Practice) began: friends see the player in a show,
   * which also keeps the party leader from queueing without them, and the
   * party is told.
   */
  private markPlayingSolo(playlistId?: string): void {
    const a = this.account?.active ? this.account : null;
    if (!a) return;
    a.setPresence('in_match', playlistId ? { playlistId } : {});
    if (a.inParty) {
      this.soloAnnounced = true;
      void a.announceSolo(true);
    }
  }

  /** The solo show is over: the party learns the player is back. */
  private endPlayingSolo(): void {
    if (!this.soloAnnounced) return;
    this.soloAnnounced = false;
    void this.account?.announceSolo(false);
  }

  /**
   * Shows a dialog and resolves with the pressed button id (the cancel
   * button's id when it is dismissed).
   */
  private ask(spec: DialogSpec): Promise<string> {
    return new Promise((resolve) => {
      const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
        if (dialogId !== spec.id) return;
        off();
        resolve(buttonId);
      });
      ui.getState().showDialog(spec);
    });
  }

  /**
   * Vs Bots or Practice Island: always allowed, but inside a party it is
   * confirmed first, since the others will wait without this player.
   *
   * @returns Whether it started.
   */
  private async playSolo(kind: PlayKind, start: () => void): Promise<boolean> {
    const a = this.account?.active ? this.account : null;
    const route = routePlay(kind, { inParty: a?.inParty ?? false, isLeader: a?.isLeader ?? true });
    if (route.action === 'confirmSolo') {
      const choice = await this.ask({
        id: 'solo-confirm',
        kind: 'confirm',
        title: route.dialog.title,
        body: route.dialog.body,
        buttons: [
          { id: 'cancel', label: 'Stay', variant: 'secondary', autofocus: true },
          { id: 'confirm', label: route.dialog.confirm, variant: 'go' },
        ],
      });
      if (choice !== 'confirm') return false;
    }
    if (this.session) return false;
    start();
    return true;
  }

  /** Practice Island, any time (tutorial prompt, Play tab, Settings). */
  private startPractice(): void {
    if (this.session) return;
    this.beginShow();
    this.menu?.setIdlePlay(false);
    this.session = runTutorial(this.ctx);
    this.markPlayingSolo();
  }

  /** Vs Bots on a playlist (the first-ever show uses the gentler starter playlist). */
  private startBotShow(playlistId: string | null): void {
    this.lastShow = { kind: 'offline', playlistId };
    // Play again (or a stale selection) can name a limited-time show that has since closed.
    const live = playlistId && isPlaylistLive(getPlaylist(playlistId), playlistId) ? playlistId : null;
    this.startOfflineShow(resolvePlaylist(live, this.showsPlayed(), this.cfg.playlist ?? null));
  }

  /** Play again: the same kind of show as last time (mode, playlist, private-show options). */
  private replayLastShow(): void {
    const a = this.account?.active ? this.account : null;
    const next = playAgainAction(this.lastShow, { partyMember: !!a && a.inParty && !a.isLeader });
    switch (next.action) {
      case 'offline':
        this.startBotShow(next.playlistId);
        break;
      case 'custom': {
        this.lastShow = { kind: 'custom', options: next.options };
        const show = privateShow(next.options);
        this.startOfflineShow(show.playlist, show.roundTimeScale);
        break;
      }
      case 'play':
        void this.startShow(next.playlistId);
        break;
      case 'menu':
        ui.getState().pushToast({ kind: 'info', title: next.title, body: next.body });
        this.goMenu();
        break;
      case 'reopenLobby':
      case 'rejoinLobby':
        this.goMenu();
        void this.backToPrivateShow(next);
        break;
      case 'playtest':
        void this.startPlaytest();
        break;
    }
  }

  /**
   * The round editor's Test play: the draft it saved, as a one-round show vs
   * bots. Read again on every start, so Play again picks up the latest save.
   */
  private async startPlaytest(): Promise<void> {
    if (this.session) return;
    const result = await loadPlaytest(defaultDrafts());
    if (!result.ok) {
      ui.getState().pushToast({ kind: 'error', title: 'Test play', body: result.message });
      this.goMenu();
      return;
    }
    if (this.session) return;
    this.lastShow = { kind: 'playtest' };
    this.startOfflineShow(result.playlist);
  }

  /** Looks up a shared round by code for a private show's round picker. */
  private async lookupCustomRound(input: string): Promise<void> {
    const set = (v: Parameters<UIState['setCustomRoundLookup']>[0]) => ui.getState().setCustomRoundLookup(v);
    const code = normalizeShareCode(input);
    if (!code) {
      set({ status: 'error', code: input, message: 'Codes are 8 letters and numbers' });
      return;
    }
    set({ status: 'loading', code });
    try {
      const shared = await this.api.customRound(code);
      const id = customRoundId(code);
      const reg = registerCustomRound(shared.definition, id);
      if (!reg.ok) {
        set({ status: 'error', code, message: 'This round does not pass the current rules' });
        return;
      }
      ui.getState().addCustomRoundEntry({
        id,
        name: reg.round.name,
        type: reg.round.type,
        custom: true,
        ...(shared.author ? { author: shared.author } : {}),
      });
      set({ status: 'ok', code, id });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      set({
        status: 'error',
        code,
        message:
          e?.code === 'taken_down'
            ? 'This round was removed by moderators'
            : e?.status === 404
              ? 'No shared round has that code'
              : 'Could not reach the server; try again',
      });
    }
  }

  /**
   * Play again after a private online show: the host reopens the same lobby
   * (a new one with the same settings if it expired), members rejoin it with
   * its code.
   */
  private async backToPrivateShow(
    next: Extract<ReturnType<typeof playAgainAction>, { action: 'reopenLobby' | 'rejoinLobby' }>,
  ): Promise<void> {
    const mm = this.mm;
    if (this.customUnavailable() || !mm) return;
    const s = ui.getState();
    try {
      const { lobby } =
        next.action === 'reopenLobby' ? await mm.reopenLobby(next.code) : await mm.joinLobby(next.code);
      this.applyLobby(lobby);
      return;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (next.action === 'reopenLobby' && code === 'lobby_not_found' && next.options) {
        try {
          this.applyLobby((await mm.createLobby(optionsToSettings(next.options), this.region())).lobby);
        } catch (again) {
          s.showDialog({
            id: 'custom-failed',
            kind: 'error',
            title: "Couldn't create the lobby",
            body: errorText(again),
          });
        }
        return;
      }
      if (code === 'lobby_started') {
        const choice = await this.ask({
          id: 'lobby-not-open',
          kind: 'info',
          title: "The host hasn't opened the next show yet",
          body: 'They reopen the lobby with Play again. Try again in a moment.',
          buttons: [
            { id: 'ok', label: 'Back to menu', variant: 'secondary' },
            { id: 'retry', label: 'Try again', variant: 'go', autofocus: true },
          ],
        });
        if (choice === 'retry') void this.backToPrivateShow(next);
        return;
      }
      s.showDialog({
        id: 'custom-closed',
        kind: 'info',
        title: code === 'lobby_not_found' ? 'That private show has closed' : "Couldn't get back to the lobby",
        body: code === 'lobby_not_found' ? 'Start a new one from Private on the Play tab.' : errorText(err),
      });
    }
  }

  /** True when Play should go through the matchmaker. */
  private get canMatchmake(): boolean {
    return !this.cfg.online && !!this.mm?.online && !!this.account?.active;
  }

  private async startShow(playlistId: string | null): Promise<void> {
    if (this.session) return;
    if (this.canMatchmake && this.refuseForMaintenance()) return;
    this.beginShow();
    this.menu?.setIdlePlay(false);
    this.lastShow = { kind: 'auto', playlistId };
    this.lastSummary = null;
    if (this.canMatchmake) {
      const selected = playlistId ?? ui.getState().selectedPlaylist;
      // A newcomer's own Play gets the First Show; a mixed party keeps what the leader picked.
      const solo = (this.account?.party?.members.length ?? 1) <= 1;
      await this.queue(solo ? playlistIdForPlay(selected, this.showsPlayed()) : selected);
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
      const playlist = resolvePlaylist(playlistId, this.showsPlayed(), this.cfg.playlist ?? null);
      const seed = this.cfg.seed ?? (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
      session = new OfflineShowSession(this.ctx, playlist, seed);
    }
    this.session = session;
    session.start();
    if (session instanceof OfflineShowSession) this.markPlayingSolo(playlistId ?? undefined);
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
    this.showSearching(account.party?.members.length ?? 1, playlistId);
    try {
      const { ticket } = await this.api.queueTicket(playlistId, this.region());
      await mm.queue(ticket);
      this.queued = true;
      account.setPresence('in_queue', { playlistId });
      // Only now are the members' ready votes spent: a refused enqueue keeps them.
      void account.confirmQueued();
    } catch (err) {
      this.queued = false;
      this.trackQueueWait('refused');
      if (err instanceof ApiError && err.code === 'maintenance') void this.liveOps.refreshStatus();
      if (err instanceof ApiError && err.code === 'playlist_unavailable')
        void this.liveOps.refreshPlaylists();
      const why = queueRefusal(err instanceof ApiError ? err.code : '', errorText(err));
      s.showDialog({
        id: 'queue-failed',
        kind: 'error',
        title: why.title,
        body: why.body,
        ...(err instanceof ApiError ? { code: err.code } : {}),
      });
      s.setQueue({ status: 'idle' });
      this.leaveQueueScreen();
    }
  }

  /** Reports how long the player searched (`matchmaking_wait`) as the search ends. */
  private trackQueueWait(outcome: 'matched' | 'cancelled' | 'refused' | 'stopped'): void {
    const q = ui.getState().queue;
    if (q.status !== 'searching' || !q.startedAt) return;
    track('matchmaking_wait', {
      seconds: Math.round((Date.now() - q.startedAt) / 1000),
      outcome,
      playlist: ui.getState().selectedPlaylist || null,
      region: q.region || null,
    });
  }

  private showSearching(partySize: number, playlistId: string | null): void {
    const s = ui.getState();
    s.setQueue({
      status: 'searching',
      startedAt: Date.now(),
      playersFound: partySize,
      playersNeeded: queueTarget(s.playlists, playlistId ?? s.selectedPlaylist),
      etaSec: -1,
      region: this.region().toUpperCase(),
    });
    if (s.screen !== 'matchmaking') s.setScreen('matchmaking');
  }

  /** Subscribes to the matchmaker stream (queue status, match found, custom lobbies). */
  private bindMatchmaker(): void {
    const mm = this.mm;
    if (!mm) return;
    mm.on('queued', (m) => {
      this.queued = true;
      const playlistId = typeof m.playlistId === 'string' ? m.playlistId : null;
      if (!this.session) this.showSearching(this.account?.party?.members.length ?? 1, playlistId);
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
      this.trackQueueWait(m.reason === 'cancelled' ? 'cancelled' : 'stopped');
      ui.getState().setQueue({ status: 'idle' });
      if (ui.getState().screen === 'matchmaking') this.leaveQueueScreen();
      if (m.reason === 'maintenance') {
        // The matchmaker sent everyone back when the window opened; the status poll may not have run yet.
        void this.liveOps.refreshStatus();
        ui.getState().pushToast({
          kind: 'warning',
          title: 'Down for maintenance',
          body: 'Matchmaking is paused for maintenance. You can still play Vs Bots.',
        });
      } else if (m.reason && m.reason !== 'cancelled')
        ui.getState().pushToast({
          kind: 'warning',
          title: 'Matchmaking stopped',
          body: String(m.reason),
          icon: '⏹️',
        });
    });
    mm.on('match_found', (m) => this.startMatchmadeShow(m as unknown as MatchFound));
    mm.on('lobby_update', (m) => this.onLobbyEvent({ type: 'lobby_update', lobby: m.lobby as Lobby }));
    mm.on('lobby_closed', (m) => this.onLobbyEvent({ type: 'lobby_closed', code: String(m.code ?? '') }));
    mm.on('lobby_chat', (m) => onLobbyChat(m, this.account?.userId ?? null));
    mm.on('error', (m) => onLobbyChatError(m));
    mm.on('lobby_kicked', (m) =>
      this.onLobbyEvent({
        type: 'lobby_kicked',
        code: String(m.code ?? ''),
        reason: m.reason === 'away' ? 'away' : 'kicked',
      }),
    );
  }

  private startMatchmadeShow(m: MatchFound): void {
    this.queued = false;
    // A replayed match_found for a show this player already finished or left must not pull them back in.
    if (this.rejoin.isEnded(m.matchId)) {
      void this.mm?.declineMatch().catch(() => undefined);
      return;
    }
    if (this.session) return;
    this.trackQueueWait('matched');
    if (ui.getState().dialog?.id === 'rejoin-show') ui.getState().closeDialog();
    this.startOnlineShow({
      url: gameSocketUrl(m.server.url),
      ticket: m.ticket,
      matchId: m.matchId,
      playlistId: m.playlistId,
      queue: m.queue,
      ticketExpiresAt: Date.now() + m.expiresIn * 1000,
    });
  }

  /** Enters a matchmade (or rejoined) online show. */
  private startOnlineShow(opts: {
    url: string;
    ticket: string;
    matchId: string;
    playlistId: string;
    queue: string;
    ticketExpiresAt: number;
    resumeToken?: string;
  }): void {
    this.beginShow();
    this.menu?.setIdlePlay(false);
    this.lastSummary = null;
    const lm = this.lobbyMatch?.matchId === opts.matchId ? this.lobbyMatch : null;
    this.lastShow =
      opts.queue === 'custom'
        ? {
            kind: 'custom',
            options: lm?.options ?? null,
            lobby: { code: lm?.code ?? null, host: lm?.host ?? false },
          }
        : { kind: 'matchmade', playlistId: opts.playlistId };
    this.applyLobby(null);
    this.showHumans = null;
    const session = new OnlineShowSession(this.ctx, {
      ...opts,
      rejoin: this.rejoin,
      onHumans: (ids) => {
        this.showHumans = ids;
        if (this.startedLobby) this.applyLobby(this.lobby);
      },
    });
    this.session = session;
    this.account?.setPresence('in_match', { playlistId: opts.playlistId });
    session.start();
  }

  /**
   * On boot: a show this tab was connected to before a reload may still be
   * running. Offer to jump back in.
   */
  private async offerRejoin(): Promise<void> {
    const plan = planRejoin(this.rejoin.load(), Date.now(), (id) => this.rejoin.isEnded(id));
    if (plan.kind === 'none') {
      this.rejoin.clear();
      return;
    }
    const choice = await this.ask({
      id: 'rejoin-show',
      kind: 'confirm',
      title: 'Rejoin show',
      body: 'Your last show is still running. Jump back in?',
      buttons: [
        { id: 'leave', label: 'Leave show', variant: 'secondary' },
        { id: 'rejoin', label: 'Rejoin', variant: 'go', autofocus: true },
      ],
    });
    // The show may have started on its own meanwhile (a replayed match_found).
    if (this.session) return;
    if (choice !== 'rejoin') {
      this.rejoin.finish(plan.record.matchId);
      return;
    }
    await this.rejoinShow(plan);
  }

  /**
   * Back into a stored show: the resume token inside the server's window,
   * a matchmaker rejoin ticket when the stored ticket or the seat is gone.
   */
  private async rejoinShow(plan: Extract<RejoinPlan, { kind: 'rejoin' }>): Promise<void> {
    const rec = plan.record;
    let target = {
      url: rec.serverUrl,
      ticket: rec.ticket,
      playlistId: rec.playlistId,
      queue: rec.queue,
      ticketExpiresAt: rec.expiresAt,
    };
    if (plan.freshTicket) {
      try {
        if (!this.mm) throw new ApiError(0, 'network', 'Matchmaking is unreachable.');
        const m = await this.mm.rejoinMatch(rec.matchId);
        target = {
          url: gameSocketUrl(m.server.url),
          ticket: m.ticket,
          playlistId: m.playlistId,
          queue: m.queue,
          ticketExpiresAt: Date.now() + m.expiresIn * 1000,
        };
      } catch (err) {
        // With a live seat the token alone may still get in; without one there is no way back.
        if (!plan.resumeToken) {
          const over = err instanceof ApiError && err.status !== 0;
          if (over) this.rejoin.finish(rec.matchId);
          ui.getState().showDialog({
            id: 'rejoin-failed',
            kind: 'info',
            title: over ? 'That show has ended' : "Couldn't rejoin the show",
            body: over ? 'It finished while you were away.' : errorText(err),
          });
          return;
        }
      }
    }
    if (this.session) return;
    this.startOnlineShow({
      ...target,
      matchId: rec.matchId,
      ...(plan.resumeToken ? { resumeToken: plan.resumeToken } : {}),
    });
  }

  /**
   * The local player is done with an online show (finished, left, or it
   * failed): stop offering it for a rejoin and stop the matchmaker replaying
   * it if they never reached the server.
   *
   * @param failed - The connection failed mid-show; the show may still run, so a reload can still rejoin.
   */
  private forgetOnlineShow(session: ShowSession | null, failed = false): void {
    if (!(session instanceof OnlineShowSession) || !session.matchId) return;
    if (!session.reachedServer) void this.mm?.declineMatch().catch(() => undefined);
    if (!failed || !session.reachedServer) this.rejoin.finish(session.matchId);
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    this.lastSummary = s.uiShowSummary();
    s.dispose();
    this.session = null;
  }

  private onSessionEnd(reason: SessionEnd): void {
    this.forgetOnlineShow(this.session, reason === 'failed');
    this.endSession();
    this.endPlayingSolo();
    this.clearStartedLobby();
    this.pushMeta();
    if (this.account?.active) {
      this.account.setPresence('in_menu');
      void this.account.refreshProgress();
    }
    if (reason === 'rewards') {
      swapUnderWipe('rewards', { transition: 'wipe' }, () => this.showMenuScene());
    } else if (reason === 'playAgain') {
      this.showMenuScene();
      this.replayLastShow();
    } else this.goMenu();
  }

  // ---------------------------------------------------------------------------
  // Custom lobbies
  // ---------------------------------------------------------------------------

  /** Applies a matchmaker lobby event and tells the player what happened. */
  private onLobbyEvent(event: LobbyEvent): void {
    const me = this.account?.userId ?? null;
    if (event.type === 'lobby_update' && event.lobby.status === 'started') {
      const l = event.lobby;
      // Play again returns everyone to this lobby, so remember it until (and after) match_found.
      if (l.matchId)
        this.lobbyMatch = {
          matchId: l.matchId,
          code: l.code,
          host: l.hostId === me,
          options: lobbyOptions(l.settings),
        };
      // The host keeps the roster of the running show for in-show kicks; members let match_found take over.
      this.startedLobby = l.hostId === me ? l : null;
      this.applyLobby(null);
      return;
    }
    const { next, notice, removed } = reduceLobbyEvent(this.lobby, event, me);
    this.applyLobby(next);
    const s = ui.getState();
    if (removed && s.overlay === 'privateShow') s.setOverlay('none');
    // In a running show the game server's kick ends the session with its own dialog and way back to the menu.
    if (!notice || (this.session && event.type === 'lobby_kicked')) return;
    if (notice.dialog)
      s.showDialog({
        id: 'custom-removed',
        kind: 'info',
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
      });
    else
      s.pushToast({ kind: notice.kind, title: notice.title, ...(notice.body ? { body: notice.body } : {}) });
  }

  private lobbyView(lobby: Lobby): CustomLobbyState {
    return toCustomLobbyState(lobby, this.account?.userId ?? null, (seat, self) =>
      self
        ? (ui.getState().profile?.colors ?? tumblerColors(this.look()))
        : tumblerColors(botLoadout(1, seat.name.length, seat.name)),
    );
  }

  private applyLobby(lobby: Lobby | null): void {
    const joined = lobby !== null && this.lobby === null;
    syncLobbyChat(this.lobby, lobby, this.account?.userId ?? null, this.mm);
    this.lobby = lobby;
    if (!lobby || lobby.status === 'started') {
      this.lobbyRevealPending = false;
      const started = this.startedLobby ? liveStartedLobby(this.startedLobby, this.showHumans) : null;
      ui.getState().setCustomLobby(started ? { ...this.lobbyView(started), started: true } : null);
      if (!lobby && this.account?.active && !this.session) this.account.setPresence('in_menu');
      return;
    }
    this.startedLobby = null;
    // Friends see the code on our row and can hop into the private show.
    if (this.account?.active) this.account.setPresence('in_menu', { lobbyCode: lobby.code });
    ui.getState().setCustomLobby(this.lobbyView(lobby));
    // Only a fresh join opens the dialog; live updates must not reopen it after the player closed it.
    if (!joined) return;
    if (ui.getState().screen === 'menu') ui.getState().setOverlay('privateShow');
    else this.lobbyRevealPending = true;
  }

  /** Forgets the running private show (its session ended). */
  private clearStartedLobby(): void {
    this.showHumans = null;
    if (!this.startedLobby) return;
    this.startedLobby = null;
    if (!this.lobby) ui.getState().setCustomLobby(null);
  }

  /**
   * Runs a call on the current lobby (or, when `started` is allowed, the
   * running private show the local player hosts). The result is not applied:
   * every change is pushed to all members as `lobby_update`, and applying a
   * response that raced a newer push would roll the view back.
   */
  private lobbyCall(
    failTitle: string,
    fn: (mm: MatchmakerClient, code: string) => Promise<unknown>,
    started = false,
  ): void {
    const lobby = this.lobby ?? (started ? this.startedLobby : null);
    const mm = this.mm;
    if (!lobby || !mm) return;
    void fn(mm, lobby.code).catch((err: unknown) =>
      ui.getState().pushToast({ kind: 'error', title: failTitle, body: errorText(err) }),
    );
  }

  /**
   * Online queueing and private lobbies are closed during maintenance (the
   * matchmaker refuses them too); explains why instead of a failed request.
   *
   * @returns True when refused.
   */
  private refuseForMaintenance(): boolean {
    if (!this.liveOps.maintenanceActive()) return false;
    ui.getState().showDialog({
      id: 'maintenance',
      kind: 'info',
      title: 'Down for maintenance',
      body: `${this.liveOps.maintenance().message} You can still play Vs Bots.`,
    });
    return true;
  }

  private customUnavailable(): boolean {
    if (this.refuseForMaintenance()) return true;
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
    bindChatRouter();
    bindUI({
      onChatInput: ({ open }) => {
        if (!open) return;
        // Typing must not steer the Tumbler: drop held keys (their keyup goes to the
        // text field) and free the mouse for the widget.
        this.ctx.input.releaseKeys();
        if (document.pointerLockElement) document.exitPointerLock();
      },
    });
    const refreshLook = (): void => this.menu?.setLoadout(this.look());
    const online = (): OnlineAccount | null => (this.account?.active ? this.account : null);
    bindUI({
      onStart: () => {
        this.audio.unlock();
        if (this.cfg.playtest && this.profile.exists && !this.session) {
          this.goMenu();
          void this.startPlaytest();
          return;
        }
        if (!this.profile.exists) s().setScreen('welcome', { transition: 'wipe' });
        else if (this.offerTutorial()) s().setScreen('tutorialPrompt', { transition: 'fade' });
        else this.goMenu();
      },
      onPreviewColors: ({ colors, pattern }) =>
        this.menu?.setLoadout(this.profile.previewLoadout({ ...colors, pattern })),
      onWelcomeDone: ({ name, colors }) => {
        this.profile.create(name, colors);
        this.pushMeta();
        refreshLook();
        if (this.cfg.api) void this.connectAccount({ name, colors }).then(() => this.auth.publishSession());
        if (this.offerTutorial()) s().setScreen('tutorialPrompt', { transition: 'fade' });
        else this.goMenu();
      },
      onTutorialChoice: (choice) => {
        const answer = tutorialAnswer(choice);
        // "I'll wing it" alone only skips this launch; the prompt returns until ticked or completed.
        if (answer.stopAsking) this.profile.answerTutorial();
        if (answer.start && !this.session) this.startPractice();
        else this.goMenu();
      },
      onStartPractice: () => {
        if (this.session) return;
        void this.playSolo('practice', () => this.startPractice());
      },
      onMenuTab: ({ tab }) => {
        if (tab !== 'play') this.menu?.setIdlePlay(false);
        if (tab === 'store') track('store_view', { online: !!online() });
        // The Profile tab lists the latest shows; an account's history lives on the API.
        if (tab === 'profile') void online()?.history();
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
      onRequestPurchaseHistory: () => {
        const a = online();
        if (a) void a.loadPurchaseHistory();
      },
      onRefundPurchase: ({ purchaseId, reason }) => {
        const a = online();
        if (a) void a.refundPurchase(purchaseId, reason);
        else s().pushToast({ kind: 'info', title: 'Refunds need an online account' });
      },
      onRequestGifts: () => {
        const a = online();
        if (a) void a.loadGifts();
      },
      onGiftAction: ({ giftId, action }) => {
        const a = online();
        if (a) void a.giftAction(giftId, action);
      },
      onOpenGiftPicker: ({ offerId, recipientId }) => {
        const a = online();
        if (a) void a.openGiftPicker(offerId, recipientId);
        else s().pushToast({ kind: 'info', title: 'Gifts need an online account' });
      },
      onSendGift: ({ offerId, recipientId, message }) => {
        const a = online();
        if (a) void a.sendGift(offerId, recipientId, message);
      },
      onRequestWishlist: () => {
        const a = online();
        if (a) void a.loadWishlist();
      },
      onWishlistToggle: ({ itemId, on }) => {
        const a = online();
        if (a) void a.wishlistToggle(itemId, on);
        else s().pushToast({ kind: 'info', title: 'Wish lists need an online account' });
      },
      onWishlistReorder: ({ itemIds }) => {
        const a = online();
        if (a) void a.wishlistReorder(itemIds);
      },
      onWishlistSettings: (patch) => {
        const a = online();
        if (a) void a.wishlistSettings(patch);
      },
      onRequestFriendWishlist: ({ userId }) => {
        const a = online();
        if (a) void a.loadFriendWishlist(userId);
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
            body: 'Earn Gems from weekly challenges, your first Crown each day, level milestones and the pass.',
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
      onClaimEventTier: ({ eventId, tier }) => {
        const a = online();
        if (a) void a.claimEventTier(eventId, tier);
        else s().pushToast({ kind: 'info', title: 'Event rewards need an online account' });
      },
      onClaimEventChallenge: ({ eventId, challengeId }) => {
        const a = online();
        if (a) void a.claimEventChallenge(eventId, challengeId);
        else s().pushToast({ kind: 'info', title: 'Event rewards need an online account' });
      },
      onClaimLoginStreak: () => {
        const a = online();
        if (a) void a.claimLoginStreak();
        else s().setLoginStreak(null);
      },
      onPlayMode: () => {
        this.modePicked = true;
      },
      onRetryOnline: () => {
        void (this.account && !this.account.active ? this.connectAccount(null) : Promise.resolve()).finally(
          () => {
            this.auth.publishSession();
            if (this.cfg.api) void this.auth.refreshProviders();
            publishSocialAvailability(this.account?.active ?? false);
            void this.refreshOnlineStatus();
          },
        );
      },
      onCustomRoundLookup: ({ code }) => void this.lookupCustomRound(code),
      onPlayCustomOffline: ({ options }) => {
        if (options.rounds.length === 0) return;
        this.lastShow = { kind: 'custom', options };
        const show = privateShow(options);
        this.startOfflineShow(show.playlist, show.roundTimeScale);
      },
      onInspectPlayer: ({ playerId, name, direct, masked }) => {
        // Party members (slots, the 3D party lobby) open the player card first.
        const member = !direct ? s().party?.members.find((m) => m.id === playerId && !m.isSelf) : undefined;
        if (member) {
          social.getState().openPlayerMenu({
            userId: member.id,
            name: member.name,
            ...(member.tag ? { tag: member.tag } : {}),
            key: member.id,
          });
          return;
        }
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
            if (!card) s().pushToast({ kind: 'info', title: "Couldn't load that profile" });
            // SECURITY: the card comes back with the real Name#tag; a click on a masked name keeps the mask.
            else s().setInspectedProfile(masked && streamerMode() ? maskedProfile(card, name) : card);
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
      onSettingsChange: ({ settings, section }) => {
        saveJson('settings', settings);
        this.applySettings(settings);
        if (section === 'gameplay') this.publishRegion();
      },
      onProbeRegions: () => void this.probeRegions(),
      onAccountAction: ({ action, value }) => {
        if (action === 'signOut') void this.signOut();
        else if (action === 'deleteAccount') void this.auth.deleteAccount(() => this.signOut());
        else void this.auth.handle(action, value);
      },
      onPlay: ({ playlistId, mode }) => {
        if (mode === 'offline' && !this.cfg.online) {
          void this.playSolo('offline', () => this.startBotShow(playlistId));
          return;
        }
        void this.startShow(playlistId);
      },
      onSelectPlaylist: ({ playlistId }) => {
        // Browsing onto a "Coming soon" card is not a pick: the API would refuse it for the party.
        if (s().playlists.find((p) => p.id === playlistId)?.comingSoon) return;
        void online()?.setPlaylist(playlistId);
      },
      onReady: ({ ready }) => void online()?.setReady(ready),
      onCancelQueue: () => {
        this.trackQueueWait('cancelled');
        if (this.queued && this.mm) {
          this.queued = false;
          void this.mm.cancel().catch(() => undefined);
          this.account?.setPresence('in_menu');
        }
        const hadSession = this.quitSession();
        s().setQueue({ status: 'idle' });
        if (hadSession) this.goMenu();
        else this.leaveQueueScreen();
      },
      onPlayAgain: () => {
        this.quitSession();
        this.replayLastShow();
      },
      onBackToLobby: () => this.leaveToMenu(),
      onLeaveShow: () => this.leaveToMenu(),
      onEmote: ({ id }) => {
        if (!this.session) this.menu?.emote(id);
        else this.session.emoteById(id);
      },
      onLobbyGameStart: ({ game }) => {
        if (!this.session) this.menu?.startLobbyGame(game);
      },
      onLobbyGameStop: () => this.menu?.stopLobbyGame(),
      onPhotoMode: () => {
        if (!this.photo.enter())
          s().pushToast({ kind: 'info', title: 'Nothing to photograph right now', icon: '📸' });
      },
      onPhotoCapture: () => this.photo.capture(),
      onPhotoExit: () => this.photo.exit(),
      onCreateCustom: ({ options }) => {
        if (this.customUnavailable() || !this.mm) return;
        void this.mm.createLobby(optionsToSettings(options), this.region()).then(
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
      onJoinCode: ({ code }) => void this.joinCode(code),
      onStartCustom: ({ force }) => {
        const lobby = this.lobby;
        if (!lobby || !this.mm) return;
        void this.mm.startLobby(lobby.code, force === true).catch((err) =>
          s().showDialog({
            id: 'custom-start-failed',
            kind: 'error',
            title: "Couldn't start the show",
            body: errorText(err),
          }),
        );
      },
      onUpdateCustom: ({ options }) =>
        this.lobbyCall("Couldn't change that setting", (mm, code) =>
          mm.updateLobby(code, optionsToSettings(options)),
        ),
      onKickCustomMember: ({ userId }) =>
        this.lobbyCall("Couldn't remove that player", (mm, code) => mm.kickFromLobby(code, userId), true),
      onUnbanCustomMember: ({ userId }) =>
        this.lobbyCall("Couldn't unban that player", (mm, code) => mm.unbanFromLobby(code, userId)),
      onTransferCustomHost: ({ userId }) =>
        this.lobbyCall("Couldn't hand over the crown", (mm, code) => mm.transferLobbyHost(code, userId)),
      onLockCustom: ({ locked }) =>
        this.lobbyCall(locked ? "Couldn't lock the show" : "Couldn't unlock the show", (mm, code) =>
          mm.lockLobby(code, locked),
        ),
      onNewCustomCode: () => this.lobbyCall("Couldn't make a new code", (mm, code) => mm.newLobbyCode(code)),
      onReadyCustom: ({ ready }) =>
        this.lobbyCall("Couldn't change ready", (mm, code) => mm.readyInLobby(code, ready)),
      onSpectateCustom: ({ spectator }) =>
        this.lobbyCall(
          spectator ? "Couldn't take a spectator seat" : "Couldn't take a player seat",
          (mm, code) => mm.setLobbyRole(code, spectator),
        ),
      onLeaveCustom: () => {
        const lobby = this.lobby;
        this.applyLobby(null);
        if (lobby && this.mm) void this.mm.leaveLobby(lobby.code).catch(() => undefined);
      },
      ...socialIntents(online),
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
      onPromotePartyMember: ({ memberId }) => void online()?.promote(memberId),
      onLeaveParty: () => void online()?.leaveParty(),
      onToastAction: ({ actionId }) => {
        online()?.handleToastAction(actionId);
      },
      // The UI copied exactly what the player picked (lobby code, party code or link) and confirmed it.
      onCopyInvite: ({ kind, what }) => track('invite.copy', { kind, what }),
      onNavUnhandled: ({ dir }) => {
        if (dir !== 'back') return;
        if (s().screen === 'menu' && s().overlay === 'none') {
          s().setOverlay('settings');
          return;
        }
        // Show screens that hand the keys to menus (results, victory, the wall) have no Back of
        // their own: Esc / B opens the in-game menu there, like on every other show screen.
        if (this.session && !this.session.ownsMenuKey && showMenuKeyAction(s()) === 'open')
          s().setOverlay('inGameMenu');
      },
      onRetryConnection: () => {
        if (this.session) this.session.retryConnection();
        else s().setConnection({ status: 'online' });
      },
      onTouchInput: (snapshot) => this.input.applyTouch(snapshot),
      onTouchLook: ({ dx, dy }) => this.input.addTouchLook(dx, dy),
    });

    const canvas = this.renderer.domElement;
    const onStagePress = (x: number, y: number): void => {
      const st = s();
      if (
        this.session ||
        st.screen !== 'menu' ||
        st.menuTab !== 'play' ||
        st.overlay !== 'none' ||
        !this.menu
      )
        return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((x - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((y - rect.top) / rect.height) * 2;
      if (this.menu.signAt(nx, ny)) {
        st.setLobbyGames({ pickerOpen: true });
        return;
      }
      const member = this.menu.memberAt(nx, ny);
      if (member) {
        uiEvents.emit('inspectPlayer', { playerId: member.userId, name: member.name });
        return;
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      canvas.focus({ preventScroll: true });
      this.menu.setIdlePlay(true);
    };
    canvas.addEventListener('pointerdown', (e) => onStagePress(e.clientX, e.clientY));
    // Touch idle play covers the stage with the camera-drag surface, which forwards taps here.
    uiEvents.on('stageTap', ({ x, y }) => onStagePress(x, y));
    uiEvents.on('leaveIdlePlay', () => this.menu?.setIdlePlay(false));
    // Capture phase + preventDefault: Esc only leaves idle play; menu navigation must not also treat it as Back.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape' || !this.menu?.idlePlaying || keyboardBusy(e)) return;
        e.preventDefault();
        this.menu.setIdlePlay(false);
      },
      true,
    );
  }

  /**
   * Join with a code: a private show's lobby when one owns the code, else
   * the party behind it (asking before leaving a party with others in it).
   */
  /**
   * The code's private show already started: offer a spectator seat and, on
   * yes, join the running show to watch it.
   */
  private async offerWatch(code: string): Promise<void> {
    const s = ui.getState();
    const mm = this.mm?.online ? this.mm : null;
    if (!mm) return;
    const choice = await this.ask({
      id: 'watch-started-show',
      kind: 'confirm',
      title: 'That show already started',
      body: 'Watch it from a spectator seat? Spectators never count as players and can follow anyone.',
      buttons: [
        { id: 'cancel', label: 'Not now', variant: 'secondary' },
        { id: 'watch', label: 'Watch', variant: 'go', autofocus: true },
      ],
    });
    if (choice !== 'watch' || this.session) return;
    const r = await watchStartedShow(code, (c) => mm.watchLobby(c));
    if (r.kind === 'error') {
      s.showDialog({ id: 'watch-failed', kind: 'error', title: r.title, body: r.body, code: r.code });
      return;
    }
    if (s.overlay === 'joinCode') s.setOverlay('none');
    this.startMatchmadeShow(r.match);
  }

  private async joinCode(code: string, leaveParty = false): Promise<void> {
    const s = ui.getState();
    const account = this.account?.active ? this.account : null;
    if (!account) {
      s.showDialog({
        id: 'custom-offline',
        kind: 'error',
        title: 'Codes need the online servers',
        body: 'Sign in and make sure the servers are reachable.',
        code: 'E-CODE-503',
      });
      return;
    }
    const mm = this.mm?.online ? this.mm : null;
    const r = await joinWithCode(
      code,
      {
        joinLobby: mm ? (c) => mm.joinLobby(c) : null,
        partyByCode: (c) => this.api.partyByCode(c),
        joinParty: (c) => this.api.joinParty(c),
        currentParty: () => account.party,
      },
      { leaveParty },
    );
    switch (r.kind) {
      case 'lobby':
        this.applyLobby(r.lobby);
        return;
      case 'started':
        await this.offerWatch(r.code);
        return;
      case 'party':
        account.adoptJoinedParty(r.party);
        if (s.overlay === 'joinCode') s.setOverlay('none');
        return;
      case 'alreadyInParty':
        s.pushToast({
          kind: 'info',
          title: "That's your party's code",
          body: 'Share it so friends can join you.',
        });
        if (s.overlay === 'joinCode') s.setOverlay('none');
        return;
      case 'confirmLeaveParty': {
        const who = partyOwnerLabel(r.preview.leader, streamerMode());
        const choice = await this.ask({
          id: 'leave-party-confirm',
          kind: 'confirm',
          title: 'Leave your party?',
          body: `You're in a party of ${r.currentSize}. Leave it and join ${who}?`,
          buttons: [
            { id: 'cancel', label: 'Stay', variant: 'secondary', autofocus: true },
            { id: 'confirm', label: 'Leave and join', variant: 'go' },
          ],
        });
        if (choice === 'confirm') await this.joinCode(code, true);
        return;
      }
      case 'error':
        s.showDialog({ id: 'badcode', kind: 'error', title: r.title, body: r.body, code: r.code });
        return;
    }
  }

  /**
   * Leaves the running show early: it is over for this player (no rejoin
   * offer, no replayed match_found), the party learns they are back, and
   * friends see them in the menu until the next show says otherwise.
   *
   * @returns Whether a show was running.
   */
  private quitSession(): boolean {
    const session = this.session;
    if (!session) return false;
    this.forgetOnlineShow(session);
    session.quit();
    this.session = null;
    this.endPlayingSolo();
    if (this.account?.active) this.account.setPresence('in_menu');
    return true;
  }

  private leaveToMenu(): void {
    this.quitSession();
    this.clearStartedLobby();
    if (this.account?.active) this.account.setPresence('in_menu');
    this.goMenu();
  }

  // ---------------------------------------------------------------------------
  // Region
  // ---------------------------------------------------------------------------

  /** The region to matchmake in: the manual pick, or what Auto chose. */
  private region(): Region {
    return chooseRegion(ui.getState().settings.gameplay.region, this.regionProbe, deviceTimezoneRegion());
  }

  /**
   * Measures region pings against the matchmaker (at most once a minute;
   * concurrent callers share one probe), then publishes the result.
   */
  private probeRegions(): Promise<void> {
    if (this.regionProbing) return this.regionProbing;
    if (!this.mm || performance.now() - this.regionProbedAt < 60_000) {
      this.publishRegion();
      return Promise.resolve();
    }
    ui.getState().setRegionStatus({ probing: true });
    this.regionProbing = probeRegions(this.cfg.mmUrl, {
      fetch: (url, init) => fetch(url, init),
      now: () => performance.now(),
    })
      .then((probe) => {
        this.regionProbe = probe;
        this.regionProbedAt = performance.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.regionProbing = null;
        ui.getState().setRegionStatus({ probing: false });
        this.publishRegion();
      });
    return this.regionProbing;
  }

  /** Shows pings and the Auto pick, remembers the region and tells the account API when it changed. */
  private publishRegion(): void {
    const region = this.region();
    ui.getState().setRegionStatus({
      pings: { ...this.regionProbe.pings },
      auto: chooseRegion('auto', this.regionProbe, deviceTimezoneRegion()),
    });
    saveJson('region', region);
    const me = this.account?.active ? this.account.me : null;
    if (me && me.region !== region) {
      me.region = region;
      void this.api.patchMe({ region }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private applySettings(st: Settings): void {
    this.quality.applySettings(st.graphics);
    this.audio.applySettings(st);
    // 3D team colours are read when a round is built, so this applies from the next round.
    setTeamColorMode(st.accessibility.colorBlind);
    this.input.settings.sensitivity = st.controls.mouseSensitivity;
    this.input.settings.invertY = st.controls.invertY;
    this.input.settings.toggleGrab = st.controls.toggleGrab;
    this.input.setKeymap(keymapFromKeybinds(st.controls.keybinds));
    this.input.setPadMap(padmapFromPadBinds(st.controls.padBinds));
    this.padNav.setStartButtons(padMenuButtons(st.controls.padBinds));
    const view = this.session?.roundView;
    view?.setAccessibility(st.accessibility.reduceShake, st.gameplay.nameplates, st.gameplay.streamerMode);
    view?.setBotTags(st.gameplay.botTags);
    if (view) view.setPreset(this.quality.preset);
    this.stats.setVisible(this.cfg.debug || st.graphics.showFps);
  }
}
