/**
 * Test doubles: an in-memory connection, a pure-JS fake MatchSim and a
 * minimal protocol client.
 */
import {
  BitReader,
  BitWriter,
  MsgType,
  PROTOCOL_VERSION,
  PositionQuantizer,
  ReliableEndpoint,
  SnapshotDecoder,
  createCharacterFullState,
  copyState,
  createDecodedSnapshot,
  decodeReliableMessage,
  encodeReliableMessage,
  readWelcome,
  writeHello,
  writeInputBatch,
  type DecodedSnapshot,
  type LowFreqMessage,
  type MatchSim,
  type MatchSimOptions,
  type ReliableMessage,
  type RoundStatus,
  type WelcomeMsg,
} from '@tumble/netcode';
import {
  EventSink,
  type CharacterFullState,
  type CharacterInput,
  type Rapier,
  type World,
} from '@tumble/sim';
import {
  RoundDefinitionSchema,
  type Quat,
  type RoundDefinition,
  type RoundPhaseId,
  type Vec3,
} from '@tumble/shared';
import type { RoomDeps } from '../src/room/types.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import type { Connection } from '../src/transport/types.ts';

let nextId = 1;

/** In-memory {@link Connection}. */
export class FakeConnection implements Connection {
  readonly id = nextId++;
  readonly remoteAddress = 'test';
  bufferedAmount = 0;
  open = true;
  readonly sent: Uint8Array[] = [];
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;

  send(data: Uint8Array): boolean {
    if (!this.open) return false;
    this.sent.push(data);
    return true;
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    this.open = false;
    this.onClose?.(code, reason);
  }

  /** Simulates the client sending `data`. */
  receive(data: Uint8Array): void {
    this.onMessage?.(data.slice());
  }

  /** Returns and clears everything sent to the client. */
  drain(): Uint8Array[] {
    return this.sent.splice(0, this.sent.length);
  }
}

/** Minimal deterministic stand-in for the real MatchSim. */
export class FakeMatchSim implements MatchSim {
  // The fake never touches physics; nothing reads `world` in the room.
  readonly world = null as unknown as World;
  readonly events = new EventSink();
  readonly round: RoundDefinition;
  readonly inputs = new Map<number, CharacterInput>();
  readonly states = new Map<number, CharacterFullState>();
  /** Every input applied, per player, in step order. */
  readonly applied = new Map<number, CharacterInput[]>();
  phaseSet: { phase: RoundPhaseId; time?: number }[] = [];
  /** Players eliminated through {@link forfeit}, in call order. */
  readonly forfeited: number[] = [];
  private steps = 0;
  private t = 0;
  disposed = false;

  constructor(readonly opts: MatchSimOptions) {
    this.round = opts.round;
    opts.players.forEach((p, i) => {
      const s = createCharacterFullState();
      s.pos.x = i * 2;
      s.pos.y = 1;
      this.states.set(p.id, s);
      this.applied.set(p.id, []);
    });
  }

  get tick(): number {
    return this.steps;
  }
  get time(): number {
    return this.t;
  }

  setInput(playerId: number, input: CharacterInput): void {
    this.inputs.set(playerId, { ...input });
  }

