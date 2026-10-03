/**
 * Online show runner: connects to a game server and plays the server's real
 * show (ShowDirector) with local prediction of the player's Tumbler and
 * interpolated remotes, mapping the reliable phase/fate/results messages onto
 * the same choreography as offline play.
 *
 * Two ways in:
 * - matchmade (`match_found`): the matchmaker's server URL + join ticket; the
 *   server posts results to the account API and forwards this player's grant
 *   (`showRewards`), which the rewards screen shows;
 * - dev (`?online=1`): an unticketed join to the local game server.
 *
 * Also derives race-progress leaders from the interpolated positions (the
 * snapshot carries no per-player progress) and plays remote Tumblers' equipped
 * emotes.
 */
import { MAIN_SHOW, getPlaylist } from '@tumble/content/shows';
import { getRound } from '@tumble/content/rounds';
import type {
  DecodedSnapshot,
  JoinRoundMsg,
  NetPlayerInfo,
  PlayerRewardMsg,
  RoundResultEntry,
  ShowInfoMsg,
} from '@tumble/netcode';
import { CharacterState } from '@tumble/sim';
import { RoundPhase, ShowPhase, type RoundDefinition, type RoundPhaseId } from '@tumble/shared';
import { emptyInput, type SimEvent } from '@tumble/sim';
import {
  PlayerRoundStatus,
  clampRoundTimeScale,
  createMatchSim,
  scaleRoundTimer,
  type MatchPlayerInfo,
  type MatchSim,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { CourseMetric } from '@tumble/sim/rounds';
import { ShowPlaylistSchema } from '@tumble/sim/show';
import { bindUI, ui, type RewardsSummary } from '@tumble/ui';
import {
  NetClient,
  NetGameSession,
  defaultServerUrl,
  type ConnectionState,
  type ReconnectAttempt,
} from '../../net/index.ts';
import { botLoadout, decodeLoadout, encodeLoadout } from '../cosmetics.ts';
import type { ShowResultForProfile } from '../profile.ts';
import type { HudInput, HudPlayerStatus } from '../round/hud.ts';
import {
  OnlineRoundSource,
  createPlayerSample,
  type PlayerSample,
  type RoundSource,
} from '../round/source.ts';
import type { GameContext, RoundOutcomeInfo, RoundStart, SessionPlayer } from './context.ts';
import { ShowSession } from './session.ts';

const MAIN = ShowPlaylistSchema.parse(MAIN_SHOW);
/** Leader/progress recompute rate (the HUD pushes at 12 Hz). */
const LEADER_INTERVAL_S = 0.1;

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
    // Probe the same server NetClient will connect to.
    const ws = defaultServerUrl();
    const url = ws.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

/** How to reach the show. */
export interface OnlineShowOptions {
  /** Game server WebSocket URL (default: `?gs=` or the dev proxy). */
  url?: string;
  /** Matchmaker join ticket. */
  ticket?: string;
  /** Match id from `match_found` (rewards are expected for it). */
  matchId?: string;
  /** Playlist id for the show name before `showInfo` arrives. */
  playlistId?: string;
}

/**
 * Online source that also replays remote emotes: the snapshot carries the
 * Emote state, the `emote` SimEvent says which wheel slot.
 */
class EmotingSource implements RoundSource {
  constructor(
    private readonly inner: OnlineRoundSource,
    private readonly emoteSlots: ReadonlyMap<number, number>,
  ) {}

  get sim(): MatchSimHandle {
    return this.inner.sim;
  }

  get players(): readonly MatchPlayerInfo[] {
    return this.inner.players;
  }

  get localId(): number {
    return this.inner.localId;
  }

  get alive(): boolean {
    return this.inner.alive;
  }

  renderTime(): number {
    return this.inner.renderTime();
  }

  sample(id: number, out: PlayerSample): boolean {
    if (!this.inner.sample(id, out)) return false;
    if (id !== this.inner.localId && out.state === CharacterState.Emote)
      out.emote = this.emoteSlots.get(id) ?? 1;
    return true;
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
  private showInfo: ShowInfoMsg | null = null;
  private apiReward: PlayerRewardMsg | null | undefined = undefined;
  private welcomed = false;
  private readonly unsub: (() => void)[] = [];
  private readonly emoteSlots = new Map<number, number>();
  private readonly fates = new Map<number, number>();
  private readonly qualifyOrder: number[] = [];
  private course: CourseMetric | null = null;
  private courseRound: RoundDefinition | null = null;
  private leaderAcc = LEADER_INTERVAL_S;
  private readonly sampleTmp = createPlayerSample();
  private readonly pos = { x: 0, y: 0, z: 0 };
  private readonly hudPlayers = new Map<number, HudPlayerStatus>();
  private standings: number[] = [];
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

  constructor(
    ctx: GameContext,
    private readonly opts: OnlineShowOptions = {},
  ) {
    super(ctx);
    this.showName = (opts.playlistId ? getPlaylist(opts.playlistId)?.name : undefined) ?? MAIN.name;
    this.net = new NetClient({
      name: ctx.playerName(),
      loadout: encodeLoadout(ctx.look()),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.ticket ? { ticket: opts.ticket } : {}),
    });
    this.session = new NetGameSession(this.net, (join) => this.createPredictSim(join), {
      onEvent: (e) => this.events.push(e),
      onRoundReady: () => this.buildRoundView(),
    });
  }

  start(): void {
    const s = ui.getState();
    if (this.opts.ticket) {
      s.setQueue({ status: 'found' });
      s.setScreen('matchFound');
    } else {
      s.setQueue({
        status: 'searching',
        startedAt: Date.now(),
        playersFound: 1,
        playersNeeded:
          (this.opts.playlistId ? getPlaylist(this.opts.playlistId) : undefined)?.maxPlayers ??
          MAIN.maxPlayers,
        etaSec: -1,
        region: 'Local server',
      });
      s.setScreen('matchmaking');
    }
    s.setConnection({ status: 'connecting' });
    const net = this.net;
    this.unsub.push(
      net.on('state', (st) => this.onConnection(st)),
      net.on('reconnect', (a) => this.onReconnectAttempt(a)),
      net.on('welcome', (w) => {
        // A fresh (non-resumed) Welcome mid-show means the server lost the room (restart): the show is gone.
        if (this.welcomed && !w.resumed && (this.preShowEntered || this.roundIndex >= 0)) {
          this.fail('The show server restarted and this show was lost.');
          return;
        }
        this.welcomed = true;
        this.localId = w.playerId;
        ui.getState().setConnection({ status: 'online' });
      }),
      net.on('lobby', (l) => {
        ui.getState().setQueue({
          playersFound: l.humans,
          playersNeeded: l.capacity,
          etaSec: Math.max(0, Math.ceil(l.startsInMs / 1000)),
        });
      }),
      net.on('playerList', (list) => {
        this.onPlayerList(list);
        // The director starts in PreShow without announcing it; bots joining means the show is on.
        if (list.some((p) => p.isBot)) this.enterOnlinePreShow();
      }),
      net.on('message', (m) => {
        if (m.t === 'showInfo') this.onShowInfo(m);
        else if (m.t === 'showRewards') this.apiReward = m.reward;
      }),
      net.on('showPhase', (p) => this.onServerShowPhase(p)),
      net.on('joinRound', (j) => this.onJoin(j)),
      net.on('roundPhase', ({ phase }) => this.onRoundPhase(phase as RoundPhaseId)),
      net.on('roundResults', ({ roundId, results }) => this.onResults(roundId, results)),
      net.on('showSummary', (m) => this.onSummary(m.winners, m.rounds)),
      net.on('snapshot', (snap) => this.onSnapshot(snap)),
      net.on('kicked', ({ reason, detail }) =>
        this.fail(
          reason === 7 ? 'Your match ticket expired — queue again.' : detail || 'Removed from the show',
        ),
      ),
      bindUI({
        onDialogResult: ({ dialogId }) => {
          if (dialogId === 'net-failed') this.ctx.onEnd('failed');
        },
      }),
    );
    this.ctx.account?.markShowStart();
    net.connect();
  }

  private createPredictSim(join: JoinRoundMsg): MatchSim {
    const round = getRound(join.roundId);
    if (!round) throw new Error(`Unknown round "${join.roundId}" from the server`);
    const sim = createMatchSim(
      {
        R: this.ctx.R,
        round,
        seed: join.seed,
        stage: join.stage,
        players: join.players,
        mode: 'predict',
        localPlayerId: this.net.playerId,
        // Same layout and quota as the server, so predicted obstacles match the authoritative ones.
        ...(join.variationId ? { variationId: join.variationId } : {}),
        ...(join.qualifyTarget > 0 ? { qualifyTarget: join.qualifyTarget } : {}),
        ...(join.mutatorId ? { mutatorId: join.mutatorId } : {}),
        ...(join.roundTimeScale !== undefined ? { roundTimeScale: join.roundTimeScale } : {}),
      },
      this.ctx.matchDeps,
    ) as MatchSimHandle;
    this.predictSim = sim;
    return sim;
  }

  private onConnection(st: ConnectionState): void {
    const s = ui.getState();
    if (this.summary) return;
    // Reconnect attempts arrive through `reconnect` with their real numbers.
    if (st === 'connected') s.setConnection({ status: 'online' });
    else if (st === 'connecting') s.setConnection({ status: 'connecting' });
    else if (st === 'failed') this.connectionLost();
  }

  private onReconnectAttempt(a: ReconnectAttempt): void {
    if (this.summary || this.failed) return;
    ui.getState().setConnection({
      status: 'reconnecting',
      attempt: a.attempt,
      maxAttempts: a.maxAttempts,
      nextAttemptAt: Date.now() + a.delayMs,
      message: 'Hold tight, wobbling back in…',
    });
  }

  /** Every attempt failed: the curtain offers Try again and Leave (kicks and lost rooms use {@link fail}). */
  private connectionLost(): void {
    if (this.failed || this.summary) return;
    const prev = ui.getState().connection;
    ui.getState().setConnection({
      status: 'lost',
      message: "We couldn't get your Tumbler back into the show.",
      ...(prev.maxAttempts !== undefined ? { maxAttempts: prev.maxAttempts } : {}),
    });
  }

  override retryConnection(): void {
    if (this.failed || this.summary) return;
    if (!this.net.retry()) this.fail('Connection lost');
  }

  private failed = false;

  private fail(message: string): void {
    // After the show summary the server winds the room down; the wall and rewards don't need the socket.
    if (this.failed || this.summary) return;
    this.failed = true;
    const s = ui.getState();
    s.setConnection({ status: 'offline', message });
    s.showDialog({
      id: 'net-failed',
      kind: 'error',
      title: 'Connection lost',
      body: message,
      code: 'E-NET-04',
      buttons: [{ id: 'menu', label: 'Back to menu', autofocus: true }],
    });
  }

  private onShowInfo(m: ShowInfoMsg): void {
    this.showInfo = m;
    this.showName = m.showName;
    this.roundCount = Math.max(1, m.roundCount);
  }

  private onPlayerList(list: NetPlayerInfo[]): void {
    for (const p of list) {
      const prev = this.players.get(p.id);
      const loadout =
        (p.id === this.net.playerId ? this.ctx.look() : decodeLoadout(p.loadout)) ??
        prev?.loadout ??
        botLoadout(this.roomSeed, p.id, p.name);
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
      if (this.roundIndex < 0) this.enterPreShow(7, this.showInfo ? null : MAIN);
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
        this.players.set(p.id, {
          id: p.id,
          name: p.name,
          isBot: p.isBot,
          loadout: botLoadout(j.seed, p.id, p.name),
        });
        this.order.push(p.id);
      }
    }
    // A resume re-sends the current round's joinRound; only a new round index starts a new round.
    const index = j.roundIndex;
    if (index === this.roundIndex && this.round?.start.round.id === j.roundId) return;
    this.roundIndex = index;
    this.fates.clear();
    this.qualifyOrder.length = 0;
    this.emoteSlots.clear();
    this.course = null;
    this.courseRound = null;
    const start: RoundStart = {
      index,
      isFinal: j.isFinal,
      // Same timer the server runs, so the rules card and HUD clock match it.
      round: scaleRoundTimer(round, clampRoundTimeScale(j.roundTimeScale)),
      players: j.players,
      seed: j.seed,
      stage: j.stage,
      qualifyTarget: j.isFinal ? 1 : Math.max(1, j.qualifyTarget),
      mutatorId: j.mutatorId ?? null,
    };
    this.onRoundSelected(start);
  }

  private onResults(roundId: string, results: RoundResultEntry[]): void {
    const round = getRound(roundId);
    const q = results
      .filter((r) => r.status === PlayerRoundStatus.Qualified)
      .sort((a, b) => a.place - b.place);
    const e = results
      .filter((r) => r.status !== PlayerRoundStatus.Qualified)
      .sort((a, b) => a.place - b.place);
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
    const outcomes =
      this.outcomes.length >= rounds.length
        ? this.outcomes.slice()
        : rounds.map((r, i) => {
            const entrants = i === 0 ? this.order : (rounds[i - 1]?.qualified ?? []);
            const round = getRound(r.roundId);
            const q = new Set(r.qualified);
            return {
              roundId: r.roundId,
              name: round?.name ?? r.roundId,
              type: round?.type ?? ('race' as const),
              isFinal: i === rounds.length - 1,
              qualified: r.qualified,
              eliminated: entrants.filter((id) => !q.has(id)),
            };
          });
    const placements = new Map<number, number>();
    let place = 1;
    for (const w of winners) placements.set(w, place++);
    for (let i = outcomes.length - 1; i >= 0; i--) {
      const o = outcomes[i] as RoundOutcomeInfo;
      for (const id of [...o.qualified, ...o.eliminated])
        if (!placements.has(id)) placements.set(id, place++);
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
      for (const e of this.events) {
        if (e.type === 'emote' && e.emote > 0) this.emoteSlots.set(e.player, e.emote);
        else if (e.type === 'qualified') {
          this.fates.set(e.player, PlayerRoundStatus.Qualified);
          if (!this.qualifyOrder.includes(e.player)) this.qualifyOrder.push(e.player);
        } else if (e.type === 'eliminated') this.fates.set(e.player, PlayerRoundStatus.Eliminated);
      }
      this.onSimEvents(this.events);
      this.events.length = 0;
    }
  }

  protected createSource(rs: RoundStart): RoundSource | null {
    const sim = this.predictSim;
    if (
      !sim ||
      this.session.sim !== sim ||
      sim.round.id !== rs.round.id ||
      this.lastJoin?.roundId !== rs.round.id
    )
      return null;
    const inner = new OnlineRoundSource(
      sim,
      rs.players,
      rs.players.some((p) => p.id === this.localId) ? this.localId : -1,
      this.session,
    );
    return new EmotingSource(inner, this.emoteSlots);
  }

  /**
   * Per-player progress and standings from interpolated positions (race-style
   * rounds) and the fate events seen so far, at 10 Hz.
   */
  private updateStandings(): void {
    const r = this.round;
    const source = r?.source;
    if (!r || !source?.alive) return;
    const round = r.start.round;
    const racing = round.qualification.mode === 'finish' || round.type === 'race';
    if (racing && this.courseRound !== round) {
      this.courseRound = round;
      this.course = new CourseMetric(round, round.spawn.origin);
    }
    const ids: number[] = [];
    for (const p of r.start.players) {
      const fate = this.fates.get(p.id) ?? PlayerRoundStatus.Playing;
      let progress = 0;
      if (fate === PlayerRoundStatus.Qualified) progress = 1;
      else if (this.course && source.sample(p.id, this.sampleTmp)) {
        this.pos.x = this.sampleTmp.x;
        this.pos.y = this.sampleTmp.y;
        this.pos.z = this.sampleTmp.z;
        progress = this.course.measure(this.pos);
      }
      let entry = this.hudPlayers.get(p.id);
      if (!entry) {
        entry = { status: fate, score: 0, progress, place: 0 };
        this.hudPlayers.set(p.id, entry);
      }
      entry.status = fate;
      entry.progress = progress;
      ids.push(p.id);
    }
    const rank = (id: number): number => {
      const q = this.qualifyOrder.indexOf(id);
      if (q >= 0) return 2 + (1 - q / 1000);
      const e = this.hudPlayers.get(id);
      return e?.status === PlayerRoundStatus.Eliminated ? -1 : (e?.progress ?? 0);
    };
    ids.sort((a, b) => rank(b) - rank(a));
    ids.forEach((id, i) => {
      const e = this.hudPlayers.get(id);
      if (e) e.place = i + 1;
    });
    this.standings = ids;
    this.hudInput.players = this.hudPlayers;
    this.hudInput.standings = this.standings;
  }

  protected liveStatus(): HudInput | null {
    if (!this.round) return null;
    return this.hudInput;
  }

  override frame(dt: number, realDt: number): void {
    this.leaderAcc += realDt;
    if (this.leaderAcc >= LEADER_INTERVAL_S) {
      this.leaderAcc = 0;
      this.updateStandings();
    }
    super.frame(dt, realDt);
  }

  protected override ping(): number {
    return this.net.rtt;
  }

  protected override isOnline(): boolean {
    return true;
  }

  /**
   * A matchmade show's results reach the account API from the game server,
   * which keeps a leaver's played rounds (reported with `quit`), so nothing is
   * banked locally. Dev shows without a ticket fall back to the local profile.
   */
  protected override bankOnLeave(facts: ShowResultForProfile): void {
    if (this.reportsToAccount()) return;
    super.bankOnLeave(facts);
  }

  private reportsToAccount(): boolean {
    return !!this.opts.matchId && !!this.ctx.account?.active;
  }

  protected override rewardsPending(): boolean {
    return !!this.opts.matchId && !!this.ctx.account?.active && this.apiReward === undefined;
  }

  protected override computeRewards(facts: ShowResultForProfile): RewardsSummary {
    const account = this.ctx.account;
    if (this.apiReward && account?.active) return account.rewardsSummary(this.apiReward);
    return super.computeRewards(facts);
  }

  protected override onDispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.session.dispose();
    this.net.close();
    ui.getState().setConnection({ status: 'online' });
  }
}
