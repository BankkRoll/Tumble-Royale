/**
 * Offline show runner (the default): a full show against seeded bots, entirely
 * in the browser, on `createOfflineShow` from `@tumble/sim/show`.
 *
 * The director is ticked here (not through `OfflineShow.advance`) so the
 * local player's input can be sampled once per fixed step, the render source
 * can capture every step for interpolation, and the UI can hold the show clock
 * while a title card is on screen.
 */
import { showRoundCatalog } from '@tumble/content/rounds';
import { RoundPhase, Rng, SIM_DT, ShowPhase, hashString, type RoundDefinition } from '@tumble/shared';
import { FixedStepper, emptyInput } from '@tumble/sim';
import { PlayerRoundStatus, type MatchPlayerInfo, type MatchSimHandle } from '@tumble/sim/match';
import {
  createOfflineShow,
  type OfflineShow,
  type ShowEvent,
  type ShowPlaylist,
  type ShowSummary,
} from '@tumble/sim/show';
import { botLoadout } from '../cosmetics.ts';
import type { HudInput, HudPlayerStatus } from '../round/hud.ts';
import { OfflineRoundSource, type RoundSource } from '../round/source.ts';
import type { GameContext, RoundStart, SessionPlayer } from './context.ts';
import { ShowSession } from './session.ts';

/** Phase lengths tuned so the UI cards and the director agree (SCREENS.md §15). */
const TIMINGS = {
  preShow: 0,
  rulesCard: 3,
  countdown: 3,
  roundEnd: 1.5,
  results: 5.5,
  transition: 0.2,
  victory: 600,
} as const;

/**
 * Builds the offline session.
 *
 * @example
 * const session = new OfflineShowSession(ctx, MAIN_SHOW_PARSED, 1234);
 * session.start();
 */
export class OfflineShowSession extends ShowSession {
  private readonly show: OfflineShow;
  private readonly rounds: ReadonlyMap<string, RoundDefinition>;
  private readonly stepper: FixedStepper;
  private source: OfflineRoundSource | null = null;
  private running = false;
  private readonly input = emptyInput();
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

  /**
   * @param ctx - App services.
   * @param playlist - Validated playlist.
   * @param seed - Show seed.
   */
  constructor(
    ctx: GameContext,
    private readonly playlist: ShowPlaylist,
    private readonly seed: number,
  ) {
    super(ctx);
    this.rounds = showRoundCatalog();
    this.show = createOfflineShow({
      R: ctx.R,
      deps: ctx.matchDeps,
      playlist,
      rounds: this.rounds,
      seed,
      humanName: ctx.playerName(),
      ...(ctx.cfg.players ? { players: Math.max(2, Math.min(60, Math.round(ctx.cfg.players))) } : {}),
      timings: TIMINGS,
    });
    this.localId = this.show.humanId;
    this.showName = playlist.name;
    for (const p of this.show.participants) {
      const loadout = p.id === this.localId ? ctx.look() : botLoadout(seed, p.id, p.name);
      const sp: SessionPlayer = { id: p.id, name: p.name, isBot: p.isBot, loadout };
      if (p.partyId !== undefined) sp.partyId = p.partyId;
      this.players.set(p.id, sp);
    }
    // Lobby join order is shuffled (seeded) so the wall's drop pattern looks lively.
    this.order = new Rng((seed ^ hashString('join')) >>> 0).shuffle([...this.players.keys()]);
    this.stepper = new FixedStepper(() => this.step(), SIM_DT, Math.max(8, Math.ceil(8 * ctx.cfg.timeScale)));
    this.show.director.on((e) => this.onDirector(e));
  }

  /**
   * Straight to the pre-show platform. A bot show has nobody to wait for, so a
   * fake queue (with a Cancel button and a dimmed menu) only read as a glitch.
   */
  start(): void {
    const preShow = this.ctx.cfg.autoplay ? 6 : 9;
    this.enterPreShow(preShow, this.playlist);
    this.after(preShow, () => {
      this.running = true;
    });
  }

  protected advance(simDt: number, showDt: number): void {
    if (!this.running) return;
    // Holds pause the show clock only; the match keeps stepping (it is frozen outside play anyway, and ROUND OVER slow-mo must keep moving).
    if (!this.gated) this.show.director.tick(showDt);
    const m = this.show.match;
    if (!m) return;
    this.stepper.advance(simDt);
    if (this.source) this.source.alpha = this.stepper.alpha;
    const evs = m.events.events;
    if (evs.length > 0) {
      this.onSimEvents(evs);
      evs.length = 0;
    }
  }

  private step(): void {
    const m = this.show.match;
    if (!m) return;
    this.show.setInput(this.fillInput(this.input));
    m.step();
    this.source?.capture();
  }

