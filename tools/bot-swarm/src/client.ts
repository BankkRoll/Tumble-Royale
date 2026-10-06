/**
 * One headless swarm client: speaks the real protocol (Hello, 60 Hz input
 * batches with redundancy and snapshot acks, ping, reliable channel), fully
 * decodes snapshots, and records traffic and latency statistics.
 */
import {
  BitReader,
  BitWriter,
  ClockSync,
  INPUT_REDUNDANCY,
  InputHistory,
  MsgType,
  NetworkConditioner,
  NO_SNAPSHOT,
  PROTOCOL_VERSION,
  PositionQuantizer,
  ReliableEndpoint,
  SnapshotDecoder,
  createDecodedSnapshot,
  decodeReliableMessage,
  encodeReliableMessage,
  quantizeInputInPlace,
  readKick,
  readPong,
  readWelcome,
  writeHello,
  writeInputBatch,
  writePing,
  type ConditionerOptions,
} from '@tumble/netcode';
import { Button, type CharacterInput } from '@tumble/sim';
import { Rng } from '@tumble/shared';
import WebSocket from 'ws';

/** Per-client counters. */
export interface ClientStats {
  connected: boolean;
  welcomed: boolean;
  kicked: string | null;
  /** Connection attempts the server refused before the handshake (and the client retried). */
  refused: number;
  snapshots: number;
  snapshotBytes: number;
  deltaSnapshots: number;
  decodeErrors: number;
  bytesIn: number;
  bytesOut: number;
  reliableMessages: number;
  rttSamples: number[];
  firstSnapshotAt: number;
  lastSnapshotAt: number;
}

const now = (): number => performance.now();
/** Refused connects a client retries before giving up. */
const MAX_CONNECT_ATTEMPTS = 20;

/** A simulated player connection. */
export class SwarmClient {
  readonly stats: ClientStats = {
    connected: false,
    welcomed: false,
    kicked: null,
    refused: 0,
    snapshots: 0,
    snapshotBytes: 0,
    deltaSnapshots: 0,
    decodeErrors: 0,
    bytesIn: 0,
    bytesOut: 0,
    reliableMessages: 0,
    rttSamples: [],
    firstSnapshotAt: 0,
    lastSnapshotAt: 0,
  };
  private ws: WebSocket | null = null;
  private closing = false;
  private readonly w = new BitWriter(2048);
  private readonly r = new BitReader();
  private readonly reliable = new ReliableEndpoint();
  private readonly decoder = new SnapshotDecoder();
  private readonly decoded = createDecodedSnapshot();
  private readonly clock = new ClockSync(now);
  private readonly history = new InputHistory();
  private readonly batch: CharacterInput[] = Array.from({ length: INPUT_REDUNDANCY }, () => ({
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    buttons: 0,
    emote: 0,
  }));
  private readonly input: CharacterInput = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
  private readonly rng: Rng;
  private quantizer: PositionQuantizer | null = null;
  private lastPing = 0;
  private lastHello = 0;
  private lastAckOnly = 0;
  private heading: number;
  private jumpHold = 0;
  private clientTick = 0;
  private inRound = false;

  private upLink: NetworkConditioner | null = null;
  private downLink: NetworkConditioner | null = null;

  /**
   * @param url - Server WebSocket URL.
   * @param index - Client number (name and RNG seed).
   * @param conditioner - Optional impairment applied to EACH direction.
   */
  constructor(
    private readonly url: string,
    readonly index: number,
    conditioner: ConditionerOptions | null = null,
  ) {
    this.rng = new Rng(0xb07 + index * 7919);
    this.heading = this.rng.range(-Math.PI, Math.PI);
    if (conditioner) {
      this.upLink = new NetworkConditioner(
        { ...conditioner, seed: index * 2 + 1 },
        (d) => this.rawSend(d),
        now,
      );
      this.downLink = new NetworkConditioner(
        { ...conditioner, seed: index * 2 + 2 },
        (d) => this.onMessage(d),
        now,
      );
    }
  }

