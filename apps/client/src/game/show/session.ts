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
import { DEFAULT_TUNING, GrabKind, createCharacterFullState } from '@tumble/sim/character';
import { PlayerRoundStatus } from '@tumble/sim/match';
import { getMutator } from '@tumble/sim/mutators';
import type { ShowPlaylist } from '@tumble/sim/show';
import {
  bindUI,
  social,
  streamerSafeName,
  ui,
  type HudGrab,
  type PlayerWallEvent,
  type RoundIntroInfo,
  type ScreenId,
  type SetScreenOptions,
  type ShowPlayer,
  type RewardsSummary,
  type ShowSummary as UiShowSummary,
} from '@tumble/ui';
import { HapticMapper, HapticThrottle } from '../../input/haptics.ts';
import { emoteSlots, showPlayer } from '../cosmetics.ts';
import type { ShowResultForProfile } from '../profile.ts';
import type { LiveRoundInfo } from '../replay/live.ts';
import { HudMapper, type HudInput } from '../round/hud.ts';
import { TumblerPool } from '../round/playerVisuals.ts';
import { RoundView } from '../round/roundView.ts';
import { ShowChat } from '../social/showChat.ts';
import type { RoundSource } from '../round/source.ts';
import {
  createPodiumView,
  createPreShowView,
  RoundWallView,
  WallView,
  type PreShowView,
} from '../views/ceremonies.ts';
import type { GameContext, RoundOutcomeInfo, RoundStart, SessionPlayer, SessionSummary } from './context.ts';
import {
  PAD_SPECTATE_NEXT,
  PAD_SPECTATE_PREV,
  SpectatePadCycler,
  afterRoundResults,
  cycleSpectateIndex,
  planAfterEliminated,
  spectateCandidates,
  spectateDetail,
  type SpectateStatus,
  type WatchDecision,
  type WatchPrefs,
} from './spectator.ts';

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
/** How often the spectate banner refreshes the watched player's place. */
const SPECTATE_REFRESH_S = 0.5;

/** Live round status → spectate status. */
function spectateStatusOf(status: number | undefined): SpectateStatus | undefined {
  if (status === undefined) return undefined;
  if (status === PlayerRoundStatus.Qualified) return 'qualified';
  if (status === PlayerRoundStatus.Eliminated) return 'eliminated';
  return 'playing';
}

