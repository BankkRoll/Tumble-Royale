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
import {
  KickReason,
  type DecodedSnapshot,
  type JoinRoundMsg,
  type LoadingStatusMsg,
  type NetPlayerInfo,
  type PlayerRewardMsg,
  type RoundResultEntry,
  type ShowInfoMsg,
} from '@tumble/netcode';
import { CharacterState } from '@tumble/sim';
import {
  DEFAULT_SHOW_PLAYERS,
  RoundPhase,
  ShowPhase,
  type RoundDefinition,
  type RoundPhaseId,
} from '@tumble/shared';
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
import { PRE_SHOW_LOBBY_ROUND, ShowPlaylistSchema } from '@tumble/sim/show';
import type { ArenaPlayer } from '@tumble/render/scenes';
import { getTheme } from '@tumble/content/themes';
import { bindUI, ui, type RewardsSummary } from '@tumble/ui';
import { KICKED_TITLE } from '../online/lobbyState.ts';
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
import type { PreShowControl, PreShowView } from '../views/ceremonies.ts';
import { createLiveLobbyView, type LiveLobbySource, type LiveLobbyView } from '../views/liveLobby.ts';
import type { CharacterInput } from '@tumble/sim';
import type { GameContext, RoundOutcomeInfo, RoundStart, SessionPlayer } from './context.ts';
import { ShowSession } from './session.ts';
import { isSpectatorId } from './spectator.ts';

