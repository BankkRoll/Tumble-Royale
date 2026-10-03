/**
 * Game-facing audio facade: maps simulation events to spatial SFX, UI/music
 * cue names to actions, round/show phases to music + announcer, and running
 * Tumblers to footsteps. This is the only module the client needs to call.
 *
 * Responsibilities:
 * - `SimEvent` router (local player = 2D and high priority, others spatial and culled by distance)
 * - cue router with warn-once for unknown names (still plays an archetype so nothing is silent)
 * - round lifecycle → music track, stingers, announcer lines, intensity
 * - adaptive intensity from round status (qualified %, time left, survivors)
 * - footstep cadence, local belly-slide loop, obstacle loop emitters
 */

import type { RoundPhaseId, RoundType, ShowPhaseId, ThemeId, Vec3 } from '@tumble/shared';
import { RoundPhase, ShowPhase } from '@tumble/shared';
import { Announcer } from '../announcer/announcer.ts';
import type { AnnouncerOptions } from '../announcer/announcer.ts';
import type { AnnouncerLineId } from '../announcer/lines.ts';
import type { AudioEngine, LoopEmitter, PlayOptions } from '../core/engine.ts';
import { LOCAL_PLAYER_PRIORITY_BONUS, VoicePriority } from '../core/voicePool.ts';
import { MusicSystem } from '../music/sequencer.ts';
import type { MusicTrackId } from '../music/types.ts';
import { OBSTACLE_LOOPS, resolveCue, soundForObstacleCue } from './cues.ts';
import { FOOTSTEP_SOUNDS, FootstepCadence } from './footsteps.ts';
import type { FootSurface } from './footsteps.ts';

// -----------------------------------------------------------------------------
// Event contract
// -----------------------------------------------------------------------------

/**
 * Structural mirror of `SimEvent` from `@tumble/sim/events` (audio may not
 * depend on sim at runtime; keep in sync — the client passes real SimEvents).
 */
export type AudioSimEvent =
  | { type: 'jump'; player: number; pos: Vec3 }
  | { type: 'land'; player: number; pos: Vec3; impact: number }
  | { type: 'dive'; player: number; pos: Vec3 }
  | { type: 'getUp'; player: number }
  | { type: 'stun'; player: number; pos: Vec3; strength: number }
  | { type: 'bounce'; player: number; pos: Vec3; obstacle?: string }
  | { type: 'grabStart'; player: number; target: number; targetKind: 'player' | 'prop' | 'ledge' }
  | { type: 'grabEnd'; player: number; target: number; reason: 'release' | 'broken' | 'stamina' }
  | { type: 'emote'; player: number; emote: number }
  | { type: 'fellOut'; player: number; pos: Vec3 }
  | { type: 'respawn'; player: number; pos: Vec3 }
  | { type: 'checkpoint'; player: number; index: number }
  | { type: 'finish'; player: number; tick: number; subTick: number }
  | { type: 'qualified'; player: number; place: number }
  | { type: 'eliminated'; player: number; place: number }
  | { type: 'tileFell'; obstacle: string; tile: number }
  | { type: 'tileWarn'; obstacle: string; tile: number }
  | { type: 'obstacleCue'; obstacle: string; cue: string; pos: Vec3 }
  | { type: 'teleport'; player: number; from: Vec3; to: Vec3 }
  | { type: 'score'; team: number; player: number; delta: number; total: number }
  | { type: 'propPickup'; player: number; prop: number }
  | { type: 'propDrop'; player: number; prop: number };

/** Anything with a `type`; lets newer sim event kinds pass through without a type error. */
export interface SimEventLike {
  readonly type: string;
}

/** What the router needs to know about an obstacle instance id. */
export interface ObstacleInfo {
  /** `ObstacleType` string, e.g. `bumperPillar`. */
  type?: string;
  /** World position (tile position for tile events). */
  pos?: Vec3;
}

