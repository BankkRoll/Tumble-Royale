/**
 * ShowDirector: the headless state machine that runs a whole show.
 *
 * PreShow → for each round: select → LOADING → INTRO_FLYOVER → RULES_CARD →
 * COUNTDOWN → PLAYING (→ OVERTIME) → ROUND_END → RESULTS → TRANSITION → …
 * → Victory → Ended.
 *
 * The director owns timing, round selection, survivor bookkeeping, party
 * fate sharing and the final summary. It does not step physics: a
 * {@link ShowRoundHost} creates a {@link RoundDriver} (normally a match sim)
 * that the caller steps at the fixed rate, while the director is ticked with
 * wall-clock deltas. Given the same seed, participants, host outcomes and
 * tick deltas it makes the same decisions on every machine.
 */
import {
  Rng,
  RoundPhase,
  ShowPhase,
  hashString,
  type RoundDefinition,
  type RoundDefinitionInput,
  type RoundPhaseId,
  type RoundType,
  type ShowPhaseId,
  RoundDefinitionSchema,
} from '@tumble/shared';
import { PlayerRoundStatus, type MatchPlayerInfo } from '../match/types.ts';
import { assignTeams } from '../rounds/team-score.ts';
import { ShowPlaylistSchema, type ShowPlaylist, type ShowPlaylistInput } from './schema/index.ts';
import { selectRound } from './selector.ts';
import {
  DEFAULT_SHOW_TIMINGS,
  type RoundDriver,
  type RoundOutcome,
  type ShowEvent,
  type ShowListener,
  type ShowParticipant,
  type ShowPlacement,
  type ShowRoundHost,
  type ShowState,
  type ShowSummary,
  type ShowTimings,
} from './types.ts';

const SELECT_SALT = 0x5e1e_c7ed;

/** Options for {@link ShowDirector}. */
export interface ShowDirectorOptions {
  seed: number;
  playlist: ShowPlaylist | ShowPlaylistInput;
  /** Round catalogue: the content registry (array or map by id). */
  rounds: readonly (RoundDefinition | RoundDefinitionInput)[] | ReadonlyMap<string, RoundDefinition>;
  participants: readonly ShowParticipant[];
  host: ShowRoundHost;
  timings?: Partial<ShowTimings>;
  /** Humans who have not acked LOADING in time are eliminated (spec default: true). */
  lateLoadersEliminated?: boolean;
  /**
   * Multiplies every round's time limit and overtime (private-show option,
   * 0.5–2). Applied to the round handed to the host, so the match sim's timer
   * and the director's safety cut-off agree.
   */
  roundTimeScale?: number;
}

interface CurrentRound {
  round: RoundDefinition;
  index: number;
  isFinal: boolean;
  driver: RoundDriver;
  entrants: number[];
  qualifyTarget: number | null;
  loaded: Set<number>;
  playingLimit: number;
}

/**
 * Runs a show. Construct, subscribe with {@link on}, then call {@link tick}
 * every frame/server tick.
 */
export class ShowDirector {
  readonly seed: number;
  readonly playlist: ShowPlaylist;
  readonly participants: readonly ShowParticipant[];
  private readonly catalog: Map<string, RoundDefinition>;
  private readonly host: ShowRoundHost;
  private readonly timings: ShowTimings;
  private readonly lateLoadersEliminated: boolean;
  private readonly roundTimeScale: number;
  private readonly rng: Rng;
  private readonly listeners: ShowListener[] = [];
  private readonly byId = new Map<number, ShowParticipant>();

  private showPhase: ShowPhaseId = ShowPhase.PreShow;
  private roundPhase: RoundPhaseId | null = null;
  private elapsed = 0;
  private duration: number;
  private roundIndex = -1;
  private live: CurrentRound | null = null;
  private alive: number[];
  private readonly left = new Set<number>();
  private readonly used = new Set<string>();
  private previousType: RoundType | null = null;
  private readonly outcomes: RoundOutcome[] = [];
  /** Groups of players knocked out, in order; later groups placed better. */
  private readonly knockedOut: { ids: number[]; round: number }[] = [];
  private winners: number[] = [];
  private summaryCache: ShowSummary | null = null;

