/**
 * Automatic highlights: the moments of a show worth a second look, found in
 * each recorded round's event stream and kept as a small top-N reel.
 *
 * Responsibilities:
 * - detect candidate moments per round: a final won, photo finishes, the
 *   last qualifying spot or a qualify in the dying seconds, big falls, grab
 *   chains, comebacks after setbacks, clutch survival, and the score that
 *   decided a team round;
 * - score them with one model (a base per kind, scaled by how close or big
 *   the moment was, ×1.5 when the local player is in it, ×1.2 in the final)
 *   and cut each to a 3–5 s segment of its recording;
 * - keep the best few per show with a deterministic order (score, then round,
 *   time, kind and player), at most two of a kind while others are left, so
 *   the reel never fills up with falls.
 *
 * Pure: no DOM, no three. Detection reads timed events only.
 */
import type { SimEvent } from '@tumble/sim';
import type { ReplayHeader } from './format.ts';

/** What kind of moment a highlight is. */
export type HighlightKind =
  | 'finalWin'
  | 'closeFinish'
  | 'lastSecondQualify'
  | 'bigFall'
  | 'chainGrab'
  | 'comeback'
  | 'clutchSurvival'
  | 'decisiveScore';

/** Tie-break order between kinds (and the reel's variety rule). */
export const HIGHLIGHT_KINDS: readonly HighlightKind[] = [
  'finalWin',
  'closeFinish',
  'lastSecondQualify',
  'decisiveScore',
  'clutchSurvival',
  'comeback',
  'chainGrab',
  'bigFall',
];

/** One highlight. Times are seconds from the start of its recording. */
export interface Highlight {
  /** Stable id: `<key>:<kind>:<centiseconds>:<player>`. */
  id: string;
  /** Replay library key of the recording. */
  key: string;
  roundIndex: number;
  roundName: string;
  isFinal: boolean;
  kind: HighlightKind;
  score: number;
  /** The moment itself. */
  t: number;
  /** Segment start. */
  start: number;
  /** Segment length (3–5 s). */
  length: number;
  /** Main player. */
  player: number;
  /** Second player (the one beaten to the line, the chain's end), or -1. */
  other: number;
  /** Kind-specific figure: margin (s), chain length, setbacks, team score… */
  value: number;
  /** The local player is the main or second player. */
  local: boolean;
}

/** Highlights kept per show. */
export const HIGHLIGHTS_PER_SHOW = 6;
/** Highlights of one kind kept while other kinds are still available. */
const MAX_PER_KIND = 2;
/** Segment bounds (s). */
export const HIGHLIGHT_MIN_S = 3;
export const HIGHLIGHT_MAX_S = 5;

/** Two finishes this close are a photo finish (s). */
const CLOSE_FINISH_S = 0.35;
/** Qualifying this close to the time limit counts as last-second (s). */
const LAST_SECONDS_S = 5;
/** Landing this hard is a big fall (m/s of vertical speed). */
const BIG_FALL_IMPACT = 16;
/** Setbacks counted towards a comeback within this long before qualifying (s). */
const COMEBACK_WINDOW_S = 25;
/** A ledge grab with no fall this long after is a save (s). */
const LEDGE_SAVE_S = 3;
/** Survival rounds ending with this many survivors or fewer are clutch. */
const CLUTCH_SURVIVORS = 3;
/** Team scores in the last this many seconds weigh more (s). */
const LATE_SCORE_S = 10;

const BASE: Readonly<Record<HighlightKind, number>> = {
  finalWin: 100,
  closeFinish: 40,
  lastSecondQualify: 45,
  bigFall: 14,
  chainGrab: 30,
  comeback: 30,
  clutchSurvival: 32,
  decisiveScore: 38,
};

/** Seconds kept before and after the moment, per kind. */
const FRAME: Readonly<Record<HighlightKind, readonly [before: number, after: number]>> = {
  finalWin: [3.5, 1.5],
  closeFinish: [3, 1],
  lastSecondQualify: [3, 1],
  bigFall: [2.5, 1.5],
  chainGrab: [1.5, 2.5],
  comeback: [3, 1],
  clutchSurvival: [2, 2],
  decisiveScore: [3, 1],
};

/** A timed event (seconds from the start of the recording). */
export interface HighlightEvent {
  t: number;
  e: SimEvent;
}

/** What detection needs about the round besides its events. */
export interface HighlightRound {
  key: string;
  header: Pick<
    ReplayHeader,
    | 'roundIndex'
    | 'roundName'
    | 'roundType'
    | 'isFinal'
    | 'qualifyTarget'
    | 'localId'
    | 'players'
    | 'duration'
  > & { startTime: number };
  /** Round time limit (s), or null when unknown. */
  timeLimit: number | null;
  /**
   * The round's own type (`race`, `survival`, `final`, …): recordings say
   * `final` for any final, which hides whether it was raced or survived.
   */
  baseType: string;
}