/** Extra context for round phase changes. */
export interface RoundInfo {
  /** 1-based round number in the show. */
  roundNumber?: number;
  /** Display name, read by the announcer on the flyover. */
  roundName?: string;
  theme?: ThemeId;
  /** Final round of the show (also implied by `roundType === 'final'`). */
  isFinal?: boolean;
  /** Override the track choice. */
  track?: MusicTrackId;
  /** Players left after the round (Results). */
  playersRemaining?: number;
}

/** Live round status for adaptive music + announcer milestones (call ~10 Hz). */
export interface RoundAudioStatus {
  roundType: RoundType;
  /** Race: players qualified so far. */
  qualified?: number;
  /** Race: qualification quota. */
  qualifyTarget?: number;
  /** Seconds left on the round timer, if timed. */
  timeLeft?: number;
  /** Survival/final: players still in. */
  alive?: number;
  /** Players at round start. */
  startPlayers?: number;
  /** Local team losing (team rounds). */
  losing?: boolean;
}

/** Options for {@link createGameAudio}. */
export interface GameAudioOptions {
  announcer?: AnnouncerOptions;
  /** Remote one-shots farther than this (m) are skipped before any work. Default 60. */
  maxEventDistance?: number;
  /** Speak "3, 2, 1" on COUNTDOWN (captions always fire). Default true. */
  announceCountdown?: boolean;
}

