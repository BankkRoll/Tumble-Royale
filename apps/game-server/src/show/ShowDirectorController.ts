/**
 * Adapts the match team's `ShowDirector` (`@tumble/sim/show`) to the room's
 * {@link ShowController} contract.
 *
 * The director owns round selection and phase timing and expects a
 * `ShowRoundHost` that synchronously creates a round and returns a driver it
 * can `setPhase`/poll. The room, however, owns the MatchSim (it also has to
 * build snapshots, lag compensation and client notifications around it), so
 * the host returned here is a thin proxy: `startRound` and `setPhase` become
 * {@link ShowEvent}s the room applies at the end of the same tick, and
 * `getStatus` answers from the status the room hands in every tick.
 */
import type { MatchPlayerInfo, PlayerRoundStatusId, RoundResultEntry, RoundStatus } from '@tumble/netcode';
import {
  ShowDirector,
  type RoundDriver,
  type RoundStartInfo,
  type ShowDirectorOptions,
  type ShowEvent as DirectorEvent,
} from '@tumble/sim/show';
import { RoundPhase, ShowPhase, type ShowPhaseId } from '@tumble/shared';
import type { ShowController, ShowEvent, ShowRoundPlan, ShowTickContext } from '../room/types.ts';

/** Show configuration forwarded to the director. */
export interface ShowDirectorControllerOptions {
  playlist: ShowDirectorOptions['playlist'];
  /** Round catalogue (content registry). */
  rounds: ShowDirectorOptions['rounds'];
  timings?: ShowDirectorOptions['timings'];
  lateLoadersEliminated?: boolean;
  /** Round timer multiplier (e.g. a private-show ticket's timer option); clamped to 0.5–2 by the director. */
  roundTimeScale?: number;
  /** Forces the show mutator; omit to let the director pick from the playlist. */
  mutatorId?: string | null;
}

const EMPTY_PLAYERS: RoundStatus['players'] = new Map();

/**
 * Real show flow for production rooms.
 *
 * @example
 * createShowController: () => new ShowDirectorController({ playlist: MAIN_SHOW, rounds: ROUNDS })
 */
export class ShowDirectorController implements ShowController {
  private director: ShowDirector | null = null;
  private readonly events: ShowEvent[] = [];
  private status: RoundStatus | null = null;
  private plan: ShowRoundPlan | null = null;
  private phase: ShowPhaseId = ShowPhase.PreShow;

  /** @param opts - Playlist, rounds and timings. */
  constructor(private readonly opts: ShowDirectorControllerOptions) {}

  get showPhase(): ShowPhaseId {
    return this.phase;
  }

  start(players: readonly MatchPlayerInfo[], seed: number): void {
    this.director = new ShowDirector({
      seed,
      playlist: this.opts.playlist,
      rounds: this.opts.rounds,
      participants: players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        ...(p.botSkill ? { botSkill: p.botSkill } : {}),
      })),
      host: { startRound: (info) => this.startRound(info) },
      ...(this.opts.timings ? { timings: this.opts.timings } : {}),
      ...(this.opts.lateLoadersEliminated !== undefined
        ? { lateLoadersEliminated: this.opts.lateLoadersEliminated }
        : {}),
      ...(this.opts.roundTimeScale !== undefined ? { roundTimeScale: this.opts.roundTimeScale } : {}),
      ...(this.opts.mutatorId !== undefined ? { mutatorId: this.opts.mutatorId } : {}),
    });
    this.director.on((e) => this.onDirectorEvent(e));
  }

  onTick(dt: number, ctx: ShowTickContext): void {
    this.status = ctx.status;
    this.director?.tick(dt);
  }

  onPlayerFate(_playerId: number, _status: PlayerRoundStatusId, _place: number): void {
    // The director reads fates from the round status it polls every tick.
  }

  onPlayerLeft(playerId: number): void {
    this.director?.onPlayerLeft(playerId);
  }

  onPlayerLoaded(playerId: number): void {
    this.director?.onPlayerLoaded(playerId);
  }

  currentRound(): ShowRoundPlan | null {
    return this.plan;
  }

  drainEvents(): ShowEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private startRound(info: RoundStartInfo): RoundDriver {
    this.status = null;
    this.plan = {
      roundId: info.round.id,
      round: info.round,
      index: info.roundIndex,
      isFinal: info.isFinal,
      stage: info.stage,
      seed: info.seed,
      playerIds: info.players.map((p) => p.id),
      ...(info.qualifyTarget !== undefined ? { qualifyTarget: info.qualifyTarget } : {}),
      mutatorId: info.mutatorId,
      roundTimeScale: info.roundTimeScale,
    };
    this.events.push({ type: 'roundStart', plan: this.plan });
    return {
      setPhase: (phase, time) => {
        this.events.push(
          time === undefined ? { type: 'roundPhase', phase } : { type: 'roundPhase', phase, time },
        );
      },
      getStatus: () => this.status ?? { phase: RoundPhase.Loading, finished: false, players: EMPTY_PLAYERS },
      // The room disposes the sim when the next round starts or the room closes, and forfeits departed players itself.
      dispose: () => {},
    };
  }

  private onDirectorEvent(e: DirectorEvent): void {
    switch (e.type) {
      case 'showPhase':
        this.phase = e.phase;
        this.events.push({ type: 'showPhase', phase: e.phase });
        return;
      case 'roundResult': {
        const o = e.outcome;
        const results: RoundResultEntry[] = [
          ...o.qualified.map((id, i) => ({ id, status: 1, place: i + 1, score: this.score(id) })),
          ...o.eliminated.map((id, i) => ({
            id,
            status: 2,
            place: o.qualified.length + i + 1,
            score: this.score(id),
          })),
        ];
        this.events.push({ type: 'roundEnd', roundId: o.roundId, results });
        return;
      }
      case 'ended':
        this.events.push({
          type: 'showEnd',
          winners: [...e.summary.winners],
          rounds: e.summary.rounds.map((r) => ({ roundId: r.roundId, qualified: [...r.qualified] })),
        });
        return;
      default:
        return;
    }
  }

  private score(id: number): number {
    return this.status?.players.get(id)?.score ?? 0;
  }
}