/**
 * Cuts a moment to a segment inside the recording.
 *
 * @param kind - Highlight kind.
 * @param t - Moment.
 * @param duration - Recording length.
 */
export function highlightSegment(
  kind: HighlightKind,
  t: number,
  duration: number,
): { start: number; length: number } {
  const [before, after] = FRAME[kind];
  const d = Math.max(0, duration);
  const length = Math.min(d, Math.max(HIGHLIGHT_MIN_S, Math.min(HIGHLIGHT_MAX_S, before + after)));
  const start = Math.max(0, Math.min(d - length, t - before));
  return { start, length };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Finds a round's highlights.
 *
 * @param r - The round (library key, header, time limit).
 * @param events - Its events in order.
 * @returns Every candidate, unsorted.
 */
export function detectHighlights(r: HighlightRound, events: readonly HighlightEvent[]): Highlight[] {
  const h = r.header;
  const out: Highlight[] = [];
  const local = h.localId;
  const type = r.baseType;
  const raceLike = type === 'race' || type === 'final';
  const add = (kind: HighlightKind, t: number, player: number, other: number, value: number, k = 1): void => {
    const isLocal = local >= 0 && (player === local || other === local);
    const score = round2(BASE[kind] * k * (isLocal ? 1.5 : 1) * (h.isFinal ? 1.2 : 1));
    const seg = highlightSegment(kind, t, h.duration);
    out.push({
      id: `${r.key}:${kind}:${Math.round(t * 100)}:${player}`,
      key: r.key,
      roundIndex: h.roundIndex,
      roundName: h.roundName,
      isFinal: h.isFinal,
      kind,
      score,
      t,
      start: seg.start,
      length: seg.length,
      player,
      other,
      value: round2(value),
      local: isLocal,
    });
  };
  const roundTime = (t: number): number => h.startTime + t;

  let lastQualify: HighlightEvent | null = null;
  const setbacks = new Map<number, number[]>();
  const holding = new Map<number, number>();
  const ledge = new Map<number, number>();
  const fellAt = new Map<number, number>();
  const teamTotals = new Map<number, number>();
  let leader = -1;
  let lastLeadChange: HighlightEvent | null = null;
  const survivors: { t: number; player: number }[] = [];
  const setback = (id: number, t: number): void => {
    const list = setbacks.get(id) ?? [];
    list.push(t);
    setbacks.set(id, list);
  };

  for (const item of events) {
    const { t, e } = item;
    switch (e.type) {
      case 'qualified': {
        if (h.isFinal && e.place === 1) add('finalWin', t, e.player, -1, 1);
        if (raceLike && lastQualify && lastQualify.e.type === 'qualified') {
          const gap = t - lastQualify.t;
          if (gap <= CLOSE_FINISH_S)
            add('closeFinish', t, e.player, lastQualify.e.player, gap, 1 + 1.5 * (1 - gap / CLOSE_FINISH_S));
        }
        if (raceLike && !h.isFinal) {
          const left = r.timeLimit !== null ? r.timeLimit - roundTime(t) : Infinity;
          if (left <= LAST_SECONDS_S && left >= -1)
            add('lastSecondQualify', t, e.player, -1, Math.max(0, left), 1 + (LAST_SECONDS_S - left) / 10);
          else if (e.place === h.qualifyTarget && h.qualifyTarget > 1)
            add('lastSecondQualify', t, e.player, -1, 0, 0.9);
        }
        if (raceLike) {
          const recent = (setbacks.get(e.player) ?? []).filter((s) => t - s <= COMEBACK_WINDOW_S).length;
          if (recent >= 2) add('comeback', t, e.player, -1, recent, Math.min(2, 1 + (recent - 2) * 0.25));
        }
        if (!raceLike && type !== 'team') survivors.push({ t, player: e.player });
        lastQualify = item;
        break;
      }
      case 'land':
        if (e.impact >= BIG_FALL_IMPACT)
          add('bigFall', t, e.player, -1, e.impact, Math.min(2.5, 1 + (e.impact - BIG_FALL_IMPACT) / 10));
        break;
      case 'fellOut':
        fellAt.set(e.player, t);
        setback(e.player, t);
        break;
      case 'stun':
        setback(e.player, t);
        break;
      case 'grabStart':
        if (e.targetKind === 'ledge') {
          ledge.set(e.player, t);
          break;
        }
        if (e.targetKind !== 'player') break;
        holding.set(e.player, e.target);
        setback(e.target, t);
        {
          // Longest line through the new grab: who holds the grabber, and who the target holds.
          let len = 2;
          let end = e.target;
          const seen = new Set<number>([e.player, e.target]);
          while (holding.has(end) && !seen.has(holding.get(end) as number)) {
            end = holding.get(end) as number;
            seen.add(end);
            len++;
          }
          let head = e.player;
          for (const [holder, target] of holding)
            if (target === head && !seen.has(holder)) {
              head = holder;
              seen.add(holder);
              len++;
            }
          if (len >= 3) add('chainGrab', t, head, end, len, 1 + (len - 3) * 0.5);
        }
        break;
      case 'grabEnd':
        if (holding.get(e.player) === e.target) holding.delete(e.player);
        break;
      case 'score': {
        if (type !== 'team' || e.team < 0) break;
        teamTotals.set(e.team, e.total);
        let best = -1;
        let bestScore = -Infinity;
        let tie = false;
        for (const [team, total] of teamTotals) {
          if (total > bestScore) {
            bestScore = total;
            best = team;
            tie = false;
          } else if (total === bestScore) tie = true;
        }
        if (!tie && best !== leader) {
          leader = best;
          lastLeadChange = item;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const [player, t] of ledge) {
    const fell = fellAt.get(player);
    if (fell === undefined || fell < t || fell - t > LEDGE_SAVE_S) {
      if (!raceLike) add('clutchSurvival', t, player, -1, 0, 0.9);
    }
  }
  if (survivors.length > 0 && survivors.length <= CLUTCH_SURVIVORS && type === 'survival' && !h.isFinal) {
    for (const s of survivors) {
      add(
        'clutchSurvival',
        s.t,
        s.player,
        -1,
        survivors.length,
        1 + (CLUTCH_SURVIVORS - survivors.length) * 0.25,
      );
    }
  }
  if (lastLeadChange && lastLeadChange.e.type === 'score') {
    const e = lastLeadChange.e;
    const left = r.timeLimit !== null ? r.timeLimit - roundTime(lastLeadChange.t) : Infinity;
    const late = left <= LATE_SCORE_S ? 1.5 : 1;
    add('decisiveScore', lastLeadChange.t, e.player, -1, e.total, late);
  }
  return out;
}

function kindRank(k: HighlightKind): number {
  return HIGHLIGHT_KINDS.indexOf(k);
}

/**
 * Deterministic highlight order: score, then earlier round, earlier moment,
 * kind order, lower player id, id.
 */
export function compareHighlights(a: Highlight, b: Highlight): number {
  return (
    b.score - a.score ||
    a.roundIndex - b.roundIndex ||
    a.t - b.t ||
    kindRank(a.kind) - kindRank(b.kind) ||
    a.player - b.player ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The best `n` highlights: at most {@link MAX_PER_KIND} of a kind while other
 * kinds can fill the reel, overlapping segments of one recording dropped.
 *
 * @param list - Candidates (any order; not modified).
 * @param n - How many to keep.
 * @returns Best first.
 */
export function selectTopHighlights(list: readonly Highlight[], n = HIGHLIGHTS_PER_SHOW): Highlight[] {
  const sorted = [...list].sort(compareHighlights);
  const picked: Highlight[] = [];
  const overlaps = (h: Highlight): boolean =>
    picked.some((p) => p.key === h.key && h.start < p.start + p.length && p.start < h.start + h.length);
  const perKind = new Map<HighlightKind, number>();
  const spare: Highlight[] = [];
  for (const h of sorted) {
    if (picked.length >= n) break;
    if (overlaps(h)) continue;
    if ((perKind.get(h.kind) ?? 0) >= MAX_PER_KIND) {
      spare.push(h);
      continue;
    }
    perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1);
    picked.push(h);
  }
  for (const h of spare) {
    if (picked.length >= n) break;
    if (!overlaps(h)) picked.push(h);
  }
  return picked.sort(compareHighlights);
}

/**
 * The show's reel: the best highlights so far, bounded.
 *
 * @example
 * const reel = new HighlightReel();
 * reel.add(detectHighlights(round, events));
 * reel.list(); // best first, at most 6
 */
export class HighlightReel {
  private items: Highlight[] = [];

  /** @param capacity - Highlights kept. */
  constructor(readonly capacity = HIGHLIGHTS_PER_SHOW) {}

  /** Forgets the previous show. */
  clear(): void {
    this.items = [];
  }

  /**
   * Merges a round's candidates (a re-recorded round replaces its own).
   *
   * @param candidates - New candidates.
   */
  add(candidates: readonly Highlight[]): void {
    const keys = new Set(candidates.map((c) => c.key));
    const kept = this.items.filter((h) => !keys.has(h.key));
    this.items = selectTopHighlights([...kept, ...candidates], this.capacity);
  }

  /**
   * Drops highlights whose recording is gone (the library evicted it).
   *
   * @param keys - Library keys still held.
   */
  retain(keys: ReadonlySet<string>): void {
    if (this.items.every((h) => keys.has(h.key))) return;
    this.items = this.items.filter((h) => keys.has(h.key));
  }

  /** Best first. */
  list(): readonly Highlight[] {
    return this.items;
  }

  /** @returns The highlight with this id, if kept. */
  get(id: string): Highlight | undefined {
    return this.items.find((h) => h.id === id);
  }
}