/** Short key name for a `KeyboardEvent.code` in hints. */
function shortKey(code: string | undefined): string {
  return (code ?? '').replace(/^Key|^Digit/, '') || '?';
}

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
function rulesFor(
  type: RoundType,
  isFinal: boolean,
  target: number,
  seconds: number,
): { icon: string; text: string }[] {
  if (isFinal)
    return [
      { icon: '👑', text: 'Only one Tumbler wins' },
      { icon: '🏁', text: type === 'race' ? 'First to the finish!' : 'Be the last one standing' },
      { icon: '🏆', text: 'Win the Crown!' },
    ];
  switch (type) {
    case 'race':
      return [
        { icon: '🏁', text: 'Reach the finish line' },
        { icon: '⚠️', text: 'Dodge the obstacles' },
        { icon: '✅', text: `First ${target} qualify` },
      ];
    case 'survival':
      return [
        { icon: '⏳', text: `Survive ${Math.round(seconds)} seconds` },
        { icon: '🌀', text: "Don't fall off!" },
        { icon: '✅', text: 'Survivors qualify' },
      ];
    case 'team':
      return [
        { icon: '🤝', text: 'Work with your team' },
        { icon: '🎯', text: 'Score the most points' },
        { icon: '📉', text: 'Lowest team is out' },
      ];
    case 'hunt':
      return [
        { icon: '🎀', text: 'Grab a tail' },
        { icon: '✊', text: 'Hold on to it' },
        { icon: '⏰', text: 'Have one when time runs out' },
      ];
    case 'logic':
      return [
        { icon: '🧠', text: 'Watch the pattern' },
        { icon: '🟩', text: 'Stand on the right tile' },
        { icon: '⬇️', text: 'Wrong tiles drop away' },
      ];
    default:
      return [
        { icon: '👑', text: 'Only one Tumbler wins' },
        { icon: '🏁', text: 'Reach the top first' },
        { icon: '🏆', text: 'Win the Crown!' },
      ];
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
  /** Quick pings and text chat (feed, bubbles, offline bot replies). */
  protected readonly chat: ShowChat;
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
  private readonly haptics = new HapticMapper();
  private readonly hapticGate = new HapticThrottle();
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
  /** What the local player chose once knocked out ("Keep watching" sticks for the show). */
  private watch: WatchDecision = 'undecided';
  /** The local player is out of the show and watching it as a spectator. */
  private outOfShow = false;
  /** The watch choice holds the (offline) show clock. */
  private choiceHeld = false;
  private readonly padCycler = new SpectatePadCycler();
  private spectateRefresh = 0;

  constructor(protected readonly ctx: GameContext) {
    this.pool = new TumblerPool(ctx.tumblers.create);
    this.chat = new ShowChat(
      {
        localId: () => this.localId,
        player: (id) => {
          const p = this.players.get(id);
          if (!p) return undefined;
          return {
            name: p.name,
            isBot: p.isBot,
            color: p.loadout.colors[0],
            ...(p.userId ? { userId: p.userId } : {}),
          };
        },
        botIds: () => [...this.players.values()].filter((p) => p.isBot).map((p) => p.id),
        bubble: (id, text) => this.round?.view?.players.say(id, text),
        releaseKeys: () => ctx.input.releaseKeys(),
      },
      0,
    );
    ui.getState().setShowSeat({ online: this.isOnline(), outOfShow: false });
    ui.getState().setWatchChoice(null);
    this.offs.push(
      bindUI({
        onTransitionCovered: ({ to }) => {
          const fn = this.covered.get(to);
          if (fn) {
            this.covered.delete(to);
            fn();
          }
        },
        onSpectate: () => this.keepWatching(),
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
    ctx.replays?.showStarted();
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
   * True for a show on a game server. Online the show never waits for this
   * player, and rewards come from the account API once the server reports the
   * show. Called from the base constructor, so overrides must not read fields.
   */
  protected isOnline(): boolean {
    return false;
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

  /** Connection-lost curtain's Try again (online sessions reconnect; nothing to do offline). */
  retryConnection(): void {}

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

  /** Publishes who the local Tumbler holds (or is held by) and the matching meter. */
  private updateGrabHud(): void {
    const c = this.round?.source?.sim.controller(this.localId);
    const st = c ? c.getState(this.debugState) : null;
    let mode: HudGrab['mode'] = 'none';
    let name = '';
    let meter = 0;
    if (st?.ext?.grabKind === GrabKind.Player) {
      name = this.players.has(st.grabTarget) ? this.publicName(st.grabTarget) : '';
      if (st.state === CharacterState.Grabbed) {
        mode = 'held';
        meter = Math.min(1, st.ext.breakFree / DEFAULT_TUNING.breakFreeMashes);
      } else {
        mode = 'holding';
        meter = st.grabStamina;
      }
    } else if (st?.ext?.grabKind === GrabKind.Prop) {
      mode = 'carrying';
      meter = st.grabStamina;
    }
    // Quantised so the store only updates when the bar visibly moves.
    meter = Math.round(meter * 20) / 20;
    const prev = ui.getState().hud.grab;
    if (prev.mode !== mode || prev.name !== name || prev.meter !== meter)
      ui.getState().setHud({ grab: { mode, name, meter } });
  }

  /** Local Tumbler's controller state for automation (null outside a round). */
  localDebug(): { state: number; grabTarget: number; x: number; y: number; z: number; grabs: number } | null {
    const c = this.round?.source?.sim.controller(this.localId);
    if (!c) return null;
    const p = c.body.translation();
    const full = c.getState(this.debugState);
    return {
      state: c.state,
      grabTarget: full.grabTarget,
      x: p.x,
      y: p.y,
      z: p.z,
      grabs: this.counters.grabs ?? 0,
    };
  }
  private readonly debugState = createCharacterFullState();

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

  /**
   * The player left before the rewards screen (watch choice, in-game menu,
   * play again). Banks what they earned: the played rounds as a quit mid-show,
   * or the full show once it is already over (victory, winner cam, wall).
   */
  quit(): void {
    if (this.ended) return;
    if (this.awaiting !== 'rewards' && this.localRounds().length > 0) {
      this.bankOnLeave(
        this.summary
          ? this.showFacts(this.summary)
          : {
              playlistName: this.showName,
              rounds: this.localRounds(),
              reachedFinal: false,
              wonCrown: false,
              place: this.order.length,
              participants: this.order.length,
              quit: true,
              counters: this.counters,
            },
      );
    }
    this.dispose();
  }

  /**
   * Banks rewards for a player leaving before the rewards screen. Offline the
   * local profile records them; online sessions whose results the server
   * reports to the account API override this.
   *
   * @param facts - What happened from the local player's seat.
   */
  protected bankOnLeave(facts: ShowResultForProfile): void {
    this.ctx.profile.applyShow(facts);
  }

  /** Tears everything down (views are disposed by the scene director's next swap). */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('keydown', this.onKey);
    this.chat.dispose();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.timers.length = 0;
    this.covered.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.ctx.input.settings.pointerLock = false;
    this.ctx.replays?.roundEnded(null);
    ui.setState({ cameraLock: 'off' });
    ui.getState().setEmoteWheel(false);
    ui.getState().setSpectate(null);
    ui.getState().setCaption(null);
    ui.getState().setEliminatedSheet(false);
    ui.getState().setWatchChoice(null);
    ui.getState().setShowSeat(null);
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
    if (!p)
      return {
        id,
        name: `Tumbler ${id}`,
        colors: { primary: '#ff6fb5', secondary: '#ffd23f', pattern: 'plain' },
        isBot: true,
      };
    return showPlayer(id, p.name, p.loadout, {
      isBot: p.isBot,
      isLocal: id === this.localId,
      ...(this.isPartyMate(id) ? { isParty: true } : {}),
    });
  }

  private isPartyMate(id: number): boolean {
    const p = this.players.get(id);
    return (
      p?.partyId !== undefined && id !== this.localId && p.partyId === this.players.get(this.localId)?.partyId
    );
  }

  /**
   * A player's name as this screen may show it: Streamer Mode hides other
   * real players everywhere the game draws names itself (3D wall, pre-show
   * plates, podium, toasts, HUD), matching the UI's own masking.
   */
  protected publicName(id: number): string {
    const p = this.players.get(id);
    if (!p) return `Tumbler ${id + 1}`;
    return streamerSafeName(
      { id, name: p.name, isBot: p.isBot, isLocal: id === this.localId, isParty: this.isPartyMate(id) },
      this.ctx.settings().gameplay.streamerMode,
    );
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
    const names = this.order.map((id) => (this.players.has(id) ? this.publicName(id) : ''));
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
        return { id: String(id), name: this.publicName(id), loadout: p.loadout };
      });
      // Autoplay keeps the pre-show hands-off; a human can roam the platform until the show starts.
      const control = this.ctx.cfg.autoplay
        ? undefined
        : { R: this.ctx.R, input: this.ctx.input, audio: this.ctx.audio.game };
      this.preShow = createPreShowView(
        getTheme('candy'),
        this.ctx.quality.preset,
        this.ctx.tumblers.create,
        arenaPlayers,
        this.localId >= 0 ? String(this.localId) : undefined,
        control,
      );
      this.preShow.arena.setBanner(this.showName.toUpperCase(), `${this.roundCount} ROUNDS · starting soon`);
      this.ctx.director.show(this.preShow);
    });
    this.ctx.audio.game.onShowPhase(ShowPhase.PreShow);
    let joined = first;
    const feed = (): void => {
      if (this.ended || joined >= names.length) return;
      joined = Math.min(names.length, joined + 2);
      const info = ui.getState().preShow;
      if (info)
        ui.getState().setPreShow({ ...info, playersJoined: joined, joinFeed: names.slice(0, joined) });
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
      s.setScreen('showIntro', { transition: 'fade' });
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
        ui.getState().setFinalHype({
          roundName: rs.round.name,
          finalists: rs.players.map((p) => this.uiPlayer(p.id)),
        });
        ui.getState().setScreen('finalHype', { transition: 'fade' });
      });
      wait += 3.6;
    }
    this.after(wait, () => this.loadRound());
  }

  private introInfo(rs: RoundStart): RoundIntroInfo {
    const r = rs.round;
    const mutator = getMutator(rs.mutatorId);
    return {
      ...(mutator
        ? { mutator: { name: mutator.name, description: mutator.description, icon: mutator.icon } }
        : {}),
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

  private replayInfo(r: ActiveRound): LiveRoundInfo {
    const rs = r.start;
    return {
      showName: this.showName,
      online: this.isOnline(),
      roundIndex: rs.index,
      isFinal: rs.isFinal,
      round: rs.round,
      seed: rs.seed,
      stage: rs.stage,
      qualifyTarget: rs.qualifyTarget,
      localId: r.inRound ? this.localId : -1,
      players: rs.players.map((p) => {
        const sp = this.players.get(p.id);
        return {
          id: p.id,
          name: sp?.name ?? p.name,
          isBot: p.isBot,
          team: p.team,
          loadout: sp?.loadout ?? null,
        };
      }),
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
      botTags: set.gameplay.botTags,
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
        return p
          ? {
              name: this.publicName(id),
              color: p.loadout.colors[0],
              isBot: p.isBot,
              isLocal: id === this.localId,
              isParty: this.isPartyMate(id),
            }
          : null;
      },
      this.ctx.audio.game,
      r.start.isFinal,
      getMutator(r.start.mutatorId),
    );
    this.ctx.audio.game.setLocalPlayer(r.inRound ? this.localId : null);
    if (this.ctx.cfg.autoplay && r.inRound) {
      this.pilot = createBotBrain({
        id: this.localId,
        skill: 'sharp',
        seed: (r.start.seed ^ 0x51ab) >>> 0,
        round: r.start.round,
      });
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
    this.ctx.audio.game.onRoundPhase(RoundPhase.IntroFlyover, rs.round.type, {
      roundNumber: rs.index + 1,
      roundName: rs.round.name,
      theme: rs.round.theme,
      isFinal: rs.isFinal,
    });
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
    const audioInfo = {
      roundNumber: rs.index + 1,
      roundName: rs.round.name,
      theme: rs.round.theme,
      isFinal: rs.isFinal,
    };
    switch (phase) {
      case RoundPhase.RulesCard:
        s.setScreen('rules', { transition: 'fade' });
        r.view?.settleBehindPlayer();
        break;
      case RoundPhase.Countdown: {
        const set = this.ctx.settings();
        r.hud?.begin(
          emoteSlots(this.players.get(this.localId)?.loadout.emotes ?? []),
          !r.inRound,
          this.ctx.input.lastDevice,
          rs.qualifyTarget,
        );
        if (!r.inRound) {
          r.fate = 'spectating';
          this.spectateLeader();
          // Online the show doesn't wait for an unanswered watch choice; keep offering it in the round.
          if (ui.getState().watchChoice) s.setEliminatedSheet(true);
        } else r.view?.followLocal();
        s.setScreen('round', { transition: 'fade' });
        if (!set.gameplay.showPing) s.setHud({ ping: -1 });
        if (r.source) this.ctx.replays?.roundStarted(this.replayInfo(r), r.source, r.view);
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
      .map((id) => ({
        player: this.uiPlayer(id),
        qualified: qualified.has(id),
        place: qualified.has(id) ? place++ : 0,
      }));
    this.ctx.replays?.roundEnded({ qualified: o.qualified, eliminated: o.eliminated });
    const s = ui.getState();
    s.clearStamps();
    s.setSpectate(null);
    s.setEliminatedSheet(false);
    s.setResults({
      roundName: rs.round.name,
      roundType: rs.isFinal ? 'final' : rs.round.type,
      roundIndex: rs.index,
      entries,
      render3D: true,
    });
    if (r.inRound) this.recordLocalRound(qualified.has(this.localId));
    this.afterResults(r, qualified.has(this.localId), o.qualified.length);
    const botTags = this.ctx.settings().gameplay.botTags;
    const wallPlayers = rs.players
      .map((p) => this.players.get(p.id))
      .filter((p): p is SessionPlayer => !!p)
      .map((p) => ({
        id: String(p.id),
        name: this.publicName(p.id),
        loadout: p.loadout,
        isBot: p.isBot && botTags,
      }));
    const eliminated = o.eliminated.filter((id) => entrants.has(id)).map(String);
    this.swapUnder('roundResults', { transition: 'wipe' }, () => {
      this.ctx.director.show(
        new RoundWallView(
          getTheme('candy'),
          this.ctx.quality.preset,
          this.ctx.tumblers.create,
          rs.index + 1,
          { name: rs.round.name, players: wallPlayers, eliminatedIds: eliminated },
          this.ctx.post,
        ),
      );
      if (this.round === r) {
        r.view = null;
        r.source = null;
      }
    });
    this.ctx.audio.game.onRoundPhase(RoundPhase.Results, rs.round.type, {
      playersRemaining: o.qualified.length,
      theme: rs.round.theme,
    });
    this.ctx.audio.game.onShowPhase(ShowPhase.BetweenRounds);
  }

  /**
   * Out of the show after this wall? Offer "Keep watching / Leave show"
   * (holding the offline show clock until the player picks), or carry on as
   * a spectator when they already chose to keep watching.
   */
  private afterResults(r: ActiveRound, localQualified: boolean, remaining: number): void {
    const next = afterRoundResults(
      { inRound: r.inRound, qualified: localQualified, isFinal: r.start.isFinal },
      this.watch,
      this.watchPrefs(),
    );
    switch (next.kind) {
      case 'stillIn':
        // Party fate sharing can carry a knocked-out player through: drop any pending offer.
        this.clearWatchChoice();
        break;
      case 'spectate':
        this.markOutOfShow();
        break;
      case 'ask':
        this.markOutOfShow();
        this.offerWatchChoice(next.autoAfterS, remaining, true);
        break;
      case 'showOver':
        this.clearWatchChoice();
        break;
    }
  }

  private watchPrefs(): WatchPrefs {
    return { autoSpectate: this.ctx.settings().gameplay.autoSpectate, autoplay: this.ctx.cfg.autoplay };
  }

  private markOutOfShow(): void {
    if (this.outOfShow) return;
    this.outOfShow = true;
    ui.getState().setShowSeat({ online: this.isOnline(), outOfShow: true });
  }

  /**
   * Puts "Keep watching / Leave show" up and schedules the automatic Keep
   * watching.
   *
   * @param autoAfterS - Flow seconds until Keep watching is picked (null = wait).
   * @param remaining - Players still in the show.
   * @param holdShow - Pause the offline show clock until the player picks.
   */
  private offerWatchChoice(autoAfterS: number | null, remaining: number, holdShow: boolean): void {
    const autoAt = autoAfterS === null ? null : Date.now() + (autoAfterS / this.flowScale) * 1000;
    ui.getState().setWatchChoice({ autoAt, remaining });
    if (holdShow && !this.choiceHeld) {
      this.choiceHeld = true;
      this.hold();
    }
    if (autoAfterS === null) return;
    const offer = ui.getState().watchChoice;
    this.after(autoAfterS, () => {
      if (this.watch === 'undecided' && ui.getState().watchChoice === offer) this.keepWatching();
    });
  }

  private clearWatchChoice(): void {
    ui.getState().setWatchChoice(null);
    if (this.choiceHeld) {
      this.choiceHeld = false;
      this.release();
    }
  }

  /**
   * "Keep watching" (button, Auto-spectate, the eliminated sheet): the show
   * continues for this player as a spectator through every remaining round.
   */
  private keepWatching(): void {
    this.watch = 'watching';
    this.clearWatchChoice();
    const s = ui.getState();
    s.setEliminatedSheet(false);
    const r = this.round;
    const p = this.phase ?? 0;
    // Between rounds there is nobody to watch yet; the next countdown starts spectating.
    if (!r || p < RoundPhase.Countdown || p >= RoundPhase.RoundEnd) return;
    if (r.fate === 'eliminated' || r.fate === 'qualified' || !r.inRound) this.beginSpectating();
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
      ...(qualified && rs.round.type === 'race' && r.qualifiedAfter !== undefined
        ? { timeSec: Math.round(r.qualifiedAfter * 10) / 10 }
        : {}),
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
        return {
          name: p.name,
          colors: p.colors,
          isBot: p.isBot,
          place,
          crowned: this.summary?.winnerId === id,
        };
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
    const rumble = this.ctx.settings().controls.vibration && !this.ctx.cfg.autoplay;
    const now = performance.now();
    for (const e of events) {
      view?.handleEvent(e);
      this.ctx.replays?.event(e);
      if (audio) this.ctx.audio.game.handleSimEvent(e, lp);
      const cue = this.haptics.map(e, this.localId);
      if (cue && rumble && this.hapticGate.allow(cue.kind, now)) this.ctx.input.rumble(cue.pattern);
      const mine = 'player' in e && e.player === this.localId;
      switch (e.type) {
        case 'qualified':
          if (mine) this.localQualified();
          else if (r && r.start.round.type === 'race')
            this.toast(`${this.publicName(e.player)} qualified!`, '🏁', e.player);
          break;
        case 'eliminated':
          if (mine) this.localEliminated();
          else if (r && r.start.round.type !== 'race')
            this.toast(`${this.publicName(e.player)} is out!`, '💨', e.player);
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
        case 'grabEnd':
        case 'fellOut':
          // A toggled grab ends with the grab itself, or it would re-grab on the next step.
          if (mine) this.ctx.input.endGrabToggle();
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
      if (this.ctx.settings().gameplay.autoSpectate) {
        this.beginSpectating();
        return;
      }
      // Waiting for the others: spectating is one key / shoulder press away.
      const binds = ui.getState().settings.controls.keybinds;
      ui.getState().pushToast({
        kind: 'info',
        variant: 'feed',
        title: 'Qualified! Waiting for the round to end',
        body: `${shortKey(binds.spectatePrev[0])} / ${shortKey(binds.spectateNext[0])} or LB / RB to watch the others`,
        durationMs: 5000,
      });
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
    const plan = planAfterEliminated(this.watch, this.watchPrefs());
    this.after(plan.afterS, () => {
      if (this.round !== r || r.fate !== 'eliminated' || (this.phase ?? 0) >= RoundPhase.RoundEnd) return;
      if (plan.kind === 'spectate') {
        this.beginSpectating();
        return;
      }
      // The round keeps running for everyone else, so this offer never holds the show clock.
      this.offerWatchChoice(plan.autoAfterS, this.stillInCount(), false);
      ui.getState().setEliminatedSheet(true);
    });
  }

  /** Entrants of the current round not yet knocked out. */
  private stillInCount(): number {
    const r = this.round;
    if (!r) return 0;
    const st = this.liveStatus()?.players;
    return r.start.players.filter((p) => st?.get(p.id)?.status !== PlayerRoundStatus.Eliminated).length;
  }

  // ---------------------------------------------------------------------------
  // Spectating
  // ---------------------------------------------------------------------------

  private candidates(): number[] {
    const r = this.round;
    if (!r) return [];
    const st = this.liveStatus();
    const order = st?.standings ?? r.start.players.map((p) => p.id);
    return spectateCandidates(order, this.localId, (id) => spectateStatusOf(st?.players?.get(id)?.status));
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

  /**
   * Watches the next/previous Tumbler. A qualified player waiting for the
   * round to end starts spectating on their first cycle.
   */
  private cycleSpectate(dir: 1 | -1): void {
    const r = this.round;
    if (!r) return;
    if (r.fate === 'qualified' && (this.phase ?? 0) < RoundPhase.RoundEnd) {
      this.beginSpectating();
      return;
    }
    if (r.fate !== 'spectating') return;
    const list = this.candidates();
    const next = cycleSpectateIndex(list, r.spectateId, dir);
    if (next < 0) return;
    this.spectatePlayer(list[next] as number, next, list.length);
  }

  private spectatePlayer(id: number, index: number, count: number): void {
    const r = this.round;
    if (!r) return;
    r.spectateId = id;
    r.view?.spectate(id);
    const st = this.liveStatus()?.players?.get(id);
    const qualified = st?.status === PlayerRoundStatus.Qualified;
    ui.getState().setSpectate({
      player: this.uiPlayer(id),
      detail: spectateDetail(index, qualified),
      qualified,
      index,
      count,
      remaining: this.stillInCount(),
    });
  }

  /** Keeps the banner's place and "still in" count current while watching. */
  private refreshSpectateBanner(realDt: number): void {
    const r = this.round;
    if (!r || r.fate !== 'spectating' || r.spectateId < 0) return;
    this.spectateRefresh += realDt;
    if (this.spectateRefresh < SPECTATE_REFRESH_S) return;
    this.spectateRefresh = 0;
    const list = this.candidates();
    const i = list.indexOf(r.spectateId);
    if (i >= 0) this.spectatePlayer(r.spectateId, i, list.length);
  }

  /** Gamepad shoulder buttons cycle spectate targets (the input system has no spectate actions). */
  private pollSpectatePad(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected && p.mapping === 'standard') {
        gp = p;
        break;
      }
    }
    const down = (i: number): boolean => !!gp?.buttons[i]?.pressed;
    const dir = this.padCycler.update(down(PAD_SPECTATE_PREV), down(PAD_SPECTATE_NEXT));
    if (dir !== 0) this.cycleSpectate(dir);
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    const r = this.round;
    if (!r) return;
    const binds = ui.getState().settings.controls.keybinds;
    const watching = r.fate === 'spectating' || r.fate === 'qualified';
    if (watching && ui.getState().screen === 'round' && ui.getState().overlay === 'none') {
      if (binds.spectatePrev.includes(e.code)) this.cycleSpectate(-1);
      else if (binds.spectateNext.includes(e.code)) this.cycleSpectate(1);
    }
    // NOTE: Escape always works too: browsers spend it on releasing pointer
    // lock, so a player who rebinds Menu still expects Esc to reach the menu.
    const menuKey = e.code === 'Escape' || this.ctx.input.isBound('menu', e.code);
    // Menu navigation already used this key (e.g. Esc pressed Resume, which closed the menu).
    if (menuKey && !e.defaultPrevented && ui.getState().screen === 'round') {
      const overlay = ui.getState().overlay;
      if (overlay === 'none') ui.getState().setOverlay('inGameMenu');
      else if (overlay === 'inGameMenu') ui.getState().setOverlay('none');
    }
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
      this.ctx.input.endGrabToggle();
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
    const us = ui.getState();
    input.settings.pointerLock =
      us.settings.controls.mouseLock &&
      !!view &&
      (active || spectating) &&
      !this.ctx.cfg.autoplay &&
      us.screen === 'round' &&
      us.overlay === 'none' &&
      !us.replay &&
      !social.getState().chatOpen &&
      !us.photo.active;
    if (
      !input.settings.pointerLock &&
      (us.overlay !== 'none' || us.photo.active) &&
      document.pointerLockElement
    )
      document.exitPointerLock();
    const lock =
      input.settings.pointerLock && !us.isTouch ? (input.pointerLocked ? 'locked' : 'unlocked') : 'off';
    if (us.cameraLock !== lock) ui.setState({ cameraLock: lock });
    const look = input.readLook(realDt);
    this.updateGrabHud();
    if (!view || !r) return;
    this.ctx.replays?.frame();
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
    if (st && r.hud && p >= RoundPhase.Countdown && p <= RoundPhase.RoundEnd)
      r.hud.update(realDt, st, this.ctx.fps(), this.ping());

    if (r.fate === 'spectating' && r.spectateId >= 0 && (this.phase ?? 0) < RoundPhase.RoundEnd) {
      const ps = st?.players?.get(r.spectateId);
      if (ps && ps.status === PlayerRoundStatus.Eliminated) this.cycleSpectate(1);
    }
    // Photo mode uses the shoulders for field of view.
    if (
      spectating &&
      us.screen === 'round' &&
      us.overlay === 'none' &&
      !us.eliminatedSheet &&
      !us.photo.active
    )
      this.pollSpectatePad();
    else this.padCycler.reset(true, true);
    this.refreshSpectateBanner(realDt);
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
      return {
        roundId: o.roundId,
        name: o.name,
        type: o.isFinal ? ('final' as const) : o.type,
        eliminatedIds: o.eliminated.filter((id) => !carried.has(id) && id !== summary.winnerId),
      };
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
    this.ctx.audio.game.onShowPhase(ShowPhase.Victory, {
      localWon,
      ...(winner ? { winnerName: winner.name } : {}),
    });
    if (!winner || winnerId === null) {
      this.after(1.2, () => this.goWall());
      return;
    }
    const crowns = this.ctx.crowns();
    s.setVictory({
      winner: this.uiPlayer(winnerId),
      isLocalWinner: localWon,
      crownsBefore: crowns,
      crownsAfter: crowns + (localWon ? 1 : 0),
      showName: this.showName,
    });
    const finalTheme = getTheme(this.round?.start.round.theme ?? 'candy');
    const ranked = [...summary.placements.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const runnersUp = ranked
      .filter((id) => id !== winnerId)
      .slice(0, 2)
      .map((id) => this.players.get(id))
      .filter((p): p is SessionPlayer => !!p)
      .map((p) => ({ name: this.publicName(p.id), loadout: p.loadout }));
    this.swapUnder(localWon ? 'victory' : 'winnerCam', { transition: 'wipe' }, () => {
      this.ctx.director.show(
        createPodiumView(
          finalTheme,
          this.ctx.quality.preset,
          this.ctx.tumblers.create,
          { name: this.publicName(winner.id), loadout: winner.loadout },
          runnersUp,
          this.ctx.post,
        ),
      );
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
      const botTags = this.ctx.settings().gameplay.botTags;
      const wall3d = {
        players: this.order.map((id) => {
          const p = this.players.get(id) as SessionPlayer;
          return { id: String(id), name: this.publicName(id), loadout: p.loadout, isBot: p.isBot && botTags };
        }),
        rounds: uiSummary.rounds.map((r) => ({ name: r.name, eliminatedIds: r.eliminatedIds.map(String) })),
        winnerId: summary.winnerId !== null ? String(summary.winnerId) : null,
      };
      this.wall = new WallView(
        getTheme('candy'),
        this.ctx.quality.preset,
        this.ctx.tumblers.create,
        wall3d,
        this.ctx.post,
      );
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

  /**
   * The finished show from the local seat. Only rounds the player actually
   * entered count; a spectator who was knocked out early still gets the
   * show's participation and their final placement.
   *
   * @param summary - The show recap.
   */
  private showFacts(summary: SessionSummary): ShowResultForProfile {
    const finalOutcome = summary.rounds[summary.rounds.length - 1];
    const reachedFinal =
      !!finalOutcome?.isFinal &&
      (finalOutcome.qualified.includes(this.localId) || finalOutcome.eliminated.includes(this.localId));
    return {
      playlistName: this.showName,
      rounds: this.localRounds(),
      reachedFinal,
      wonCrown: summary.winnerId === this.localId,
      place: summary.placements.get(this.localId) ?? this.order.length,
      participants: this.order.length,
      quit: false,
      counters: this.counters,
      field: this.fieldSummary(),
    };
  }

  private goRewards(): void {
    if (this.awaiting === 'rewards' || !this.summary) return;
    // Give the server's reward summary a few seconds before falling back to the local estimate.
    if (this.rewardsPending() && this.rewardsWait < 32) {
      this.rewardsWait++;
      this.after(0.25, () => this.goRewards());
      return;
    }
    this.awaiting = 'rewards';
    const rewards = this.computeRewards(this.showFacts(this.summary));
    const s = ui.getState();
    s.setRewards(rewards);
    this.wall = null;
    this.ctx.onEnd('rewards');
  }
}
