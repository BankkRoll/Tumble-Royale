/**
 * One show instance: up to 40 players (humans + bots), one MatchSim at a time.
 *
 * Responsibilities:
 * - roster: human joins, bot fill after a wait, resume tokens, idle-while-disconnected;
 * - the authoritative tick: per sim step, feed each player's buffered input
 *   (humans via jitter buffers, bots via injected brains), step the sim, route
 *   SimEvents to the reliable channel and fates to the show controller;
 * - per-client snapshots (delta + interest) at SNAPSHOT_HZ;
 * - delegating show flow to a {@link ShowController} and applying its events;
 * - lag-compensation history ({@link LagCompensator}).
 */
import { randomBytes } from 'node:crypto';
import {
  BitReader,
  BitWriter,
  EntityTable,
  INPUT_REDUNDANCY,
  InputJitterBuffer,
  KickReason,
  MsgType,
  ObstacleTable,
  PROTOCOL_VERSION,
  PositionQuantizer,
  createCharacterFullState,
  createNetRoundStatus,
  decodeReliableMessage,
  encodeReliableMessage,
  readInputBatch,
  readPing,
  simTickOf,
  writeKick,
  writePong,
  writeWelcome,
  type HelloMsg,
  type InputBatchHeader,
  type KickReasonId,
  type LowFreqMessage,
  type MatchPlayerInfo,
  type MatchSim,
  type NetPlayerInfo,
  type NetRoundStatus,
  type PlayerRewardMsg,
  type RoundStatus,
  type SnapshotFrame,
} from '@tumble/netcode';
import type { CharacterInput, SimEvent } from '@tumble/sim';
import { assignBotSkills, assignShowParties, lobbySpawnPoint } from '@tumble/sim/show';
import {
  MAX_PLAYERS,
  RoundPhase,
  SERVER_TICK_HZ,
  SIM_STEPS_PER_TICK,
  ShowPhase,
  type RoundDefinition,
  type Vec3,
} from '@tumble/shared';
import { BodyMonitor, InputRateMonitor, type AnomalyKind } from '../anomaly.ts';
import { InputSequenceGuard, sanitizeChat, sanitizeName } from '../antiCheat.ts';
import { createLobbyWanderBot } from '../bots/lobbyWanderBot.ts';
import { HitAssist } from '../hitAssist.ts';
import { LagCompensator } from '../lagcomp.ts';
import type { ServerMetrics } from '../metrics.ts';
import {
  computePlacements,
  type MatchResultPayload,
  type PlayerStatsCounters,
  type ResultRound,
} from '../results.ts';
import type { JoinTicketClaims } from '../tickets.ts';
import type { ClientSession } from './session.ts';
import type {
  MatchSettings,
  RoomConfig,
  RoomDeps,
  ServerBotBrain,
  ShowController,
  ShowEvent,
  ShowRoundPlan,
} from './types.ts';

/** Lifecycle of a room. */
export type RoomState = 'lobby' | 'show' | 'ended' | 'closed';

/** A player in the room, human or bot. Survives reconnects. */
interface PlayerSlot {
  id: number;
  name: string;
  isBot: boolean;
  loadout: string;
  token: string;
  session: ClientSession | null;
  disconnectedAt: number;
  /** Left for good (resume window expired); kept for results. */
  left: boolean;
  /** Joined after the show started: watches only. */
  spectator: boolean;
  jitter: InputJitterBuffer;
  seqGuard: InputSequenceGuard;
  brain: ServerBotBrain | null;
  lastYaw: number;
  /** Account id from the join ticket (null for bots and unticketed dev joins). */
  userId: string | null;
  /** Action counters for challenge progress. */
  stats: PlayerStatsCounters;
  /** Who this human queued with: matchmaker team, else party id (null for solos and bots). */
  partyKey: string | null;
  /** Show party (duos/squads), -1 when solo. Fixed when the show starts. */
  partyId: number;
  /** Bot skill tier (bots only). */
  botSkill: 'clumsy' | 'average' | 'sharp' | undefined;
  /** A seat held for a ticketed human who has not arrived yet (see {@link RoomConfig.lateJoinGraceMs}). */
  reserved: boolean;
  /** Bot brain on the pre-show platform. */
  lobbyBrain: ServerBotBrain | null;
  /** The input the sim consumed for this player on the latest step (hit assist). */
  lastInput: CharacterInput;
  /** Input-flood / sequence anomaly tracking. */
  inputRate: InputRateMonitor;
}

/** A finished round as reported to the API. */
interface RoundRecord extends ResultRound {
  entrants: number[];
  qualifiedIds: number[];
}

/** A fresh slot with every per-player helper allocated. */
function newSlot(
  init: Pick<PlayerSlot, 'id' | 'name' | 'isBot' | 'userId' | 'loadout' | 'token' | 'session' | 'spectator'>,
): PlayerSlot {
  return {
    ...init,
    stats: newStats(),
    disconnectedAt: -1,
    left: false,
    jitter: new InputJitterBuffer(),
    seqGuard: new InputSequenceGuard(),
    brain: null,
    lastYaw: 0,
    partyKey: null,
    partyId: -1,
    botSkill: undefined,
    reserved: false,
    lobbyBrain: null,
    lastInput: { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 },
    inputRate: new InputRateMonitor(),
  };
}

/** Party key for a ticketed human: the matchmaker's in-show team, else their queue party. */
function partyKeyOf(ticket: JoinTicketClaims | null): string | null {
  if (!ticket) return null;
  if (ticket.team !== null) return `team:${ticket.team}`;
  return ticket.pid && !ticket.pid.startsWith('solo:') ? `party:${ticket.pid}` : null;
}

/** Drop-in height above the lobby platform for joiners (they fall onto it). */
const LOBBY_DROP_HEIGHT = 4;

const newStats = (): PlayerStatsCounters => ({
  jumps: 0,
  dives: 0,
  grabs: 0,
  checkpoints: 0,
  bounces: 0,
  emotes: 0,
});

/** Sim events that count toward a player's challenge stats. */
const STAT_EVENTS: Partial<Record<SimEvent['type'], keyof PlayerStatsCounters>> = {
  jump: 'jumps',
  dive: 'dives',
  grabStart: 'grabs',
  checkpoint: 'checkpoints',
  bounce: 'bounces',
  emote: 'emotes',
};

/** Summary for `/rooms`. */
export interface RoomInfo {
  id: string;
  state: RoomState;
  humans: number;
  connected: number;
  bots: number;
  serverTick: number;
  round: string | null;
  epoch: number;
}

