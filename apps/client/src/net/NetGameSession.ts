/**
 * Glue between {@link NetClient}, {@link PredictionController} and
 * {@link RemoteEntities} for one connected game: builds the predict sim when a
 * round starts, routes snapshots (reconciliation, remote samples, obstacle
 * states), mirrors phases, and exposes render-ready transforms.
 *
 * The composition root (`main.ts`) creates one of these and calls
 * {@link frame} every animation frame.
 */
import {
  MAX_ENTITIES,
  createRenderEntityState,
  type DecodedSnapshot,
  type JoinRoundMsg,
  type MatchPlayerInfo,
  type MatchSim,
  type RenderEntityState,
} from '@tumble/netcode';
import type { CharacterInput, SimEvent } from '@tumble/sim';
import { RoundPhase } from '@tumble/shared';
import type { NetClient } from './NetClient.ts';
import { PredictionController, type PredictionOptions } from './PredictionController.ts';
import { RemoteEntities } from './RemoteEntities.ts';

/** Builds the client's MatchSim (`mode: 'predict'`) for a round. */
export type CreatePredictSim = (join: JoinRoundMsg, localPlayerId: number) => MatchSim | Promise<MatchSim>;

/** Event types the local sim predicts for the local player; the server's copies are dropped. */
const PREDICTED_EVENTS: ReadonlySet<SimEvent['type']> = new Set([
  'jump',
  'land',
  'dive',
  'getUp',
  'emote',
  'bounce',
]);

/**
 * True when a server SimEvent duplicates something the local prediction
 * already played (so VFX/SFX fire once, without latency).
 */
export function isPredictedLocally(event: SimEvent, localPlayerId: number): boolean {
  return PREDICTED_EVENTS.has(event.type) && 'player' in event && event.player === localPlayerId;
}

/** Options for {@link NetGameSession}. */
export interface NetGameSessionOptions {
  prediction?: PredictionOptions;
  /** Gameplay events for VFX/SFX/UI: predicted local ones immediately, server ones on arrival. */
  onEvent?: (event: SimEvent, predicted: boolean) => void;
  /** Called when a round's predict sim is ready (load visuals, set camera…). */
  onRoundReady?: (join: JoinRoundMsg, sim: MatchSim) => void;
}

/**
 * One networked game session.
 *
 * @example
 * const session = new NetGameSession(net, (join, id) => createMatchSim({ ...opts, mode: 'predict', localPlayerId: id }, deps));
 * function raf(t) { session.frame(t, () => input.sample()); render(session.local, session.remotes); }
 */
export class NetGameSession {
  readonly remotes: RemoteEntities;
  /** The local player's render state (prediction + smoothing). */
  readonly local: RenderEntityState = createRenderEntityState();
  prediction: PredictionController | null = null;
  sim: MatchSim | null = null;
  private lastFrameMs = -1;
  private loading = 0;
  /**
   * Lobby: 1 for ids the server explicitly removed (left for good), as
   * opposed to remotes momentarily unknown after a reconnect rebuild.
   */
  readonly lobbyLeft = new Uint8Array(MAX_ENTITIES);
  /** Lobby sims: remote ids that already have a proxy. */
  private readonly lobbyKnown = new Uint8Array(MAX_ENTITIES);
  private readonly lobbyInfo: MatchPlayerInfo = { id: 0, name: '', isBot: false, team: -1 };
  private readonly offs: (() => void)[] = [];

  /**
   * @param net - Connected (or connecting) client.
   * @param createPredictSim - Predict-mode sim factory (the integrator wires `createMatchSim`).
   * @param opts - Hooks and tuning.
   */
  constructor(
    readonly net: NetClient,
    private readonly createPredictSim: CreatePredictSim,
    private readonly opts: NetGameSessionOptions = {},
  ) {
    this.remotes = new RemoteEntities(net.playerId);
    this.offs.push(
      net.on('welcome', (w) => {
        this.remotes.localPlayerId = w.playerId;
      }),
      net.on('joinRound', (j) => void this.startRound(j)),
      net.on('snapshot', (s) => this.onSnapshot(s)),
      net.on('roundPhase', ({ phase }) => this.prediction?.setPhase(phase)),
      net.on('simEvent', ({ event }) => {
        if (!isPredictedLocally(event, net.playerId)) this.opts.onEvent?.(event, false);
      }),
    );
  }

