/**
 * Online show runner (`?online=1`): connects to the game server, plays the
 * server's real show (ShowDirector) with local prediction of the player's
 * Tumbler and interpolated remotes, and maps the reliable phase/fate/results
 * messages onto the same choreography as offline play.
 */
import { MAIN_SHOW } from '@tumble/content/shows';
import { getRound } from '@tumble/content/rounds';
import type { DecodedSnapshot, JoinRoundMsg, NetPlayerInfo, RoundResultEntry } from '@tumble/netcode';
import { RoundPhase, ShowPhase, type RoundPhaseId } from '@tumble/shared';
import { emptyInput, type SimEvent } from '@tumble/sim';
import { PlayerRoundStatus, createMatchSim, type MatchSim, type MatchSimHandle } from '@tumble/sim/match';
import { ShowPlaylistSchema } from '@tumble/sim/show';
import { bindUI, ui } from '@tumble/ui';
import { NetClient, NetGameSession, type ConnectionState } from '../../net/index.ts';
import { botLoadout, decodeLoadout, encodeLoadout } from '../cosmetics.ts';
import type { HudInput } from '../round/hud.ts';
import { OnlineRoundSource, type RoundSource } from '../round/source.ts';
import type { GameContext, RoundOutcomeInfo, RoundStart, SessionPlayer } from './context.ts';
import { ShowSession } from './session.ts';

const MAIN = ShowPlaylistSchema.parse(MAIN_SHOW);

/**
 * Probes the game server through the Vite proxy.
 *
 * @param timeoutMs - Give up after this long.
 * @returns True when `/gs/health` answers.
 */
