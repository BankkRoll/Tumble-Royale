/**
 * Browser connection to the game server.
 *
 * Responsibilities: socket lifecycle (connect, Hello/Welcome, resume with the
 * token for 30 s after a drop, then fail), clock sync (ping on connect and
 * every 2 s), input batches with redundancy + snapshot acks, snapshot decoding,
 * the reliable channel, a typed event stream for the game/UI, and optional
 * network impairment from `?lag=150&loss=0.02`.
 *
 * Rendering-agnostic: no three.js, no React.
 */
import {
  BitReader,
  BitWriter,
  ClockSync,
  INPUT_REDUNDANCY,
  LEAVE_CLOSE_REASON,
  MsgType,
  NetworkConditioner,
  PROTOCOL_VERSION,
  PositionQuantizer,
  ReliableEndpoint,
  SnapshotDecoder,
  conditionerFromParams,
  createDecodedSnapshot,
  decodeReliableMessage,
  encodeReliableMessage,
  readKick,
  readPong,
  readWelcome,
  writeHello,
  writeInputBatch,
  writePing,
  type ConditionerOptions,
  type DecodedSnapshot,
  type InputHistory,
  type JoinRoundMsg,
  type ChatMsg,
  type LowFreqMessage,
  type NetPlayerInfo,
  type RoundResultEntry,
  type WelcomeMsg,
} from '@tumble/netcode';
import type { CharacterInput, SimEvent } from '@tumble/sim';
import type { RoundPhaseId, ShowPhaseId } from '@tumble/shared';
import { TypedEmitter } from './emitter.ts';
import { devParam, ENDPOINTS } from '../devTools.ts';

/** Connection state for the UI. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** Events emitted by {@link NetClient}. Snapshot payloads are reused: consume synchronously. */
export interface NetClientEvents extends Record<string, unknown> {
  state: ConnectionState;
  welcome: WelcomeMsg;
  joinRound: JoinRoundMsg;
  /** A decoded snapshot newer than any before it. */
  snapshot: DecodedSnapshot;
  simEvent: { tick: number; event: SimEvent };
  roundPhase: { phase: RoundPhaseId; time: number };
  showPhase: ShowPhaseId;
  playerList: NetPlayerInfo[];
  roundResults: { roundId: string; results: RoundResultEntry[] };
  showSummary: { winners: number[]; rounds: { roundId: string; qualified: number[] }[] };
  lobby: { humans: number; capacity: number; startsInMs: number };
  /** Relayed in-show chat (text with `masked` variant, or a quick-chat preset). */
  chat: Omit<ChatMsg, 't'>;
  /** A reconnect attempt was scheduled after a drop. */
  reconnect: ReconnectAttempt;
  /** Every low-frequency message, including the ones above. */
  message: LowFreqMessage;
  kicked: { reason: number; detail: string };
}

/** One scheduled reconnect attempt. */
export interface ReconnectAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Attempts before the client gives up. */
  maxAttempts: number;
  /** Delay before this attempt opens a socket (ms). */
  delayMs: number;
}

/** Default reconnect attempts before giving up (all fit inside the server's 30 s resume window). */
export const DEFAULT_RECONNECT_ATTEMPTS = 5;

/**
 * Backoff before reconnect attempt `attempt` (1-based): 0.5 s, 1 s, 2 s, then
 * 4 s per attempt.
 *
 * @param attempt - Attempt number.
 * @returns Delay in ms.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(4000, 250 * 2 ** Math.min(Math.max(1, attempt), 4));
}

/** The subset of the browser WebSocket the client uses (injectable for tests). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Options for {@link NetClient}. */
export interface NetClientOptions {
  /** WebSocket URL; defaults to `?gs=` or `/gs/ws` on the current host (Vite proxy). */
  url?: string;
  name: string;
  /** Opaque cosmetic loadout forwarded to other players. */
  loadout?: string;
  /** Matchmaker join ticket (matchmade shows); omitted for unticketed dev rooms. */
  ticket?: string;
  /** Impairment per direction; defaults to parsing `location.search` (`lag`, `jitter`, `loss`, `dup`, `reorder`). */
  conditioner?: ConditionerOptions | null;
  /** Monotonic clock in ms. */
  now?: () => number;
  createSocket?: (url: string) => WebSocketLike;
  /** How long to keep trying to resume after a drop. */
  reconnectWindowMs?: number;
  /** Reconnect attempts after a drop before the state becomes `failed`. */
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
}

const OPEN = 1;

