/**
 * Show choreography shared by the offline and online runners.
 *
 * Responsibilities:
 * - drives the UI screens through a whole show (pre-show → show intro →
 *   per round: loading, flyover title, rules, countdown, HUD, stamps, results,
 *   between rounds, final hype → victory / winner cam → player wall → rewards),
 *   mirroring the timing of the UI preview's mock show;
 * - swaps 3D views while the Tumble Wipe covers the screen;
 * - owns the round view, HUD mapper, gameplay input (look, emote wheel,
 *   spectate cycling), local fate stamps, slow-mo and the autoplay pilot;
 * - builds the end-of-show recap for the wall and the rewards payload.
 *
 * Subclasses supply the data (director events or server messages) through the
 * protected `on*` entry points and implement {@link advance}. The offline
 * runner also honours {@link gated}: the UI pauses the show clock while a card
 * is on screen, so nothing happens behind a title the player is still reading.
 */
import type { ChallengeMetric } from '@tumble/content/progression';
import { getTheme } from '@tumble/content/themes';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { RoundPhase, ShowPhase, type RoundPhaseId, type RoundType } from '@tumble/shared';
import { CharacterState, type CharacterFullState, type CharacterInput, type SimEvent } from '@tumble/sim';
import { createBotBrain, type BotBrainLike, type BotSelfView } from '@tumble/sim/bots';
import { createCharacterFullState } from '@tumble/sim/character';
import { PlayerRoundStatus } from '@tumble/sim/match';
import type { ShowPlaylist } from '@tumble/sim/show';
import {
  bindUI,
  ui,
  type PlayerWallEvent,
  type RoundIntroInfo,
  type ScreenId,
  type SetScreenOptions,
  type ShowPlayer,
  type RewardsSummary,
  type ShowSummary as UiShowSummary,
} from '@tumble/ui';
import { emoteSlots, showPlayer } from '../cosmetics.ts';
import type { ShowResultForProfile } from '../profile.ts';
import { HudMapper, type HudInput } from '../round/hud.ts';
import { TumblerPool } from '../round/playerVisuals.ts';
import { RoundView } from '../round/roundView.ts';
import type { RoundSource } from '../round/source.ts';
import { createPodiumView, createPreShowView, createResultsView, WallView, type PreShowView } from '../views/ceremonies.ts';
import type { GameContext, RoundOutcomeInfo, RoundStart, SessionPlayer, SessionSummary } from './context.ts';

/** Local player's fate in the current round. */
type Fate = 'playing' | 'qualified' | 'eliminated' | 'spectating';

interface ActiveRound {
  start: RoundStart;
  source: RoundSource | null;
  view: RoundView | null;
  hud: HudMapper | null;
  fate: Fate;
  inRound: boolean;
  /** The loading wipe is up: the 3D round may be built now. */
  loadRequested: boolean;
  introShown: boolean;
  loadMinDone: boolean;
  outcome: RoundOutcomeInfo | null;
  resultsShown: boolean;
  countdown: number | null;
  spectateId: number;
  playingSince: number;
  /** Seconds from GO to the local player qualifying (race finish time). */
  qualifiedAfter?: number;
}

const SLOWMO_SCALE = 0.3;
const SLOWMO_SECONDS = 1.5;
const WIPE_FALLBACK_S = 1.6;

/**
 * Estimated rounds in a show, replaying the director's final-round rule with
 * the playlist's shrink curve (the real count depends on live results).
 *
 * @param p - Playlist.
 * @param players - Show size.
 */
export function estimateRoundCount(p: ShowPlaylist, players: number): number {
  let n = players;
  for (let i = 0; i < p.maxRounds; i++) {
    const isFinal = n <= 2 || i >= p.maxRounds - 1 || (n <= p.finalAtOrBelow && i >= p.minRounds - 1);
    if (isFinal) return i + 1;
    n = Math.max(2, Math.round(n * (p.qualifyCurve[i] ?? 0.65)));
  }
  return p.maxRounds;
}

/** Rules card pictograms per round type. */
function rulesFor(type: RoundType, isFinal: boolean, target: number, seconds: number): { icon: string; text: string }[] {
  if (isFinal) return [{ icon: '👑', text: 'Only one Tumbler wins' }, { icon: '🏁', text: type === 'race' ? 'First to the finish!' : 'Be the last one standing' }, { icon: '🏆', text: 'Win the Crown!' }];
  switch (type) {
    case 'race':
      return [{ icon: '🏁', text: 'Reach the finish line' }, { icon: '⚠️', text: 'Dodge the obstacles' }, { icon: '✅', text: `First ${target} qualify` }];
    case 'survival':
      return [{ icon: '⏳', text: `Survive ${Math.round(seconds)} seconds` }, { icon: '🌀', text: "Don't fall off!" }, { icon: '✅', text: 'Survivors qualify' }];
    case 'team':
      return [{ icon: '🤝', text: 'Work with your team' }, { icon: '🎯', text: 'Score the most points' }, { icon: '📉', text: 'Lowest team is out' }];
    case 'hunt':
      return [{ icon: '🎀', text: 'Grab a tail' }, { icon: '✊', text: 'Hold on to it' }, { icon: '⏰', text: 'Have one when time runs out' }];
    case 'logic':
      return [{ icon: '🧠', text: 'Watch the pattern' }, { icon: '🟩', text: 'Stand on the right tile' }, { icon: '⬇️', text: 'Wrong tiles drop away' }];
    default:
      return [{ icon: '👑', text: 'Only one Tumbler wins' }, { icon: '🏁', text: 'Reach the top first' }, { icon: '🏆', text: 'Win the Crown!' }];
  }
}

/**
 * Base class for a running show.
 *
 * @example
 * const s = new OfflineShowSession(ctx, playlist);
 * s.start();
 * // per frame
 * s.frame(dt, realDt);
 */