/** The game audio facade. */
export interface GameAudio {
  readonly engine: AudioEngine;
  readonly music: MusicSystem;
  readonly announcer: Announcer;
  readonly footsteps: FootstepCadence;
  /** Sets which player is "you" (2D, priority, stingers). */
  setLocalPlayer(id: number | null): void;
  /** Positions for events that carry none (grab, getUp, finish…). */
  setPlayerPositionResolver(fn: ((player: number) => Vec3 | undefined) | null): void;
  /** Obstacle type/position lookup for tile events and bounce attribution. */
  setObstacleResolver(fn: ((obstacleId: string, tile?: number) => ObstacleInfo | undefined) | null): void;
  /** Routes one simulation event to sound. */
  handleSimEvent(e: SimEventLike, listenerPos?: Vec3): void;
  /** Routes a batch (e.g. `sink.drain()`). */
  handleSimEvents(events: readonly SimEventLike[], listenerPos?: Vec3): void;
  /** Plays a UI / music / stinger / announcer cue by name. Unknown names warn once and fall back. */
  playCue(name: string, opts?: PlayOptions): void;
  /** Round lifecycle hook. */
  onRoundPhase(phase: RoundPhaseId, roundType: RoundType, info?: RoundInfo): void;
  /** Show lifecycle hook. */
  onShowPhase(phase: ShowPhaseId, info?: { localWon?: boolean; winnerName?: string }): void;
  /** Adaptive music + milestone lines from live round status. */
  updateRoundStatus(status: RoundAudioStatus): void;
  /** Footsteps: call per player per frame; plays a step when the cadence says so. */
  stepFootstep(player: number, speed: number, grounded: boolean, surface: FootSurface, pos: Vec3, dt: number): void;
  /** Starts/stops the belly-slide loop for a player (2D for the local player). */
  setSliding(player: number, sliding: boolean, pos?: Vec3): void;
  /** Creates the pose-driven loop for an obstacle type, or null if it has none. */
  createObstacleLoop(obstacleType: string, pos: Vec3): LoopEmitter | null;
  /** Per-frame update (emitter virtualisation). */
  update(): void;
  dispose(): void;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

/** Music intensity per UI music context (SCREENS.md `music.<context>`). */
const CONTEXT_INTENSITY: Readonly<Record<string, number>> = {
  menu: 0.5,
  matchmaking: 0.1,
  preshow: 0.75,
  rewards: 0.4,
  results: 0.3,
  wall: 0.6,
};

const TYPE_LINES: Readonly<Record<RoundType, AnnouncerLineId>> = {
  race: 'type.race',
  survival: 'type.survival',
  team: 'type.team',
  hunt: 'type.hunt',
  logic: 'type.logic',
  final: 'type.final',
};

/**
 * Picks the music for a round: finals and logic rounds have dedicated tracks,
 * everything else plays its theme.
 *
 * @param roundType - Round type.
 * @param theme - Round theme.
 * @param isFinal - Final round flag.
 * @returns Track id.
 */
export function trackForRound(roundType: RoundType, theme: ThemeId | undefined, isFinal = false): MusicTrackId {
  if (isFinal || roundType === 'final') return 'final';
  if (roundType === 'logic') return 'logic';
  return theme ?? 'candy';
}

/**
 * Adaptive intensity from round status (AUDIO.md §2.5, simplified).
 *
 * @param s - Round status.
 * @returns Intensity 0..1.
 */
export function intensityForStatus(s: RoundAudioStatus): number {
  let i = 0.4;
  if (s.qualified !== undefined && s.qualifyTarget) i = Math.max(i, 0.3 + 0.7 * (s.qualified / s.qualifyTarget));
  if (s.alive !== undefined && s.startPlayers) i = Math.max(i, 0.35 + 0.65 * (1 - s.alive / s.startPlayers));
  if (s.timeLeft !== undefined && s.timeLeft <= 30) i = Math.max(i, 0.75);
  if (s.losing) i = Math.max(i, 0.7);
  if (s.roundType === 'final' && s.alive !== undefined && s.alive <= 3) i = 1;
  return Math.min(1, i);
}

/** Normalises `land.impact`: AUDIO.md treats it as 0..1, but a sim reporting m/s is handled too. */
function normaliseImpact(impact: number): number {
  return impact > 1.5 ? Math.min(1, impact / 14) : Math.max(0, impact);
}

/**
 * Builds the game audio facade on an engine.
 *
 * @param engine - The audio engine.
 * @param opts - Options.
 * @returns The facade.
 * @example
 * const audio = createGameAudio(engine);
 * audio.setLocalPlayer(myId);
 * for (const e of sink.drain()) audio.handleSimEvent(e, camera.position);
 */
export function createGameAudio(engine: AudioEngine, opts: GameAudioOptions = {}): GameAudio {
  const music = new MusicSystem(engine);
  const announcer = new Announcer(engine, opts.announcer);
  const footsteps = new FootstepCadence(64);
  const maxDist = opts.maxEventDistance ?? 60;
  const announceCountdown = opts.announceCountdown ?? true;
  const warned = new Set<string>();
  const slides = new Map<number, LoopEmitter>();
  const countdownTimers: Array<ReturnType<typeof setTimeout>> = [];
  const milestones = new Set<string>();
  const play: PlayOptions = {};

  let local: number | null = null;
  let playerPos: ((p: number) => Vec3 | undefined) | null = null;
  let obstacleInfo: ((id: string, tile?: number) => ObstacleInfo | undefined) | null = null;
  let theme: ThemeId | undefined;

  const clearCountdown = (): void => {
    for (const t of countdownTimers) clearTimeout(t);
    countdownTimers.length = 0;
  };

  const far = (pos: Vec3 | undefined, listener: Vec3 | undefined): boolean => {
    if (!pos || !listener) return false;
    const dx = pos.x - listener.x;
    const dy = pos.y - listener.y;
    const dz = pos.z - listener.z;
    return dx * dx + dy * dy + dz * dz > maxDist * maxDist;
  };

  /** Plays for a player: 2D + priority bonus for the local player, spatial otherwise. `play` is reused to avoid per-event allocation. */
  const sfx = (name: string, player: number | null, pos: Vec3 | undefined, volume = 1, delay = 0, priority?: number): void => {
    const isLocal = player !== null && player === local;
    const def = engine.sfx.def(name);
    play.pos = isLocal ? null : (pos ?? null);
    play.volume = volume;
    play.delay = delay;
    play.priority = priority ?? (def?.priority ?? VoicePriority.Normal) + (isLocal ? LOCAL_PLAYER_PRIORITY_BONUS : 0);
    play.pitch = 0;
    engine.play(name, play);
  };

  const posOf = (player: number): Vec3 | undefined => playerPos?.(player);

  const handle = (raw: SimEventLike, listener?: Vec3): void => {
    // The mirror union matches SimEvent; kinds added to the sim later reach the default branch at runtime.
    const e = raw as AudioSimEvent;
    const isLocal = 'player' in e && e.player === local;
    switch (e.type) {
      case 'jump':
        if (!isLocal && far(e.pos, listener)) return;
        sfx('jump', e.player, e.pos);
        return;
      case 'land': {
        if (!isLocal && far(e.pos, listener)) return;
        const k = normaliseImpact(e.impact);
        sfx(k < 0.35 ? 'land.soft' : 'land.hard', e.player, e.pos, 0.6 + 0.6 * k);
        return;
      }
      case 'dive':
        if (!isLocal && far(e.pos, listener)) return;
        sfx('dive', e.player, e.pos);
        return;
      case 'getUp':
        sfx('getUp', e.player, posOf(e.player), 0.8);
        slides.get(e.player)?.stop(0.12);
        return;
      case 'stun':
        if (!isLocal && far(e.pos, listener)) return;
        sfx('stun', e.player, e.pos, 0.7 + 0.3 * Math.min(1, e.strength));
        if (isLocal || e.strength >= 0.5) sfx('stun.birds', e.player, e.pos, 0.8, 0.25);
        return;
      case 'bounce': {
        if (!isLocal && far(e.pos, listener)) return;
        const type = e.obstacle ? (obstacleInfo?.(e.obstacle)?.type ?? e.obstacle) : '';
        sfx(/bumper/i.test(type) ? 'bumper.boing' : 'bounce.pad', e.player, e.pos);
        return;
      }
      case 'grabStart':
        sfx(e.targetKind === 'prop' ? 'egg.pickup' : 'grab', e.player, posOf(e.player), e.targetKind === 'ledge' ? 0.7 : 1);
        return;
      case 'grabEnd':
        sfx('grab.release', e.player, posOf(e.player), e.reason === 'release' ? 0.6 : 1);
        return;
      case 'emote':
        sfx('emote', e.player, posOf(e.player));
        return;
      case 'fellOut':
        sfx('fallout', e.player, e.pos);
        if (isLocal) sfx('crowd.gasp', null, undefined, 0.7);
        else if (!far(e.pos, listener) && Math.random() < 0.3) sfx('crowd.laugh', null, undefined, 0.4);
        return;
      case 'respawn':
        if (!isLocal && far(e.pos, listener)) return;
        sfx('respawn', e.player, e.pos);
        return;
      case 'checkpoint':
        if (isLocal) sfx('checkpoint', e.player, undefined);
        return;
      case 'finish':
        if (isLocal) {
          sfx('finish.fanfare', e.player, undefined, 1, 0, VoicePriority.Critical);
          sfx('confetti.pop', e.player, undefined, 0.8);
          sfx('crowd.cheer', null, undefined, 0.8, 0.2);
        }
        return;
      case 'qualified':
        if (isLocal) {
          music.stinger('qualified');
          announcer.say('qualified', {}, { priority: 2 });
          sfx('crowd.cheer', null, undefined, 0.7);
        }
        return;
      case 'eliminated':
        if (isLocal) {
          sfx('eliminated.trombone', e.player, undefined, 1, 0, VoicePriority.Critical);
          sfx('crowd.aww', null, undefined, 0.8, 0.4);
          announcer.say('eliminated', {}, { priority: 2 });
          music.setIntensity(0.15);
        }
        return;
      case 'tileWarn':
      case 'tileFell': {
        const info = obstacleInfo?.(e.obstacle, e.tile);
        if (far(info?.pos, listener)) return;
        sfx(e.type === 'tileWarn' ? 'tile.warn' : 'tile.fall', null, info?.pos, info?.pos ? 1 : 0.4);
        if (e.type === 'tileFell') sfx('tile.crack', null, info?.pos, info?.pos ? 0.8 : 0.3);
        return;
      }
      case 'obstacleCue': {
        if (far(e.pos, listener)) return;
        const type = obstacleInfo?.(e.obstacle)?.type;
        sfx(soundForObstacleCue(e.cue, type), null, e.pos);
        return;
      }
      case 'teleport':
        sfx('teleport.zap', e.player, e.from);
        sfx('teleport.zap', e.player, e.to, 1, 0.08);
        return;
      case 'score':
        if (e.delta > 0) {
          sfx('team.horn', null, undefined, 0.8);
          sfx('crowd.cheer', null, undefined, 0.5, 0.1);
        } else if (e.delta < 0) sfx('crowd.aww', null, undefined, 0.5);
        return;
      case 'propPickup':
        sfx('egg.pickup', e.player, posOf(e.player));
        return;
      case 'propDrop':
        sfx('prop.drop', e.player, posOf(e.player));
        return;
      default: {
        // Newer sim event kinds: ignore until mapped (AudioSimEvent mirrors the current union).
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  };

  const say = (line: AnnouncerLineId, vars: Record<string, string | number> = {}, priority = 1): void => {
    announcer.say(line, vars, { priority });
  };

  const api: GameAudio = {
    engine,
    music,
    announcer,
    footsteps,

    setLocalPlayer(id) {
      local = id;
    },

    setPlayerPositionResolver(fn) {
      playerPos = fn;
    },

    setObstacleResolver(fn) {
      obstacleInfo = fn;
    },

    handleSimEvent(e, listenerPos) {
      try {
        handle(e, listenerPos);
      } catch (err) {
        // Audio must never throw into the game loop.
        console.warn('[audio] event handling failed', err);
      }
    },

    handleSimEvents(events, listenerPos) {
      for (const e of events) api.handleSimEvent(e, listenerPos);
    },

    playCue(name, options) {
      const r = resolveCue(name);
      if (!r) return;
      if (r.via === 'archetype' && !warned.has(name)) {
        warned.add(name);
        console.warn(`[audio] unknown cue "${name}" — playing archetype "${r.action.kind === 'sfx' ? r.action.sound : r.action.kind}"`);
      }
      const a = r.action;
      switch (a.kind) {
        case 'sfx':
          engine.play(a.sound, options ?? {});
          return;
        case 'music': {
          music.play(a.track);
          const ctxName = name.startsWith('music.') ? name.slice(6) : name;
          const level = CONTEXT_INTENSITY[ctxName];
          if (level !== undefined) music.setIntensity(level);
          return;
        }
        case 'musicStop':
          music.stop();
          return;
        case 'stinger':
          music.stinger(a.stinger);
          return;
        case 'announce':
          announcer.say(a.line);
          return;
      }
    },

    onRoundPhase(phase, roundType, info = {}) {
      const isFinal = info.isFinal ?? roundType === 'final';
      if (info.theme) theme = info.theme;
      switch (phase) {
        case RoundPhase.Loading:
          clearCountdown();
          milestones.clear();
          return;
        case RoundPhase.IntroFlyover:
          music.setFinal30(false);
          music.setIntensity(0.25);
          music.play(info.track ?? trackForRound(roundType, theme, isFinal), { fade: 1.2 });
          if (isFinal) {
            music.stinger('finalRound');
            say('finalRound', {}, 2);
          } else if (info.roundNumber) say('roundNumber', { n: info.roundNumber }, 2);
          if (info.roundName) announcer.sayText(`${info.roundName}!`, { priority: 2 });
          return;
        case RoundPhase.RulesCard:
          say(TYPE_LINES[roundType]);
          return;
        case RoundPhase.Countdown:
          clearCountdown();
          if (!announceCountdown) return;
          (['countdown.3', 'countdown.2', 'countdown.1'] as const).forEach((line, i) => {
            countdownTimers.push(setTimeout(() => announcer.say(line, {}, { priority: 3, interrupt: true }), i * 1000));
          });
          return;
        case RoundPhase.Playing:
          clearCountdown();
          music.stinger('roundStart');
          music.setIntensity(0.4);
          announcer.say('countdown.go', {}, { priority: 3, interrupt: true });
          return;
        case RoundPhase.Overtime:
          music.setFinal30(true);
          music.stinger('overtime');
          say('overtime', {}, 2);
          return;
        case RoundPhase.RoundEnd:
          clearCountdown();
          music.setFinal30(false);
          music.stinger('roundOver');
          engine.play('round.whistle');
          say('roundOver', {}, 2);
          return;
        case RoundPhase.Results:
          music.play('results', { fade: 1.2 });
          music.setIntensity(0.3);
          if (info.playersRemaining !== undefined) say('playersRemaining', { count: info.playersRemaining });
          return;
        case RoundPhase.Transition:
          music.stinger('nextRound');
          return;
      }
    },

    onShowPhase(phase, info = {}) {
      switch (phase) {
        case ShowPhase.PreShow:
          music.play('lobby');
          music.setIntensity(0.75);
          say('showStart');
          return;
        case ShowPhase.BetweenRounds:
          music.play('results');
          return;
        case ShowPhase.Victory:
          music.stinger('victory');
          music.play('victory', { quantize: 'bar', fade: 1 });
          music.setIntensity(0.8);
          engine.play('crown.shine');
          engine.play('crowd.cheer', { delay: 0.3 });
          if (info.localWon) say('youWin', {}, 3);
          else say('winner', info.winnerName ? { name: info.winnerName } : {}, 3);
          return;
        case ShowPhase.Ended:
          music.play('results');
          music.setIntensity(0.6);
          return;
        case ShowPhase.InRound:
          return;
      }
    },

    updateRoundStatus(status) {
      music.setIntensity(intensityForStatus(status));
      const once = (key: string, line: AnnouncerLineId, extra?: () => void): void => {
        if (milestones.has(key)) return;
        milestones.add(key);
        say(line, {}, 2);
        extra?.();
      };
      if (status.qualified !== undefined && status.qualifyTarget) {
        if (status.qualified >= status.qualifyTarget / 2) once('half', 'halfThrough');
        if (status.qualifyTarget - status.qualified <= 3 && status.qualified < status.qualifyTarget) once('last', 'lastSpots', () => music.stinger('lastSpots'));
      }
      if (status.timeLeft !== undefined) {
        if (status.timeLeft <= 30) {
          music.setFinal30(true);
          once('30', 'thirtySeconds', () => music.stinger('thirtySeconds'));
        }
        if (status.timeLeft <= 10) once('10', 'tenSeconds');
      }
    },

    stepFootstep(player, speed, grounded, surface, pos, dt) {
      if (!footsteps.update(player, speed, grounded, surface, dt)) return;
      const isLocal = player === local;
      if (!isLocal && engine.distanceTo(pos) > 18) return;
      sfx(FOOTSTEP_SOUNDS[surface], player, pos, isLocal ? 0.8 : 0.5);
    },

    setSliding(player, sliding, pos) {
      let em = slides.get(player);
      if (sliding) {
        if (!em) {
          em = engine.createEmitter('slide.loop', { pos: player === local ? null : (pos ?? null), volume: player === local ? 0.8 : 0.6 });
          slides.set(player, em);
        }
        if (pos) em.setPosition(pos.x, pos.y, pos.z);
        if (!em.playing) em.start();
      } else em?.stop(0.12);
    },

    createObstacleLoop(obstacleType, pos) {
      const sound = OBSTACLE_LOOPS[obstacleType];
      return sound ? engine.createEmitter(sound, { pos }) : null;
    },

    update() {
      engine.update();
    },

    dispose() {
      clearCountdown();
      for (const em of slides.values()) em.dispose();
      slides.clear();
      music.dispose();
      announcer.dispose();
    },
  };
  return api;
}
