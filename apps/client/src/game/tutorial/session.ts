/**
 * Practice Island runner (SPEC §14.1 step 4): the optional ~2 minute warm-up
 * with Coach Boing, ending in a mini race against bots.
 *
 * Responsibilities:
 * - load the island offline: the practice sim (you + the coach), then the
 *   mini race sim (you + 7 clumsy/average bots, the coach cheering from a
 *   podium) behind Tumble Wipes;
 * - run the stations in order — move, jump, dive, grab, ledge climb, bounce
 *   pad, falling tiles, checkpoint + fall demo, race arch — with the coach
 *   demonstrating each one ahead of you and waiting, success detected from sim
 *   events and state, gentle hints after misses;
 * - drive the overlay (`@tumble/ui/tutorial`): checklist, objective card with
 *   the player's real bindings, the coach's text bubble, skip flow and the
 *   "You're ready!" card (no voice: text, emotes and sound effects only);
 * - grant the one-time reward and hand control back through `ctx.onEnd`;
 * - `?autoplay=1`: a scripted pilot completes every station and the race.
 *
 * It extends {@link ShowSession} so the app's frame loop, settings hooks and
 * teardown treat it like any other session; the show choreography (cards,
 * results, wall) is simply never triggered.
 */
import {
  COACH_PODIUM,
  FALL_BOARD,
  ISLAND,
  PRACTICE_STATIONS,
  RACE_SECONDS,
  RACE_SPAWN,
  TUTORIAL_ROUND,
  type PracticeStation,
  type ZoneBox,
} from '@tumble/content/rounds/practice-island';
import type { TumblerLoadout } from '@tumble/render/scenes';
import { RoundPhase, Rng, SIM_DT, hashString, type RoundDefinition, type Vec3 } from '@tumble/shared';
import {
  Button,
  CharacterState,
  FixedStepper,
  emptyInput,
  type CharacterFullState,
  type CharacterInput,
  type SimEvent,
} from '@tumble/sim';
import { generateBotNames } from '@tumble/sim/bots';
import { createCharacterFullState } from '@tumble/sim/character';
import { createMatchSim, type MatchPlayerInfo, type MatchSimHandle } from '@tumble/sim/match';
import { playCue, ui, type RoundIntroInfo } from '@tumble/ui';
import {
  mountTutorialOverlay,
  setCoachAnchor,
  tutorialEvents,
  tutorialUi,
  type CoachLine,
  type TutorialDevice,
  type TutorialOverlayHandle,
  type TutorialStep,
} from '@tumble/ui/tutorial';
import { Vector3 } from 'three/webgpu';
import { botLoadout, emoteSlots } from '../cosmetics.ts';
import { pushMeta } from '../meta.ts';
import { HudMapper, type HudInput, type HudPlayerStatus } from '../round/hud.ts';
import { FOOT_OFFSET, OfflineRoundSource, type RoundSource } from '../round/source.ts';
import type { GameContext, RoundStart, SessionEnd } from '../show/context.ts';
import { ShowSession } from '../show/session.ts';
import { promptKeys, type PromptAction } from './bindings.ts';
import { RouteFollower, routeBetween, steerTo } from './driver.ts';
import { grantTutorialReward } from './reward.ts';
import { DIVE_ON_FLAT, FALL_DEMO, LINES, SCRIPT, ordinal, renderPrompt } from './script.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const HUMAN = 0;
const PRACTICE_COACH = 1;
const RACE_BOTS = 7;
/**
 * The coach keeps his practice id in the race: the session's Tumbler pool keeps one visual per id
 * for its lifetime, so reusing id 1 for a bot would dress that bot as the coach.
 */
const RACE_COACH = PRACTICE_COACH;
/** First race bot id (after you and the coach). */
const FIRST_BOT = 2;
/** Seconds the coach talks before demonstrating. */
const INTRO_SECONDS = 1.6;
/** Seconds the success burst holds before the next station. */
const NEXT_STATION_SECONDS = 1.3;
/** A demo that stalls this long ends with the coach popping to his wait point. */
const DEMO_STALL_TICKS = 9 * 60;
/** Misses (falls) or seconds on a station before the tip appears. */
const HINT_FAILS = 2;
const HINT_SECONDS = 22;
/**
 * Seconds between the load swap and the reveal. The swap runs inside the
 * wipe's "covered" callback, where a screen change would be overwritten by
 * the wipe finishing its own transition, so the reveal waits a beat.
 */
const REVEAL_DELAY = 0.5;
const COACH_NAME = 'Coach Boing';
const COACH_EMOTE = { wave: 1, jacks: 2, flex: 3, dance: 4 } as const;

/** Where the tutorial is. */
type Stage = 'loading' | 'intro' | 'practice' | 'toRace' | 'race' | 'raceOver' | 'ready' | 'done';
/** Within a station. */
type StationPhase = 'intro' | 'demo' | 'turn' | 'done';

/** Latched achievements of the human (never reset, so running ahead still counts). */
interface Flags {
  jumped: boolean;
  dived: boolean;
  grabbedCoach: boolean;
  grabbedLedge: boolean;
  climbed: boolean;
  bounced: boolean;
  checkpointSaved: boolean;
  fellAfterCheckpoint: boolean;
  respawnedAfterCheckpoint: boolean;
}

/** Automation hooks (`window.__tutorial`) for Playwright and the console. */
export interface TutorialHooks {
  stage: () => string;
  station: () => string | null;
  completed: () => string[];
  raceResult: () => { place: number; of: number } | 'timeUp' | null;
  /** Seconds since the tutorial started (sim time). */
  elapsed: () => number;
  /** Local Tumbler feet position (debug, tests). */
  position: () => { x: number; y: number; z: number };
  /** Debug: teleports the local Tumbler (feet position). */
  teleport: (x: number, y: number, z: number) => void;
}