export abstract class ShowSession {
  /** Participants by id. */
  protected readonly players = new Map<number, SessionPlayer>();
  /** Lobby join order (player wall cell order). */
  protected order: number[] = [];
  /** Local player id (-1 before assignment). */
  protected localId = -1;
  protected showName = 'Main Show';
  protected roundCount = 3;
  /** Active round, if any. */
  protected round: ActiveRound | null = null;
  /** Latest round phase seen. */
  protected phase: RoundPhaseId | null = null;
  /** Latest show phase seen. */
  protected showPhaseId: number = ShowPhase.PreShow;
  protected readonly pool: TumblerPool;
  protected readonly outcomes: RoundOutcomeInfo[] = [];
  protected summary: SessionSummary | null = null;
  protected readonly counters: Partial<Record<ChallengeMetric, number>> = {};
  /** Set while a UI card holds the show clock (offline only honours it). */
  private holds = 0;
  private flowClock = 0;
  private timers: { at: number; fn: () => void }[] = [];
  private readonly covered = new Map<ScreenId, () => void>();
  private readonly offs: (() => void)[] = [];
  private ended = false;
  private awaiting: 'victory' | 'wall' | 'rewards' | null = null;
  private wall: WallView | null = null;
  private preShow: PreShowView | null = null;
  private slowmo = 0;
  private wheelOpen = false;
  private pendingEmote = 0;
  private toastTokens = 4;
  private uiSummary: UiShowSummary | null = null;
  private pilot: BotBrainLike | null = null;
  private readonly pilotSelf: BotSelfView = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    grounded: true,
    state: CharacterState.Idle,
    facing: 0,
    status: PlayerRoundStatus.Playing,
    team: -1,
    hasItem: false,
    checkpoint: 0,
  };
  private readonly pilotState: CharacterFullState = createCharacterFullState();
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(protected readonly ctx: GameContext) {
    this.pool = new TumblerPool(ctx.tumblers.create);
    this.offs.push(
      bindUI({
        onTransitionCovered: ({ to }) => {
          const fn = this.covered.get(to);
          if (fn) {
            this.covered.delete(to);
            fn();
          }
        },
        onSpectate: () => this.beginSpectating(),
        onSpectateNext: ({ dir }) => this.cycleSpectate(dir),
        onEmote: ({ slot }) => {
          this.pendingEmote = Math.min(4, slot + 1);
          this.counters.emotes = (this.counters.emotes ?? 0) + 1;
        },
        onContinue: ({ from }) => {
          if ((from === 'victory' || from === 'winnerCam') && this.awaiting === 'victory') this.goWall();
          else if (from === 'playerWall' && this.awaiting === 'wall') this.goRewards();
        },
        onPlayerWallEvent: (e: PlayerWallEvent) => this.wall?.handle(e),
      }),
    );
    window.addEventListener('keydown', this.onKey);
  }

  // ---------------------------------------------------------------------------
  // Subclass contract
  // ---------------------------------------------------------------------------

  /** Begins the show flow (matchmaking / connection). */
  abstract start(): void;

  /**
   * Advances the authoritative show (director + sim offline, network online).
   *
   * @param simDt - Scaled delta with slow-mo applied (physics).
   * @param showDt - Scaled delta without slow-mo (show timers).
   */
  protected abstract advance(simDt: number, showDt: number): void;

  /** Builds the render source once the round's sim exists (null if not yet). */
  protected abstract createSource(rs: RoundStart): RoundSource | null;

  /** Live status for HUD/countdown, or null when no round is running. */
  protected abstract liveStatus(): HudInput | null;

  /** Round-trip time for the HUD; negative offline (the HUD hides it). */
  protected ping(): number {
    return -1;
  }

  /**
   * Records a show phase change (hooks, audio).
   *
   * @param phase - New show phase.
   */
  protected onShowPhaseChanged(phase: number): void {
    this.showPhaseId = phase;
    if (phase === ShowPhase.BetweenRounds) this.ctx.audio.game.onShowPhase(ShowPhase.BetweenRounds);
  }

  /** Extra teardown in subclasses. */
  protected onDispose(): void {}

  /** Debug: force-ends the current round (offline). */
  skipRound(): void {}

  /** Debug: decides the local player's fate (offline). */
  forceLocalFate(_qualify: boolean): void {}

  /** Debug: teleports the local player to the next checkpoint (offline). */
  teleportToCheckpoint(): void {}

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  /** True while a UI card holds the show clock. */
  get gated(): boolean {
    return this.holds > 0;
  }

  /** Render-time multiplier (ROUND OVER slow-mo). */
  get timeWarp(): number {
    return this.slowmo > 0 ? SLOWMO_SCALE : 1;
  }

  /** Show phase name for hooks. */
  showPhaseName(): string {
    const names = ['preShow', 'inRound', 'betweenRounds', 'victory', 'ended'];
    return names[this.showPhaseId] ?? 'unknown';
  }

  /** Current round id for hooks. */
  roundId(): string | null {
    return this.round?.start.round.id ?? null;
  }

  /** Current round phase for hooks. */
  roundPhase(): RoundPhaseId | null {
    return this.phase;
  }

  /** End-of-show recap as the UI sees it (null until the show ends). */
  uiShowSummary(): UiShowSummary | null {
    return this.uiSummary;
  }

  /** Number of Tumblers rendered this round. */
  visibleTumblers(): number {
    return this.round?.view?.players.count ?? 0;
  }

  /** The live round view (debug, quality changes). */
  get roundView(): RoundView | null {
    return this.round?.view ?? null;
  }

  /**
   * Per-frame update.
   *
   * @param dt - Scaled frame delta (s).
   * @param realDt - Unscaled frame delta (s).
   */
  frame(dt: number, realDt: number): void {
    if (this.ended) return;
    this.flowClock += realDt * this.flowScale;
    this.runTimers();
    this.toastTokens = Math.min(4, this.toastTokens + realDt * 3);
    if (this.slowmo > 0) this.slowmo -= dt;
    this.advance(dt * this.timeWarp, dt);
    this.roundFrame(realDt);
  }

  /** The player left mid-show (eliminated sheet, pause menu). Banks round rewards. */
  quit(): void {
    if (this.ended) return;
    if (!this.summary && this.localRounds().length > 0) {
      this.ctx.profile.applyShow({
        playlistName: this.showName,
        rounds: this.localRounds(),
        reachedFinal: false,
        wonCrown: false,
        place: this.order.length,
        participants: this.order.length,
        quit: true,
        counters: this.counters,
      });
    }
    this.dispose();
  }

  /** Tears everything down (views are disposed by the scene director's next swap). */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('keydown', this.onKey);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.timers.length = 0;
    this.covered.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.ctx.input.settings.pointerLock = false;
    ui.getState().setEmoteWheel(false);
    ui.getState().setSpectate(null);
    ui.getState().setCaption(null);
    this.onDispose();
    // The round view on screen may still render pooled Tumblers until the next wipe swaps it out.
    const pool = this.pool;
    this.ctx.director.deferUntilSwap(() => pool.dispose());
  }

  // ---------------------------------------------------------------------------
  // Flow helpers
  // ---------------------------------------------------------------------------

  /** Flow timers run at most 2× so cards stay readable in fast test runs. */
  private get flowScale(): number {
    return Math.min(2, this.ctx.cfg.timeScale);
  }

  /**
   * Schedules `fn` after `seconds` of flow time.
   *
   * @param seconds - Delay.
   * @param fn - Callback.
   */
  protected after(seconds: number, fn: () => void): void {
    this.timers.push({ at: this.flowClock + Math.max(0, seconds), fn });
  }

  private runTimers(): void {
    if (this.timers.length === 0) return;
    const due = this.timers.filter((t) => t.at <= this.flowClock);
    if (due.length === 0) return;
    this.timers = this.timers.filter((t) => t.at > this.flowClock);
    for (const t of due) {
      try {
        t.fn();
      } catch (err) {
        console.error('[show] flow step failed', err);
      }
    }
  }

  /** Pauses the show clock (offline) while a card is up. */
  protected hold(): void {
    this.holds++;
  }

  /** Releases one {@link hold}. */
  protected release(): void {
    this.holds = Math.max(0, this.holds - 1);
  }

  /**
   * Changes screen and runs `swap` while the wipe covers it (immediately when
   * Reduce Motion turns the wipe into a fade).
   *
   * @param screen - Target screen.
   * @param opts - Screen options (wipe by default).
   * @param swap - 3D swap to perform under cover.
   */
  protected swapUnder(screen: ScreenId, opts: SetScreenOptions, swap: () => void): void {
    const reduce = ui.getState().settings.accessibility.reduceMotion;
    const wipe = (opts.transition ?? 'wipe') === 'wipe' && !reduce;
    let done = false;
    const run = (): void => {
      if (done || this.ended) return;
      done = true;
      try {
        swap();
      } catch (err) {
        console.error(`[show] scene swap for ${screen} failed`, err);
      }
    };
    if (wipe) {
      this.covered.set(screen, run);
      this.after(WIPE_FALLBACK_S, run);
    }
    ui.getState().setScreen(screen, { transition: 'wipe', ...opts });
    if (!wipe) run();
  }

  /** UI participant for a player id. */
  protected uiPlayer(id: number): ShowPlayer {
    const p = this.players.get(id);
    if (!p) return { id, name: `Tumbler ${id}`, colors: { primary: '#ff6fb5', secondary: '#ffd23f', pattern: 'plain' }, isBot: true };
    return showPlayer(id, p.name, p.loadout, { isBot: p.isBot, isLocal: id === this.localId, ...(p.partyId !== undefined && id !== this.localId && p.partyId === this.players.get(this.localId)?.partyId ? { isParty: true } : {}) });
  }

  private toast(title: string, icon: string, id: number): void {
    if (this.toastTokens < 1) return;
    this.toastTokens -= 1;
    const color = this.players.get(id)?.loadout.colors[0];
    ui.getState().pushToast({ title, icon, variant: 'feed', durationMs: 3500, ...(color ? { color } : {}) });
  }

  // ---------------------------------------------------------------------------
  // Pre-show
  // ---------------------------------------------------------------------------

  /**
   * Shows the pre-show waiting platform.
   *
   * @param seconds - Countdown length (flow time).
   * @param playlist - Playlist (round count estimate).
   */
  protected enterPreShow(seconds: number, playlist: ShowPlaylist | null): void {
    const s = ui.getState();
    if (playlist) this.roundCount = estimateRoundCount(playlist, this.order.length);
    const names = this.order.map((id) => this.players.get(id)?.name ?? '');
    const first = Math.min(names.length, 8);
    s.setPreShow({
      showName: this.showName,
      roundCount: this.roundCount,
      playersJoined: first,
      maxPlayers: this.order.length,
      startsAt: Date.now() + (seconds / this.flowScale) * 1000,
      joinFeed: names.slice(0, first),
    });
    this.swapUnder('preShow', { transition: 'wipe' }, () => {
      const arenaPlayers = this.order.map((id) => {
        const p = this.players.get(id) as SessionPlayer;
        return { id: String(id), name: p.name, loadout: p.loadout };
      });
      // Autoplay keeps the pre-show hands-off; a human can roam the platform until the show starts.
      const control = this.ctx.cfg.autoplay ? undefined : { R: this.ctx.R, input: this.ctx.input, audio: this.ctx.audio.game };
      this.preShow = createPreShowView(getTheme('candy'), this.ctx.quality.preset, this.ctx.tumblers.create, arenaPlayers, this.localId >= 0 ? String(this.localId) : undefined, control);
      this.preShow.arena.setBanner(this.showName.toUpperCase(), `${this.roundCount} ROUNDS · starting soon`);
      this.ctx.director.show(this.preShow);
    });
    this.ctx.audio.game.onShowPhase(ShowPhase.PreShow);
    let joined = first;
    const feed = (): void => {
      if (this.ended || joined >= names.length) return;
      joined = Math.min(names.length, joined + 2);
      const info = ui.getState().preShow;
      if (info) ui.getState().setPreShow({ ...info, playersJoined: joined, joinFeed: names.slice(0, joined) });
      this.after(0.18, feed);
    };
    this.after(0.6, feed);
    for (let k = Math.floor(seconds); k >= 1; k--) {
      this.after(seconds - k, () => {
        this.preShow?.arena.setBanner(this.showName.toUpperCase(), `starting in ${k}`);
        if (k === 3) this.preShow?.arena.hype();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Round lifecycle
  // ---------------------------------------------------------------------------

  /**
   * A round was selected (director) or announced (server). Plays the between
   * rounds / final hype / show intro cards, then loads the round behind a wipe.
   *
   * @param rs - The round.
   */
  protected onRoundSelected(rs: RoundStart): void {
    const prevEntrants = this.round?.start.players.length ?? this.order.length;
    this.round = {
      start: rs,
      source: null,
      view: null,
      hud: null,
      fate: 'playing',
      inRound: rs.players.some((p) => p.id === this.localId),
      loadRequested: false,
      introShown: false,
      loadMinDone: false,
      outcome: null,
      resultsShown: false,
      countdown: null,
      spectateId: -1,
      playingSince: 0,
    };
    this.roundCount = Math.max(this.roundCount, rs.index + 1);
    if (rs.isFinal) this.roundCount = rs.index + 1;
    this.phase = RoundPhase.Loading;
    this.hold();
    const s = ui.getState();
    const roundType: RoundType = rs.isFinal ? 'final' : rs.round.type;
    let wait: number;
    if (rs.index === 0) {
      s.setShowIntro({ showName: this.showName, roundIndex: 0, roundCount: this.roundCount });
      s.setScreen('showIntro', { transition: 'wipe' });
      wait = 2.6;
    } else {
      s.setBetweenRounds({
        remainingBefore: prevEntrants,
        remaining: rs.players.length,
        roundIndex: rs.index - 1,
        roundCount: this.roundCount,
        next: { name: rs.round.name, type: roundType, isFinal: rs.isFinal },
      });
      s.setScreen('betweenRounds', { transition: 'fade' });
      wait = 3.8;
    }
    if (rs.isFinal) {
      this.after(wait, () => {
        ui.getState().setFinalHype({ roundName: rs.round.name, finalists: rs.players.map((p) => this.uiPlayer(p.id)) });
        ui.getState().setScreen('finalHype', { transition: 'wipe' });
      });
      wait += 3.6;
    }
    this.after(wait, () => this.loadRound());
  }

  private introInfo(rs: RoundStart): RoundIntroInfo {
    const r = rs.round;
    return {
      roundId: r.id,
      name: r.name,
      type: rs.isFinal ? 'final' : r.type,
      theme: r.theme,
      objective: rs.isFinal && r.type === 'race' ? 'First to the finish wins the Crown!' : r.objective,
      rules: rulesFor(r.type, rs.isFinal, rs.qualifyTarget, r.duration.seconds),
      tips: r.tips.length ? r.tips : ['Dive mid-jump to cover more ground!'],
      roundIndex: rs.index,
      roundCount: this.roundCount,
      isFinal: rs.isFinal,
      playerCount: rs.players.length,
      qualifyTarget: rs.qualifyTarget,
    };
  }

  private loadRound(): void {
    const r = this.round;
    if (!r || this.ended) return;
    const s = ui.getState();
    s.setRoundIntro(this.introInfo(r.start));
    this.ctx.audio.game.onRoundPhase(RoundPhase.Loading, r.start.round.type, { theme: r.start.round.theme });
    this.swapUnder('roundLoading', { transition: 'wipe', hold: true }, () => {
      r.loadRequested = true;
      this.buildRoundView();
      this.after(0.9, () => {
        r.loadMinDone = true;
        this.maybeShowIntro();
      });
    });
  }

  /** Builds the round's 3D view (retried when the source appears later online). */
  protected buildRoundView(): void {
    const r = this.round;
    if (!r || r.view || !r.loadRequested) return;
    const source = this.createSource(r.start);
    if (!source) return;
    r.source = source;
    const set = this.ctx.settings();
    const loadouts = new Map<number, TumblerLoadout>();
    for (const p of r.start.players) {
      const sp = this.players.get(p.id);
      if (sp) loadouts.set(p.id, sp.loadout);
    }
    const view = new RoundView({
      R: this.ctx.R,
      source,
      round: r.start.round,
      stage: r.start.stage,
      seed: r.start.seed,
      loadouts,
      pool: this.pool,
      preset: this.ctx.quality.preset,
      audio: this.ctx.audio.game,
      post: this.ctx.post,
      ragdolls: this.ctx.tumblers.name === 'tumbler',
      reduceShake: set.accessibility.reduceShake,
      nameplates: set.gameplay.nameplates,
      streamerMode: set.gameplay.streamerMode,
    });
    r.view = view;
    this.preShow = null;
    this.ctx.director.show(view);
    r.hud = new HudMapper(
      r.start.round,
      r.start.players.length,
      r.inRound ? this.localId : -1,
      (id) => {
        const p = this.players.get(id);
        return p ? { name: p.name, color: p.loadout.colors[0] } : null;
      },
      this.ctx.audio.game,
      r.start.isFinal,
    );
    this.ctx.audio.game.setLocalPlayer(r.inRound ? this.localId : null);
    if (this.ctx.cfg.autoplay && r.inRound) {
      this.pilot = createBotBrain({ id: this.localId, skill: 'sharp', seed: (r.start.seed ^ 0x51ab) >>> 0, round: r.start.round });
      this.pilotSelf.checkpoint = 0;
    } else this.pilot = null;
    this.maybeShowIntro();
  }

  private maybeShowIntro(): void {
    const r = this.round;
    if (!r || r.introShown || !r.view || !r.loadMinDone) return;
    if (this.phase === null || this.phase < RoundPhase.IntroFlyover) return;
    r.introShown = true;
    ui.getState().setScreen('roundIntro', { transition: 'wipe' });
    ui.getState().releaseWipe();
    r.view.playFlyover();
    const rs = r.start;
    this.ctx.audio.game.onRoundPhase(RoundPhase.IntroFlyover, rs.round.type, { roundNumber: rs.index + 1, roundName: rs.round.name, theme: rs.round.theme, isFinal: rs.isFinal });
    this.release();
    // A late intro (online, slow load) catches up with phases that already passed.
    if (this.phase >= RoundPhase.RulesCard) this.applyPhase(this.phase);
  }

  /**
   * A round phase began.
   *
   * @param phase - New phase.
   */
  protected onRoundPhase(phase: RoundPhaseId): void {
    this.phase = phase;
    const r = this.round;
    if (!r) return;
    if (phase === RoundPhase.IntroFlyover) {
      this.maybeShowIntro();
      return;
    }
    if (!r.introShown) return;
    this.applyPhase(phase);
  }

  private applyPhase(phase: RoundPhaseId): void {
    const r = this.round;
    if (!r) return;
    const s = ui.getState();
    const rs = r.start;
    const audioInfo = { roundNumber: rs.index + 1, roundName: rs.round.name, theme: rs.round.theme, isFinal: rs.isFinal };
    switch (phase) {
      case RoundPhase.RulesCard:
        s.setScreen('rules', { transition: 'fade' });
        r.view?.settleBehindPlayer();
        break;
      case RoundPhase.Countdown: {
        const set = this.ctx.settings();
        r.hud?.begin(emoteSlots(this.players.get(this.localId)?.loadout.emotes ?? []), !r.inRound, this.ctx.input.lastDevice, rs.qualifyTarget);
        if (!r.inRound) {
          r.fate = 'spectating';
          this.spectateLeader();
        } else r.view?.followLocal();
        s.setScreen('round', { transition: 'fade' });
        if (!set.gameplay.showPing) s.setHud({ ping: -1 });
        break;
      }
      case RoundPhase.Playing:
        s.setCountdown(null);
        r.countdown = null;
        s.showStamp('go');
        r.playingSince = this.flowClock;
        this.after(10, () => {
          if (this.round === r) ui.getState().setHud({ controlsHint: false });
        });
        break;
      case RoundPhase.Overtime:
        s.showStamp('overtime');
        break;
      case RoundPhase.RoundEnd: {
        this.slowmo = SLOWMO_SECONDS;
        s.setCountdown(null);
        s.setEmoteWheel(false);
        this.wheelOpen = false;
        if (document.pointerLockElement) document.exitPointerLock();
        const timed = rs.round.type === 'survival' || (this.liveStatus()?.timeLeft ?? 1) === 0;
        s.showStamp(timed ? 'timeUp' : 'roundOver');
        // Let the stamp and slow-mo land before the results wipe (offline holds the show clock).
        this.hold();
        this.after(1.9, () => this.release());
        break;
      }
      case RoundPhase.Results:
        this.maybeShowResults();
        break;
      default:
        break;
    }
    if (phase !== RoundPhase.Results) this.ctx.audio.game.onRoundPhase(phase, rs.round.type, audioInfo);
  }

  /**
   * The round's outcome is known (director `roundResult` / server `roundResults`).
   *
   * @param o - Outcome.
   */
  protected onRoundOutcome(o: RoundOutcomeInfo): void {
    this.outcomes.push(o);
    const r = this.round;
    if (!r) return;
    r.outcome = o;
    this.maybeShowResults();
  }

  private maybeShowResults(): void {
    const r = this.round;
    if (!r || r.resultsShown || !r.outcome || this.phase === null || this.phase < RoundPhase.Results) return;
    r.resultsShown = true;
    const o = r.outcome;
    const rs = r.start;
    const qualified = new Set(o.qualified);
    let place = 1;
    const ordered = [...o.qualified, ...o.eliminated];
    const entrants = new Set(rs.players.map((p) => p.id));
    for (const p of rs.players) if (!ordered.includes(p.id)) ordered.push(p.id);
    const entries = ordered
      .filter((id) => entrants.has(id))
      .map((id) => ({ player: this.uiPlayer(id), qualified: qualified.has(id), place: qualified.has(id) ? place++ : 0 }));
    const s = ui.getState();
    s.clearStamps();
    s.setSpectate(null);
    s.setEliminatedSheet(false);
    s.setResults({ roundName: rs.round.name, roundType: rs.isFinal ? 'final' : rs.round.type, roundIndex: rs.index, entries });
    if (r.inRound) this.recordLocalRound(qualified.has(this.localId));
    const mood = !r.inRound ? 'neutral' : qualified.has(this.localId) ? 'qualified' : 'eliminated';
    const bouncers = o.qualified.slice(0, 5).map((id) => this.players.get(id)?.loadout).filter((l): l is TumblerLoadout => !!l);
    this.swapUnder('roundResults', { transition: 'wipe' }, () => {
      this.ctx.director.show(createResultsView(getTheme(rs.round.theme), this.ctx.quality.preset, this.ctx.tumblers.create, bouncers, mood));
      if (this.round === r) {
        r.view = null;
        r.source = null;
      }
    });
    this.ctx.audio.game.onRoundPhase(RoundPhase.Results, rs.round.type, { playersRemaining: o.qualified.length, theme: rs.round.theme });
    this.ctx.audio.game.onShowPhase(ShowPhase.BetweenRounds);
  }

  private readonly playedRounds: ShowResultForProfile['rounds'] = [];

  private recordLocalRound(qualified: boolean): void {
    const r = this.round;
    const rs = r?.start;
    if (!r || !rs) return;
    const idx = r.outcome ? r.outcome.qualified.indexOf(this.localId) : -1;
    this.playedRounds.push({
      name: rs.round.name,
      type: rs.isFinal ? 'final' : rs.round.type,
      qualified,
      roundId: rs.round.id,
      of: rs.players.length,
      ...(idx >= 0 ? { place: idx + 1 } : {}),
      ...(qualified && rs.round.type === 'race' && r.qualifiedAfter !== undefined ? { timeSec: Math.round(r.qualifiedAfter * 10) / 10 } : {}),
    });
  }

  /** Who else was in the show, for the offline Hall of Fame. */
  protected fieldSummary(): NonNullable<ShowResultForProfile['field']> {
    const placements = this.summary?.placements;
    return this.order
      .filter((id) => id !== this.localId)
      .map((id) => {
        const p = this.uiPlayer(id);
        const place = placements?.get(id) ?? this.order.length;
        return { name: p.name, colors: p.colors, isBot: p.isBot, place, crowned: this.summary?.winnerId === id };
      });
  }

  /** Rounds the local player entered, with outcomes. */
  protected localRounds(): ShowResultForProfile['rounds'] {
    return this.playedRounds;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Routes sim events to the view (VFX/feedback), audio and the local fate flow.
   *
   * @param events - Events this frame.
   * @param audio - Also play them through the audio router (false when the online session already did).
   */
  protected onSimEvents(events: readonly SimEvent[], audio = true): void {
    const r = this.round;
    const view = r?.view ?? null;
    const lp = this.ctx.director.listenerPos;
    for (const e of events) {
      view?.handleEvent(e);
      if (audio) this.ctx.audio.game.handleSimEvent(e, lp);
      const mine = 'player' in e && e.player === this.localId;
      switch (e.type) {
        case 'qualified':
          if (mine) this.localQualified();
          else if (r && r.start.round.type === 'race') this.toast(`${this.players.get(e.player)?.name ?? 'Someone'} qualified!`, '🏁', e.player);
          break;
        case 'eliminated':
          if (mine) this.localEliminated();
          else if (r && r.start.round.type !== 'race') this.toast(`${this.players.get(e.player)?.name ?? 'Someone'} is out!`, '💨', e.player);
          break;
        case 'checkpoint':
          if (mine) {
            this.pilotSelf.checkpoint = Math.max(this.pilotSelf.checkpoint, e.index);
            this.counters.checkpoints = (this.counters.checkpoints ?? 0) + 1;
          }
          break;
        case 'respawn':
          if (mine) this.pilot?.onRespawn?.();
          break;
        case 'jump':
          if (mine) this.counters.jumps = (this.counters.jumps ?? 0) + 1;
          break;
        case 'dive':
          if (mine) this.counters.dives = (this.counters.dives ?? 0) + 1;
          break;
        case 'grabStart':
          if (mine) this.counters.grabs = (this.counters.grabs ?? 0) + 1;
          break;
        case 'bounce':
          if (mine) this.counters.bounces = (this.counters.bounces ?? 0) + 1;
          break;
        default:
          break;
      }
    }
  }

  private localQualified(): void {
    const r = this.round;
    if (!r || r.fate !== 'playing') return;
    r.fate = 'qualified';
    if (r.playingSince > 0) r.qualifiedAfter = Math.max(0, this.flowClock - r.playingSince);
    const s = ui.getState();
    s.setHud({ localStatus: 'qualified' });
    s.setEmoteWheel(false);
    s.showStamp(r.start.isFinal ? 'victory' : 'qualified', r.start.isFinal ? { text: 'CROWNED!' } : {});
    r.view?.celebrate();
    this.after(2.6, () => {
      if (this.round !== r || r.fate !== 'qualified' || (this.phase ?? 0) >= RoundPhase.RoundEnd) return;
      if (this.ctx.settings().gameplay.autoSpectate) this.beginSpectating();
    });
  }

  private localEliminated(): void {
    const r = this.round;
    if (!r || r.fate !== 'playing') return;
    r.fate = 'eliminated';
    const s = ui.getState();
    s.setHud({ localStatus: 'eliminated' });
    s.setEmoteWheel(false);
    s.showStamp('eliminated');
    if (document.pointerLockElement) document.exitPointerLock();
    this.after(1.6, () => {
      if (this.round !== r || r.fate !== 'eliminated' || (this.phase ?? 0) >= RoundPhase.Results) return;
      ui.getState().setEliminatedSheet(true);
      if (this.ctx.cfg.autoplay) this.after(1.4, () => this.beginSpectating());
    });
  }

  // ---------------------------------------------------------------------------
  // Spectating
  // ---------------------------------------------------------------------------

  private candidates(): number[] {
    const r = this.round;
    if (!r) return [];
    const st = this.liveStatus();
    const stillIn = (id: number): boolean => {
      const p = st?.players?.get(id);
      return !p || p.status === PlayerRoundStatus.Playing;
    };
    const order = st?.standings ?? r.start.players.map((p) => p.id);
    const list = order.filter((id) => id !== this.localId && stillIn(id));
    return list.length > 0 ? list : order.filter((id) => id !== this.localId);
  }

  private beginSpectating(): void {
    const r = this.round;
    if (!r) return;
    ui.getState().setEliminatedSheet(false);
    if (r.fate === 'playing' && r.inRound) return;
    r.fate = 'spectating';
    ui.getState().setHud({ localStatus: 'spectating', controlsHint: false });
    this.spectateLeader();
  }

  private spectateLeader(): void {
    const list = this.candidates();
    const id = list[0];
    if (id !== undefined) this.spectatePlayer(id, 0, list.length);
  }

  private cycleSpectate(dir: 1 | -1): void {
    const r = this.round;
    if (!r || r.fate !== 'spectating') return;
    const list = this.candidates();
    if (list.length === 0) return;
    const i = Math.max(0, list.indexOf(r.spectateId));
    const next = (i + dir + list.length) % list.length;
    this.spectatePlayer(list[next] as number, next, list.length);
  }

  private spectatePlayer(id: number, index: number, count: number): void {
    const r = this.round;
    if (!r) return;
    r.spectateId = id;
    r.view?.spectate(id);
    const st = this.liveStatus()?.players?.get(id);
    const qualified = st?.status === PlayerRoundStatus.Qualified;
    const detail = qualified ? 'Qualified!' : index === 0 ? 'In the lead' : `${index + 1}${['st', 'nd', 'rd'][index] ?? 'th'} place`;
    ui.getState().setSpectate({ player: this.uiPlayer(id), detail, qualified, index, count });
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    const r = this.round;
    if (!r) return;
    const binds = ui.getState().settings.controls.keybinds;
    if (r.fate === 'spectating' && ui.getState().screen === 'round') {
      if (binds.spectatePrev.includes(e.code)) this.cycleSpectate(-1);
      else if (binds.spectateNext.includes(e.code)) this.cycleSpectate(1);
    }
    if (e.code === 'Escape' && ui.getState().screen === 'round' && ui.getState().overlay === 'none') ui.getState().setOverlay('settings');
  }

  // ---------------------------------------------------------------------------
  // Per-frame round work
  // ---------------------------------------------------------------------------

  /** True while the local Tumbler takes gameplay input. */
  protected get controlsActive(): boolean {
    const r = this.round;
    if (!r || !r.view || !r.inRound || r.fate !== 'playing') return false;
    const p = this.phase;
    return p === RoundPhase.Countdown || p === RoundPhase.Playing || p === RoundPhase.Overtime;
  }

  /**
   * Fills the local player's input for one fixed step: the autoplay pilot,
   * or the input system (zeroed when controls are inactive) plus wheel emotes.
   *
   * @param out - Input to fill.
   */
  protected fillInput(out: CharacterInput): CharacterInput {
    const r = this.round;
    const yaw = r?.view?.rig.yaw ?? r?.start.round.spawn.yaw ?? 0;
    const sim = r?.source?.alive ? r.source.sim : null;
    if (this.pilot && sim && this.controlsActive) {
      this.ctx.input.sample(yaw, out);
      if (sim.getPlayerState(this.localId, this.pilotState)) {
        const st = this.pilotState;
        const self = this.pilotSelf;
        const sp = self.pos as { x: number; y: number; z: number };
        const sv = self.vel as { x: number; y: number; z: number };
        sp.x = st.pos.x;
        sp.y = st.pos.y;
        sp.z = st.pos.z;
        sv.x = st.vel.x;
        sv.y = st.vel.y;
        sv.z = st.vel.z;
        self.grounded = st.grounded;
        self.state = st.state;
        self.facing = st.facing;
        const ps = this.liveStatus()?.players?.get(this.localId);
        self.status = (ps?.status as BotSelfView['status'] | undefined) ?? PlayerRoundStatus.Playing;
        self.team = ps?.team ?? -1;
        self.hasItem = ps?.hasItem ?? false;
        this.pilot.think(sim.botView, self, out);
      }
      return out;
    }
    this.ctx.input.sample(yaw, out);
    if (!this.controlsActive) {
      out.moveX = 0;
      out.moveZ = 0;
      out.buttons = 0;
      out.emote = 0;
    } else if (this.pendingEmote > 0) {
      out.emote = this.pendingEmote;
      this.pendingEmote = 0;
    }
    return out;
  }

  private roundFrame(realDt: number): void {
    const r = this.round;
    const input = this.ctx.input;
    const view = r?.view ?? null;
    const active = this.controlsActive;
    const spectating = r?.fate === 'spectating' || r?.fate === 'qualified';
    input.settings.pointerLock = !!view && (active || spectating) && !this.ctx.cfg.autoplay && ui.getState().screen === 'round';
    const look = input.readLook(realDt);
    if (!view || !r) return;
    if (active || spectating) view.rig.addLook(look.yaw, look.pitch);

    if (active && !this.pilot) {
      const open = input.emoteWheelOpen;
      if (open !== this.wheelOpen) {
        this.wheelOpen = open;
        ui.getState().setEmoteWheel(open);
        if (open && document.pointerLockElement) document.exitPointerLock();
      }
    }

    const st = this.liveStatus();
    if (this.phase === RoundPhase.Countdown && r.source?.alive) {
      const t = r.source.sim.time;
      const n = t < 0 ? Math.max(1, Math.min(3, Math.ceil(-t - 1e-3))) : null;
      if (n !== r.countdown) {
        r.countdown = n;
        ui.getState().setCountdown(n);
      }
    }
    const p = this.phase ?? 0;
    if (st && r.hud && p >= RoundPhase.Countdown && p <= RoundPhase.RoundEnd) r.hud.update(realDt, st, this.ctx.fps(), this.ping());

    if (r.fate === 'spectating' && r.spectateId >= 0 && (this.phase ?? 0) < RoundPhase.RoundEnd) {
      const ps = st?.players?.get(r.spectateId);
      if (ps && ps.status === PlayerRoundStatus.Eliminated) this.cycleSpectate(1);
    }
  }

  // ---------------------------------------------------------------------------
  // End of show
  // ---------------------------------------------------------------------------

  /**
   * The show is over: victory / winner cam, then the wall and rewards.
   *
   * @param summary - Normalised recap.
   */
  protected onShowEnded(summary: SessionSummary): void {
    if (this.summary) return;
    this.summary = summary;
    this.showPhaseId = ShowPhase.Victory;
    const s = ui.getState();
    s.setSpectate(null);
    s.setEliminatedSheet(false);
    const rounds = summary.rounds.map((o) => {
      const carried = new Set(o.qualified);
      return { roundId: o.roundId, name: o.name, type: o.isFinal ? ('final' as const) : o.type, eliminatedIds: o.eliminated.filter((id) => !carried.has(id) && id !== summary.winnerId) };
    });
    this.uiSummary = {
      showName: this.showName,
      players: this.order.map((id) => this.uiPlayer(id)),
      rounds,
      winnerId: summary.winnerId ?? -1,
      seed: (this.round?.start.seed ?? 1) >>> 0,
    };
    const winnerId = summary.winnerId;
    const localWon = winnerId !== null && winnerId === this.localId;
    const winner = winnerId !== null ? this.players.get(winnerId) : undefined;
    this.ctx.audio.game.onShowPhase(ShowPhase.Victory, { localWon, ...(winner ? { winnerName: winner.name } : {}) });
    if (!winner || winnerId === null) {
      this.after(1.2, () => this.goWall());
      return;
    }
    const crowns = this.ctx.crowns();
    s.setVictory({ winner: this.uiPlayer(winnerId), isLocalWinner: localWon, crownsBefore: crowns, crownsAfter: crowns + (localWon ? 1 : 0), showName: this.showName });
    const finalTheme = getTheme(this.round?.start.round.theme ?? 'candy');
    const ranked = [...summary.placements.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const runnersUp = ranked
      .filter((id) => id !== winnerId)
      .slice(0, 2)
      .map((id) => this.players.get(id))
      .filter((p): p is SessionPlayer => !!p)
      .map((p) => ({ name: p.name, loadout: p.loadout }));
    this.swapUnder(localWon ? 'victory' : 'winnerCam', { transition: 'wipe' }, () => {
      this.ctx.director.show(createPodiumView(finalTheme, this.ctx.quality.preset, this.ctx.tumblers.create, { name: winner.name, loadout: winner.loadout }, runnersUp, this.ctx.post));
      if (this.round) {
        this.round.view = null;
        this.round.source = null;
      }
    });
    this.awaiting = 'victory';
    if (this.ctx.cfg.autoplay) this.after(6, () => this.goWall());
  }

  private goWall(): void {
    if (this.awaiting === 'wall' || this.awaiting === 'rewards' || !this.uiSummary || !this.summary) return;
    this.awaiting = 'wall';
    const uiSummary = this.uiSummary;
    const summary = this.summary;
    const s = ui.getState();
    s.setPlayerWall(uiSummary, { render3D: true, autoContinueMs: this.ctx.cfg.autoplay ? 2500 : 9000 });
    this.swapUnder('playerWall', { transition: 'wipe' }, () => {
      const wall3d = {
        players: this.order.map((id) => {
          const p = this.players.get(id) as SessionPlayer;
          return { id: String(id), name: p.name, loadout: p.loadout };
        }),
        rounds: uiSummary.rounds.map((r) => ({ name: r.name, eliminatedIds: r.eliminatedIds.map(String) })),
        winnerId: summary.winnerId !== null ? String(summary.winnerId) : null,
      };
      this.wall = new WallView(getTheme('candy'), this.ctx.quality.preset, this.ctx.tumblers.create, wall3d, this.ctx.post);
      this.ctx.director.show(this.wall);
    });
  }

  /**
   * True while an authoritative reward is still on its way (online: the game
   * server forwards the API's grant a moment after the show ends).
   */
  protected rewardsPending(): boolean {
    return false;
  }

  /**
   * The rewards screen payload. Offline (and as the online fallback) the local
   * profile computes and banks it; online sessions return the API's grant.
   *
   * @param facts - What happened from the local player's seat.
   */
  protected computeRewards(facts: ShowResultForProfile): RewardsSummary {
    return this.ctx.profile.applyShow(facts);
  }

  private rewardsWait = 0;

  private goRewards(): void {
    if (this.awaiting === 'rewards' || !this.summary) return;
    // Give the server's reward summary a few seconds before falling back to the local estimate.
    if (this.rewardsPending() && this.rewardsWait < 32) {
      this.rewardsWait++;
      this.after(0.25, () => this.goRewards());
      return;
    }
    this.awaiting = 'rewards';
    const summary = this.summary;
    const rounds = this.localRounds();
    const finalOutcome = summary.rounds[summary.rounds.length - 1];
    const reachedFinal = !!finalOutcome?.isFinal && (finalOutcome.qualified.includes(this.localId) || finalOutcome.eliminated.includes(this.localId));
    const rewards = this.computeRewards({
      playlistName: this.showName,
      rounds,
      reachedFinal,
      wonCrown: summary.winnerId === this.localId,
      place: summary.placements.get(this.localId) ?? this.order.length,
      participants: this.order.length,
      quit: false,
      counters: this.counters,
      field: this.fieldSummary(),
    });
    const s = ui.getState();
    s.setRewards(rewards);
    this.wall = null;
    this.ctx.onEnd('rewards');
  }
}