const SPECTATOR_ID_BASE = 64;
const BOT_NAMES_A = [
  'Bouncy',
  'Wobbly',
  'Zippy',
  'Fizzy',
  'Jelly',
  'Sprinkle',
  'Bubbly',
  'Gummy',
  'Snappy',
  'Dizzy',
  'Puffy',
  'Squishy',
];
const BOT_NAMES_B = [
  'Tumbler',
  'Noodle',
  'Pebble',
  'Muffin',
  'Biscuit',
  'Comet',
  'Pickle',
  'Waffle',
  'Sprout',
  'Button',
  'Marble',
  'Turnip',
];

/**
 * Authoritative room.
 *
 * @example
 * const room = new Room('r1', deps, config, metrics, () => scheduler.dueTime(0));
 * room.join(session, hello);   // from RoomManager on Hello
 * room.tick(now);              // 30 Hz from the shared scheduler
 */
export class Room {
  state: RoomState = 'lobby';
  /** Network ticks since the room was created. */
  serverTick = 0;
  /** Lag-compensation history (global sim ticks, see {@link simTickNow}). */
  readonly lagComp = new LagCompensator();

  private readonly slots = new Map<number, PlayerSlot>();
  private readonly sessions = new Set<ClientSession>();
  private readonly show: ShowController;
  private sim: MatchSim | null = null;
  private round: RoundDefinition | null = null;
  private quantizer: PositionQuantizer | null = null;
  private obstacles = new ObstacleTable([]);
  private roundPlayers: number[] = [];
  private epoch = 0;
  private snapshotId = 0;
  private firstJoinAt = -1;
  private endedAt = -1;
  private emptySince = -1;
  private lastLobbyBroadcast = 0;
  private status: RoundStatus | null = null;