declare global {
  interface Window {
    __tutorial?: TutorialHooks;
  }
}

/** Drops the held loading wipe onto the in-round screen. */
function revealRound(): void {
  ui.getState().setScreen('round', { transition: 'wipe' });
  ui.getState().releaseWipe();
}

const inBox = (b: ZoneBox, p: Vec3): boolean =>
  p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

/** Coach Boing's loadout, built on a stable bot outfit so every slot is valid. */
function coachLoadout(): TumblerLoadout {
  return {
    ...botLoadout(7, 7, COACH_NAME),
    colors: ['#3ee6b4', '#2b1a5e', '#ffd23f'],
    pattern: 'stripes',
    face: 'face.mustache',
    headwear: 'headwear.propeller',
    emotes: ['emote.wave', 'emote.jumping-jacks', 'emote.flex', 'emote.dance'],
    nameplate: 'nameplate.mint',
  };
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

/**
 * One run through Practice Island.
 *
 * @example
 * const session = new TutorialSession(ctx);
 * session.start();
 * // per frame (the app's loop does this for any session)
 * session.frame(dt, realDt);
 */
export class TutorialSession extends ShowSession {
  private stage: Stage = 'loading';
  private sim: MatchSimHandle | null = null;
  private source: OfflineRoundSource | null = null;
  private readonly stepper: FixedStepper;
  private readonly seed: number;
  private readonly practiceRound: RoundDefinition;
  private readonly raceRound: RoundDefinition;
  private overlay: TutorialOverlayHandle | null = null;
  private readonly listeners: (() => void)[] = [];
  private finishing = false;
  private elapsed = 0;

  // Human.
  private readonly human: CharacterFullState = createCharacterFullState();
  private readonly feet: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly flags: Flags = {
    jumped: false,
    dived: false,
    grabbedCoach: false,
    grabbedLedge: false,
    climbed: false,
    bounced: false,
    checkpointSaved: false,
    fellAfterCheckpoint: false,
    respawnedAfterCheckpoint: false,
  };

  // Stations.
  private stationIndex = -1;
  private stationPhase: StationPhase = 'intro';
  private stationTime = 0;
  private stationFails = 0;
  private hintShown = false;
  private diveOnFlat = false;
  private fallStep = false;
  private readonly completed: string[] = [];
  private device: TutorialDevice = 'keyboard';
  private coachSeq = 0;

  // Coach.
  private coachId = PRACTICE_COACH;
  private readonly coachState: CharacterFullState = createCharacterFullState();
  private readonly coachIn: CharacterInput = emptyInput();
  private coachMode: 'idle' | 'demo' | 'fallDemo' | 'afterFall' | 'podium' = 'idle';
  private coachFollower: RouteFollower | null = null;
  private coachEmote = 0;
  private readonly headScratch = new Vector3();
  private readonly feetScratch = { x: 0, y: 0, z: 0 };

  // Autopilot (`?autoplay=1`).
  private readonly autoplay: boolean;
  private pilotFollower: RouteFollower | null = null;
  private pilotFor = '';
  private pilotFall = false;

  // Race.
  private raceResult: { place: number; of: number } | 'timeUp' | null = null;
  private racePromptHidden = false;
  private readonly hudInput: HudInput = {
    timeLeft: -1,
    qualifiedCount: 0,
    qualifyTarget: 0,
    eliminatedCount: 0,
    overtime: false,
    teamScores: [],
    players: null,
    standings: null,
  };

  // Gamepad edges.
  private padPrev = 0;

  /**
   * @param ctx - App services.
   * @param seed - Seed for bot names/looks (random by default).
   */
  constructor(ctx: GameContext, seed?: number) {
    super(ctx);
    this.seed = (seed ?? ctx.cfg.seed ?? (Math.random() * 0x7fffffff) | 0) >>> 0;
    this.autoplay = ctx.cfg.autoplay;
    this.showName = 'Practice Island';
    this.localId = HUMAN;
    this.practiceRound = TUTORIAL_ROUND;
    this.raceRound = {
      ...TUTORIAL_ROUND,
      objective: LINES.raceObjective,
      spawn: { ...TUTORIAL_ROUND.spawn, ...RACE_SPAWN, origin: { ...RACE_SPAWN.origin } },
      duration: { seconds: RACE_SECONDS, overtimeSeconds: 0 },
    };
    this.stepper = new FixedStepper(
      (tick) => this.step(tick),
      SIM_DT,
      Math.max(8, Math.ceil(8 * ctx.cfg.timeScale)),
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Loads the island behind a wipe and starts the intro flyover. */
  start(): void {
    this.overlay = mountTutorialOverlay();
    this.installInput();
    // The coach only ever talks in text; keep the voice announcer quiet for the whole tutorial.
    this.ctx.audio.game.announcer.setEnabled(false);
    window.__tutorial = {
      stage: () => this.stage,
      station: () => PRACTICE_STATIONS[this.stationIndex]?.id ?? null,
      completed: () => [...this.completed],
      raceResult: () => this.raceResult,
      elapsed: () => this.elapsed,
      position: () => ({ ...this.feet }),
      teleport: (x, y, z) => this.sim?.controller(HUMAN)?.teleport({ x, y, z }),
    };
    ui.getState().setRoundIntro(this.loadingInfo(this.practiceRound.name, this.practiceRound.tips));
    this.ctx.audio.game.music.play('lobby', { fade: 1.2 });
    this.ctx.audio.game.music.setIntensity(0.3);
    this.swapUnder('roundLoading', { transition: 'wipe', hold: true }, () => this.loadPractice());
  }

  /** Ends the tutorial (skip or ready card) and lets the app decide what's next. */
  private finish(reason: SessionEnd): void {
    if (this.finishing) return;
    this.finishing = true;
    this.stage = 'done';
    tutorialUi.setState({ phase: 'hidden' });
    this.ctx.onEnd(reason);
  }

  protected override onDispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.overlay?.unmount();
    this.overlay = null;
    setCoachAnchor(0, 0, false);
    this.ctx.audio.game.announcer.setEnabled(this.ctx.settings().accessibility.spokenAnnouncer === true);
    this.ctx.audio.game.setLocalPlayer(null);
    const sim = this.sim;
    this.sim = null;
    sim?.dispose();
    if (window.__tutorial) window.__tutorial = { ...window.__tutorial, stage: () => 'done' };
  }

  // ---------------------------------------------------------------------------
  // Input: skip (Esc / Start / button), intro skip, ready card keys
  // ---------------------------------------------------------------------------

  private get modalOpen(): boolean {
    const s = tutorialUi.getState();
    return s.skipConfirm || s.ready !== null;
  }

  private installInput(): void {
    const onKey = (e: KeyboardEvent): void => {
      if (this.stage === 'loading' || this.stage === 'done') return;
      const s = tutorialUi.getState();
      const pause = ui.getState().settings.controls.keybinds.pause;
      if (e.code === 'Escape' || pause.includes(e.code)) {
        // Capture phase: the show session would otherwise open the settings sheet.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        if (s.ready) tutorialEvents.emit('readyChoice', { next: 'menu' });
        else if (s.skipConfirm) tutorialEvents.emit('skip', {});
        else tutorialUi.setState({ skipConfirm: true });
        return;
      }
      if (e.repeat) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (s.ready) tutorialEvents.emit('readyChoice', { next: 'show' });
        else if (s.skipConfirm) tutorialEvents.emit('skip', {});
        else if (this.stage === 'intro') this.endIntro();
      } else if (this.stage === 'intro' && e.code === 'Space') this.endIntro();
    };
    const onPointer = (): void => {
      if (this.stage === 'intro') this.endIntro();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer);
    this.listeners.push(
      () => window.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('pointerdown', onPointer),
      tutorialEvents.on('skip', () => this.finish('backToLobby')),
      tutorialEvents.on('readyChoice', ({ next }) =>
        this.finish(next === 'show' ? 'playAgain' : 'backToLobby'),
      ),
    );
  }

  /** Gamepad: Start toggles skip, Ⓐ confirms / skips the intro, Ⓑ backs out. */
  private pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let bits = 0;
    for (const p of pads) {
      if (!p) continue;
      if (p.buttons[0]?.pressed) bits |= 1;
      if (p.buttons[1]?.pressed) bits |= 2;
      if (p.buttons[9]?.pressed) bits |= 4;
    }
    const pressed = bits & ~this.padPrev;
    this.padPrev = bits;
    if (!pressed) return;
    const s = tutorialUi.getState();
    if (pressed & 4 && !s.ready) tutorialUi.setState({ skipConfirm: !s.skipConfirm });
    else if (pressed & 1) {
      if (s.ready) tutorialEvents.emit('readyChoice', { next: 'show' });
      else if (s.skipConfirm) tutorialEvents.emit('skip', {});
      else if (this.stage === 'intro') this.endIntro();
    } else if (pressed & 2) {
      if (s.ready) tutorialEvents.emit('readyChoice', { next: 'menu' });
      else if (s.skipConfirm) tutorialUi.setState({ skipConfirm: false });
    }
  }

  protected override get controlsActive(): boolean {
    return super.controlsActive && !this.modalOpen && this.stage !== 'intro';
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private loadingInfo(name: string, tips: string[]): RoundIntroInfo {
    // A show's last loading state must not leak onto the island's loading screen.
    ui.getState().setRoundLoading(null);
    return {
      roundId: this.practiceRound.id,
      name,
      type: 'race',
      theme: this.practiceRound.theme,
      objective: this.practiceRound.objective,
      rules: [],
      tips,
      roundIndex: 0,
      roundCount: 1,
      isFinal: false,
      playerCount: 1,
      qualifyTarget: 1,
    };
  }

  /** Points the base session at a freshly built sim and builds its round view. */
  private mountRound(round: RoundDefinition, players: MatchPlayerInfo[], qualifyTarget: number): void {
    const sim = this.sim as MatchSimHandle;
    this.source = new OfflineRoundSource(sim, players, HUMAN, () => this.sim === sim);
    this.stepper.reset();
    this.source.capture();
    const start: RoundStart = {
      index: 0,
      isFinal: false,
      round,
      players,
      seed: this.seed,
      stage: 0,
      qualifyTarget,
    };
    this.round = {
      start,
      source: null,
      view: null,
      hud: null,
      fate: 'playing',
      inRound: true,
      loadRequested: true,
      building: false,
      loadPct: 0,
      waited: false,
      everyoneIn: false,
      introShown: true,
      loadMinDone: false,
      outcome: null,
      resultsShown: false,
      countdown: null,
      spectateId: -1,
      playingSince: 0,
    };
    this.buildRoundView();
  }

  private loadPractice(): void {
    const name = this.ctx.playerName();
    const players: MatchPlayerInfo[] = [
      { id: HUMAN, name, isBot: false, team: -1 },
      { id: PRACTICE_COACH, name: COACH_NAME, isBot: false, team: -1 },
    ];
    this.players.set(HUMAN, { id: HUMAN, name, isBot: false, loadout: this.ctx.look() });
    this.players.set(PRACTICE_COACH, {
      id: PRACTICE_COACH,
      name: COACH_NAME,
      isBot: true,
      loadout: coachLoadout(),
    });
    this.order = [HUMAN, PRACTICE_COACH];
    this.sim = createMatchSim(
      { R: this.ctx.R, round: this.practiceRound, seed: this.seed, stage: 0, players, mode: 'offline' },
      this.ctx.matchDeps,
    );
    for (const w of this.sim.warnings) console.warn('[tutorial]', w);
    this.sim.setPhase(RoundPhase.Playing, 0);
    this.coachId = PRACTICE_COACH;
    this.phase = RoundPhase.IntroFlyover;
    this.mountRound(this.practiceRound, players, 1);
    const r = this.round;
    if (!r?.view) return;
    // Practice uses its own overlay; the race HUD widgets (timer, counters, progress) stay hidden.
    r.hud = null;
    ui.getState().resetHud({
      roundType: 'team',
      objective: '',
      timeLeft: -1,
      timeTotal: 0,
      teams: [],
      controlsHint: false,
      localStatus: 'playing',
      device: this.ctx.input.lastDevice,
      emotes: emoteSlots(this.players.get(HUMAN)?.loadout.emotes ?? []),
    });
    this.after(REVEAL_DELAY, () => this.revealPractice());
  }

  private revealPractice(): void {
    const view = this.round?.view;
    if (!view || this.stage !== 'loading') return;
    this.stage = 'intro';
    this.device = this.ctx.input.lastDevice;
    revealRound();
    tutorialUi.setState({
      phase: 'intro',
      device: this.device,
      title: {
        title: 'Practice Island',
        subtitle: 'A 2-minute warm-up with Coach Boing',
        skipKeys: this.introSkipKeys(),
      },
      steps: PRACTICE_STATIONS.map((s): TutorialStep => ({
        id: s.id,
        label: SCRIPT[s.id].label,
        icon: SCRIPT[s.id].icon,
        state: 'todo',
      })),
      skipKeys: this.keys('skip'),
    });
    view.playFlyover(() => this.endIntro());
    if (this.autoplay) this.after(3.5, () => this.endIntro());
  }

  private introSkipKeys(): string[] {
    if (this.device === 'gamepad') return ['Ⓐ'];
    if (this.device === 'touch') return ['Tap'];
    return ['Space'];
  }

  private endIntro(): void {
    if (this.stage !== 'intro') return;
    const view = this.round?.view;
    if (!view) return;
    this.stage = 'practice';
    view.settleBehindPlayer();
    view.followLocal();
    this.phase = RoundPhase.Playing;
    tutorialUi.setState({ phase: 'practice', title: null });
    this.beginStation(0);
  }

  // ---------------------------------------------------------------------------
  // Base session hooks
  // ---------------------------------------------------------------------------

  protected createSource(_rs: RoundStart): RoundSource | null {
    return this.source;
  }

  protected liveStatus(): HudInput | null {
    const m = this.sim;
    if (!m || this.stage === 'intro' || this.stage === 'practice' || this.stage === 'loading') return null;
    const st = m.getStatus();
    const h = this.hudInput;
    h.timeLeft = st.timeLeft;
    h.qualifiedCount = st.qualifiedCount;
    h.qualifyTarget = st.qualifyTarget;
    h.eliminatedCount = st.eliminatedCount;
    h.overtime = false;
    h.teamScores = st.teamScores;
    h.players = st.players as ReadonlyMap<number, HudPlayerStatus>;
    h.standings = m.getStandings().filter((id) => id !== RACE_COACH);
    return h;
  }

  protected advance(simDt: number, showDt: number): void {
    const sim = this.sim;
    if (!sim || this.stage === 'loading' || this.stage === 'done') return;
    this.pollGamepad();
    this.stepper.advance(simDt);
    if (this.source && this.source.sim === sim) this.source.alpha = this.stepper.alpha;
    const evs = sim.events.events;
    if (evs.length > 0) {
      this.handleEvents(evs);
      evs.length = 0;
    }
    if (this.sim !== sim) return;
    this.elapsed += showDt;
    const device = this.ctx.input.lastDevice;
    if (device !== this.device) {
      this.device = device;
      tutorialUi.setState({ device, skipKeys: this.keys('skip') });
      this.refreshPrompt();
    }
    if (this.stage === 'practice') this.tickStation(showDt);
    else if (this.stage === 'race') this.tickRace();
  }

  override frame(dt: number, realDt: number): void {
    super.frame(dt, realDt);
    if (this.modalOpen) {
      this.ctx.input.settings.pointerLock = false;
      if (document.pointerLockElement) document.exitPointerLock();
    }
    this.updateCoachAnchor();
  }

  protected override fillInput(out: CharacterInput): CharacterInput {
    if (!this.autoplay) {
      super.fillInput(out);
      return out;
    }
    const yaw = this.round?.view?.rig.yaw ?? 0;
    this.ctx.input.sample(yaw, out);
    out.moveX = 0;
    out.moveZ = 0;
    out.buttons = 0;
    out.emote = 0;
    if (this.controlsActive) this.pilotStep(out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fixed step
  // ---------------------------------------------------------------------------

  private step(tick: number): void {
    const sim = this.sim;
    if (!sim) return;
    const input = this.fillInput(emptyInputScratch);
    sim.setInput(HUMAN, input);
    sim.setInput(this.coachId, this.coachStep(tick));
    sim.step();
    this.source?.capture();
    if (sim.getPlayerState(HUMAN, this.human)) {
      this.feet.x = this.human.pos.x;
      this.feet.y = this.human.pos.y - FOOT_OFFSET;
      this.feet.z = this.human.pos.z;
      if (this.human.state === CharacterState.LedgeClimb) this.flags.climbed = true;
    }
  }

  /** Sim events: VFX/audio through the base session, plus tutorial bookkeeping. */
  private handleEvents(events: SimEvent[]): void {
    const forBase: SimEvent[] = [];
    for (const e of events) {
      if (e.type === 'eliminated' && e.player === HUMAN) {
        this.onRaceTimeUp();
        continue;
      }
      // The coach never qualifies or gets knocked out in the player's feed.
      if ((e.type === 'eliminated' || e.type === 'qualified') && e.player === this.coachId) continue;
      forBase.push(e);
      if ('player' in e && e.player === this.coachId) this.onCoachEvent(e);
      if (!('player' in e) || e.player !== HUMAN) continue;
      switch (e.type) {
        case 'jump':
          this.flags.jumped = true;
          break;
        case 'dive':
          this.flags.dived = true;
          break;
        case 'grabStart':
          if (e.targetKind === 'player' && e.target === this.coachId) this.flags.grabbedCoach = true;
          if (e.targetKind === 'ledge') this.flags.grabbedLedge = true;
          break;
        case 'bounce':
          this.flags.bounced = true;
          break;
        case 'checkpoint':
          if (e.index >= 6 && !this.flags.checkpointSaved) {
            this.flags.checkpointSaved = true;
            if (this.currentStation()?.id === 'checkpoint') this.enterFallStep();
          }
          break;
        case 'fellOut':
          this.stationFails++;
          if (this.flags.checkpointSaved && this.currentStation()?.id === 'checkpoint')
            this.flags.fellAfterCheckpoint = true;
          else if (this.stage === 'practice')
            this.say(LINES.oops[this.stationFails % LINES.oops.length] as string, 'talk');
          break;
        case 'respawn':
          if (this.flags.fellAfterCheckpoint) this.flags.respawnedAfterCheckpoint = true;
          this.pilotFollower?.resync(e.pos);
          break;
        case 'qualified':
          this.onRaceFinished(e.place);
          break;
        default:
          break;
      }
    }
    this.onSimEvents(forBase);
  }

  // ---------------------------------------------------------------------------
  // Stations
  // ---------------------------------------------------------------------------

  private currentStation(): PracticeStation | null {
    return PRACTICE_STATIONS[this.stationIndex] ?? null;
  }

  private keys(action: PromptAction): string[] {
    return promptKeys(action, this.device, ui.getState().settings.controls.keybinds);
  }

  private beginStation(i: number): void {
    const st = PRACTICE_STATIONS[i];
    if (!st) return;
    this.stationIndex = i;
    this.stationPhase = 'intro';
    this.stationTime = 0;
    this.stationFails = 0;
    this.hintShown = false;
    this.diveOnFlat = false;
    this.fallStep = st.id === 'checkpoint' && this.flags.checkpointSaved;
    this.pilotFollower = null;
    this.pilotFor = '';
    this.pilotFall = false;
    tutorialUi.setState({
      steps: tutorialUi
        .getState()
        .steps.map((s, k) => ({ ...s, state: k < i ? 'done' : k === i ? 'active' : 'todo' })),
    });
    this.refreshPrompt();
    this.say(SCRIPT[st.id].intro, 'talk');
    // The player may have run ahead: the coach pops over to meet them at the station.
    const sim = this.sim;
    if (sim?.getPlayerState(this.coachId, this.coachState)) {
      const c = this.coachState.pos;
      if (
        Math.hypot(c.x - st.start.x, c.z - st.start.z) > 6 ||
        Math.abs(c.y - FOOT_OFFSET - st.start.y) > 1.5
      ) {
        sim.controller(this.coachId)?.teleport({ ...st.start }, 0);
      }
    }
    this.coachMode = 'idle';
    this.coachEmote = st.id === 'move' ? COACH_EMOTE.wave : 0;
    if (this.fallStep) this.enterFallStep();
  }

  /** Rebuilds the objective card for the current station (also on device change). */
  private refreshPrompt(): void {
    const st = this.currentStation();
    const keys = (a: PromptAction): string[] => this.keys(a);
    if (this.stage === 'race' || this.stage === 'raceOver') {
      if (this.racePromptHidden) return;
      tutorialUi.setState({
        prompt: {
          id: 'race',
          icon: 'race',
          title: LINES.raceTitle,
          parts: renderPrompt(LINES.raceObjective, keys),
          hint: null,
        },
      });
      return;
    }
    if (!st) return;
    const s = SCRIPT[st.id];
    let title = s.title;
    let objective = s.objective;
    if (st.id === 'checkpoint' && this.fallStep) {
      title = FALL_DEMO.title;
      objective = FALL_DEMO.objective;
    }
    if (st.id === 'dive' && this.diveOnFlat) objective = DIVE_ON_FLAT.objective;
    tutorialUi.setState({
      prompt: {
        id: `${st.id}${this.fallStep ? '-fall' : ''}${this.diveOnFlat ? '-flat' : ''}`,
        icon: s.icon,
        title,
        parts: renderPrompt(objective, keys),
        hint: this.hintShown ? renderPrompt(s.hint, keys) : null,
      },
    });
  }

  /** Shows a coach line; it fades after a while so the bubble never parks in the view. */
  private say(text: string, mood: CoachLine['mood']): void {
    const seq = ++this.coachSeq;
    tutorialUi.setState({ coach: { text, mood, seq } });
    const racing = this.stage === 'race' || this.stage === 'raceOver' || this.stage === 'toRace';
    this.after(racing ? 3.5 : mood === 'wait' ? 10 : 7, () => {
      if (tutorialUi.getState().coach?.seq === seq) tutorialUi.setState({ coach: null });
    });
  }

  private enterFallStep(): void {
    if (this.fallStep && this.stationPhase !== 'intro') return;
    this.fallStep = true;
    tutorialUi.setState({ success: { text: FALL_DEMO.saved, seq: ++this.coachSeq } });
    playCue('ui.confirm');
    this.refreshPrompt();
  }

  /** Per-frame station logic: demo timing, success, hints, run-ahead. */
  private tickStation(dt: number): void {
    const st = this.currentStation();
    if (!st || this.stationPhase === 'done') return;
    this.stationTime += dt;
    if (this.stationPhase === 'intro' && this.stationTime >= INTRO_SECONDS) this.startDemo(st);

    if (this.stationSucceeded(st)) {
      this.completeStation(st);
      return;
    }
    // Ran past the station without the move (e.g. climbed before grabbing the coach): count it and carry on.
    if (
      st.id !== 'race' &&
      this.feet.z > st.goal.max.z + 1 &&
      this.feet.y > st.goal.min.y - 0.5 &&
      this.human.grounded
    ) {
      this.completeStation(st);
      return;
    }
    if (st.id === 'dive' && !this.diveOnFlat && !this.flags.dived && inBox(st.goal, this.feet)) {
      this.diveOnFlat = true;
      this.say(DIVE_ON_FLAT.coach, 'talk');
      this.refreshPrompt();
    }
    if (!this.hintShown && (this.stationFails >= HINT_FAILS || this.stationTime > HINT_SECONDS)) {
      this.hintShown = true;
      this.refreshPrompt();
      if (this.stationPhase === 'turn') this.say(LINES.slow, 'wait');
    }
  }

  private stationSucceeded(st: PracticeStation): boolean {
    const f = this.flags;
    const there = inBox(st.goal, this.feet);
    switch (st.id) {
      case 'move':
        return there;
      case 'jump':
        return f.jumped && there;
      case 'dive':
        return f.dived && (there || this.feet.z > st.goal.min.z);
      case 'grab':
        return f.grabbedCoach;
      case 'climb':
        return (f.climbed || f.grabbedLedge) && there && this.human.grounded;
      case 'bounce':
        return f.bounced && there && this.human.grounded;
      case 'tiles':
        return there && this.human.grounded;
      case 'checkpoint':
        return f.checkpointSaved && f.respawnedAfterCheckpoint;
      case 'race':
        return there;
    }
  }

  private startDemo(st: PracticeStation): void {
    this.stationPhase = 'demo';
    const next = PRACTICE_STATIONS[this.stationIndex + 1];
    const nav = this.practiceRound.botNav;
    let route = routeBetween(nav, st.navFrom, next?.navFrom ?? null);
    if (st.id === 'race') route = routeBetween(nav, 701, 801);
    this.coachFollower = new RouteFollower(route, st.id === 'checkpoint' ? null : st.end);
    this.coachMode = 'demo';
  }

  /** The coach finished demonstrating and waits for the player. */
  private onCoachDemoDone(): void {
    const st = this.currentStation();
    this.coachMode = 'idle';
    this.coachFollower = null;
    if (!st || this.stationPhase !== 'demo') return;
    this.stationPhase = 'turn';
    this.say(SCRIPT[st.id].turn, 'wait');
    this.coachEmote = st.id === 'grab' ? COACH_EMOTE.flex : COACH_EMOTE.wave;
  }

  private completeStation(st: PracticeStation): void {
    this.stationPhase = 'done';
    if (!this.completed.includes(st.id)) this.completed.push(st.id);
    if (st.id === 'race') {
      this.startRaceTransition();
      return;
    }
    tutorialUi.setState({
      steps: tutorialUi.getState().steps.map((s) => (s.id === st.id ? { ...s, state: 'done' } : s)),
      success: { text: 'Nice!', seq: ++this.coachSeq },
    });
    playCue('ui.claim');
    this.say(SCRIPT[st.id].cheer, 'cheer');
    this.coachEmote = COACH_EMOTE.jacks;
    if (this.coachMode === 'demo' || this.coachMode === 'fallDemo' || this.coachMode === 'afterFall') {
      // Player beat the demo: the coach stops showing off and catches up at the next station.
      this.coachMode = 'idle';
      this.coachFollower = null;
    }
    const index = this.stationIndex;
    this.after(NEXT_STATION_SECONDS, () => {
      if (this.stage === 'practice' && this.stationIndex === index) this.beginStation(index + 1);
    });
  }

  // ---------------------------------------------------------------------------
  // Coach
  // ---------------------------------------------------------------------------

  private coachStep(tick: number): CharacterInput {
    const out = this.coachIn;
    out.moveX = 0;
    out.moveZ = 0;
    out.buttons = 0;
    out.emote = 0;
    const sim = this.sim;
    if (!sim || !sim.getPlayerState(this.coachId, this.coachState)) return out;
    const self = {
      pos: this.coachState.pos,
      state: this.coachState.state,
      grounded: this.coachState.grounded,
    };
    const st = this.currentStation();
    switch (this.coachMode) {
      case 'demo': {
        const f = this.coachFollower;
        if (!f) break;
        if (f.step(self, tick, out) === 'done' && this.coachState.grounded) {
          if (st?.id === 'checkpoint') {
            this.coachMode = 'fallDemo';
            this.say('Now watch this...', 'talk');
          } else this.onCoachDemoDone();
        } else if (f.stalled > DEMO_STALL_TICKS && st) {
          sim.controller(this.coachId)?.teleport({ ...st.end }, Math.PI);
          if (st.id === 'checkpoint') this.coachMode = 'afterFall';
          else this.onCoachDemoDone();
        }
        break;
      }
      case 'fallDemo':
        // Walk off the end of the diving board; the respawn at the checkpoint is the demo.
        steerTo(self.pos, { x: FALL_BOARD.x + 3, y: FALL_BOARD.y, z: FALL_BOARD.z }, out);
        break;
      case 'afterFall':
        if (st && steerTo(self.pos, { x: st.end.x, y: st.end.y, z: st.end.z }, out, 0.8) < 0.5)
          this.onCoachDemoDone();
        break;
      case 'podium':
      case 'idle':
        if (this.coachEmote > 0 && this.coachState.grounded) {
          out.emote = this.coachEmote;
          this.coachEmote = 0;
        }
        break;
    }
    return out;
  }

  private onCoachEvent(e: SimEvent): void {
    if (e.type !== 'respawn') return;
    if (this.coachMode === 'fallDemo') {
      this.coachMode = 'afterFall';
      this.say('Ta-da! Back at the checkpoint.', 'cheer');
    } else if (this.coachMode === 'demo') this.coachFollower?.resync(e.pos);
  }

  /** Projects the coach's head to the screen for the speech bubble. */
  private updateCoachAnchor(): void {
    const view = this.round?.view;
    if (
      !view ||
      this.stage === 'loading' ||
      this.stage === 'done' ||
      !view.players.feetOf(this.coachId, this.feetScratch)
    ) {
      setCoachAnchor(0, 0, false);
      return;
    }
    const p = this.headScratch
      .set(this.feetScratch.x, this.feetScratch.y + 2.4, this.feetScratch.z)
      .project(view.camera);
    const visible = p.z > -1 && p.z < 1;
    setCoachAnchor(((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight, visible);
  }

  // ---------------------------------------------------------------------------
  // Autopilot (`?autoplay=1`)
  // ---------------------------------------------------------------------------

  private pilotStep(out: CharacterInput): void {
    const self = { pos: this.human.pos, state: this.human.state, grounded: this.human.grounded };
    const tick = this.sim?.tick ?? 0;
    if (this.stage === 'race') {
      if (this.phase !== RoundPhase.Playing) return;
      if (this.pilotFor !== 'race') {
        this.pilotFor = 'race';
        // Run on past the last waypoint (it only needs a 4 m arrival) so the feet actually cross the line.
        const pastLine = { x: 0, y: ISLAND.raceLowTop, z: ISLAND.finishZ + 4 };
        this.pilotFollower = new RouteFollower(routeBetween(this.raceRound.botNav, 801, null), pastLine);
      }
      this.pilotFollower?.step(self, tick, out);
      return;
    }
    const st = this.currentStation();
    // Watch the demo first (that's the point of a coach), unless the coach is slow.
    if (
      !st ||
      this.stationPhase === 'done' ||
      this.stationPhase === 'intro' ||
      (this.stationPhase === 'demo' && this.stationTime < 7)
    )
      return;
    if (st.id === 'grab') {
      if (steerTo(self.pos, this.coachState.pos, out) < 1.4) out.buttons |= Button.Grab;
      return;
    }
    if (this.pilotFor !== st.id) {
      this.pilotFor = st.id;
      const next = PRACTICE_STATIONS[this.stationIndex + 1];
      const nav = this.practiceRound.botNav;
      const route =
        st.id === 'race' ? routeBetween(nav, 701, 801) : routeBetween(nav, st.navFrom, next?.navFrom ?? null);
      const end = { x: st.end.x - 1.6, y: st.end.y, z: st.end.z };
      this.pilotFollower = new RouteFollower(route, st.id === 'race' ? null : end);
      this.pilotFall = false;
    }
    if (st.id === 'checkpoint' && this.flags.checkpointSaved && !this.flags.fellAfterCheckpoint)
      this.pilotFall = true;
    if (this.pilotFall) {
      if (!this.flags.fellAfterCheckpoint)
        steerTo(self.pos, { x: FALL_BOARD.x + 3, y: FALL_BOARD.y, z: FALL_BOARD.z }, out);
      return;
    }
    this.pilotFollower?.step(self, tick, out);
  }

  // ---------------------------------------------------------------------------
  // Mini race
  // ---------------------------------------------------------------------------

  private startRaceTransition(): void {
    if (this.stage !== 'practice') return;
    this.stage = 'toRace';
    tutorialUi.setState({
      steps: tutorialUi.getState().steps.map((s) => ({ ...s, state: s.id === 'race' ? 'active' : 'done' })),
      success: { text: 'Race time!', seq: ++this.coachSeq },
    });
    playCue('ui.confirm');
    this.say(SCRIPT.race.cheer, 'cheer');
    ui.getState().setRoundIntro(
      this.loadingInfo('Mini Race', [
        'Use everything you learned!',
        'Dive over the last gap for a speed boost.',
      ]),
    );
    this.after(1.1, () =>
      this.swapUnder('roundLoading', { transition: 'wipe', hold: true }, () => this.loadRace()),
    );
  }

  private loadRace(): void {
    if (this.stage !== 'toRace') return;
    const rng = new Rng((this.seed ^ hashString('tutorial-race')) >>> 0);
    const names = generateBotNames(RACE_BOTS, rng, [this.ctx.playerName()]);
    const human = this.players.get(HUMAN);
    const players: MatchPlayerInfo[] = [{ id: HUMAN, name: human?.name ?? 'You', isBot: false, team: -1 }];
    names.forEach((name, k) => {
      const id = FIRST_BOT + k;
      players.push({ id, name, isBot: true, team: -1, botSkill: k % 2 === 0 ? 'clumsy' : 'average' });
      this.players.set(id, { id, name, isBot: true, loadout: botLoadout(this.seed, id, name) });
    });
    const all = [...players, { id: RACE_COACH, name: COACH_NAME, isBot: false, team: -1 }];
    this.order = all.map((p) => p.id);

    const old = this.sim;
    this.sim = createMatchSim(
      {
        R: this.ctx.R,
        round: this.raceRound,
        seed: this.seed,
        stage: 0,
        players: all,
        mode: 'offline',
        qualifyTarget: players.length,
      },
      this.ctx.matchDeps,
    );
    old?.dispose();
    for (const w of this.sim.warnings) console.warn('[tutorial]', w);
    this.coachId = RACE_COACH;
    this.coachMode = 'podium';
    this.coachFollower = null;
    // The coach cheers from a podium beside the finish trigger, out of the racing line.
    this.sim.controller(RACE_COACH)?.teleport({ ...COACH_PODIUM }, Math.PI);
    this.sim.setPhase(RoundPhase.Countdown);
    this.phase = RoundPhase.Countdown;
    this.pilotFollower = null;
    this.pilotFor = '';
    // IMPORTANT: pooled Tumblers are shared between round views. Release them from the practice
    // view first; disposing it after the race view took them would pull them out of the new scene.
    this.round?.view?.dispose();
    this.mountRound(this.raceRound, all, players.length);
    const r = this.round;
    if (!r?.view) return;
    // Own HUD mapper without the audio sink: its milestone lines would go through the announcer.
    r.hud = new HudMapper(
      this.raceRound,
      players.length,
      HUMAN,
      (id) => {
        const p = this.players.get(id);
        return p ? { name: p.name, color: p.loadout.colors[0] } : null;
      },
      null,
      false,
    );
    r.hud.begin(emoteSlots(human?.loadout.emotes ?? []), false, this.ctx.input.lastDevice, players.length);
    ui.getState().setHud({ controlsHint: false });
    r.view.settleBehindPlayer();
    r.view.followLocal();
    // Hold the countdown (the sim does not step while loading) until the wipe reveals the start line.
    this.stage = 'loading';
    this.after(REVEAL_DELAY, () => this.revealRace());
  }

  private revealRace(): void {
    if (this.stage !== 'loading' || !this.round?.view) return;
    this.stage = 'race';
    revealRound();
    // The coach is on a podium far down the track: his bubble docks bottom-left instead of floating mid-view.
    tutorialUi.setState({ phase: 'race', coachDocked: true });
    this.refreshPrompt();
    this.say(LINES.raceIntro, 'talk');
    this.coachEmote = COACH_EMOTE.jacks;
    this.ctx.audio.game.music.play('candy', { fade: 1 });
    this.ctx.audio.game.music.setIntensity(0.45);
  }

  private tickRace(): void {
    const sim = this.sim;
    if (!sim) return;
    if (sim.phase === RoundPhase.Countdown && sim.time >= 0) {
      sim.setPhase(RoundPhase.Playing, 0);
      this.phase = RoundPhase.Playing;
      ui.getState().setCountdown(null);
      ui.getState().showStamp('go');
      this.ctx.audio.game.music.stinger('roundStart');
      this.ctx.audio.game.music.setIntensity(0.65);
      // The objective card would cover the track behind you once racing starts.
      this.after(2.5, () => {
        if (this.stage !== 'race') return;
        this.racePromptHidden = true;
        tutorialUi.setState({ prompt: null });
      });
    }
    if (sim.getStatus().finished && !this.raceResult) this.onRaceTimeUp();
  }

  private onRaceFinished(place: number): void {
    if (this.stage !== 'race' || this.raceResult) return;
    this.raceResult = { place, of: RACE_BOTS + 1 };
    this.stage = 'raceOver';
    // RoundEnd stops input and the base session's auto-spectate; the camera stays on you.
    this.phase = RoundPhase.RoundEnd;
    this.coachMode = 'podium';
    this.coachEmote = COACH_EMOTE.dance;
    this.say(place === 1 ? LINES.raceWin : LINES.raceFinish, 'cheer');
    this.ctx.audio.game.music.stinger('qualified');
    this.after(3.2, () => this.showReady());
  }

  private onRaceTimeUp(): void {
    if (this.stage !== 'race' || this.raceResult) return;
    this.raceResult = 'timeUp';
    this.stage = 'raceOver';
    // RoundEnd stops input and the base session's auto-spectate; the camera stays on you.
    this.phase = RoundPhase.RoundEnd;
    ui.getState().showStamp('timeUp');
    this.say(LINES.raceTimeUp, 'cheer');
    this.after(2.6, () => this.showReady());
  }

  private showReady(): void {
    if (this.stage !== 'raceOver') return;
    this.stage = 'ready';
    if (!this.completed.includes('race')) this.completed.push('race');
    void grantTutorialReward(this.ctx).then((reward) => {
      if (this.stage !== 'ready') return;
      if (!this.ctx.account?.active) pushMeta(this.ctx.profile);
      this.presentReady(reward);
    });
  }

  private presentReady(reward: Awaited<ReturnType<typeof grantTutorialReward>>): void {
    const res = this.raceResult;
    const raceLine =
      res === 'timeUp' || !res
        ? 'You learned every move. Time for the real thing!'
        : res.place === 1
          ? 'You WON the mini race! Every move learned.'
          : `You finished ${ordinal(res.place)} of ${res.of} in the mini race. Every move learned!`;
    tutorialUi.setState({
      phase: 'ready',
      prompt: null,
      coach: null,
      steps: tutorialUi.getState().steps.map((s) => ({ ...s, state: 'done' })),
      ready: { ...reward, raceLine },
    });
    this.round?.view?.celebrate();
    if (this.autoplay) this.after(4, () => tutorialEvents.emit('readyChoice', { next: 'menu' }));
  }
}

/** Reused per step: the session's input never escapes `step()`. */
const emptyInputScratch: CharacterInput = emptyInput();