export async function gameServerAvailable(timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // `?gs=ws://host:port/ws` points at a specific server; probe that one instead of the dev proxy.
    const gs = new URLSearchParams(location.search).get('gs');
    const url = gs ? gs.replace(/^ws/, 'http').replace(/\/ws$/, '/health') : '/gs/health';
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

/** A connected show. */
export class OnlineShowSession extends ShowSession {
  private readonly net: NetClient;
  private readonly session: NetGameSession;
  private predictSim: MatchSimHandle | null = null;
  private readonly events: SimEvent[] = [];
  private readonly input = emptyInput();
  private roundIndex = -1;
  private preShowEntered = false;
  private roomSeed = 0;
  private lastJoin: JoinRoundMsg | null = null;
  private readonly unsub: (() => void)[] = [];
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

  constructor(ctx: GameContext) {
    super(ctx);
    this.showName = MAIN.name;
    this.net = new NetClient({ name: ctx.profile.name, loadout: encodeLoadout(ctx.profile.tumblerLoadout()) });
    this.session = new NetGameSession(this.net, (join) => this.createPredictSim(join), {
      onEvent: (e) => this.events.push(e),
      onRoundReady: () => this.buildRoundView(),
    });
  }

  start(): void {
    const s = ui.getState();
    s.setQueue({ status: 'searching', startedAt: Date.now(), playersFound: 1, playersNeeded: 40, etaSec: -1, region: 'Local server' });
    s.setScreen('matchmaking');
    s.setConnection({ status: 'connecting' });
    const net = this.net;
    this.unsub.push(
      net.on('state', (st) => this.onConnection(st)),
      net.on('welcome', (w) => {
        this.localId = w.playerId;
        ui.getState().setConnection({ status: 'online' });
      }),
      net.on('lobby', (l) => {
        ui.getState().setQueue({ playersFound: l.humans, playersNeeded: l.capacity, etaSec: Math.max(0, Math.ceil(l.startsInMs / 1000)) });
      }),
      net.on('playerList', (list) => {
        this.onPlayerList(list);
        // The director starts in PreShow without announcing it; bots joining means the show is on.
        if (list.some((p) => p.isBot)) this.enterOnlinePreShow();
      }),
      net.on('showPhase', (p) => this.onServerShowPhase(p)),
      net.on('joinRound', (j) => this.onJoin(j)),
      net.on('roundPhase', ({ phase }) => this.onRoundPhase(phase as RoundPhaseId)),
      net.on('roundResults', ({ roundId, results }) => this.onResults(roundId, results)),
      net.on('showSummary', (m) => this.onSummary(m.winners, m.rounds)),
      net.on('snapshot', (snap) => this.onSnapshot(snap)),
      net.on('kicked', ({ detail }) => this.fail(detail || 'Removed from the show')),
      bindUI({
        onDialogResult: ({ dialogId }) => {
          if (dialogId === 'net-failed') this.ctx.onEnd('failed');
        },
      }),
    );
    net.connect();
  }

  private createPredictSim(join: JoinRoundMsg): MatchSim {
    const round = getRound(join.roundId);
    if (!round) throw new Error(`Unknown round "${join.roundId}" from the server`);
    const sim = createMatchSim(
      { R: this.ctx.R, round, seed: join.seed, stage: join.stage, players: join.players, mode: 'predict', localPlayerId: this.net.playerId },
      this.ctx.matchDeps,
    ) as MatchSimHandle;
    this.predictSim = sim;
    return sim;
  }

  private onConnection(st: ConnectionState): void {
    const s = ui.getState();
    if (st === 'reconnecting') s.setConnection({ status: 'reconnecting', attempt: 1, maxAttempts: 5, message: 'Hold tight, wobbling back in…' });
    else if (st === 'connected') s.setConnection({ status: 'online' });
    else if (st === 'connecting') s.setConnection({ status: 'connecting' });
    else if (st === 'failed') this.fail('Connection lost');
  }

  private fail(message: string): void {
    const s = ui.getState();
    s.setConnection({ status: 'offline', message });
    s.showDialog({ id: 'net-failed', kind: 'error', title: 'Connection lost', body: message, code: 'E-NET-04', buttons: [{ id: 'menu', label: 'Back to menu', autofocus: true }] });
  }

  private onPlayerList(list: NetPlayerInfo[]): void {
    for (const p of list) {
      const prev = this.players.get(p.id);
      const loadout = (p.id === this.net.playerId ? this.ctx.profile.tumblerLoadout() : decodeLoadout(p.loadout)) ?? prev?.loadout ?? botLoadout(this.roomSeed, p.id, p.name);
      const sp: SessionPlayer = { id: p.id, name: p.name, isBot: p.isBot, loadout };
      this.players.set(p.id, sp);
      if (!this.order.includes(p.id)) this.order.push(p.id);
    }
  }

  private onServerShowPhase(phase: number): void {
    this.onShowPhaseChanged(phase);
    if (phase === ShowPhase.PreShow && !this.preShowEntered) this.enterOnlinePreShow();
  }

  private enterOnlinePreShow(): void {
    if (this.preShowEntered) return;
    this.preShowEntered = true;
    const s = ui.getState();
    s.setQueue({ status: 'found', playersFound: this.order.length || 40 });
    s.setScreen('matchFound');
    this.after(1.5, () => {
      if (this.roundIndex < 0) this.enterPreShow(7, MAIN);
    });
  }

  private onJoin(j: JoinRoundMsg): void {
    const round = getRound(j.roundId);
    if (!round) {
      this.fail(`This build doesn't have the round "${j.roundId}"`);
      return;
    }
    this.roomSeed = j.seed;
    this.lastJoin = j;
    for (const p of j.players) {
      if (!this.players.has(p.id)) {
        this.players.set(p.id, { id: p.id, name: p.name, isBot: p.isBot, loadout: botLoadout(j.seed, p.id, p.name) });
        this.order.push(p.id);
      }
    }
    this.roundIndex++;
    const isFinal = round.type === 'final' || j.players.length <= 2;
    const start: RoundStart = {
      index: this.roundIndex,
      isFinal,
      round,
      players: j.players,
      seed: j.seed,
      stage: j.stage,
      qualifyTarget: isFinal ? 1 : Math.max(1, Math.round(j.players.length * (MAIN.qualifyCurve[this.roundIndex] ?? round.qualification.ratio))),
    };
    this.onRoundSelected(start);
  }

  private onResults(roundId: string, results: RoundResultEntry[]): void {
    const round = getRound(roundId);
    const q = results.filter((r) => r.status === PlayerRoundStatus.Qualified).sort((a, b) => a.place - b.place);
    const e = results.filter((r) => r.status !== PlayerRoundStatus.Qualified).sort((a, b) => a.place - b.place);
    const info: RoundOutcomeInfo = {
      roundId,
      name: round?.name ?? roundId,
      type: round?.type ?? 'race',
      isFinal: this.round?.start.isFinal ?? false,
      qualified: q.map((r) => r.id),
      eliminated: e.map((r) => r.id),
    };
    this.onRoundOutcome(info);
  }

  private onSummary(winners: number[], rounds: { roundId: string; qualified: number[] }[]): void {
    const outcomes = this.outcomes.length >= rounds.length ? this.outcomes.slice() : rounds.map((r, i) => {
      const entrants = i === 0 ? this.order : (rounds[i - 1]?.qualified ?? []);
      const round = getRound(r.roundId);
      const q = new Set(r.qualified);
      return { roundId: r.roundId, name: round?.name ?? r.roundId, type: round?.type ?? ('race' as const), isFinal: i === rounds.length - 1, qualified: r.qualified, eliminated: entrants.filter((id) => !q.has(id)) };
    });
    const placements = new Map<number, number>();
    let place = 1;
    for (const w of winners) placements.set(w, place++);
    for (let i = outcomes.length - 1; i >= 0; i--) {
      const o = outcomes[i] as RoundOutcomeInfo;
      for (const id of [...o.qualified, ...o.eliminated]) if (!placements.has(id)) placements.set(id, place++);
    }
    for (const id of this.order) if (!placements.has(id)) placements.set(id, place++);
    this.onShowEnded({ winnerId: winners[0] ?? null, rounds: outcomes, placements });
  }

  private onSnapshot(s: DecodedSnapshot): void {
    const h = this.hudInput;
    const st = s.status;
    h.timeLeft = st.timeLeft;
    h.qualifiedCount = st.qualifiedCount;
    h.qualifyTarget = st.qualifyTarget;
    h.eliminatedCount = st.eliminatedCount;
    h.overtime = st.phase === RoundPhase.Overtime;
    h.teamScores = st.teamScores.slice(0, st.teamCount);
  }

  protected advance(): void {
    this.session.frame(performance.now(), () => this.fillInput(this.input));
    if (this.events.length > 0) {
      this.onSimEvents(this.events);
      this.events.length = 0;
    }
  }

  protected createSource(rs: RoundStart): RoundSource | null {
    const sim = this.predictSim;
    if (!sim || this.session.sim !== sim || sim.round.id !== rs.round.id || this.lastJoin?.roundId !== rs.round.id) return null;
    return new OnlineRoundSource(sim, rs.players, rs.players.some((p) => p.id === this.localId) ? this.localId : -1, this.session);
  }

  protected liveStatus(): HudInput | null {
    return this.round ? this.hudInput : null;
  }

  protected override ping(): number {
    return this.net.rtt;
  }

  protected override onDispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.session.dispose();
    this.net.close();
    ui.getState().setConnection({ status: 'online' });
  }
}