  private readonly entities = new EntityTable();
  private readonly netStatus: NetRoundStatus = createNetRoundStatus();
  private readonly leaders = new Int32Array(3).fill(-1);
  private readonly frame: SnapshotFrame;
  private readonly writer = new BitWriter(4096);
  private readonly reader = new BitReader();
  private readonly scratchState = createCharacterFullState();
  private readonly scratchInput: CharacterInput = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
  private readonly batchInputs: CharacterInput[] = Array.from({ length: INPUT_REDUNDANCY }, () => ({
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    buttons: 0,
    emote: 0,
  }));
  private readonly batchHeader: InputBatchHeader = {
    newestSeq: 0,
    clientTick: 0,
    ackSnapshotId: -1,
    count: 0,
  };
  private readonly presentPlayers = new Set<number>();
  private readonly log: (msg: string) => void;
  private readonly config: RoomConfig;
  private roundIndex = -1;
  private roundStartedAt = 0;
  private showStartedAtWall = 0;
  private readonly roundRecords: RoundRecord[] = [];
  private currentPlan: ShowRoundPlan | null = null;
  /** Rewards per user id once the API answered (replayed to late reconnects). */
  private readonly rewardsByUser = new Map<string, Record<string, unknown> | null>();
  private rewardsDone = false;
  /** The running sim is the pre-show platform, not a show round. */
  private lobbyActive = false;
  /** Server tick at which the pre-show countdown ends (-1 before the show starts). */
  private preShowEndTick = -1;
  /** Held seats of absent ticketed humans forfeit after this time (ms); -1 while round 1 has not started. */
  private reservedUntil = -1;
  /** Lag-compensated grab/dive assist (see hitAssist.ts). */
  readonly hitAssist = new HitAssist(this.lagComp, createCharacterFullState);
  private readonly bodies = new BodyMonitor();
  private readonly lastAnomalyLog = new Map<AnomalyKind, number>();
  private readonly lobbyFeet: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * @param id - Room id.
   * @param deps - Injected collaborators.
   * @param config - Tuning.
   * @param metrics - Process metrics.
   * @param tickEpochMs - Server clock (ms) at which this room's tick 0 was due.
   * @param match - Matchmade show settings from the join tickets; null for an unticketed dev room.
   */
  constructor(
    readonly id: string,
    private readonly deps: RoomDeps,
    config: RoomConfig,
    private readonly metrics: ServerMetrics,
    private readonly tickEpochMs: () => number,
    readonly match: MatchSettings | null = null,
  ) {
    this.config = match
      ? {
          ...config,
          capacity: Math.max(1, Math.min(MAX_PLAYERS, match.humans + match.bots)),
          startAtHumans: Math.max(1, match.humans),
          fillWaitMs: config.ticketedFillWaitMs,
        }
      : config;
    this.show = deps.createShowController({ roomId: id, match });
    this.log = deps.log ?? (() => {});
    this.frame = {
      snapshotId: 0,
      serverTick: 0,
      epoch: 0,
      matchTime: 0,
      entities: this.entities,
      obstacles: this.obstacles,
      status: this.netStatus,
      leaders: this.leaders,
      quantizer: new PositionQuantizer({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } }),
    };
  }

  /** Global sim tick of the room's current state (lag-compensation timeline). */
  get simTickNow(): number {
    return simTickOf(this.serverTick);
  }

  /** The running sim, if any (tests, tools, lag-comp consumers). */
  get matchSim(): MatchSim | null {
    return this.sim;
  }

  /** Connected human sessions. */
  get connectedCount(): number {
    return this.sessions.size;
  }

  /** Humans in the roster (connected or resumable). */
  get humanCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (!s.isBot && !s.left && !s.spectator) n++;
    return n;
  }

  /** True when a new unticketed human can join as a player (dev rooms only). */
  canAcceptPlayer(): boolean {
    return this.match === null && this.state === 'lobby' && this.humanCount < this.config.capacity;
  }

  /** The slot id a ticketed account already holds here (rejoin after a reload), or -1. */
  slotOfUser(userId: string): number {
    for (const s of this.slots.values()) if (s.userId === userId && !s.left) return s.id;
    return -1;
  }

  /**
   * Reattaches a ticketed account to its existing slot (a reload lost the
   * resume token, but the ticket still proves who it is).
   *
   * @returns False when the account has no live slot here.
   */
  rejoinUser(session: ClientSession, userId: string): boolean {
    const id = this.slotOfUser(userId);
    const slot = id >= 0 ? this.slots.get(id) : undefined;
    return slot ? this.resume(session, slot.token) : false;
  }

  /** True when the room can take a spectator. */
  canAcceptSpectator(): boolean {
    return this.state === 'show' && this.slots.size < 255 - SPECTATOR_ID_BASE;
  }

  /** Room summary. */
  info(): RoomInfo {
    let bots = 0;
    for (const s of this.slots.values()) if (s.isBot) bots++;
    return {
      id: this.id,
      state: this.state,
      humans: this.humanCount,
      connected: this.sessions.size,
      bots,
      serverTick: this.serverTick,
      round: this.round?.id ?? null,
      epoch: this.epoch,
    };
  }

  /** RTT estimates of connected sessions (ms), for metrics. */
  sessionRtts(): number[] {
    const out: number[] = [];
    for (const s of this.sessions) out.push(s.rttMs);
    return out;
  }

  /** Sums and resets the jitter-buffer miss/late counters of all human slots. */
  takeInputStats(): { missed: number; late: number } {
    let missed = 0;
    let late = 0;
    for (const s of this.slots.values()) {
      missed += s.jitter.missed;
      late += s.jitter.late;
      s.jitter.missed = 0;
      s.jitter.late = 0;
    }
    return { missed, late };
  }

  /** Finds a resumable slot by token. */
  hasToken(token: string): boolean {
    for (const s of this.slots.values()) if (s.token === token && !s.left) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Adds a new human (player in the lobby, spectator during a show).
   *
   * @returns The assigned player id.
   */
  join(session: ClientSession, hello: HelloMsg, now: number, ticket: JoinTicketClaims | null = null): number {
    // Ticketed names come from the account (`name#tag`); the tag stays off the nameplate.
    const name = ticket ? sanitizeName(ticket.name.replace(/#\d+$/, '')) : sanitizeName(hello.name);
    const held = this.state === 'show' && ticket?.role === 'player' ? this.heldSeatFor(ticket) : null;
    if (held) {
      held.reserved = false;
      held.name = name;
      held.userId = ticket!.sub;
      held.loadout = hello.loadout.slice(0, 255);
      held.session = session;
      this.enterLobby(held);
      this.attach(session, held, false);
      this.log(`[room ${this.id}] ${name} took held seat ${held.id} after the show started`);
      return held.id;
    }
    const spectator = this.state !== 'lobby' || ticket?.role === 'spectator';
    const id = this.allocateId(spectator);
    const slot = newSlot({
      id,
      name,
      userId: ticket?.sub ?? null,
      isBot: false,
      loadout: hello.loadout.slice(0, 255),
      token: randomBytes(18).toString('base64url'),
      session,
      spectator,
    });
    slot.partyKey = partyKeyOf(ticket);
    this.slots.set(id, slot);
    if (this.firstJoinAt < 0) this.firstJoinAt = now;
    if (!spectator) this.enterLobby(slot);
    this.attach(session, slot, false);
    this.log(`[room ${this.id}] ${slot.name} joined as ${spectator ? 'spectator' : 'player'} ${id}`);
    return id;
  }

  /**
   * A seat held for this ticketed human: one reserved for their matchmaker
   * party first, else any. Only until the late-join grace runs out.
   */
  private heldSeatFor(ticket: JoinTicketClaims): PlayerSlot | null {
    const key = partyKeyOf(ticket);
    let any: PlayerSlot | null = null;
    for (const s of this.slots.values()) {
      if (!s.reserved || s.left) continue;
      if (key !== null && s.partyKey === key) return s;
      if (!any && (s.partyKey === null || key === null)) any = s;
    }
    return any;
  }

  /**
   * Reattaches a reconnecting client to its slot.
   *
   * @returns False if the token is unknown or expired.
   */
  resume(session: ClientSession, token: string): boolean {
    for (const slot of this.slots.values()) {
      if (slot.token !== token || slot.left) continue;
      if (slot.session && slot.session !== session) this.detach(slot.session, 'replaced');
      slot.jitter.reset();
      slot.seqGuard.reset();
      slot.inputRate.resetSeq();
      slot.disconnectedAt = -1;
      this.attach(session, slot, true);
      this.log(`[room ${this.id}] ${slot.name} resumed player ${slot.id}`);
      return true;
    }
    return false;
  }

  /** Routes one inbound message from a joined session. */
  onMessage(session: ClientSession, data: Uint8Array, now: number): void {
    if (!session.guard.admit(now, data.length)) {
      this.metrics.rateLimited++;
      if (session.guard.violation(now)) this.kick(session, KickReason.RateLimited, 'rate limited');
      return;
    }
    const slot = this.slots.get(session.playerId);
    if (!slot || slot.session !== session) return;
    const r = this.reader.reset(data);
    const type = r.readBits(8);
    switch (type) {
      case MsgType.InputBatch:
        this.onInputBatch(session, slot, r, now);
        return;
      case MsgType.Reliable:
        if (!session.reliable.receive(r, (p) => this.onReliable(session, slot, p, now)))
          this.violation(session, now);
        return;
      case MsgType.Ping: {
        const t0 = readPing(r);
        if (r.overflow) return this.violation(session, now);
        const w = this.writer.reset();
        writePong(w, t0, now, now);
        session.conn.send(w.finish().slice());
        return;
      }
      case MsgType.Hello:
        // Our Welcome was lost (conditioned link) or the client retried: answer again.
        this.sendWelcome(session, slot, false);
        return;
      default:
        this.violation(session, now);
    }
  }

  /** Called when a session's connection closes. */
  onClose(session: ClientSession, now: number): void {
    this.sessions.delete(session);
    const slot = this.slots.get(session.playerId);
    if (!slot || slot.session !== session) return;
    slot.session = null;
    if (slot.spectator) {
      this.slots.delete(slot.id);
      return;
    }
    slot.disconnectedAt = now;
    slot.jitter.reset();
    slot.jitter.setIdle(slot.lastYaw);
    this.log(
      `[room ${this.id}] player ${slot.id} disconnected (resumable for ${this.config.resumeWindowMs / 1000}s)`,
    );
    this.broadcastPlayerList();
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  /**
   * Runs one 30 Hz network tick.
   *
   * @param now - Current server time (ms).
   */
  tick(now: number): void {
    if (this.state === 'closed') return;
    const t0 = performance.now();
    this.serverTick++;
    this.updateRoster(now);

    let simMs = 0;
    if (this.sim) {
      const ts = performance.now();
      for (let s = 0; s < SIM_STEPS_PER_TICK; s++) {
        const simTick = simTickOf(this.serverTick - 1) + s + 1;
        this.applyInputs(this.sim);
        this.sim.step();
        this.routeSimEvents(this.sim, simTick);
        this.assistHits(this.sim, simTick);
      }
      simMs = performance.now() - ts;
      this.recordHistory(this.sim, now);
      // The director runs on round status; the lobby platform has none to report.
      this.status = this.lobbyActive ? null : this.sim.getStatus();
    } else {
      this.status = null;
    }

    this.presentPlayers.clear();
    for (const s of this.slots.values()) if (!s.left && !s.spectator) this.presentPlayers.add(s.id);
    this.show.onTick(1 / SERVER_TICK_HZ, { status: this.status, presentPlayers: this.presentPlayers });
    this.applyShowEvents(this.show.drainEvents(), now);

    const tSnap = performance.now();
    const every = this.config.snapshotEvery * (this.lobbyActive ? this.config.lobbySnapshotDivisor : 1);
    if (this.sim && this.serverTick % Math.max(1, every) === 0) this.sendSnapshots(this.sim, now);
    const tSend = performance.now();
    this.flushReliable(now);
    const tEnd = performance.now();

    if (this.sim || this.sessions.size > 0) {
      this.metrics.tick.sim.add(simMs);
      this.metrics.tick.snapshot.add(tSend - tSnap);
      this.metrics.tick.send.add(tEnd - tSend);
      this.metrics.tick.total.add(tEnd - t0);
    }
  }

  /** Closes every session and disposes the sim. */
  dispose(): void {
    for (const s of [...this.sessions]) this.kick(s, KickReason.Shutdown, 'room closed');
    this.sim?.dispose();
    this.sim = null;
    this.state = 'closed';
  }

  // ---------------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------------

  private updateRoster(now: number): void {
    for (const slot of this.slots.values()) {
      if (slot.isBot || slot.left || slot.session || slot.disconnectedAt < 0) continue;
      if (now - slot.disconnectedAt < this.config.resumeWindowMs) continue;
      // Until then the Tumbler idles on the platform, so a resume never flashes a despawn.
      this.leaveLobby(slot.id);
      if (this.state === 'lobby') {
        this.slots.delete(slot.id);
      } else {
        slot.left = true;
        // The real sim eliminates forfeiting players at once; the contract makes it optional.
        (this.sim as { forfeit?: (id: number) => void } | null)?.forfeit?.(slot.id);
        this.show.onPlayerLeft(slot.id);
      }
      this.log(`[room ${this.id}] player ${slot.id} resume window expired`);
      this.broadcastPlayerList();
    }

    if (this.reservedUntil >= 0 && now >= this.reservedUntil) {
      this.reservedUntil = -1;
      for (const slot of this.slots.values()) {
        if (!slot.reserved || slot.left) continue;
        // Never showed up: the seat forfeits like a quitter (the director eliminates it).
        slot.left = true;
        slot.reserved = false;
        (this.sim as { forfeit?: (id: number) => void } | null)?.forfeit?.(slot.id);
        this.show.onPlayerLeft(slot.id);
        this.log(`[room ${this.id}] held seat ${slot.id} released (ticketed player never arrived)`);
      }
      this.broadcastPlayerList();
    }

    if (this.state === 'lobby') {
      const humans = this.humanCount;
      if (humans === 0) {
        this.firstJoinAt = -1;
      } else if (
        now - this.firstJoinAt >= this.config.fillWaitMs ||
        humans >= Math.min(this.config.startAtHumans, this.config.capacity)
      ) {
        this.startShow();
      } else if (now - this.lastLobbyBroadcast >= 1000) {
        this.lastLobbyBroadcast = now;
        this.broadcast({
          t: 'lobby',
          humans,
          capacity: this.config.capacity,
          startsInMs: Math.max(0, this.config.fillWaitMs - (now - this.firstJoinAt)),
        });
      }
    }

    let anyHuman = this.sessions.size > 0;
    if (!anyHuman)
      for (const s of this.slots.values()) if (!s.isBot && !s.left && s.disconnectedAt >= 0) anyHuman = true;
    if (anyHuman) this.emptySince = -1;
    else if (this.emptySince < 0) this.emptySince = now;
    const idle =
      this.state !== 'lobby' && this.emptySince >= 0 && now - this.emptySince > this.config.idleCloseMs;
    const over = this.state === 'ended' && now - this.endedAt > this.config.idleCloseMs;
    if (
      idle ||
      over ||
      (this.state === 'lobby' && this.slots.size === 0 && this.serverTick > SERVER_TICK_HZ * 60)
    ) {
      this.log(`[room ${this.id}] closing (${over ? 'show over' : 'empty'})`);
      this.dispose();
    }
  }

  private startShow(): void {
    this.state = 'show';
    const seed = this.deps.randomSeed();
    const partySize = Math.max(1, this.show.partySize ?? this.match?.teamSize ?? 1);
    const held = this.holdSeats(partySize);
    let botIndex = 0;
    const bots: PlayerSlot[] = [];
    while (this.humanCount + botIndex < this.config.capacity) {
      const id = this.allocateId(false);
      if (id < 0) break;
      const name = `${BOT_NAMES_A[(seed + botIndex * 7) % BOT_NAMES_A.length]} ${BOT_NAMES_B[(seed >>> 3) % BOT_NAMES_B.length]!.slice(0, 1)}${botIndex}`;
      const slot = newSlot({
        id,
        name,
        userId: null,
        isBot: true,
        loadout: '',
        token: '',
        session: null,
        spectator: false,
      });
      this.slots.set(id, slot);
      bots.push(slot);
      botIndex++;
    }
    // Same seeded tiers from the playlist's mix as the offline runner (Chaos Mode, First Show…).
    const skills = assignBotSkills(
      seed,
      bots.length,
      this.show.botSkillMix ?? { clumsy: 1, average: 2, sharp: 1 },
    );
    bots.forEach((b, i) => (b.botSkill = skills[i]));
    const seats = [...this.slots.values()]
      .filter((s) => !s.spectator && !s.left)
      .map((s) => ({ id: s.id, isBot: s.isBot, partyKey: s.partyKey }));
    const parties = assignShowParties(seats, partySize);
    for (const s of this.slots.values()) s.partyId = parties.get(s.id) ?? -1;
    const roster = this.roster();
    for (const info of roster) {
      const slot = this.slots.get(info.id)!;
      if (slot.isBot && this.deps.createBot) slot.brain = this.deps.createBot(info, seed);
      if (slot.isBot) {
        slot.lobbyBrain = createLobbyWanderBot(info, seed);
        this.enterLobby(slot);
      }
    }
    this.log(
      `[room ${this.id}] show starting: ${this.humanCount - held} humans (+${held} held seats) + ${botIndex} bots`,
    );
    this.showStartedAtWall = Date.now();
    this.preShowEndTick = this.serverTick + Math.round((this.show.preShowSeconds ?? 10) * SERVER_TICK_HZ);
    this.broadcastPlayerList();
    this.broadcastShowInfo();
    this.broadcast(this.preShowPhase());
    this.show.start(roster, seed);
  }

  /**
   * Holds seats for ticketed humans the matchmaker placed here who have not
   * connected yet (slow loads, a reload during matchmaking), so the show does
   * not fill them with bots and they can still walk in before round 1.
   * A held seat inherits the party of a queued group that is a member short.
   *
   * @returns Seats held.
   */
  private holdSeats(partySize: number): number {
    const m = this.match;
    if (!m) return 0;
    const missing = Math.min(this.config.capacity, m.humans) - this.humanCount;
    if (missing <= 0) return 0;
    const short: string[] = [];
    if (partySize > 1) {
      const sizes = new Map<string, number>();
      for (const s of this.slots.values())
        if (!s.isBot && !s.spectator && s.partyKey) sizes.set(s.partyKey, (sizes.get(s.partyKey) ?? 0) + 1);
      for (const [key, n] of sizes) for (let k = n; k < partySize; k++) short.push(key);
    }
    let held = 0;
    for (let i = 0; i < missing; i++) {
      const id = this.allocateId(false);
      if (id < 0) break;
      const slot = newSlot({
        id,
        name: 'Tumbler',
        userId: null,
        isBot: false,
        loadout: '',
        token: randomBytes(18).toString('base64url'),
        session: null,
        spectator: false,
      });
      slot.reserved = true;
      slot.partyKey = short.shift() ?? null;
      this.slots.set(id, slot);
      held++;
    }
    return held;
  }

  /** The pre-show phase with the countdown left (for the show start and late joiners). */
  private preShowPhase(): LowFreqMessage {
    const ticks = Math.max(0, this.preShowEndTick - this.serverTick);
    return {
      t: 'showPhase',
      phase: ShowPhase.PreShow,
      startsInMs: Math.round((ticks * 1000) / SERVER_TICK_HZ),
    };
  }

  private roster(): MatchPlayerInfo[] {
    const out: MatchPlayerInfo[] = [];
    for (const s of this.slots.values()) {
      if (s.spectator) continue;
      const info: MatchPlayerInfo = { id: s.id, name: s.name, isBot: s.isBot, team: -1 };
      if (s.isBot) info.botSkill = s.botSkill ?? 'average';
      if (s.partyId >= 0) info.partyId = s.partyId;
      out.push(info);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------------------------
  // Pre-show platform
  // ---------------------------------------------------------------------------

  /**
   * Puts a player on the live pre-show platform, starting the lobby sim with
   * the first one. They drop in from above at a spot fixed by their id.
   */
  private enterLobby(slot: PlayerSlot): void {
    const round = this.deps.lobbyRound;
    if (!round || slot.spectator || slot.reserved) return;
    if (this.sim && !this.lobbyActive) return;
    if (!this.sim) {
      if (this.roundIndex >= 0) return;
      this.startLobby(round);
    }
    const sim = this.sim!;
    if (this.roundPlayers.includes(slot.id)) return;
    const feet = lobbySpawnPoint(slot.id, this.lobbyFeet);
    feet.y += LOBBY_DROP_HEIGHT;
    // The server sim drives bots through lobby brains, so everyone enters it as a "human".
    const info: MatchPlayerInfo = { id: slot.id, name: slot.name, isBot: false, team: -1 };
    if (!sim.addPlayer?.(info, feet, Math.atan2(-feet.x, -feet.z))) return;
    this.roundPlayers.push(slot.id);
    this.bodies.forget(slot.id);
  }

  /** Takes a player off the platform (left for good); grabs involving them break. */
  private leaveLobby(id: number): void {
    if (!this.lobbyActive || !this.sim) return;
    const i = this.roundPlayers.indexOf(id);
    if (i < 0) return;
    this.sim.removePlayer?.(id);
    this.roundPlayers.splice(i, 1);
    this.bodies.forget(id);
  }

  private startLobby(round: RoundDefinition): void {
    const sim = this.deps.createMatchSim({
      R: this.deps.R,
      round,
      seed: 0,
      stage: 0,
      players: [],
      mode: 'authority',
      lobby: true,
    });
    sim.setPhase(RoundPhase.Playing, 0);
    this.lobbyActive = true;
    this.installSim(sim, round, []);
    this.currentPlan = null;
    this.log(`[room ${this.id}] pre-show platform live, epoch ${this.epoch}`);
  }

  private allocateId(spectator: boolean): number {
    const lo = spectator ? SPECTATOR_ID_BASE : 0;
    const hi = spectator ? 255 : Math.min(MAX_PLAYERS, SPECTATOR_ID_BASE);
    for (let id = lo; id < hi; id++) if (!this.slots.has(id)) return id;
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Inputs & events
  // ---------------------------------------------------------------------------

  private applyInputs(sim: MatchSim): void {
    const input = this.scratchInput;
    for (const id of this.roundPlayers) {
      const slot = this.slots.get(id);
      if (!slot) continue;
      if (slot.isBot) {
        const brain = this.lobbyActive ? slot.lobbyBrain : slot.brain;
        if (brain) {
          brain.think(sim, id, input);
          sim.setInput(id, input);
        }
        continue;
      }
      const seq = slot.jitter.next(input);
      if (seq >= 0) slot.lastYaw = input.yaw;
      sim.setInput(id, input);
      const last = slot.lastInput;
      last.moveX = input.moveX;
      last.moveZ = input.moveZ;
      last.yaw = input.yaw;
      last.buttons = input.buttons;
      last.emote = input.emote;
    }
  }

  /** Lag-compensated grab/dive assist for every connected human after a step. */
  private assistHits(sim: MatchSim, simTick: number): void {
    if (!sim.assistGrab && !sim.assistTackle) return;
    const c = this.hitAssist.counters;
    const grabs = c.grabs;
    const tackles = c.tackles;
    for (const id of this.roundPlayers) {
      const slot = this.slots.get(id);
      if (!slot || slot.isBot || !slot.session) continue;
      this.hitAssist.afterStep(sim, id, slot.lastInput, this.roundPlayers, simTick, slot.session.rttMs);
    }
    if (c.grabs === grabs && c.tackles === tackles) return;
    this.metrics.lagCompGrabs += c.grabs - grabs;
    this.metrics.lagCompTackles += c.tackles - tackles;
    // Assisted grabs emit grabStart on the sim; route it with this step.
    this.routeSimEvents(sim, simTick);
  }

  /**
   * Once per network tick: pose history for lag compensation and the body
   * sanity check (both after the tick's sim steps).
   */
  private recordHistory(sim: MatchSim, now: number): void {
    const st = this.scratchState;
    this.lagComp.begin(simTickOf(this.serverTick));
    for (const id of this.roundPlayers) {
      if (!sim.getPlayerState(id, st)) continue;
      this.lagComp.add(id, st.pos, st.rot);
      const kind = this.bodies.observe(id, st.pos, 1 / SERVER_TICK_HZ);
      if (kind)
        this.anomaly(
          kind,
          now,
          `player ${id} at (${st.pos.x.toFixed(1)}, ${st.pos.y.toFixed(1)}, ${st.pos.z.toFixed(1)})`,
        );
    }
  }

  /** Counts an anomaly and logs it (at most once per kind per 10 s per room). */
  private anomaly(kind: AnomalyKind, now: number, detail: string): void {
    this.metrics.anomalies[kind]++;
    const last = this.lastAnomalyLog.get(kind) ?? -Infinity;
    if (now - last < 10_000) return;
    this.lastAnomalyLog.set(kind, now);
    this.log(`[room ${this.id}] anomaly ${kind}: ${detail} (round ${this.round?.id ?? '-'})`);
  }

  private routeSimEvents(sim: MatchSim, simTick: number): void {
    const events = sim.events.drain();
    for (const e of events) {
      if (e.type === 'qualified') this.show.onPlayerFate(e.player, 1, e.place);
      else if (e.type === 'eliminated') this.show.onPlayerFate(e.player, 2, e.place);
      else if (e.type === 'teleport' || e.type === 'respawn' || e.type === 'fellOut')
        this.bodies.exempt(e.player);
      const stat = STAT_EVENTS[e.type];
      // Warm-up antics on the pre-show platform don't count toward challenges.
      if (stat && 'player' in e && !this.lobbyActive) {
        const slot = this.slots.get(e.player);
        if (slot && !slot.isBot) slot.stats[stat]++;
      }
      this.broadcastEvent(e, simTick);
    }
  }

  private broadcastEvent(event: SimEvent, simTick: number): void {
    if (this.sessions.size === 0) return;
    const payload = encodeReliableMessage({ kind: 'sim', tick: simTick, event });
    for (const s of this.sessions) s.reliable.send(payload);
  }

  private onInputBatch(session: ClientSession, slot: PlayerSlot, r: BitReader, now: number): void {
    const h = readInputBatch(r, this.batchInputs, this.batchHeader);
    if (r.overflow) return this.violation(session, now);
    session.onSnapshotAck(h.ackSnapshotId, now);
    if (slot.inputRate.note(now))
      this.anomaly('input_flood', now, `player ${slot.id} sent > 120 input batches/s`);
    if (h.count === 0 || slot.spectator) return;
    if (slot.inputRate.noteSeq(h.newestSeq)) {
      // Clients keep one sequence for the whole session; a rewind means a restarted or forged stream.
      this.anomaly('input_seq_rewind', now, `player ${slot.id} input seq rewound to ${h.newestSeq}`);
      slot.jitter.reset();
      slot.seqGuard.reset();
    }
    if (!slot.seqGuard.check(h.newestSeq, now)) {
      this.metrics.rateLimited++;
      this.anomaly('input_seq_ahead', now, `player ${slot.id} input seq ${h.newestSeq} ahead of the clock`);
      return this.violation(session, now);
    }
    // Oldest first, so arrival-time jitter tracking sees sequences in order.
    for (let i = h.count - 1; i >= 0; i--) {
      const input = this.batchInputs[i]!;
      if (input.emote > 4) {
        this.anomaly('input_bad_emote', now, `player ${slot.id} sent emote slot ${input.emote}`);
        input.emote = 0;
      }
      slot.jitter.push(h.newestSeq - i, input, now);
    }
  }

  private onReliable(session: ClientSession, slot: PlayerSlot, payload: Uint8Array, now: number): void {
    const m = decodeReliableMessage(payload);
    // Clients may only send low-frequency messages; SimEvents are server-authored.
    if (!m || m.kind !== 'msg') return this.violation(session, now);
    this.onLowFreq(session, slot, m.msg, now);
  }

  private onLowFreq(session: ClientSession, slot: PlayerSlot, msg: LowFreqMessage, now: number): void {
    switch (msg.t) {
      case 'chat': {
        const text = sanitizeChat(msg.text);
        if (!text || !session.guard.admitChat(now)) return;
        this.broadcast({ t: 'chat', from: slot.id, text });
        return;
      }
      case 'spectate':
        session.spectateTarget =
          typeof msg.target === 'number' && this.roundPlayers.includes(msg.target) ? msg.target : -1;
        return;
      case 'loaded':
        if (this.round && msg.roundId === this.round.id && !this.lobbyActive)
          this.show.onPlayerLoaded?.(slot.id);
        return;
      default:
        this.violation(session, now);
    }
  }

  // ---------------------------------------------------------------------------
  // Show flow
  // ---------------------------------------------------------------------------

  private applyShowEvents(events: ShowEvent[], now: number): void {
    for (const e of events) {
      switch (e.type) {
        case 'showPhase':
          this.broadcast({ t: 'showPhase', phase: e.phase });
          break;
        case 'roundStart':
          this.startRound(e.plan);
          break;
        case 'roundPhase':
          if (this.sim) {
            this.sim.setPhase(e.phase, e.time);
            this.broadcast({ t: 'roundPhase', phase: e.phase, time: e.time ?? this.sim.time });
          }
          break;
        case 'roundEnd':
          this.broadcast({ t: 'roundResults', roundId: e.roundId, results: e.results });
          this.recordRound(e.roundId, e.results, now);
          break;
        case 'showEnd':
          this.broadcast({ t: 'showSummary', winners: e.winners, rounds: e.rounds });
          this.state = 'ended';
          this.endedAt = now;
          this.reportResults(e.winners);
          break;
      }
    }
  }

  private startRound(plan: ShowRoundPlan): void {
    this.sim?.dispose();
    this.sim = null;
    this.lobbyActive = false;
    const round = plan.round ?? this.deps.loadRound(plan.roundId);
    const players: MatchPlayerInfo[] = [];
    const roster = this.roster();
    for (const id of plan.playerIds) {
      const info = roster.find((p) => p.id === id);
      if (!info) continue;
      // The show's own entry carries its team assignment (parties kept together in team rounds).
      const planned = plan.players?.find((p) => p.id === id);
      players.push(planned ? { ...info, team: planned.team } : info);
    }
    if (this.roundIndex < 0 && this.reservedUntil < 0 && this.hasHeldSeats())
      this.reservedUntil = this.deps.now() + this.config.lateJoinGraceMs;
    const sim = this.deps.createMatchSim({
      R: this.deps.R,
      round,
      seed: plan.seed,
      stage: plan.stage,
      players,
      mode: 'authority',
      ...(plan.qualifyTarget !== undefined ? { qualifyTarget: plan.qualifyTarget } : {}),
      ...(plan.variationId !== undefined ? { variationId: plan.variationId } : {}),
    });
    this.currentPlan = plan;
    this.roundIndex = plan.index ?? this.roundIndex + 1;
    this.roundStartedAt = this.deps.now();
    this.installSim(
      sim,
      round,
      players.map((p) => p.id),
    );
    this.log(
      `[room ${this.id}] round ${round.id} (stage ${plan.stage}) with ${players.length} players, epoch ${this.epoch}`,
    );
  }

  private hasHeldSeats(): boolean {
    for (const s of this.slots.values()) if (s.reserved && !s.left) return true;
    return false;
  }

  /** Makes `sim` the room's running sim: new snapshot epoch, fresh history, joinRound to everyone. */
  private installSim(sim: MatchSim, round: RoundDefinition, playerIds: number[]): void {
    this.sim = sim;
    this.round = round;
    this.roundPlayers = playerIds;
    this.quantizer = new PositionQuantizer(round.bounds);
    const ids = new Set<string>(round.obstacles.map((o) => o.id));
    for (const k of sim.getObstacleNetStates().keys()) ids.add(k);
    this.obstacles = new ObstacleTable([...ids]);
    this.epoch = (this.epoch + 1) & 0xff;
    this.lagComp.reset();
    this.hitAssist.reset();
    this.bodies.reset();
    this.frame.obstacles = this.obstacles;
    this.frame.quantizer = this.quantizer;
    this.frame.epoch = this.epoch;
    for (const s of this.sessions) this.sendJoinRound(s);
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  private sendSnapshots(sim: MatchSim, now: number): void {
    const q = this.quantizer!;
    const simTick = simTickOf(this.serverTick);
    const st = this.scratchState;
    this.entities.clear();
    for (const id of this.roundPlayers) {
      if (!sim.getPlayerState(id, st)) continue;
      this.entities.set(id, st, q, simTick);
    }
    this.obstacles.update(sim.getObstacleNetStates());
    this.fillStatus(this.status);
    const standings = sim.getStandings();
    for (let i = 0; i < this.leaders.length; i++) this.leaders[i] = standings[i] ?? -1;

    const f = this.frame;
    f.snapshotId = this.snapshotId;
    this.snapshotId = (this.snapshotId + 1) & 0xffff;
    f.serverTick = this.serverTick;
    f.matchTime = sim.time;

    const viewer = { playerId: -1, spectateTarget: -1, ackedInputSeq: -1 };
    for (const s of this.sessions) {
      const slot = this.slots.get(s.playerId);
      if (!slot) continue;
      viewer.playerId = slot.spectator ? -1 : slot.id;
      viewer.spectateTarget = s.spectateTarget;
      viewer.ackedInputSeq = slot.spectator ? -1 : slot.jitter.lastConsumedSeq;
      const w = this.writer.reset();
      const stats = s.encoder.encode(w, f, viewer);
      // ws may hold the buffer until the socket drains, so each send gets its own copy.
      if (s.conn.send(w.finish().slice(), true)) {
        s.noteSnapshotSent(f.snapshotId, now);
        this.metrics.snapshotsSent++;
        this.metrics.snapshotBytes.add(stats.bytes);
      } else {
        this.metrics.snapshotsDropped++;
      }
    }
  }

  private fillStatus(status: RoundStatus | null): void {
    const n = this.netStatus;
    if (!status) return;
    n.phase = status.phase;
    n.timeLeft = status.timeLeft;
    n.qualifiedCount = status.qualifiedCount;
    n.qualifyTarget = status.qualifyTarget;
    n.eliminatedCount = status.eliminatedCount;
    n.finished = status.finished;
    n.teamCount = Math.min(status.teamScores.length, n.teamScores.length);
    for (let i = 0; i < n.teamCount; i++) n.teamScores[i] = status.teamScores[i]!;
  }

  // ---------------------------------------------------------------------------
  // Messaging helpers
  // ---------------------------------------------------------------------------

  private attach(session: ClientSession, slot: PlayerSlot, resumed: boolean): void {
    session.playerId = slot.id;
    session.resetSnapshots();
    session.reliable.reset();
    slot.session = session;
    this.sessions.add(session);
    this.sendWelcome(session, slot, resumed);
    if (this.state !== 'lobby' || this.match) session.sendLowFreq(this.showInfo());
    if (this.state === 'show' && this.roundIndex < 0 && this.preShowEndTick >= 0)
      session.sendLowFreq(this.preShowPhase());
    if (this.sim) this.sendJoinRound(session);
    this.sendRewards(session);
    this.broadcastPlayerList();
    if (this.sim && this.status && !this.lobbyActive)
      session.sendLowFreq({ t: 'roundPhase', phase: this.status.phase, time: this.sim.time });
    this.flushSession(session, performance.now());
  }

  private detach(session: ClientSession, reason: string): void {
    this.sessions.delete(session);
    session.conn.close(4000, reason);
  }

  private sendWelcome(session: ClientSession, slot: PlayerSlot, resumed: boolean): void {
    const w = this.writer.reset();
    writeWelcome(w, {
      version: PROTOCOL_VERSION,
      playerId: slot.id,
      resumeToken: slot.token,
      roomId: this.id,
      serverTick: this.serverTick,
      tickEpochMs: this.tickEpochMs(),
      tickMs: 1000 / SERVER_TICK_HZ,
      resumed,
    });
    session.conn.send(w.finish().slice());
  }

  private sendJoinRound(session: ClientSession): void {
    if (!this.sim || !this.round) return;
    const plan = this.currentPlan;
    const players = this.roster().filter((p) => this.roundPlayers.includes(p.id));
    if (plan?.players)
      for (const p of players) p.team = plan.players.find((x) => x.id === p.id)?.team ?? p.team;
    if (this.lobbyActive) {
      session.sendLowFreq({
        t: 'joinRound',
        roundId: this.round.id,
        seed: 0,
        stage: 0,
        players,
        obstacleIds: [...this.obstacles.ids],
        bounds: this.round.bounds,
        epoch: this.epoch,
        startTick: this.serverTick,
        roundIndex: -1,
        isFinal: false,
        qualifyTarget: 0,
        variationId: null,
        lobby: true,
      });
      return;
    }
    session.sendLowFreq({
      t: 'joinRound',
      roundId: this.round.id,
      seed: this.show.currentRound()?.seed ?? 0,
      stage: this.show.currentRound()?.stage ?? 0,
      players,
      obstacleIds: [...this.obstacles.ids],
      bounds: this.round.bounds,
      epoch: this.epoch,
      startTick: this.serverTick,
      roundIndex: Math.max(0, this.roundIndex),
      isFinal: plan?.isFinal ?? this.round.type === 'final',
      qualifyTarget: plan?.qualifyTarget ?? this.sim.getStatus().qualifyTarget,
      variationId: this.sim.variationId ?? null,
      ...(plan?.durationScale !== undefined && plan.durationScale !== 1
        ? { durationScale: plan.durationScale }
        : {}),
    });
  }

  private showInfo(): LowFreqMessage {
    const m = this.match;
    const players = this.roster().length || this.config.capacity;
    const desc = this.deps.describePlaylist?.(m?.custom?.playlistId ?? m?.playlistId ?? null, players);
    return {
      t: 'showInfo',
      matchId: m?.matchId ?? null,
      playlistId: desc?.id ?? m?.playlistId ?? 'main-show',
      showName: desc?.name ?? 'Main Show',
      queue: m?.queue ?? 'dev',
      roundCount: desc?.roundCount ?? 3,
    };
  }

  private broadcastShowInfo(): void {
    this.broadcast(this.showInfo());
  }

  // ---------------------------------------------------------------------------
  // Results → account API
  // ---------------------------------------------------------------------------

  private recordRound(
    roundId: string,
    results: readonly { id: number; status: number; place: number; score: number }[],
    now: number,
  ): void {
    const round = this.round?.id === roundId ? this.round : null;
    const entrants =
      this.currentPlan?.roundId === roundId ? [...this.currentPlan.playerIds] : results.map((r) => r.id);
    const qualifiedIds = results.filter((r) => r.status === 1).map((r) => r.id);
    const isRace = round?.type === 'race' || round?.qualification.mode === 'finish';
    this.roundRecords.push({
      roundId,
      roundType: this.currentPlan?.isFinal ? 'final' : (round?.type ?? 'race'),
      durationMs: Math.max(0, Math.round(now - this.roundStartedAt)),
      entrants,
      qualifiedIds,
      results: entrants.map((id) => {
        const r = results.find((x) => x.id === id);
        const qualified = r?.status === 1;
        return {
          key: String(id),
          qualified,
          ...(isRace && qualified && r ? { position: Math.min(100, Math.max(1, r.place)) } : {}),
          ...(r && Number.isFinite(r.score) ? { score: Math.round(r.score) } : {}),
        };
      }),
    });
  }

  /** Builds the API payload for a finished matchmade show. */
  buildResults(winners: readonly number[]): MatchResultPayload | null {
    const m = this.match;
    if (!m || this.roundRecords.length === 0) return null;
    const players = [...this.slots.values()].filter((s) => !s.spectator && (s.isBot || s.userId));
    const keys = new Set(players.map((s) => String(s.id)));
    const placements = computePlacements(
      players.map((s) => String(s.id)),
      this.roundRecords.map((r) => ({
        entrants: r.entrants.map(String).filter((k) => keys.has(k)),
        qualified: r.qualifiedIds.map(String).filter((k) => keys.has(k)),
      })),
      winners.map(String).filter((k) => keys.has(k)),
    );
    return {
      matchId: m.matchId,
      queue: m.queue,
      playlistId: m.custom?.playlistId ?? m.playlistId,
      region: m.region.slice(0, 8) || 'na',
      startedAt: new Date(this.showStartedAtWall || Date.now()).toISOString(),
      endedAt: new Date().toISOString(),
      participants: players.map((s) => ({
        key: String(s.id),
        userId: s.isBot ? null : s.userId,
        isBot: s.isBot,
        name: s.name.slice(0, 32) || 'Tumbler',
        ...(s.left ? { quit: true } : {}),
        ...(s.isBot ? {} : { stats: { ...s.stats } }),
      })),
      rounds: this.roundRecords.slice(0, 10).map((r) => ({
        roundId: r.roundId,
        roundType: r.roundType,
        durationMs: Math.min(r.durationMs, 30 * 60_000),
        results: r.results.filter((x) => keys.has(x.key)),
      })),
      placements,
    };
  }

  private reportResults(winners: readonly number[]): void {
    const sink = this.deps.results;
    const payload = sink ? this.buildResults(winners) : null;
    if (!sink || !payload) {
      this.finishRewards(null);
      return;
    }
    void sink
      .post(payload)
      .then((res) => {
        this.log(
          `[room ${this.id}] results for ${payload.matchId} ${res ? `recorded (${res.rewards.length} rewards${res.alreadyProcessed ? ', replayed' : ''})` : 'not recorded'}`,
        );
        this.finishRewards(res?.rewards ?? null);
      })
      .catch(() => this.finishRewards(null));
  }

  private finishRewards(rewards: readonly { userId: string; [k: string]: unknown }[] | null): void {
    if (this.state === 'closed') return;
    this.rewardsDone = true;
    for (const s of this.slots.values()) {
      if (s.isBot || !s.userId) continue;
      this.rewardsByUser.set(s.userId, rewards?.find((r) => r.userId === s.userId) ?? null);
    }
    for (const session of this.sessions) this.sendRewards(session);
  }

  private sendRewards(session: ClientSession): void {
    const m = this.match;
    const slot = this.slots.get(session.playerId);
    if (!m || !this.rewardsDone || !slot?.userId) return;
    const reward = this.rewardsByUser.get(slot.userId) ?? null;
    // The API's PlayerRewardSummary is a superset of PlayerRewardMsg; it is forwarded untouched.
    session.sendLowFreq({ t: 'showRewards', matchId: m.matchId, reward: reward as PlayerRewardMsg | null });
  }

  private broadcastPlayerList(): void {
    const players: NetPlayerInfo[] = [];
    for (const s of this.slots.values()) {
      // Held seats appear once their player walks in (the join feed counts real arrivals).
      if (s.spectator || s.reserved) continue;
      players.push({
        id: s.id,
        name: s.name,
        isBot: s.isBot,
        loadout: s.loadout,
        connected: s.isBot || s.session !== null,
        ...(s.partyId >= 0 ? { partyId: s.partyId } : {}),
      });
    }
    this.broadcast({ t: 'playerList', players });
  }

  private broadcast(msg: LowFreqMessage): void {
    if (this.sessions.size === 0) return;
    const payload = encodeReliableMessage({ kind: 'msg', msg });
    for (const s of this.sessions) s.reliable.send(payload);
  }

  private flushReliable(now: number): void {
    for (const s of this.sessions) this.flushSession(s, now);
  }

  private flushSession(s: ClientSession, now: number): void {
    // Several packets per tick only when a backlog built up (e.g. a resume burst).
    for (let i = 0; i < 4; i++) {
      const w = this.writer.reset();
      if (!s.reliable.flush(now, s.rttMs, w)) break;
      s.conn.send(w.finish().slice());
      if (!s.reliable.wantsFlush(now, s.rttMs)) break;
    }
    if (s.reliable.overflowed) this.kick(s, KickReason.BadMessage, 'reliable backlog');
  }

  private violation(session: ClientSession, now: number): void {
    if (session.guard.violation(now)) this.kick(session, KickReason.BadMessage, 'protocol violations');
  }

  private kick(session: ClientSession, reason: KickReasonId, detail: string): void {
    const w = this.writer.reset();
    writeKick(w, reason, detail);
    session.conn.send(w.finish().slice());
    session.conn.close(4000 + reason, detail);
    this.metrics.kicks++;
    this.sessions.delete(session);
  }
}