  /**
   * Per-frame update: network housekeeping, local prediction steps, remote interpolation.
   *
   * @param nowMs - `performance.now()` / rAF timestamp.
   * @param sampleInput - Current input state (called once per fixed step).
   */
  frame(nowMs: number, sampleInput: () => CharacterInput): void {
    const dt = this.lastFrameMs < 0 ? 0 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    this.net.update();
    this.prediction?.advance(dt, sampleInput);
    this.remotes.update(nowMs, this.sim);
    const p = this.prediction;
    const s = p?.latestState();
    if (p && s) {
      p.renderPosition(this.local.pos);
      this.local.id = this.net.playerId;
      this.local.rot.x = s.rot.x;
      this.local.rot.y = s.rot.y;
      this.local.rot.z = s.rot.z;
      this.local.rot.w = s.rot.w;
      this.local.vel.x = s.vel.x;
      this.local.vel.y = s.vel.y;
      this.local.vel.z = s.vel.z;
      this.local.state = s.state;
      this.local.stateTime = s.stateTime;
      this.local.facing = s.facing;
      this.local.flags = s.flags;
      this.local.grabTarget = s.grabTarget;
    }
  }

  /** Unsubscribes and disposes the predict sim. */
  dispose(): void {
    for (const off of this.offs) off();
    this.sim?.dispose();
    this.sim = null;
    this.prediction = null;
  }

  private async startRound(join: JoinRoundMsg): Promise<void> {
    const token = ++this.loading;
    this.sim?.dispose();
    this.sim = null;
    this.prediction = null;
    this.remotes.reset();
    this.lobbyKnown.fill(0);
    this.lobbyLeft.fill(0);
    if (join.lobby) for (const p of join.players) if (p.id !== this.net.playerId) this.lobbyKnown[p.id] = 1;
    const sim = await this.createPredictSim(join, this.net.playerId);
    // A newer round started while this one was loading.
    if (token !== this.loading) {
      sim.dispose();
      return;
    }
    // The pre-show platform is always live: no LOADING/countdown gate.
    if (join.lobby) sim.setPhase(RoundPhase.Playing, 0);
    this.sim = sim;
    const net = this.net;
    this.prediction = new PredictionController(
      sim,
      net.playerId,
      {
        matchTime: () => net.matchTime(),
        rttMs: () => net.rtt,
        sendInput: (seq, history) => net.sendInput(seq, history),
        onPredictedEvent: (e) => this.opts.onEvent?.(e, true),
      },
      this.opts.prediction,
    );
    if (!join.lobby) net.sendLowFreq({ t: 'loaded', roundId: join.roundId });
    this.opts.onRoundReady?.(join, sim);
  }

  /**
   * Lobby sims gain and lose players live: give every newly seen remote a
   * kinematic proxy (so the local Tumbler bumps into it) and drop leavers.
   */
  private syncLobbyProxies(s: DecodedSnapshot, sim: MatchSim): void {
    for (let i = 0; i < s.removedCount; i++) {
      const id = s.removed[i]!;
      this.lobbyLeft[id] = 1;
      if (this.lobbyKnown[id]) {
        this.lobbyKnown[id] = 0;
        sim.removePlayer?.(id);
      }
    }
    for (let i = 0; i < s.entityCount; i++) {
      const e = s.entities[i]!;
      this.lobbyLeft[e.id] = 0;
      if (e.id === this.net.playerId || this.lobbyKnown[e.id]) continue;
      this.lobbyKnown[e.id] = 1;
      const info = this.lobbyInfo;
      info.id = e.id;
      sim.addPlayer?.(info, e.pos);
    }
  }

  private onSnapshot(s: DecodedSnapshot): void {
    const now = performance.now();
    this.remotes.onSnapshot(s, now, s.serverTick * this.net.tickMs);
    const sim = this.sim;
    const round = this.net.round;
    if (sim && round?.lobby) this.syncLobbyProxies(s, sim);
    if (sim && round) {
      for (let i = 0; i < s.obstacleCount; i++) {
        const id = round.obstacleIds[s.obstacleIndices[i]!];
        if (id !== undefined) sim.setObstacleNetState(id, s.obstacleValues[i]!);
      }
    }
    if (!this.prediction) return;
    for (let i = 0; i < s.entityCount; i++) {
      const e = s.entities[i]!;
      if (e.id === this.net.playerId) {
        this.prediction.reconcile(s.ackedInputSeq, e, s.matchTime);
        break;
      }
    }
  }
}
