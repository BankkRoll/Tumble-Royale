/**
 * The broadcast director: picks who (or what) the auto camera shows, the way
 * a show's vision mixer would — the leader, a close race, the player on the
 * qualifying bubble, someone about to fall out, the team that just scored,
 * the final — with an establishing wide shot at the start and when nothing
 * is happening.
 *
 * Comfort rules: every shot holds at least {@link DIRECTOR_TIMING.minHold}
 * seconds; a new pick has to beat the current one clearly (hysteresis); a
 * followed player who is knocked out or qualifies stays on screen briefly so
 * the moment reads; long holds rotate to the next best story.
 *
 * Deterministic: the same frames and events always give the same shots
 * (stable ordering, ties to the lower id, no randomness), so the logic is
 * unit-tested and two viewers of the same show see the same cut.
 */

/** A round participant's live state for spectating. */
export type DirectorStatus = 'playing' | 'qualified' | 'eliminated';

/** Why the director picked a shot (shown on the broadcast overlay). */
export type DirectorReason =
  'opening' | 'leader' | 'closeRace' | 'bubble' | 'danger' | 'teamSwing' | 'final' | 'quiet' | 'pinned';

/** What the auto camera shows. */
export type DirectorShot =
  { kind: 'follow'; id: number; reason: DirectorReason } | { kind: 'overview'; reason: DirectorReason };

/** One player as the director sees them. */
export interface DirectorPlayer {
  id: number;
  status: DirectorStatus;
  /** 1 = first; 0 when unknown. */
  place: number;
  /** Race progress 0..1 (1 = finished). */
  progress: number;
  /** Team index, −1 when solo. */
  team: number;
  /** 0..1: how close they look to falling out of the round right now. */
  danger: number;
  /** A party or club member of the viewer: a small bonus breaks near-ties their way. */
  favourite?: boolean;
}

/** Round kinds the director tells apart. */
export type DirectorRoundKind = 'race' | 'survival' | 'team' | 'hunt' | 'logic';

/** One frame of the round. */
export interface DirectorFrame {
  /** Seconds since the round's countdown (monotonic). */
  time: number;
  kind: DirectorRoundKind;
  isFinal: boolean;
  /** Qualifying places (1 in a final). */
  qualifyTarget: number;
  /** In standings order (best first). */
  players: readonly DirectorPlayer[];
}

/** Something that just happened. */
export type DirectorEvent =
  | { kind: 'eliminated'; id: number }
  | { kind: 'qualified'; id: number }
  /** A team's score changed by `delta`. */
  | { kind: 'teamScore'; team: number; delta: number };

/** Hold times and thresholds (seconds unless noted). */
export const DIRECTOR_TIMING = Object.freeze({
  /** Establishing wide shot at the start of a round. */
  opening: 4,
  /** Shortest hold of any shot. */
  minHold: 4,
  /** Longest hold before rotating to the next story. */
  maxHold: 14,
  /** A followed player knocked out stays on screen this long. */
  eliminatedLinger: 1.8,
  /** A followed player who qualified stays on screen this long. */
  qualifiedLinger: 1.5,
  /** A new pick must score this many times the current one. */
  switchMargin: 1.3,
  /** Interest below this counts as a quiet moment. */
  quietScore: 2,
  /** Quiet this long brings back the wide shot. */
  quietAfter: 25,
  /** Wide shot length when it comes back for a quiet moment. */
  overviewHold: 5,
  /** How long a team score swing stays interesting. */
  swingFade: 6,
  /** Race progress gap (fraction of the course) that counts as neck and neck. */
  closeGap: 0.015,
});

interface Scored {
  id: number;
  score: number;
  reason: DirectorReason;
}

/**
 * The auto camera's brain.
 *
 * @example
 * const director = new BroadcastDirector();
 * director.note({ kind: 'eliminated', id: 12 }, frame.time);
 * const shot = director.update(frame);
 */
export class BroadcastDirector {
  private current: DirectorShot = { kind: 'overview', reason: 'opening' };
  private since = 0;
  private lastInteresting = 0;
  private lastOverview = 0;
  private leaving: { id: number; at: number; linger: number } | null = null;
  private swings: { team: number; delta: number; at: number }[] = [];

  /** The shot on air. */
  get shot(): DirectorShot {
    return this.current;
  }

  /**
   * Starts a new round on the establishing wide shot.
   *
   * @param time - Round time now.
   */
  reset(time = 0): void {
    this.current = { kind: 'overview', reason: 'opening' };
    this.since = time;
    this.lastInteresting = time;
    this.lastOverview = time;
    this.leaving = null;
    this.swings = [];
  }

  /**
   * Feeds an event.
   *
   * @param e - What happened.
   * @param time - Round time it happened at.
   */
  note(e: DirectorEvent, time: number): void {
    if (e.kind === 'teamScore') {
      if (e.delta !== 0) this.swings.push({ team: e.team, delta: e.delta, at: time });
      return;
    }
    const followed = this.current.kind === 'follow' && this.current.id === e.id;
    if (followed && !this.leaving)
      this.leaving = {
        id: e.id,
        at: time,
        linger: e.kind === 'eliminated' ? DIRECTOR_TIMING.eliminatedLinger : DIRECTOR_TIMING.qualifiedLinger,
      };
  }

