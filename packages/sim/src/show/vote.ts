/**
 * Round voting between rounds: one ballot, its tally, the bots' seeded
 * ballots and the deterministic result. The {@link ShowDirector} opens a
 * {@link RoundVote} when RESULTS starts and reads the winner when it selects
 * the next round; hosts (server room, offline runner) only relay ballots and
 * mirror the public {@link VoteSnapshot}.
 *
 * Rules (SHOWS.md §2.1):
 * - voters are the players still in the show when the ballot opens; party
 *   members vote individually; eliminated players and spectators never vote;
 * - one ballot per voter, changeable until the vote closes;
 * - every bot pre-rolls a choice (weighted by the candidates' selection
 *   weights) and a moment to cast it, both from the show seed;
 * - humans sway it: when humans can vote, all bot ballots together weigh at
 *   most half as much as the human electorate;
 * - the highest score wins; ties go to a seeded pick among the tied rounds,
 *   and a ballot with no votes at all goes to a seeded pick of the candidates.
 */
import { Rng } from '@tumble/shared';
import type { RoundCandidate } from './selector.ts';

const VOTE_SALT = 0x0b_a110_75;

/**
 * Earliest a ballot may close once every connected human voted, so the card
 * is on screen long enough to read and the bots visibly join in.
 */
export const VOTE_MIN_OPEN_SECONDS = 3;

/** Why a vote resolved the way it did. */
export type VoteResolution = 'votes' | 'tie' | 'noVotes';

/** Outcome of a ballot. */
export interface VoteResult {
  /** Index into the ballot's options. */
  winner: number;
  roundId: string;
  /** Raw ballots per option. */
  counts: number[];
  /** Weighted score per option (what decided it). */
  scores: number[];
  reason: VoteResolution;
}

/** A ballot as hosts and the UI see it. */
export interface VoteSnapshot {
  /** Index of the round being voted on. */
  roundIndex: number;
  isFinal: boolean;
  /** Candidate round ids in display order. */
  options: string[];
  /** Raw ballots per option. */
  counts: number[];
  /** Ballots cast. */
  voted: number;
  /** Players allowed to vote. */
  eligible: number;
  /** Seconds left until the ballot closes at the latest (0 once closed). */
  closesIn: number;
  /** True when bot ballots count for less than a human's. */
  botsDiscounted: boolean;
  /** Set once the ballot closed. */
  result: VoteResult | null;
}

/** What happened to a cast ballot. */
export type VoteCastResult = 'accepted' | 'changed' | 'unchanged' | 'closed' | 'ineligible' | 'invalid';

/** Options for {@link RoundVote}. */
export interface RoundVoteOptions {
  /** Show seed. */
  seed: number;
  /** Index of the round being voted on. */
  roundIndex: number;
  isFinal: boolean;
  /** Ballot candidates (2–4), in draw order. */
  candidates: readonly RoundCandidate[];
  /** Players allowed to vote. */
  voters: readonly { id: number; isBot: boolean }[];
  /** Longest the ballot stays open (s). */
  seconds: number;
  /**
   * The RESULTS + TRANSITION gap the vote is folded into (s). With nobody
   * human left to wait for, the ballot closes at the end of it.
   */
  baseGap: number;
}

/** The state of one round vote. */
export class RoundVote {
  readonly roundIndex: number;
  readonly isFinal: boolean;
  /** Candidates in display order. */
  readonly options: readonly RoundCandidate[];
  /** Longest the ballot stays open (s). */
  readonly seconds: number;
  private readonly rng: Rng;
  private readonly bots = new Set<number>();
  private readonly humans = new Set<number>();
  private readonly offline = new Set<number>();
  private readonly ballots = new Map<number, number>();
  /** Bot ballots still to cast, earliest first. */
  private readonly pending: { id: number; at: number; option: number }[] = [];
  private readonly humanWeight: number;
  private readonly botWeight: number;
  private readonly idleClose: number;
  private elapsed = 0;
  private outcome: VoteResult | null = null;

  /** @param opts - Ballot setup. */
  constructor(opts: RoundVoteOptions) {
    this.roundIndex = opts.roundIndex;
    this.isFinal = opts.isFinal;
    this.seconds = Math.max(0, opts.seconds);
    this.rng = new Rng((opts.seed ^ VOTE_SALT ^ Math.imul(opts.roundIndex + 1, 0x9e3779b1)) >>> 0);
    // Draw order puts the director's own favourite first; shuffle so the card position never hints at it.
    this.options = this.rng.shuffle([...opts.candidates]);
    for (const v of [...opts.voters].sort((a, b) => a.id - b.id)) {
      if (v.isBot) this.bots.add(v.id);
      else this.humans.add(v.id);
    }
    const h = this.humans.size;
    const b = this.bots.size;
    // Integer weights keep tallies exact: each bot is worth min(1, h / 2b) of a human.
    this.humanWeight = b === 0 ? 1 : h === 0 ? 1 : 2 * b;
    this.botWeight = b === 0 ? 0 : h === 0 ? 1 : Math.min(2 * b, h);
    this.idleClose = Math.min(this.seconds, Math.max(0, opts.baseGap));
    const weights = this.options.map((c) => Math.max(c.weight, 1e-6));
    for (const id of this.bots) {
      const at = this.idleClose * (0.1 + 0.5 * this.rng.next());
      this.pending.push({ id, at, option: this.rng.weightedIndex(weights) });
    }
    this.pending.sort((x, y) => x.at - y.at || x.id - y.id);
  }

  /** The result once closed, else null. */
  get result(): VoteResult | null {
    return this.outcome;
  }

  /** True once the ballot closed. */
  get closed(): boolean {
    return this.outcome !== null;
  }