  constructor(opts: ShowDirectorOptions) {
    this.seed = opts.seed >>> 0;
    this.playlist = ShowPlaylistSchema.parse(opts.playlist);
    this.participants = opts.participants.map((p) => ({ ...p }));
    for (const p of this.participants) this.byId.set(p.id, p);
    this.catalog = new Map();
    const list =
      opts.rounds instanceof Map
        ? [...opts.rounds.values()]
        : (opts.rounds as readonly RoundDefinitionInput[]);
    for (const r of list) {
      const parsed = RoundDefinitionSchema.parse(r);
      this.catalog.set(parsed.id, parsed);
    }
    this.host = opts.host;
    this.timings = { ...DEFAULT_SHOW_TIMINGS, ...opts.timings };
    this.lateLoadersEliminated = opts.lateLoadersEliminated ?? true;
    const scale = opts.roundTimeScale ?? 1;
    this.roundTimeScale = Number.isFinite(scale) && scale > 0 ? Math.min(4, Math.max(0.25, scale)) : 1;
    this.rng = new Rng((this.seed ^ SELECT_SALT) >>> 0);
    this.alive = this.participants.map((p) => p.id);
    this.duration = this.timings.preShow;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to show events.
   *
   * @returns An unsubscribe function.
   */
  on(listener: ShowListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The running round's driver (match sim), if any. */
  get driver(): RoundDriver | null {
    return this.live?.driver ?? null;
  }

  /** Advances timers by `dt` seconds and polls the running round. */
  tick(dt: number): void {
    if (this.showPhase === ShowPhase.Ended) return;
    this.elapsed += Math.max(0, dt);
    // Several short phases may complete inside one large dt; carry the remainder.
    for (let guard = 0; guard < 32; guard++) {
      if (!this.advance()) break;
    }
  }

  /** A human finished loading the current round. */
  onPlayerLoaded(playerId: number): void {
    this.live?.loaded.add(playerId);
  }

  /** A participant disconnected or quit. They are out of the show. */
  onPlayerLeft(playerId: number): void {
    if (this.left.has(playerId) || !this.byId.has(playerId)) return;
    this.left.add(playerId);
    const inRound =
      this.live !== null &&
      this.roundPhase !== null &&
      this.roundPhase < RoundPhase.Results &&
      this.live.entrants.includes(playerId);
    if (inRound) {
      this.live?.driver.forfeit?.(playerId);
    } else if (this.alive.includes(playerId)) {
      this.alive = this.alive.filter((id) => id !== playerId);
      this.knockedOut.push({ ids: [playerId], round: Math.max(0, this.roundIndex) });
    }
  }

  /** Current snapshot (allocates; call at UI/network rates, not per physics step). */
  current(): ShowState {
    return this.snapshot();
  }

  /** The end-of-show summary, available once Victory starts. */
  summary(): ShowSummary | null {
    return this.summaryCache;
  }

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  /** @returns True if a transition happened and another may follow immediately. */
  private advance(): boolean {
    switch (this.showPhase) {
      case ShowPhase.PreShow:
        if (this.elapsed < this.duration) return false;
        this.elapsed -= this.duration;
        this.startNextRound();
        return true;
      case ShowPhase.InRound:
      case ShowPhase.BetweenRounds:
        return this.advanceRound();
      case ShowPhase.Victory:
        if (this.elapsed < this.duration) return false;
        this.elapsed -= this.duration;
        this.setShowPhase(ShowPhase.Ended, 0);
        this.emit({ type: 'ended', summary: this.summaryCache as ShowSummary });
        return false;
      default:
        return false;
    }
  }

  private advanceRound(): boolean {
    const cur = this.live;
    if (!cur) return false;
    const t = this.timings;
    switch (this.roundPhase) {
      case RoundPhase.Loading: {
        const allLoaded = cur.entrants.every(
          (id) => this.byId.get(id)?.isBot || cur.loaded.has(id) || this.left.has(id),
        );
        if (!allLoaded && this.elapsed < this.duration) return false;
        if (this.lateLoadersEliminated) {
          for (const id of cur.entrants) {
            if (!this.byId.get(id)?.isBot && !cur.loaded.has(id)) cur.driver.forfeit?.(id);
          }
        }
        this.elapsed = allLoaded ? 0 : this.elapsed - this.duration;
        this.setRoundPhase(RoundPhase.IntroFlyover, cur.round.flyover.duration || t.introFlyover);
        return true;
      }
      case RoundPhase.IntroFlyover:
        return this.timed(RoundPhase.RulesCard, t.rulesCard);
      case RoundPhase.RulesCard:
        return this.timed(RoundPhase.Countdown, t.countdown, -t.countdown);
      case RoundPhase.Countdown:
        return this.timed(RoundPhase.Playing, -1, 0);
      case RoundPhase.Playing:
      case RoundPhase.Overtime: {
        const st = cur.driver.getStatus();
        if (st.phase === RoundPhase.Overtime && this.roundPhase !== RoundPhase.Overtime) {
          this.roundPhase = RoundPhase.Overtime;
          this.emit({
            type: 'roundPhase',
            phase: RoundPhase.Overtime,
            roundIndex: cur.index,
            roundId: cur.round.id,
          });
        }
        if (!st.finished && this.elapsed < cur.playingLimit) return false;
        this.elapsed = st.finished ? 0 : this.elapsed - cur.playingLimit;
        this.setRoundPhase(RoundPhase.RoundEnd, t.roundEnd);
        return true;
      }
      case RoundPhase.RoundEnd: {
        if (this.elapsed < this.duration) return false;
        this.elapsed -= this.duration;
        this.concludeRound(cur);
        this.setShowPhase(ShowPhase.BetweenRounds, -1);
        this.setRoundPhase(RoundPhase.Results, t.results);
        return true;
      }
      case RoundPhase.Results: {
        if (this.elapsed < this.duration) return false;
        this.elapsed -= this.duration;
        if (cur.isFinal || this.alive.length <= 1) {
          this.finishShow();
          return true;
        }
        this.setRoundPhase(RoundPhase.Transition, t.transition);
        return true;
      }
      case RoundPhase.Transition: {
        if (this.elapsed < this.duration) return false;
        this.elapsed -= this.duration;
        this.startNextRound();
        return true;
      }
      default:
        return false;
    }
  }

  private timed(next: RoundPhaseId, nextDuration: number, matchTime?: number): boolean {
    if (this.elapsed < this.duration) return false;
    this.elapsed -= this.duration;
    const cur = this.live as CurrentRound;
    if (next === RoundPhase.Playing) {
      const d = cur.round.duration;
      cur.playingLimit = d.seconds > 0 ? d.seconds + d.overtimeSeconds + this.timings.safetyGrace : Infinity;
    }
    this.setRoundPhase(next, nextDuration, matchTime);
    return true;
  }

  private startNextRound(): void {
    this.disposeCurrent();
    const n = this.alive.length;
    if (n <= 1) {
      this.finishShow();
      return;
    }
    const index = this.roundIndex + 1;
    const p = this.playlist;
    const isFinal = n <= 2 || index >= p.maxRounds - 1 || (n <= p.finalAtOrBelow && index >= p.minRounds - 1);
    const picked = selectRound(
      p,
      this.catalog,
      { roundIndex: index, players: n, isFinal, previousType: this.previousType, used: this.used },
      this.rng,
    );
    const round = picked ? scaleRoundDuration(picked, this.roundTimeScale) : null;
    if (!round) {
      this.finishShow();
      return;
    }
    this.roundIndex = index;
    this.used.add(round.id);
    this.previousType = round.type;
    const qualifyTarget = this.qualifyTargetFor(round, n, index, isFinal);
    const players = this.matchPlayers(round);
    const driver = this.host.startRound({
      round,
      roundIndex: index,
      stage: Math.max(0, index + p.stageOffset),
      seed: this.seed,
      players,
      qualifyTarget: qualifyTarget ?? undefined,
      isFinal,
    });
    this.live = {
      round,
      index,
      isFinal,
      driver,
      entrants: players.map((x) => x.id),
      qualifyTarget,
      loaded: new Set(),
      playingLimit: Infinity,
    };
    for (const id of this.left) if (this.live.entrants.includes(id)) driver.forfeit?.(id);
    this.setShowPhase(ShowPhase.InRound, -1);
    this.emit({ type: 'roundSelected', roundIndex: index, roundId: round.id, isFinal });
    this.setRoundPhase(RoundPhase.Loading, this.timings.loadingMax);
  }

  /**
   * Finals always crown one player (any round used as a final is forced to a
   * single qualifier). Team rounds decide their own count; other rounds use
   * the playlist curve when it has an entry for this index.
   */
  private qualifyTargetFor(
    round: RoundDefinition,
    n: number,
    index: number,
    isFinal: boolean,
  ): number | null {
    if (isFinal) return 1;
    if (round.qualification.mode === 'teamScore') return null;
    const ratio = this.playlist.qualifyCurve[index];
    if (ratio === undefined) return null;
    return Math.max(1, Math.min(n - 1, Math.round(n * ratio)));
  }

  /** Builds match players, keeping parties on one team in team rounds. */
  private matchPlayers(round: RoundDefinition): MatchPlayerInfo[] {
    const ids = this.alive;
    const teams = ids.map(() => -1);
    if (round.qualification.mode === 'teamScore') {
      const teamCount = Math.max(2, Math.min(4, round.qualification.teams || 2));
      // Whole parties go to the currently smallest team, largest parties first.
      const parties = new Map<number, number[]>();
      ids.forEach((id, i) => {
        const party = this.byId.get(id)?.partyId;
        if (party !== undefined && this.playlist.partySize > 1) {
          let list = parties.get(party);
          if (!list) parties.set(party, (list = []));
          list.push(i);
        }
      });
      const counts = new Array<number>(teamCount).fill(0);
      const groups = [...parties.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
      for (const [, members] of groups) {
        let best = 0;
        for (let t = 1; t < teamCount; t++) if ((counts[t] as number) < (counts[best] as number)) best = t;
        for (const i of members) teams[i] = best;
        counts[best] = (counts[best] as number) + members.length;
      }
      // Solo players are shuffled so team composition varies show to show.
      const solos = ids.map((_, i) => i).filter((i) => teams[i] === -1);
      this.rng.shuffle(solos);
      for (const i of solos) {
        let best = 0;
        for (let t = 1; t < teamCount; t++) if ((counts[t] as number) < (counts[best] as number)) best = t;
        teams[i] = best;
        counts[best] = (counts[best] as number) + 1;
      }
      assignTeams(teams, ids, teamCount);
    }
    return ids.map((id, i) => {
      const p = this.byId.get(id) as ShowParticipant;
      return {
        id,
        name: p.name,
        isBot: p.isBot,
        team: teams[i] as number,
        botSkill: p.botSkill,
        ...(p.partyId !== undefined ? { partyId: p.partyId } : {}),
      };
    });
  }

  private concludeRound(cur: CurrentRound): void {
    const st = cur.driver.getStatus();
    const qualified: { id: number; place: number }[] = [];
    const eliminated: { id: number; place: number }[] = [];
    const undecided: number[] = [];
    for (const id of cur.entrants) {
      const e = st.players.get(id);
      if (this.left.has(id)) eliminated.push({ id, place: Number.MAX_SAFE_INTEGER });
      else if (!e || e.status === PlayerRoundStatus.Playing) undecided.push(id);
      else if (e.status === PlayerRoundStatus.Qualified) qualified.push({ id, place: e.place });
      else eliminated.push({ id, place: e.place });
    }
    // The safety cut-off fired before the rules decided: never strand a show with zero survivors.
    if (undecided.length > 0) {
      if (qualified.length === 0 && !cur.isFinal)
        for (const id of undecided) qualified.push({ id, place: 1e6 });
      else if (qualified.length === 0 && cur.isFinal)
        qualified.push({ id: undecided.shift() as number, place: 1e6 });
      for (const id of undecided)
        if (!qualified.some((q) => q.id === id)) eliminated.push({ id, place: 1e6 });
    }
    qualified.sort((a, b) => a.place - b.place || a.id - b.id);
    eliminated.sort((a, b) => a.place - b.place || a.id - b.id);

    let survivors = qualified.map((q) => q.id);
    const carried: number[] = [];
    if (this.playlist.partySize > 1 && !cur.isFinal) {
      const winningParties = new Set<number>();
      for (const id of survivors) {
        const party = this.byId.get(id)?.partyId;
        if (party !== undefined) winningParties.add(party);
      }
      for (const e of eliminated) {
        const party = this.byId.get(e.id)?.partyId;
        if (party !== undefined && winningParties.has(party) && !this.left.has(e.id)) carried.push(e.id);
      }
      survivors = [...survivors, ...carried];
    }
    const out = eliminated.map((e) => e.id).filter((id) => !carried.includes(id));
    const keep = new Set(survivors);
    this.alive = this.alive.filter((id) => keep.has(id));
    if (out.length > 0) this.knockedOut.push({ ids: out, round: cur.index });

    const outcome: RoundOutcome = {
      roundIndex: cur.index,
      roundId: cur.round.id,
      name: cur.round.name,
      type: cur.round.type,
      isFinal: cur.isFinal,
      qualified: qualified.map((q) => q.id),
      eliminated: eliminated.map((e) => e.id),
      carried,
    };
    this.outcomes.push(outcome);
    if (cur.isFinal) this.winners = this.crownFor(qualified[0]?.id ?? null);
    this.emit({ type: 'roundResult', outcome });
  }

  /** The winner plus, in party modes, their teammates still in the show. */
  private crownFor(winner: number | null): number[] {
    if (winner === null) return [];
    const party = this.byId.get(winner)?.partyId;
    if (this.playlist.partySize <= 1 || party === undefined) return [winner];
    const mates = this.participants
      .filter((p) => p.partyId === party && p.id !== winner && !this.left.has(p.id))
      .map((p) => p.id);
    return [winner, ...mates];
  }

  private finishShow(): void {
    this.disposeCurrent();
    if (this.winners.length === 0 && this.alive.length === 1)
      this.winners = this.crownFor(this.alive[0] as number);
    this.summaryCache = this.buildSummary();
    this.roundPhase = null;
    this.setShowPhase(ShowPhase.Victory, this.timings.victory);
  }

  private buildSummary(): ShowSummary {
    const placements: ShowPlacement[] = [];
    const placed = new Set<number>();
    for (const id of this.winners) {
      placements.push({ playerId: id, place: 1, eliminatedInRound: -1 });
      placed.add(id);
    }
    let place = placements.length + 1;
    // Survivors who never got knocked out but did not win (e.g. show ended early) rank next.
    for (const id of this.alive) {
      if (placed.has(id)) continue;
      placements.push({ playerId: id, place: place++, eliminatedInRound: -1 });
      placed.add(id);
    }
    for (let g = this.knockedOut.length - 1; g >= 0; g--) {
      const group = this.knockedOut[g] as { ids: number[]; round: number };
      for (const id of group.ids) {
        if (placed.has(id)) continue;
        placements.push({ playerId: id, place: place++, eliminatedInRound: group.round });
        placed.add(id);
      }
    }
    for (const p of this.participants) {
      if (placed.has(p.id)) continue;
      placements.push({ playerId: p.id, place: place++, eliminatedInRound: Math.max(0, this.roundIndex) });
    }
    return {
      seed: this.seed,
      playlistId: this.playlist.id,
      participants: this.participants.map((p) => ({ ...p })),
      rounds: this.outcomes.map((o) => ({
        ...o,
        qualified: [...o.qualified],
        eliminated: [...o.eliminated],
        carried: [...o.carried],
      })),
      winner: this.winners[0] ?? null,
      winners: [...this.winners],
      placements,
    };
  }

  private disposeCurrent(): void {
    if (this.live) {
      this.live.driver.dispose();
      this.live = null;
    }
  }

  private setShowPhase(phase: ShowPhaseId, duration: number): void {
    if (duration >= 0) this.duration = duration;
    if (this.showPhase === phase) return;
    this.showPhase = phase;
    this.emit({ type: 'showPhase', phase });
  }

  private setRoundPhase(phase: RoundPhaseId, duration: number, matchTime?: number): void {
    const cur = this.live as CurrentRound;
    this.roundPhase = phase;
    this.duration = duration < 0 ? Infinity : duration;
    cur.driver.setPhase(phase, matchTime);
    this.emit({ type: 'roundPhase', phase, roundIndex: cur.index, roundId: cur.round.id });
  }

  private snapshot(): ShowState {
    const cur = this.live;
    const aliveSet = new Set(this.alive);
    return {
      showPhase: this.showPhase,
      roundPhase: this.roundPhase,
      roundIndex: this.roundIndex,
      roundId: cur?.round.id ?? null,
      roundName: cur?.round.name ?? null,
      roundType: cur?.round.type ?? null,
      isFinal: cur?.isFinal ?? false,
      phaseElapsed: this.elapsed,
      phaseDuration: Number.isFinite(this.duration) ? this.duration : -1,
      alive: [...this.alive],
      spectators: this.participants.filter((p) => !aliveSet.has(p.id)).map((p) => p.id),
      qualifyTarget: cur?.qualifyTarget ?? null,
    };
  }

  private emit(e: ShowEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/**
 * A round with its time limit and overtime multiplied by `scale` (private-show
 * timer option). Returns the same object when `scale` is 1 so catalogue
 * identity checks keep working.
 *
 * @param round - Validated round.
 * @param scale - Multiplier; untimed rounds (`seconds <= 0`) stay untimed.
 * @returns The scaled round.
 * @example
 * const slow = scaleRoundDuration(getRound('tile-panic')!, 1.5);
 */
export function scaleRoundDuration(round: RoundDefinition, scale: number): RoundDefinition {
  if (scale === 1 || !(scale > 0) || round.duration.seconds <= 0) return round;
  return {
    ...round,
    duration: {
      seconds: Math.round(round.duration.seconds * scale * 10) / 10,
      overtimeSeconds: Math.round(round.duration.overtimeSeconds * scale * 10) / 10,
    },
  };
}

/** Seed helper: a per-show seed from a room id and creation counter. */
export function showSeed(roomId: string, counter: number): number {
  return (hashString(roomId) ^ Math.imul(counter + 1, 0x9e3779b1)) >>> 0;
}