  step(): void {
    for (const [id, s] of this.states) {
      const inp = this.inputs.get(id) ?? { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
      this.applied.get(id)!.push({ ...inp });
      s.vel.x = inp.moveX * 5;
      s.vel.z = inp.moveZ * 5;
      s.pos.x += s.vel.x / 60;
      s.pos.z += s.vel.z / 60;
      s.stateTime += 1 / 60;
      if (inp.buttons & 1 && !(s.prevButtons & 1))
        this.events.push({ type: 'jump', player: id, pos: { ...s.pos } });
      s.prevButtons = inp.buttons;
    }
    this.steps++;
    this.t += 1 / 60;
  }

  setPhase(phase: RoundPhaseId, time?: number): void {
    this.phaseSet.push(time === undefined ? { phase } : { phase, time });
    if (time !== undefined) this.t = time;
  }

  getPlayerState(id: number, out: CharacterFullState): boolean {
    const s = this.states.get(id);
    if (!s) return false;
    copyState(s, out);
    return true;
  }

  setPlayerState(id: number, state: CharacterFullState): void {
    const s = this.states.get(id);
    if (s) copyState(state, s);
  }

  setRemoteProxy(_id: number, _pos: Vec3, _rot: Quat, _vel: Vec3, _state: number): void {}

  getObstacleNetStates(): Map<string, number[]> {
    return new Map([['door', [Math.floor(this.t)]]]);
  }

  setObstacleNetState(): void {}

  forfeit(playerId: number): void {
    if (!this.forfeited.includes(playerId)) this.forfeited.push(playerId);
  }

  getStatus(): RoundStatus {
    return {
      phase: 4,
      time: this.t,
      timeLeft: 60 - this.t,
      qualifiedCount: 0,
      qualifyTarget: 10,
      eliminatedCount: 0,
      teamScores: [],
      players: new Map(),
      finished: false,
    };
  }

  getStandings(): number[] {
    return [...this.states.keys()];
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A tiny valid round. */
export function testRound(): RoundDefinition {
  return RoundDefinitionSchema.parse({
    id: 'test-round',
    name: 'Test',
    type: 'race',
    theme: 'candy',
    objective: 'test',
    players: { min: 1, max: 60, ideal: 40 },
    qualification: { mode: 'finish' },
    duration: { seconds: 60 },
    bounds: { min: { x: -100, y: -20, z: -100 }, max: { x: 100, y: 50, z: 100 } },
    spawn: { origin: { x: 0, y: 1, z: 0 } },
    geometry: [],
    obstacles: [{ id: 'door', type: 'x', position: { x: 0, y: 0, z: 0 } }],
    flyover: {
      path: [
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ],
      lookAt: [{ x: 0, y: 0, z: 0 }],
    },
    music: 'none',
    fallBehavior: 'eliminate',
  });
}

/** Test deps with a controllable clock. */
export function testDeps(clock: { now: number }, sims: FakeMatchSim[]): RoomDeps {
  return {
    // The fake sim never calls into Rapier.
    R: { version: () => 'test' } as unknown as Rapier,
    createMatchSim: (o) => {
      const s = new FakeMatchSim(o);
      sims.push(s);
      return s;
    },
    loadRound: () => testRound(),
    createShowController: () => new SimpleShowController({ roundId: 'test-round', playSeconds: 1000 }),
    createBot: () => ({
      think(_sim, _id, out) {
        out.moveX = 0.5;
        out.moveZ = 0;
        out.yaw = 0;
        out.buttons = 0;
        out.emote = 0;
      },
    }),
    now: () => clock.now,
    randomSeed: () => 1234,
  };
}

/** Minimal protocol client over a {@link FakeConnection}. */
export class TestClient {
  welcome: WelcomeMsg | null = null;
  readonly messages: ReliableMessage[] = [];
  readonly snapshots: DecodedSnapshot[] = [];
  readonly reliable = new ReliableEndpoint();
  readonly decoder = new SnapshotDecoder();
  quantizer: PositionQuantizer | null = null;
  kicked = false;
  private readonly w = new BitWriter();
  private readonly r = new BitReader();
  private seq = 0;

  constructor(readonly conn: FakeConnection) {}

  hello(name = 'tester', resumeToken = '', ticket = ''): void {
    writeHello(this.w.reset(), { version: PROTOCOL_VERSION, name, resumeToken, loadout: 'blue', ticket });
    this.conn.receive(this.w.finish());
  }

  /** Processes everything the server sent since the last call. */
  pump(now = 0): void {
    for (const data of this.conn.drain()) {
      const r = this.r.reset(data);
      const type = r.readBits(8);
      if (type === MsgType.Welcome) this.welcome = readWelcome(r);
      else if (type === MsgType.Kick) this.kicked = true;
      else if (type === MsgType.Reliable) {
        this.reliable.receive(r, (p) => {
          const m = decodeReliableMessage(p);
          if (!m) return;
          this.messages.push(m);
          if (m.kind === 'msg' && m.msg.t === 'joinRound') {
            this.quantizer = new PositionQuantizer(m.msg.bounds);
            this.decoder.reset();
          }
        });
      } else if (type === MsgType.Snapshot && this.quantizer) {
        const out = createDecodedSnapshot();
        if (this.decoder.decode(r, this.quantizer, out) === 'ok') this.snapshots.push(out);
      }
    }
    if (this.reliable.flush(now, 50, this.w.reset())) this.conn.receive(this.w.finish());
  }

  /** Sends one input (with the newest snapshot ack). */
  input(input: CharacterInput): number {
    const seq = this.seq++;
    writeInputBatch(
      this.w.reset(),
      { newestSeq: seq, clientTick: seq, ackSnapshotId: this.decoder.newestId, count: 1 },
      [input],
    );
    this.conn.receive(this.w.finish());
    return seq;
  }

  /** Queues a low-frequency message; the next {@link pump} flushes it. */
  send(msg: LowFreqMessage): void {
    this.reliable.send(encodeReliableMessage({ kind: 'msg', msg }));
  }

  lowFreq(t: LowFreqMessage['t']): LowFreqMessage[] {
    return this.messages.flatMap((m) => (m.kind === 'msg' && m.msg.t === t ? [m.msg] : []));
  }
}