  /** Opens the socket and sends Hello. */
  connect(): void {
    const ws = new WebSocket(this.url, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    ws.on('open', () => {
      this.stats.connected = true;
      this.sendHello();
    });
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (this.downLink) this.downLink.send(bytes);
      else this.onMessage(bytes);
    });
    ws.on('close', () => {
      this.stats.connected = false;
    });
    ws.on('error', () => {
      this.stats.connected = false;
      if (!this.stats.welcomed) this.retry();
    });
  }

  /**
   * The server refuses upgrades (429) once one address holds
   * `MAX_PENDING_PER_IP` (default 8) unhandshaken sockets, and a swarm opens
   * every client from one host: under load the first handshakes take longer
   * than the ramp, so a few clients are refused and must try again.
   */
  private retry(): void {
    if (this.closing || this.stats.refused >= MAX_CONNECT_ATTEMPTS) return;
    this.stats.refused++;
    setTimeout(() => {
      if (!this.closing && !this.stats.welcomed) this.connect();
    }, 150 * this.stats.refused);
  }

  /** Closes the socket. */
  close(): void {
    this.closing = true;
    this.ws?.close();
  }

  /** One 60 Hz client step: produce and send an input batch, ping, flush reliable. */
  step(): void {
    this.upLink?.update();
    this.downLink?.update();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const t = now();
    if (!this.stats.welcomed) {
      // Hello can be lost on a conditioned link; the server answers duplicates idempotently.
      if (t - this.lastHello > 1000) this.sendHello();
      return;
    }
    this.clientTick++;
    if (this.inRound) {
      this.makeInput(this.input);
      quantizeInputInPlace(this.input);
      const seq = this.history.push(this.input);
      const n = this.history.collectRecent(seq, INPUT_REDUNDANCY, this.batch);
      const w = this.w.reset();
      writeInputBatch(
        w,
        { newestSeq: seq, clientTick: this.clientTick, ackSnapshotId: this.decoder.newestId, count: n },
        this.batch,
      );
      this.send(w.finish());
    } else if (t - this.lastAckOnly > 100) {
      this.lastAckOnly = t;
      const w = this.w.reset();
      writeInputBatch(
        w,
        { newestSeq: 0, clientTick: this.clientTick, ackSnapshotId: NO_SNAPSHOT, count: 0 },
        this.batch,
      );
      this.send(w.finish());
    }
    if (t - this.lastPing > 2000) {
      this.lastPing = t;
      const w = this.w.reset();
      writePing(w, t);
      this.send(w.finish());
    }
    const w = this.w.reset();
    if (this.reliable.flush(t, this.clock.rtt || 100, w)) this.send(w.finish());
  }

  private sendHello(): void {
    this.lastHello = now();
    const w = this.w.reset();
    writeHello(w, { version: PROTOCOL_VERSION, name: `swarm-${this.index}`, resumeToken: '', loadout: '' });
    this.send(w.finish());
  }

  private makeInput(out: CharacterInput): void {
    if (this.rng.chance(0.02)) this.heading += this.rng.range(-1.5, 1.5);
    out.yaw = this.heading;
    out.moveX = this.rng.chance(0.1) ? this.rng.range(-1, 1) : 0;
    out.moveZ = this.rng.chance(0.005) ? 0 : 1;
    if (this.jumpHold > 0) this.jumpHold--;
    else if (this.rng.chance(0.015)) this.jumpHold = this.rng.int(3, 15);
    out.buttons = (this.jumpHold > 0 ? Button.Jump : 0) | (this.rng.chance(0.002) ? Button.Dive : 0);
    out.emote = this.rng.chance(0.0005) ? this.rng.int(1, 4) : 0;
  }

  private send(bytes: Uint8Array): void {
    this.stats.bytesOut += bytes.length;
    if (this.upLink) this.upLink.send(bytes);
    // ws may hold the buffer until written; the writer is reused next step.
    else this.rawSend(bytes.slice());
  }

  private rawSend(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes, { binary: true });
  }

  private onMessage(data: Uint8Array): void {
    this.stats.bytesIn += data.length;
    const r = this.r.reset(data);
    const type = r.readBits(8);
    switch (type) {
      case MsgType.Welcome: {
        readWelcome(r);
        this.stats.welcomed = true;
        return;
      }
      case MsgType.Snapshot: {
        if (!this.quantizer) return;
        const res = this.decoder.decode(r, this.quantizer, this.decoded);
        if (res !== 'ok') {
          this.stats.decodeErrors++;
          return;
        }
        const t = now();
        if (this.stats.snapshots === 0) this.stats.firstSnapshotAt = t;
        this.stats.lastSnapshotAt = t;
        this.stats.snapshots++;
        this.stats.snapshotBytes += data.length;
        if (this.decoded.baselineId >= 0) this.stats.deltaSnapshots++;
        return;
      }
      case MsgType.Reliable:
        this.reliable.receive(r, (p) => {
          this.stats.reliableMessages++;
          const m = decodeReliableMessage(p);
          if (m?.kind === 'msg' && m.msg.t === 'joinRound') {
            this.quantizer = new PositionQuantizer(m.msg.bounds);
            this.decoder.reset();
            this.inRound = true;
            // Nothing to build headless; without the ack the director holds LOADING until its hard
            // cap and then eliminates every swarm client, so PLAYING was never load-tested.
            this.reliable.send(
              encodeReliableMessage({ kind: 'msg', msg: { t: 'loaded', roundId: m.msg.roundId } }),
            );
          } else if (m?.kind === 'msg' && m.msg.t === 'voteOptions' && m.msg.canVote) {
            // One seeded ballot per vote so load tests cover the castVote path and its tally broadcasts.
            const option = this.rng.int(0, Math.max(0, m.msg.options.length - 1));
            this.reliable.send(
              encodeReliableMessage({
                kind: 'msg',
                msg: { t: 'castVote', roundIndex: m.msg.roundIndex, option },
              }),
            );
          }
        });
        return;
      case MsgType.Pong: {
        const { t0, t1, t2 } = readPong(r);
        const t3 = now();
        if (this.clock.addSample(t0, t1, t2, t3)) this.stats.rttSamples.push(t3 - t0 - (t2 - t1));
        return;
      }
      case MsgType.Kick:
        this.stats.kicked = readKick(r).detail;
        return;
    }
  }
}