  /**
   * @param playerId - A player.
   * @returns True if the player may cast a ballot right now.
   */
  canVote(playerId: number): boolean {
    return !this.closed && (this.humans.has(playerId) || this.bots.has(playerId));
  }

  /**
   * The option a player voted for.
   *
   * @param playerId - A player.
   * @returns Option index, or -1 when they have not voted.
   */
  ballotOf(playerId: number): number {
    return this.ballots.get(playerId) ?? -1;
  }

  /**
   * Records or changes a ballot.
   *
   * @param playerId - The voter.
   * @param option - Option index.
   * @returns What happened; only `accepted` and `changed` alter the tally.
   */
  cast(playerId: number, option: number): VoteCastResult {
    if (this.closed) return 'closed';
    if (!this.humans.has(playerId) && !this.bots.has(playerId)) return 'ineligible';
    if (!Number.isInteger(option) || option < 0 || option >= this.options.length) return 'invalid';
    const prev = this.ballots.get(playerId);
    if (prev === option) return 'unchanged';
    this.ballots.set(playerId, option);
    return prev === undefined ? 'accepted' : 'changed';
  }

  /**
   * A voter left the show for good: their ballot no longer counts.
   *
   * @param playerId - The player.
   * @returns True if the tally changed.
   */
  remove(playerId: number): boolean {
    if (this.closed) return false;
    this.humans.delete(playerId);
    this.bots.delete(playerId);
    this.offline.delete(playerId);
    const i = this.pending.findIndex((p) => p.id === playerId);
    if (i >= 0) this.pending.splice(i, 1);
    return this.ballots.delete(playerId);
  }

  /**
   * A human's connection dropped or came back. A disconnected voter keeps
   * their ballot (they may resume) but is not waited for.
   *
   * @param playerId - The player.
   * @param connected - New connection state.
   */
  setConnected(playerId: number, connected: boolean): void {
    if (!this.humans.has(playerId)) return;
    if (connected) this.offline.delete(playerId);
    else this.offline.add(playerId);
  }

  /**
   * Advances the ballot clock: casts due bot ballots and closes the vote when
   * its window ends, when every connected human has voted (after
   * {@link VOTE_MIN_OPEN_SECONDS}), or when no connected human can vote and
   * the base gap has passed.
   *
   * @param dt - Seconds.
   * @returns Whether the tally changed, and how far past its close time the
   *   vote closed (s), or -1 while it is still open.
   */
  advance(dt: number): { changed: boolean; overshoot: number } {
    if (this.closed) return { changed: false, overshoot: -1 };
    this.elapsed += Math.max(0, dt);
    let changed = false;
    while (this.pending.length > 0 && (this.pending[0] as { at: number }).at <= this.elapsed) {
      const p = this.pending.shift() as { id: number; option: number };
      if (!this.ballots.has(p.id)) {
        this.ballots.set(p.id, p.option);
        changed = true;
      }
    }
    let waiting = 0;
    for (const id of this.humans) if (!this.offline.has(id) && !this.ballots.has(id)) waiting++;
    const connectedHumans = this.humans.size - this.offline.size;
    let closeAt = this.seconds;
    if (connectedHumans <= 0) closeAt = this.idleClose;
    else if (waiting === 0) closeAt = Math.min(this.seconds, VOTE_MIN_OPEN_SECONDS);
    if (this.elapsed < closeAt) return { changed, overshoot: -1 };
    const overshoot = this.elapsed - closeAt;
    if (this.close()) changed = true;
    return { changed, overshoot };
  }

  /**
   * Closes the ballot now: bots who had not voted yet cast their pre-rolled
   * choice, then the result is decided.
   *
   * @returns True if late bot ballots changed the tally.
   */
  close(): boolean {
    if (this.closed) return false;
    let changed = false;
    for (const p of this.pending) {
      if (this.ballots.has(p.id)) continue;
      this.ballots.set(p.id, p.option);
      changed = true;
    }
    this.pending.length = 0;
    this.outcome = this.resolve();
    return changed;
  }

  /** @returns Raw ballots per option. */
  counts(): number[] {
    const out = this.options.map(() => 0);
    for (const o of this.ballots.values()) out[o] = (out[o] as number) + 1;
    return out;
  }

  /** @returns The public view of the ballot (allocates). */
  snapshot(): VoteSnapshot {
    return {
      roundIndex: this.roundIndex,
      isFinal: this.isFinal,
      options: this.options.map((c) => c.round.id),
      counts: this.counts(),
      voted: this.ballots.size,
      eligible: this.humans.size + this.bots.size,
      closesIn: this.closed ? 0 : Math.max(0, this.seconds - this.elapsed),
      botsDiscounted: this.botWeight < this.humanWeight && this.humans.size > 0,
      result: this.outcome ? { ...this.outcome, counts: [...this.outcome.counts] } : null,
    };
  }

  private resolve(): VoteResult {
    const counts = this.counts();
    const scores = this.options.map(() => 0);
    for (const [id, o] of this.ballots)
      scores[o] = (scores[o] as number) + (this.bots.has(id) ? this.botWeight : this.humanWeight);
    let reason: VoteResolution = 'votes';
    let winner: number;
    if (this.ballots.size === 0) {
      reason = 'noVotes';
      winner = this.rng.int(0, this.options.length - 1);
    } else {
      const top = Math.max(...scores);
      const tied = scores.map((s, i) => (s === top ? i : -1)).filter((i) => i >= 0);
      if (tied.length > 1) reason = 'tie';
      winner = tied.length > 1 ? this.rng.pick(tied) : (tied[0] as number);
    }
    return {
      winner,
      roundId: (this.options[winner] as RoundCandidate).round.id,
      counts,
      scores,
      reason,
    };
  }
}