  /**
   * Interest per still-playing player for this frame, best first (ties to
   * the lower id). Exposed for tests and the overlay's "why" caption.
   *
   * @param f - The frame.
   */
  scores(f: DirectorFrame): Scored[] {
    const out: Scored[] = [];
    const playing = f.players.filter((p) => p.status === 'playing');
    const swing = this.freshSwing(f.time);
    const swingFirst = new Set<number>();
    if (swing) {
      const scorer = playing.find((p) => p.team === swing.team);
      if (scorer) swingFirst.add(scorer.id);
    }
    const close = new Set<number>();
    if (f.kind === 'race') {
      for (let i = 0; i + 1 < playing.length; i++) {
        const a = playing[i]!;
        const b = playing[i + 1]!;
        const near = a.place <= 3 || Math.abs(a.place - f.qualifyTarget) <= 1;
        if (near && Math.abs(a.progress - b.progress) < DIRECTOR_TIMING.closeGap) {
          close.add(a.id);
          close.add(b.id);
        }
      }
    }
    for (const p of playing) {
      let score = 0.5;
      let reason: DirectorReason = 'leader';
      // Places only tell a story where they rank a race or a score; in survival everyone still in is level.
      const ranked = f.kind === 'race' || f.kind === 'hunt' || f.isFinal;
      const lead = ranked && p.place === 1;
      const take = (s: number, r: DirectorReason): void => {
        if (s > score) {
          score = s;
          reason = r;
        }
      };
      if (lead) take(f.isFinal ? 4 : 3, f.isFinal ? 'final' : 'leader');
      else if (ranked && p.place > 0) take(Math.min(2.5, 2.5 / p.place + 0.5), 'leader');
      if (close.has(p.id)) take(f.isFinal ? 5 : 3.5, f.isFinal ? 'final' : 'closeRace');
      if (f.kind === 'race' && !f.isFinal && f.qualifyTarget > 1 && p.place > 0) {
        if (p.place === f.qualifyTarget || p.place === f.qualifyTarget + 1) take(2.8, 'bubble');
      }
      if (f.kind !== 'race' && p.danger > 0) take(1 + p.danger * 3.5, 'danger');
      if (swing && swingFirst.has(p.id)) {
        const fade = 1 - (f.time - swing.at) / DIRECTOR_TIMING.swingFade;
        take(1.5 + 2.5 * fade * Math.min(2, Math.abs(swing.delta)), 'teamSwing');
      }
      if (p.favourite) score += 0.4;
      out.push({ id: p.id, score, reason });
    }
    out.sort((a, b) => b.score - a.score || a.id - b.id);
    return out;
  }

  /**
   * Picks the shot for this frame.
   *
   * @param f - The frame.
   * @returns The shot to show (also {@link shot}).
   */
  update(f: DirectorFrame): DirectorShot {
    const T = DIRECTOR_TIMING;
    const ranked = this.scores(f);
    const best = ranked[0];
    if (best && best.score >= T.quietScore) this.lastInteresting = f.time;
    const held = f.time - this.since;
    const cur = this.current;

    if (cur.kind === 'overview') {
      const hold = cur.reason === 'opening' ? T.opening : T.overviewHold;
      if (held < hold || !best) return cur;
      return this.cut({ kind: 'follow', id: best.id, reason: best.reason }, f.time);
    }

    const me = f.players.find((p) => p.id === cur.id);
    if (!me || me.status !== 'playing') {
      // Show the moment (a knock-out, a finish) before moving on.
      const leaving = this.leaving?.id === cur.id ? this.leaving : null;
      const linger = leaving ? leaving.linger - (f.time - leaving.at) : 0;
      if (linger > 0 && me) return cur;
      this.leaving = null;
      if (!best) return this.cut({ kind: 'overview', reason: 'quiet' }, f.time);
      return this.cut({ kind: 'follow', id: best.id, reason: best.reason }, f.time);
    }
    if (held < T.minHold || !best) return cur;
    if (f.time - this.lastInteresting >= T.quietAfter && f.time - this.lastOverview >= T.quietAfter)
      return this.cut({ kind: 'overview', reason: 'quiet' }, f.time);
    const mine = ranked.find((s) => s.id === cur.id);
    const mineScore = mine?.score ?? 0;
    if (held >= T.maxHold) {
      const next = ranked.find((s) => s.id !== cur.id);
      if (next) return this.cut({ kind: 'follow', id: next.id, reason: next.reason }, f.time);
    }
    if (best.id !== cur.id && best.score > mineScore * T.switchMargin)
      return this.cut({ kind: 'follow', id: best.id, reason: best.reason }, f.time);
    // Same player, new story (e.g. the leader is now in a close race): refresh the caption only.
    if (mine && mine.reason !== cur.reason)
      this.current = { kind: 'follow', id: cur.id, reason: mine.reason };
    return this.current;
  }

  private cut(next: DirectorShot, time: number): DirectorShot {
    this.current = next;
    this.since = time;
    if (next.kind === 'overview') this.lastOverview = time;
    return next;
  }

  private freshSwing(time: number): { team: number; delta: number; at: number } | null {
    this.swings = this.swings.filter((s) => time - s.at < DIRECTOR_TIMING.swingFade);
    let pick: { team: number; delta: number; at: number } | null = null;
    for (const s of this.swings) if (!pick || s.at > pick.at) pick = s;
    return pick;
  }
}
