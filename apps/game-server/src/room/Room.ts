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
  LOADING_STATUS_MAX_WAITING,
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
import { MAX_PLAYERS, SERVER_TICK_HZ, SIM_STEPS_PER_TICK, type RoundDefinition } from '@tumble/shared';
import { InputSequenceGuard, sanitizeChat, sanitizeName } from '../antiCheat.ts';
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
}

/** A finished round as reported to the API. */
interface RoundRecord extends ResultRound {
  entrants: number[];
  qualifiedIds: number[];
}

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
/** `loadingStatus` is broadcast at most this often (2 Hz)… */
const LOADING_STATUS_INTERVAL_MS = 500;
/** …and at least this often while a round loads, even when nothing changed. */
const LOADING_STATUS_KEEPALIVE_MS = 1000;
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
  private loadingPolledAt = -Infinity;
  private loadingSentAt = -Infinity;
  private loadingKey = '';

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
    const spectator = this.state !== 'lobby' || ticket?.role === 'spectator';
    const id = this.allocateId(spectator);
    // Ticketed names come from the account (`name#tag`); the tag stays off the nameplate.
    const name = ticket ? sanitizeName(ticket.name.replace(/#\d+$/, '')) : sanitizeName(hello.name);
    const slot: PlayerSlot = {
      id,
      name,
      userId: ticket?.sub ?? null,
      stats: newStats(),
      isBot: false,
      loadout: hello.loadout.slice(0, 255),
      token: randomBytes(18).toString('base64url'),
      session,
      disconnectedAt: -1,
      left: false,
      spectator,
      jitter: new InputJitterBuffer(),
      seqGuard: new InputSequenceGuard(),
      brain: null,
      lastYaw: 0,
    };
    this.slots.set(id, slot);
    if (this.firstJoinAt < 0) this.firstJoinAt = now;
    this.attach(session, slot, false);
    this.log(`[room ${this.id}] ${slot.name} joined as ${spectator ? 'spectator' : 'player'} ${id}`);
    return id;
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
    this.show.onPlayerConnection?.(slot.id, false);
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
        this.applyInputs(this.sim);
        this.sim.step();
        this.routeSimEvents(this.sim, simTickOf(this.serverTick - 1) + s + 1);
      }
      simMs = performance.now() - ts;
      this.status = this.sim.getStatus();
    } else {
      this.status = null;
    }

    this.presentPlayers.clear();
    for (const s of this.slots.values()) if (!s.left && !s.spectator) this.presentPlayers.add(s.id);
    this.show.onTick(1 / SERVER_TICK_HZ, { status: this.status, presentPlayers: this.presentPlayers });
    this.applyShowEvents(this.show.drainEvents(), now);
    this.updateLoadingStatus(now);

    const tSnap = performance.now();
    if (this.sim && this.serverTick % this.config.snapshotEvery === 0) this.sendSnapshots(this.sim, now);
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
    let botIndex = 0;
    const seed = this.deps.randomSeed();
    while (this.humanCount + botIndex < this.config.capacity) {
      const id = this.allocateId(false);
      if (id < 0) break;
      const name = `${BOT_NAMES_A[(seed + botIndex * 7) % BOT_NAMES_A.length]} ${BOT_NAMES_B[(seed >>> 3) % BOT_NAMES_B.length]!.slice(0, 1)}${botIndex}`;
      const slot: PlayerSlot = {
        id,
        name,
        userId: null,
        stats: newStats(),
        isBot: true,
        loadout: '',
        token: '',
        session: null,
        disconnectedAt: -1,
        left: false,
        spectator: false,
        jitter: new InputJitterBuffer(),
        seqGuard: new InputSequenceGuard(),
        brain: null,
        lastYaw: 0,
      };
      this.slots.set(id, slot);
      botIndex++;
    }
    const roster = this.roster();
    for (const info of roster) {
      const slot = this.slots.get(info.id)!;
      if (slot.isBot && this.deps.createBot) slot.brain = this.deps.createBot(info, seed);
    }
    this.log(`[room ${this.id}] show starting: ${this.humanCount} humans + ${botIndex} bots`);
    this.showStartedAtWall = Date.now();
    this.broadcastPlayerList();
    this.broadcastShowInfo();
    this.show.start(roster, seed);
    for (const s of this.slots.values())
      if (!s.isBot && !s.spectator && !s.session) this.show.onPlayerConnection?.(s.id, false);
  }

  private roster(): MatchPlayerInfo[] {
    const out: MatchPlayerInfo[] = [];
    for (const s of this.slots.values()) {
      if (s.spectator) continue;
      out.push(
        s.isBot
          ? { id: s.id, name: s.name, isBot: true, team: -1, botSkill: 'average' }
          : { id: s.id, name: s.name, isBot: false, team: -1 },
      );
    }
    return out.sort((a, b) => a.id - b.id);
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
        if (slot.brain) {
          slot.brain.think(sim, id, input);
          sim.setInput(id, input);
        }
        continue;
      }
      const seq = slot.jitter.next(input);
      if (seq >= 0) slot.lastYaw = input.yaw;
      sim.setInput(id, input);
    }
  }

  private routeSimEvents(sim: MatchSim, simTick: number): void {
    const events = sim.events.drain();
    for (const e of events) {
      if (e.type === 'qualified') this.show.onPlayerFate(e.player, 1, e.place);
      else if (e.type === 'eliminated') this.show.onPlayerFate(e.player, 2, e.place);
      const stat = STAT_EVENTS[e.type];
      if (stat && 'player' in e) {
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
    if (h.count === 0 || slot.spectator) return;
    if (!slot.seqGuard.check(h.newestSeq, now)) {
      this.metrics.rateLimited++;
      return this.violation(session, now);
    }
    // Oldest first, so arrival-time jitter tracking sees sequences in order.
    for (let i = h.count - 1; i >= 0; i--) {
      const input = this.batchInputs[i]!;
      if (input.emote > 4) input.emote = 0;
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
        if (this.round && msg.roundId === this.round.id) this.show.onPlayerLoaded?.(slot.id);
        return;
      case 'loadProgress':
        if (slot.spectator || typeof msg.pct !== 'number' || !Number.isFinite(msg.pct)) return;
        if (this.round && msg.roundId === this.round.id)
          this.show.onPlayerLoadProgress?.(slot.id, Math.max(0, Math.min(1, msg.pct)));
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
        case 'forfeit':
          (this.sim as { forfeit?: (id: number) => void } | null)?.forfeit?.(e.playerId);
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

  /**
   * Mirrors the LOADING roster to clients: polled at most 2 Hz (the roster
   * allocates), sent when it changed, plus a 1 Hz keepalive so a client that
   * resumed mid-load catches up.
   */
  private updateLoadingStatus(now: number): void {
    if (!this.show.loadingStatus || now - this.loadingPolledAt < LOADING_STATUS_INTERVAL_MS) return;
    this.loadingPolledAt = now;
    const st = this.show.loadingStatus();
    if (!st) {
      this.loadingKey = '';
      return;
    }
    const key = `${st.roundId}|${st.loaded}|${st.total}|${st.waitingOn.join(',')}`;
    if (key === this.loadingKey && now - this.loadingSentAt < LOADING_STATUS_KEEPALIVE_MS) return;
    this.loadingKey = key;
    this.loadingSentAt = now;
    this.broadcast({
      t: 'loadingStatus',
      roundId: st.roundId,
      loaded: st.loaded,
      total: st.total,
      waitingOn: st.waitingOn.slice(0, LOADING_STATUS_MAX_WAITING),
    });
  }

  private startRound(plan: ShowRoundPlan): void {
    this.sim?.dispose();
    this.sim = null;
    const round = plan.round ?? this.deps.loadRound(plan.roundId);
    const players: MatchPlayerInfo[] = [];
    const roster = this.roster();
    for (const id of plan.playerIds) {
      const info = roster.find((p) => p.id === id);
      if (info) players.push(info);
    }
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
    this.sim = sim;
    this.round = round;
    this.currentPlan = plan;
    this.roundIndex = plan.index ?? this.roundIndex + 1;
    this.roundStartedAt = this.deps.now();
    this.roundPlayers = players.map((p) => p.id);
    this.quantizer = new PositionQuantizer(round.bounds);
    const ids = new Set<string>(round.obstacles.map((o) => o.id));
    for (const k of sim.getObstacleNetStates().keys()) ids.add(k);
    this.obstacles = new ObstacleTable([...ids]);
    this.epoch = (this.epoch + 1) & 0xff;
    this.lagComp.reset();
    this.frame.obstacles = this.obstacles;
    this.frame.quantizer = this.quantizer;
    this.frame.epoch = this.epoch;
    for (const s of this.sessions) this.sendJoinRound(s);
    this.log(
      `[room ${this.id}] round ${round.id} (stage ${plan.stage}) with ${players.length} players, epoch ${this.epoch}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  private sendSnapshots(sim: MatchSim, now: number): void {
    const q = this.quantizer!;
    const simTick = simTickOf(this.serverTick);
    const st = this.scratchState;
    this.entities.clear();
    this.lagComp.begin(simTick);
    for (const id of this.roundPlayers) {
      if (!sim.getPlayerState(id, st)) continue;
      this.entities.set(id, st, q, simTick);
      this.lagComp.add(id, st.pos, st.rot);
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
    if (!slot.spectator && !slot.isBot) this.show.onPlayerConnection?.(slot.id, true);
    this.sendWelcome(session, slot, resumed);
    if (this.state !== 'lobby' || this.match) session.sendLowFreq(this.showInfo());
    if (this.sim) this.sendJoinRound(session);
    this.sendRewards(session);
    this.broadcastPlayerList();
    if (this.sim && this.status)
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
    const roster = this.roster();
    session.sendLowFreq({
      t: 'joinRound',
      roundId: this.round.id,
      seed: this.show.currentRound()?.seed ?? 0,
      stage: this.show.currentRound()?.stage ?? 0,
      players: roster.filter((p) => this.roundPlayers.includes(p.id)),
      obstacleIds: [...this.obstacles.ids],
      bounds: this.round.bounds,
      epoch: this.epoch,
      startTick: this.serverTick,
      roundIndex: Math.max(0, this.roundIndex),
      isFinal: this.currentPlan?.isFinal ?? this.round.type === 'final',
      qualifyTarget: this.currentPlan?.qualifyTarget ?? this.sim.getStatus().qualifyTarget,
      variationId: this.sim.variationId ?? null,
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
      if (s.spectator) continue;
      players.push({
        id: s.id,
        name: s.name,
        isBot: s.isBot,
        loadout: s.loadout,
        connected: s.isBot || s.session !== null,
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