const MAIN = ShowPlaylistSchema.parse(MAIN_SHOW);
const AIRBORNE: ReadonlySet<number> = new Set([
  CharacterState.Jump,
  CharacterState.Fall,
  CharacterState.Dive,
  CharacterState.Bounce,
  CharacterState.Stunned,
  CharacterState.LedgeHang,
]);
/** Leader/progress recompute rate (the HUD pushes at 12 Hz). */
const LEADER_INTERVAL_S = 0.1;
/** `loadProgress` heartbeat period while this machine builds a round. */
const LOAD_PROGRESS_MS = 500;

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
  private heartbeat = 0;
  private readonly emoteSlots = new Map<number, number>();
  private readonly fates = new Map<number, number>();
  private readonly qualifyOrder: number[] = [];
  private course: CourseMetric | null = null;
  private courseRound: RoundDefinition | null = null;
  private leaderAcc = LEADER_INTERVAL_S;
  private readonly sampleTmp = createPlayerSample();
  private readonly pos = { x: 0, y: 0, z: 0 };
  private readonly hudPlayers = new Map<number, HudPlayerStatus>();
  /** The server's pre-show platform is running (between the first join and round 1). */
  private lobbyLive = false;
  private lobbyView: LiveLobbyView | null = null;
  /** Seconds until round 1 as last announced (`showPhase.startsInMs`, else the fill wait). */
  private preShowSeconds = -1;
  private preShowViewEntered = false;
  private lobbyCapacity = 0;
  private showStarted = false;
  private readonly lobbySource: LiveLobbySource;
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
      onRoundReady: (join) => {
        if (!join.lobby) this.requestRoundBuild();
      },
    });
    this.lobbySource = this.createLobbySource();
  }

  /** Network-driven roster and poses for the live pre-show view. */
  private createLobbySource(): LiveLobbySource {
    const session = this.session;
    const net = this.net;
    const emoteSlots = this.emoteSlots;
    const players = this.players;
    return {
      get localId() {
        return net.playerId;
      },
      get live() {
        return net.round?.lobby === true;
      },
      sample(id, out) {
        let e;
        if (id === net.playerId) {
          if (!session.prediction || net.round?.lobby !== true) return false;
          e = session.local;
        } else e = session.remotes.get(id);
        if (!e) return false;
        out.x = e.pos.x;
        out.y = e.pos.y;
        out.z = e.pos.z;
        out.vx = e.vel.x;
        out.vy = e.vel.y;
        out.vz = e.vel.z;
        out.state = e.state;
        out.stateTime = e.stateTime;
        out.facing = e.facing;
        out.grounded = !AIRBORNE.has(e.state);
        out.flags = e.flags;
        out.emote = e.state === CharacterState.Emote ? (emoteSlots.get(id) ?? 1) : 0;
        return true;
      },
      hasLeft: (id) => session.lobbyLeft[id] === 1,
      player(id): ArenaPlayer | null {
        const p = players.get(id);
        return p ? { id: String(id), name: p.name, loadout: p.loadout } : null;
      },
    };
  }

  protected override liveJoinFeed(): boolean {
    return this.lobbyLive;
  }

  protected override buildPreShowView(
    arenaPlayers: ArenaPlayer[],
    control: PreShowControl | undefined,
  ): PreShowView {
    this.preShowViewEntered = true;
    if (!this.lobbyLive) return super.buildPreShowView(arenaPlayers, control);
    this.lobbyView = createLiveLobbyView(
      getTheme('candy'),
      this.ctx.quality.preset,
      this.ctx.tumblers.create,
      this.lobbySource,
    );
    this.updatePreShowFeed();
    return this.lobbyView;
  }

  /** On the live platform the local Tumbler takes input relative to the lobby camera. */
  protected override fillInput(out: CharacterInput): CharacterInput {
    if (!this.lobbyLive || this.round) return super.fillInput(out);
    this.ctx.input.sample(this.lobbyView?.yaw ?? 0, out);
    const emote = this.takePendingEmote();
    if (emote > 0) out.emote = emote;
    if (this.ctx.cfg.autoplay || !this.lobbyView) {
      out.moveX = 0;
      out.moveZ = 0;
      out.buttons = 0;
    }
    return out;
  }

  protected override onSpectateTarget(id: number): void {
    this.net.sendLowFreq({ t: 'spectate', target: id });
  }

  /** Pre-show player count and join feed from the server's roster (not the offline fake feed). */
  private updatePreShowFeed(): void {
    if (!this.lobbyLive) return;
    const info = ui.getState().preShow;
    if (!info) return;
    const names = this.order
      .filter((id) => this.present.has(id))
      .map((id) => this.players.get(id)?.name ?? '');
    ui.getState().setPreShow({
      ...info,
      playersJoined: names.length,
      maxPlayers: Math.max(names.length, this.lobbyCapacity || info.maxPlayers),
      joinFeed: names,
    });
  }

  private readonly present = new Set<number>();

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
        if (isSpectatorId(w.playerId)) this.markSpectatorSeat();
        ui.getState().setConnection({ status: 'online' });
      }),
      net.on('lobby', (l) => {
        this.lobbyCapacity = l.capacity;
        if (this.preShowSeconds < 0 || !this.showStarted)
          this.preShowSeconds = Math.max(0, l.startsInMs / 1000) + 10;
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
        else if (m.t === 'loadingStatus') this.onLoadingStatus(m);
        else if (m.t === 'showPhase' && m.phase === ShowPhase.PreShow && m.startsInMs !== undefined) {
          this.showStarted = true;
          this.preShowSeconds = m.startsInMs / 1000;
          // The show is on: every client restarts the same countdown from the server's clock.
          if (this.preShowViewEntered) this.setPreShowCountdown(this.preShowSeconds);
        }
      }),
      net.on('chat', (m) => this.chat.receive(m)),
      net.on('showPhase', (p) => this.onServerShowPhase(p)),
      net.on('joinRound', (j) => this.onJoin(j)),
      net.on('roundPhase', ({ phase }) => this.onRoundPhase(phase as RoundPhaseId)),
      net.on('roundResults', ({ roundId, results }) => this.onResults(roundId, results)),
      net.on('showSummary', (m) => this.onSummary(m.winners, m.rounds)),
      net.on('snapshot', (snap) => this.onSnapshot(snap)),
      net.on('kicked', ({ reason, detail }) =>
        reason === KickReason.RemovedByHost
          ? this.fail('The host of this private show removed you.', KICKED_TITLE)
          : this.fail(
              reason === KickReason.BadTicket
                ? 'Your match ticket expired — queue again.'
                : detail || 'Removed from the show',
            ),
      ),
      bindUI({
        onDialogResult: ({ dialogId }) => {
          if (dialogId === 'net-failed') this.ctx.onEnd('failed');
        },
      }),
    );
    this.chat.setTransport((m) => this.net.sendLowFreq(m));
    this.ctx.account?.markShowStart();
    net.connect();
  }

  private createPredictSim(join: JoinRoundMsg): MatchSim {
    const round = join.lobby ? PRE_SHOW_LOBBY_ROUND : getRound(join.roundId);
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
        ...(join.lobby ? { lobby: true } : {}),
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

  private fail(message: string, title = 'Connection lost'): void {
    // After the show summary the server winds the room down; the wall and rewards don't need the socket.
    if (this.failed || this.summary) return;
    this.failed = true;
    const s = ui.getState();
    s.setConnection({ status: 'offline', message });
    s.showDialog({
      id: 'net-failed',
      kind: 'error',
      title,
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
      if (p.userId) sp.userId = p.userId;
      if (p.partyId !== undefined) sp.partyId = p.partyId;
      this.players.set(p.id, sp);
      if (!this.order.includes(p.id)) this.order.push(p.id);
    }
    this.present.clear();
    for (const p of list) this.present.add(p.id);
    this.updatePreShowFeed();
    // Typed chat only makes sense with another human in the show.
    this.chat.setTextEnabled(list.some((p) => !p.isBot && p.id !== this.net.playerId));
  }

  private onServerShowPhase(phase: number): void {
    this.onShowPhaseChanged(phase);
    if (phase === ShowPhase.PreShow && !this.preShowEntered) this.enterOnlinePreShow();
  }

  private enterOnlinePreShow(): void {
    if (this.preShowEntered) return;
    this.preShowEntered = true;
    const s = ui.getState();
    s.setQueue({ status: 'found', playersFound: this.order.length || DEFAULT_SHOW_PLAYERS });
    s.setScreen('matchFound');
    this.after(this.lobbyLive ? 0.8 : 1.5, () => {
      if (this.roundIndex < 0)
        this.enterPreShow(this.preShowSeconds >= 0 ? this.preShowSeconds : 7, this.showInfo ? null : MAIN);
    });
  }

  private onJoin(j: JoinRoundMsg): void {
    if (j.lobby) {
      // A resume re-sends the platform's joinRound; the pre-show is already up.
      this.lobbyLive = true;
      this.enterOnlinePreShow();
      return;
    }
    this.lobbyLive = false;
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
    if (index === this.roundIndex && this.round?.start.round.id === j.roundId) {
      // The server may have missed our ack while we were away: say it again, or keep reporting progress.
      if (this.phase === RoundPhase.Loading) {
        if (this.round.view) this.net.sendLowFreq({ t: 'loaded', roundId: j.roundId });
        else this.startLoadHeartbeat(j.roundId);
      }
      return;
    }
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
    this.startLoadHeartbeat(j.roundId);
  }

  /**
   * Reports load progress every {@link LOAD_PROGRESS_MS} from the moment a
   * round is announced until it is built: the server keeps the round in
   * LOADING for as long as these arrive. A timer, not the frame loop, so it
   * keeps beating while build slices or a background tab starve frames.
   */
  private startLoadHeartbeat(roundId: string): void {
    this.stopLoadHeartbeat();
    const beat = (): void => {
      if (this.round?.start.round.id !== roundId || this.round.view) {
        this.stopLoadHeartbeat();
        return;
      }
      this.net.sendLowFreq({ t: 'loadProgress', roundId, pct: this.localLoadProgress() });
    };
    beat();
    this.heartbeat = window.setInterval(beat, LOAD_PROGRESS_MS);
  }

  private stopLoadHeartbeat(): void {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = 0;
  }

  protected override get waitsForOthers(): boolean {
    return true;
  }

  protected override onRoundBuilt(rs: RoundStart): void {
    this.stopLoadHeartbeat();
    this.net.sendLowFreq({ t: 'loaded', roundId: rs.round.id });
  }

  /** The server's LOADING roster: who the round is still waiting for. */
  private onLoadingStatus(m: LoadingStatusMsg): void {
    if (this.round?.start.round.id !== m.roundId || this.round.everyoneIn) return;
    ui.getState().setRoundLoading({
      loaded: m.loaded,
      total: m.total,
      waiting: m.waitingOn.filter((id) => id !== this.localId).map((id) => this.uiPlayer(id)),
    });
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
    // Duos/squads: the whole winning party shares the Crown (place 1), like offline.
    for (const w of winners) placements.set(w, 1);
    let place = winners.length + 1;
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
    this.stopLoadHeartbeat();
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.session.dispose();
    this.net.close();
    ui.getState().setConnection({ status: 'online' });
  }
}
