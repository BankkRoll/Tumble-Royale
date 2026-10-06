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
  DEFAULT_SHOW_TIMINGS,
  ShowDirector,
  ShowPlaylistSchema,
  type RoundDriver,
  type ShowPlaylist,
  type RoundStartInfo,
  type ShowDirectorOptions,
  type ShowEvent as DirectorEvent,
  type VoteSnapshot,
} from '@tumble/sim/show';
import { RoundPhase, ShowPhase, type ShowPhaseId } from '@tumble/shared';
import type {
  ShowController,
  ShowEvent,
  ShowLoadingStatus,
  ShowRoundPlan,
  ShowTickContext,
  ShowVote,
} from '../room/types.ts';

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
  /**
   * Round voting (the `shows.mapVoting` flag when the show starts); the
   * playlist must allow it too. Default: off.
   */
  voting?: boolean;
}

const EMPTY_PLAYERS: RoundStatus['players'] = new Map();

function toShowVote(v: VoteSnapshot): ShowVote {
  return {
    roundIndex: v.roundIndex,
    isFinal: v.isFinal,
    options: v.options,
    counts: v.counts,
    voted: v.voted,
    eligible: v.eligible,
    closesIn: v.closesIn,
    botsDiscounted: v.botsDiscounted,
    result: v.result
      ? {
          winner: v.result.winner,
          roundId: v.result.roundId,
          counts: v.result.counts,
          reason: v.result.reason,
        }
      : null,
  };
}

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
  private readonly playlist: ShowPlaylist;

  constructor(private readonly opts: ShowDirectorControllerOptions) {
    this.playlist = ShowPlaylistSchema.parse(opts.playlist);
  }

  get showPhase(): ShowPhaseId {
    return this.phase;
  }

  get partySize(): number {
    return this.playlist.partySize;
  }

  get botSkillMix(): ShowController['botSkillMix'] {
    return this.playlist.botSkillMix;
  }

  get preShowSeconds(): number {
    return this.opts.timings?.preShow ?? DEFAULT_SHOW_TIMINGS.preShow;
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
        ...(p.partyId !== undefined ? { partyId: p.partyId } : {}),
      })),
      host: { startRound: (info) => this.startRound(info) },
      ...(this.opts.timings ? { timings: this.opts.timings } : {}),
      ...(this.opts.lateLoadersEliminated !== undefined
        ? { lateLoadersEliminated: this.opts.lateLoadersEliminated }
        : {}),
      ...(this.opts.roundTimeScale !== undefined ? { roundTimeScale: this.opts.roundTimeScale } : {}),
      ...(this.opts.mutatorId !== undefined ? { mutatorId: this.opts.mutatorId } : {}),
      ...(this.opts.voting !== undefined ? { voting: this.opts.voting } : {}),
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

  onPlayerLoadProgress(playerId: number): void {
    this.director?.onPlayerLoadProgress(playerId);
  }

  onPlayerConnection(playerId: number, connected: boolean): void {
    this.director?.onPlayerConnection(playerId, connected);
  }

  loadingStatus(): ShowLoadingStatus | null {
    return this.director?.loadingRoster() ?? null;
  }

  currentRound(): ShowRoundPlan | null {
    return this.plan;
  }

  castVote(playerId: number, roundIndex: number, option: number): void {
    this.director?.castVote(playerId, roundIndex, option);
  }

  currentVote(): ShowVote | null {
    const v = this.director?.currentVote();
    return v ? toShowVote(v) : null;
  }

  canVote(playerId: number): boolean {
    return this.director?.canVote(playerId) ?? false;
  }

  ballotOf(playerId: number): number {
    return this.director?.ballotOf(playerId) ?? -1;
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
      players: info.players,
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
      forfeit: (playerId) => {
        this.events.push({ type: 'forfeit', playerId });
      },
      // The room disposes the sim when the next round starts or the room closes.
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
        // Teammates carried by a qualifier advance like qualifiers (status 1), flagged so clients say why.
        const carried = new Set(o.carried);
        const out = o.eliminated.filter((id) => !carried.has(id));
        const results: RoundResultEntry[] = [
          ...o.qualified.map((id, i) => ({ id, status: 1, place: i + 1, score: this.score(id) })),
          ...o.carried.map((id, i) => ({
            id,
            status: 1,
            place: o.qualified.length + i + 1,
            score: this.score(id),
            carried: true,
          })),
          ...out.map((id, i) => ({
            id,
            status: 2,
            place: o.qualified.length + o.carried.length + i + 1,
            score: this.score(id),
          })),
        ];
        this.events.push({ type: 'roundEnd', roundId: o.roundId, results });
        return;
      }
      case 'voteOpen':
        this.events.push({ type: 'voteOpen', vote: toShowVote(e.vote) });
        return;
      case 'voteTally':
        this.events.push({ type: 'voteTally', roundIndex: e.roundIndex, counts: e.counts, voted: e.voted });
        return;
      case 'voteClosed':
        this.events.push(
          e.result
            ? {
                type: 'voteResult',
                roundIndex: e.roundIndex,
                winner: e.result.winner,
                roundId: e.result.roundId,
                counts: e.result.counts,
                reason: e.result.reason,
              }
            : {
                type: 'voteResult',
                roundIndex: e.roundIndex,
                winner: -1,
                roundId: '',
                counts: [],
                reason: 'cancelled',
              },
        );
        return;
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