  protected createSource(rs: RoundStart): RoundSource | null {
    return this.source && this.source.sim === this.show.match && rs.round.id === this.source.sim.round.id
      ? this.source
      : null;
  }

  protected liveStatus(): HudInput | null {
    const m = this.show.match;
    if (!m || !this.source || this.source.sim !== m) return null;
    const st = m.getStatus();
    const h = this.hudInput;
    h.timeLeft = st.timeLeft;
    h.qualifiedCount = st.qualifiedCount;
    h.qualifyTarget = st.qualifyTarget;
    h.eliminatedCount = st.eliminatedCount;
    h.overtime = st.phase === RoundPhase.Overtime;
    h.teamScores = st.teamScores;
    h.players = st.players as ReadonlyMap<number, HudPlayerStatus>;
    h.standings = m.getStandings();
    return h;
  }

  private onDirector(e: ShowEvent): void {
    switch (e.type) {
      case 'showPhase':
        this.onShowPhaseChanged(e.phase);
        if (e.phase === ShowPhase.Victory) {
          const summary = this.show.director.summary();
          if (summary) this.finish(summary);
        }
        break;
      case 'roundSelected': {
        const m = this.show.match;
        const round = this.rounds.get(e.roundId);
        if (!m || !round) break;
        const st = m.getStatus();
        const players: MatchPlayerInfo[] = [];
        for (const [id, p] of st.players) {
          const sp = this.players.get(id);
          players.push({
            id,
            name: sp?.name ?? `Tumbler ${id}`,
            isBot: sp?.isBot ?? true,
            team: p.team ?? -1,
          });
        }
        const inRound = players.some((p) => p.id === this.localId);
        this.source = new OfflineRoundSource(
          m as MatchSimHandle,
          players,
          inRound ? this.localId : -1,
          () => this.show.match === m,
        );
        this.stepper.reset();
        this.source.capture();
        this.onRoundSelected({
          index: e.roundIndex,
          isFinal: e.isFinal,
          round,
          players,
          seed: this.show.director.seed,
          stage: Math.max(0, e.roundIndex + this.playlist.stageOffset),
          qualifyTarget: e.isFinal ? 1 : m.qualifyTarget,
        });
        break;
      }
      case 'roundPhase':
        this.onRoundPhase(e.phase);
        break;
      case 'roundResult': {
        const o = e.outcome;
        const carried = new Set(o.carried);
        this.onRoundOutcome({
          roundId: o.roundId,
          name: o.name,
          type: o.type,
          isFinal: o.isFinal,
          qualified: [...o.qualified, ...o.carried],
          eliminated: o.eliminated.filter((id) => !carried.has(id)),
        });
        break;
      }
      default:
        break;
    }
  }

  private finish(summary: ShowSummary): void {
    const placements = new Map<number, number>();
    for (const p of summary.placements) placements.set(p.playerId, p.place);
    this.onShowEnded({
      winnerId: summary.winner,
      placements,
      rounds: summary.rounds.map((o) => {
        const carried = new Set(o.carried);
        return {
          roundId: o.roundId,
          name: o.name,
          type: o.type,
          isFinal: o.isFinal,
          qualified: [...o.qualified, ...o.carried],
          eliminated: o.eliminated.filter((id) => !carried.has(id)),
        };
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  override skipRound(): void {
    const m = this.show.match;
    if (!m) return;
    const st = m.getStatus();
    for (const [id, p] of st.players) if (p.status === PlayerRoundStatus.Playing) m.forfeit(id);
  }

  override forceLocalFate(qualify: boolean): void {
    const m = this.show.match;
    if (!m || !this.source || this.source.localId < 0) return;
    if (!qualify) {
      m.forfeit(this.localId);
      return;
    }
    const finish = m.round.triggers.find((t) => t.kind === 'finish');
    if (finish)
      m.controller(this.localId)?.teleport({
        x: finish.position.x,
        y: finish.position.y,
        z: finish.position.z,
      });
  }

  override teleportToCheckpoint(): void {
    const m = this.show.match;
    if (!m || this.localId < 0) return;
    const ctrl = m.controller(this.localId);
    if (!ctrl) return;
    const z = ctrl.body.translation().z;
    const cps = m.round.triggers
      .filter((t) => t.kind === 'checkpoint')
      .sort((a, b) => a.position.z - b.position.z);
    const next = cps.find((c) => c.position.z > z + 1) ?? cps[0];
    const spot = next?.respawn?.[0] ?? next?.position;
    if (spot) ctrl.teleport({ x: spot.x, y: spot.y + 0.5, z: spot.z });
  }

  protected override onDispose(): void {
    this.running = false;
    this.show.dispose();
  }
}