/**
 * Resolves the default server URL: `?gs=<url>` in dev builds, else the
 * deployment's `VITE_GAME_SERVER_URL`, else `/gs/ws` on this origin (the Vite
 * proxy in dev, a reverse proxy when deployed).
 */
export function defaultServerUrl(): string {
  const explicit = devParam(new URLSearchParams(location.search), 'gs');
  if (explicit) return explicit;
  if (ENDPOINTS.gameServer) return ENDPOINTS.gameServer;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gs/ws`;
}

/**
 * Game server connection.
 *
 * @example
 * const net = new NetClient({ name: 'Player' });
 * net.on('state', (s) => ui.setConnection(s));
 * net.connect();
 * // every frame:
 * net.update();
 */
export class NetClient extends TypedEmitter<NetClientEvents> {
  readonly clock: ClockSync;
  state: ConnectionState = 'idle';
  /** This client's player id (valid after Welcome). */
  playerId = -1;
  roomId = '';
  /** The round currently loaded, or null. */
  round: JoinRoundMsg | null = null;
  quantizer: PositionQuantizer | null = null;
  /** Network tick length (ms) from Welcome. */
  tickMs = 1000 / 30;
  /** Server clock time of network tick 0 (ms). */
  tickEpochMs = 0;
  /** Diagnostics for the HUD/debug overlay. */
  readonly stats = {
    bytesIn: 0,
    bytesOut: 0,
    snapshots: 0,
    snapshotBytes: 0,
    decodeFailures: 0,
    lastSnapshotAt: 0,
  };

  private readonly opts: Required<Omit<NetClientOptions, 'url' | 'conditioner' | 'createSocket'>> & {
    url: string;
    conditioner: ConditionerOptions | null;
    createSocket: (url: string) => WebSocketLike;
  };
  private socket: WebSocketLike | null = null;
  private up: NetworkConditioner | null = null;
  private down: NetworkConditioner | null = null;
  private readonly w = new BitWriter(1024);
  private readonly r = new BitReader();
  private readonly reliable = new ReliableEndpoint();
  private readonly decoder = new SnapshotDecoder();
  private readonly decoded = createDecodedSnapshot();
  private readonly batch: CharacterInput[] = Array.from({ length: INPUT_REDUNDANCY }, () => ({
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    buttons: 0,
    emote: 0,
  }));
  private resumeToken = '';
  private welcomed = false;
  private userClosed = false;
  private lastHelloAt = 0;
  private lastPingAt = -Infinity;
  private lastInputAt = 0;
  private droppedAt = -1;
  private reconnectAttempts = 0;
  private nextReconnectAt = 0;
  private clientTick = 0;
  private presentedSnapshot = -1;

  /** @param opts - Connection options. */
  constructor(opts: NetClientOptions) {
    super();
    const now = opts.now ?? (() => performance.now());
    this.opts = {
      url: opts.url ?? defaultServerUrl(),
      name: opts.name,
      loadout: opts.loadout ?? '',
      ticket: opts.ticket ?? '',
      conditioner:
        opts.conditioner !== undefined
          ? opts.conditioner
          : typeof location !== 'undefined'
            ? conditionerFromParams(new URLSearchParams(location.search))
            : null,
      now,
      createSocket: opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike),
      reconnectWindowMs: opts.reconnectWindowMs ?? 30_000,
      maxReconnectAttempts: Math.max(1, opts.maxReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS),
      pingIntervalMs: opts.pingIntervalMs ?? 2000,
    };
    this.clock = new ClockSync(now);
    if (this.opts.conditioner) {
      this.up = new NetworkConditioner({ ...this.opts.conditioner, seed: 11 }, (d) => this.rawSend(d), now);
      this.down = new NetworkConditioner({ ...this.opts.conditioner, seed: 12 }, (d) => this.onData(d), now);
      // Frame-rate pumping would quantise the simulated latency to 16 ms steps.
      this.up.startAutoPump(4);
      this.down.startAutoPump(4);
    }
  }

  /** Smoothed RTT (ms). */
  get rtt(): number {
    return this.clock.rtt;
  }

  /** Newest decoded snapshot id, or -1. */
  get newestSnapshotId(): number {
    return this.decoder.newestId;
  }

  /** Opens the connection (no-op when already open). */
  connect(): void {
    if (this.socket) return;
    this.userClosed = false;
    this.setState(this.droppedAt >= 0 ? 'reconnecting' : 'connecting');
    this.open();
  }

  /**
   * Starts a fresh round of reconnect attempts after the client gave up
   * (`failed`), e.g. from the connection-lost curtain's Try again. No-op when
   * a socket is open, after {@link close}, or after a kick.
   *
   * @returns True when a new attempt started.
   */
  retry(): boolean {
    if (this.socket || this.userClosed || this.state !== 'failed') return false;
    this.reconnectAttempts = 0;
    this.droppedAt = this.opts.now();
    this.scheduleReconnect(this.droppedAt);
    return true;
  }

  /** Closes for good (no reconnect). */
  close(): void {
    this.userClosed = true;
    this.socket?.close(1000, LEAVE_CLOSE_REASON);
    this.socket = null;
    this.up?.stopAutoPump();
    this.down?.stopAutoPump();
    this.setState('idle');
  }

  /** Server clock time of network tick `tick` (ms). */
  serverTimeOfTick(tick: number): number {
    return this.tickEpochMs + tick * this.tickMs;
  }

  /** Authoritative match time estimate (s). */
  matchTime(): number {
    return this.clock.matchTime();
  }

  /**
   * Sends the newest input with up to two redundant predecessors and the
   * newest snapshot ack. Call once per local fixed step.
   */
  sendInput(seq: number, history: InputHistory): void {
    if (!this.welcomed) return;
    const n = history.collectRecent(seq, INPUT_REDUNDANCY, this.batch);
    const w = this.w.reset();
    writeInputBatch(
      w,
      { newestSeq: seq, clientTick: this.clientTick++, ackSnapshotId: this.decoder.newestId, count: n },
      this.batch,
    );
    this.send(w.finish());
    this.lastInputAt = this.opts.now();
  }

  /** Queues a low-frequency message (chat, spectate, loaded) on the reliable channel. */
  sendLowFreq(msg: LowFreqMessage): void {
    this.reliable.send(encodeReliableMessage({ kind: 'msg', msg }));
    this.flushReliable();
  }

  /** Housekeeping; call every frame (and it is cheap to call more often). */
  update(): void {
    const now = this.opts.now();
    if (!this.socket) {
      if (this.state === 'reconnecting' && now >= this.nextReconnectAt) this.open();
      return;
    }
    if (this.socket.readyState !== OPEN) return;
    if (!this.welcomed) {
      if (now - this.lastHelloAt > 1000) this.sendHello();
      return;
    }
    if (now - this.lastPingAt >= this.opts.pingIntervalMs) {
      this.lastPingAt = now;
      const w = this.w.reset();
      writePing(w, now);
      this.send(w.finish());
    }
    // Keep acking snapshots while not sending inputs (lobby, spectating) so deltas stay small.
    if (now - this.lastInputAt > 100) {
      this.lastInputAt = now;
      const w = this.w.reset();
      writeInputBatch(
        w,
        { newestSeq: 0, clientTick: this.clientTick, ackSnapshotId: this.decoder.newestId, count: 0 },
        this.batch,
      );
      this.send(w.finish());
    }
    this.flushReliable();
  }

  // ---------------------------------------------------------------------------
  // Socket
  // ---------------------------------------------------------------------------

  private open(): void {
    const ws = this.opts.createSocket(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    this.welcomed = false;
    ws.onopen = () => this.sendHello();
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      if (this.down) this.down.send(bytes);
      else this.onData(bytes);
    };
    ws.onclose = () => this.onSocketClosed();
    ws.onerror = () => {};
  }

  private onSocketClosed(): void {
    this.socket = null;
    this.welcomed = false;
    if (this.userClosed || this.state === 'failed') return;
    const now = this.opts.now();
    if (this.droppedAt < 0) this.droppedAt = now;
    if (
      this.reconnectAttempts >= this.opts.maxReconnectAttempts ||
      now - this.droppedAt > this.opts.reconnectWindowMs
    ) {
      this.setState('failed');
      return;
    }
    this.scheduleReconnect(now);
  }

  private scheduleReconnect(now: number): void {
    this.reconnectAttempts++;
    const delayMs = reconnectDelayMs(this.reconnectAttempts);
    this.nextReconnectAt = now + delayMs;
    this.setState('reconnecting');
    this.emit('reconnect', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.opts.maxReconnectAttempts,
      delayMs,
    });
  }

  private sendHello(): void {
    this.lastHelloAt = this.opts.now();
    const w = this.w.reset();
    writeHello(w, {
      version: PROTOCOL_VERSION,
      name: this.opts.name,
      resumeToken: this.resumeToken,
      loadout: this.opts.loadout,
      ticket: this.opts.ticket,
    });
    this.send(w.finish());
  }

  private send(bytes: Uint8Array): void {
    this.stats.bytesOut += bytes.length;
    if (this.up) this.up.send(bytes);
    else this.rawSend(bytes.slice());
  }

  private rawSend(bytes: Uint8Array): void {
    if (this.socket?.readyState === OPEN) this.socket.send(bytes);
  }

  private flushReliable(): void {
    if (!this.welcomed) return;
    const w = this.w.reset();
    if (this.reliable.flush(this.opts.now(), this.clock.rtt || 150, w)) this.send(w.finish());
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private onData(data: Uint8Array): void {
    this.stats.bytesIn += data.length;
    const r = this.r.reset(data);
    switch (r.readBits(8)) {
      case MsgType.Welcome:
        return this.onWelcome(readWelcome(r));
      case MsgType.Snapshot:
        return this.onSnapshot(r, data.length);
      case MsgType.Reliable:
        this.reliable.receive(r, (p) => this.onReliable(p));
        return;
      case MsgType.Pong: {
        const { t0, t1, t2 } = readPong(r);
        if (!r.overflow) this.clock.addSample(t0, t1, t2, this.opts.now());
        return;
      }
      case MsgType.Kick: {
        const k = readKick(r);
        this.userClosed = true;
        this.emit('kicked', k);
        this.setState('failed');
        return;
      }
    }
  }

  private onWelcome(m: WelcomeMsg): void {
    if (this.welcomed) return;
    if (m.version !== PROTOCOL_VERSION) {
      this.setState('failed');
      return;
    }
    this.welcomed = true;
    // The server starts a fresh reliable channel and snapshot baseline for every connection.
    this.reliable.reset();
    this.decoder.reset();
    this.presentedSnapshot = -1;
    this.playerId = m.playerId;
    this.roomId = m.roomId;
    this.resumeToken = m.resumeToken;
    this.tickMs = m.tickMs;
    this.tickEpochMs = m.tickEpochMs;
    this.droppedAt = -1;
    this.reconnectAttempts = 0;
    this.lastPingAt = -Infinity;
    this.setState('connected');
    this.emit('welcome', m);
    this.update();
  }

  private onSnapshot(r: BitReader, bytes: number): void {
    if (!this.quantizer) return;
    const res = this.decoder.decode(r, this.quantizer, this.decoded);
    if (res !== 'ok') {
      this.stats.decodeFailures++;
      return;
    }
    const s = this.decoded;
    if (this.round && s.epoch !== (this.round.epoch & 0xff)) return;
    this.stats.snapshots++;
    this.stats.snapshotBytes += bytes;
    this.stats.lastSnapshotAt = this.opts.now();
    if (this.presentedSnapshot >= 0 && !isNewer16(s.snapshotId, this.presentedSnapshot)) return;
    this.presentedSnapshot = s.snapshotId;
    this.clock.setMatchAnchor(this.serverTimeOfTick(s.serverTick), s.matchTime, true);
    this.emit('snapshot', s);
  }

  private onReliable(payload: Uint8Array): void {
    const m = decodeReliableMessage(payload);
    if (!m) return;
    if (m.kind === 'sim') {
      this.emit('simEvent', { tick: m.tick, event: m.event });
      return;
    }
    const msg = m.msg;
    switch (msg.t) {
      case 'joinRound':
        this.round = msg;
        this.quantizer = new PositionQuantizer(msg.bounds);
        this.decoder.reset();
        this.presentedSnapshot = -1;
        this.emit('joinRound', msg);
        break;
      case 'roundPhase':
        this.emit('roundPhase', { phase: msg.phase, time: msg.time });
        break;
      case 'showPhase':
        this.emit('showPhase', msg.phase);
        break;
      case 'playerList':
        this.emit('playerList', msg.players);
        break;
      case 'roundResults':
        this.emit('roundResults', { roundId: msg.roundId, results: msg.results });
        break;
      case 'showSummary':
        this.emit('showSummary', { winners: msg.winners, rounds: msg.rounds });
        break;
      case 'lobby':
        this.emit('lobby', { humans: msg.humans, capacity: msg.capacity, startsInMs: msg.startsInMs });
        break;
      case 'chat':
        this.emit('chat', {
          from: msg.from,
          text: msg.text,
          ...(msg.masked ? { masked: msg.masked } : {}),
          ...(msg.quick ? { quick: msg.quick } : {}),
        });
        break;
    }
    this.emit('message', msg);
  }
}

function isNewer16(a: number, b: number): boolean {
  const d = (a - b + 65536) % 65536;
  return d !== 0 && d < 32768;
}
