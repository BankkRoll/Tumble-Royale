/**
 * Planning the "How you went out" replay from a recording.
 *
 * Responsibilities:
 * - read a recording's event stream as timed events (round time), without
 *   decoding the frames;
 * - find the local player's elimination, attribute it ({@link attributeElimination})
 *   and pick the camera subject;
 * - choose the window (the last ~7.5 s up to just after the knock-out) and the
 *   playback plan: a quicker lead-in and slow motion around the decisive
 *   moment, sized to play in about five seconds.
 *
 * The same plan serves offline shows (the full round recording) and online
 * shows (the short recording built from the client's own ring buffer,
 * {@link ReplayTape}). Pure: no DOM, no three.
 */
import { ByteReader } from './codec.ts';
import {
  attributeElimination,
  causeFocusPlayer,
  type CauseObstacle,
  type EliminationCause,
  type TimedEvent,
} from './elimCause.ts';
import { TIME_SCALE, readEvent, type ReplayData } from './format.ts';

/** Longest stretch of round shown (s): "the last ~6–8 s". */
export const ELIM_WINDOW_S = 7.5;
/** The replay keeps rolling this long after the knock-out (s). */
export const ELIM_TAIL_S = 1;
/** Slow-motion rate around the decisive moment. */
export const ELIM_SLOW_RATE = 0.45;
/** Slow motion starts this long before the decisive moment… */
export const ELIM_SLOW_BEFORE_S = 0.5;
/** …and ends this long after it (s). */
export const ELIM_SLOW_AFTER_S = 0.9;
/** Target real playing time (s). */
export const ELIM_TARGET_REAL_S = 5.5;
/** The lead-in never runs faster than this. */
const MAX_FAST_RATE = 3;

/** A window of a recording, in seconds from its first frame. */
export interface ElimWindow {
  start: number;
  end: number;
  /** The decisive moment, inside the window. */
  focus: number;
}

/** How the window plays: one fast rate, one slow stretch. */
export interface ElimPlayback extends ElimWindow {
  slowFrom: number;
  slowTo: number;
  slowRate: number;
  fastRate: number;
}

/** Everything the player needs to show the replay. */
export interface EliminationPlan {
  cause: EliminationCause;
  playback: ElimPlayback;
  /** Player the camera follows. */
  follow: number;
}

/** Facts about the round the recording cannot tell. */
export interface EliminationFacts {
  obstacles: readonly CauseObstacle[];
  teams: ReadonlyMap<number, number>;
  finishGap: number | null;
  /**
   * Round time the session saw the local player go out, used when the
   * recording holds no `eliminated` event for them (it started too late).
   */
  eliminatedAt?: number;
  /** The knock-out came with the end of the round (see `CauseContext.atRoundEnd`). */
  atRoundEnd?: boolean;
}

/**
 * A recording's events with their round times.
 *
 * @param data - Recording.
 * @returns Events in order; a damaged stream yields what decoded before the damage.
 */
export function timedEvents(data: ReplayData): TimedEvent[] {
  const h = data.header;
  const out: TimedEvent[] = [];
  const r = new ByteReader(data.events);
  let cs = 0;
  try {
    for (let i = 0; i < h.eventCount; i++) {
      cs += r.varint();
      out.push({ t: h.startTime + cs / TIME_SCALE, e: readEvent(r, h.strings) });
    }
  } catch {
    // Attribution works on whatever decoded; the replay itself is checked when it loads.
  }
  return out;
}

/**
 * The window to show.
 *
 * @param duration - Recording length (s).
 * @param eliminatedAt - Knock-out, seconds from the first frame.
 * @param focus - Decisive moment, seconds from the first frame.
 * @returns A window of at most {@link ELIM_WINDOW_S} ending {@link ELIM_TAIL_S}
 *   after the knock-out, holding the decisive moment.
 * @example
 * selectEliminationWindow(60, 40, 38); // { start: 33.5, end: 41, focus: 38 }
 */
export function selectEliminationWindow(duration: number, eliminatedAt: number, focus: number): ElimWindow {
  const d = Math.max(0, duration);
  const end = Math.max(0, Math.min(d, eliminatedAt + ELIM_TAIL_S));
  let start = Math.max(0, end - ELIM_WINDOW_S);
  // A decisive moment from long before keeps a beat of lead-in (the lookback is shorter than the window, so rare).
  if (focus < start + 0.5) start = Math.max(0, Math.min(start, focus - 1.5));
  return { start, end, focus: Math.max(start, Math.min(end, focus)) };
}

/**
 * Speeds for a window: slow motion over the decisive moment and a lead-in
 * rate chosen so the whole thing plays in about {@link ELIM_TARGET_REAL_S}.
 *
 * @param w - The window.
 * @returns The plan.
 */
export function planElimPlayback(w: ElimWindow): ElimPlayback {
  const slowFrom = Math.max(w.start, w.focus - ELIM_SLOW_BEFORE_S);
  const slowTo = Math.min(w.end, w.focus + ELIM_SLOW_AFTER_S);
  const slowLen = Math.max(0, slowTo - slowFrom);
  const rest = Math.max(0, w.end - w.start - slowLen);
  const realLeft = Math.max(1, ELIM_TARGET_REAL_S - slowLen / ELIM_SLOW_RATE);
  const fastRate = Math.max(1, Math.min(MAX_FAST_RATE, rest / realLeft));
  return { ...w, slowFrom, slowTo, slowRate: ELIM_SLOW_RATE, fastRate };
}

/**
 * Playback rate at a point of the window.
 *
 * @param p - Plan.
 * @param t - Seconds from the first frame.
 */
export function playbackRateAt(p: ElimPlayback, t: number): number {
  return t >= p.slowFrom && t < p.slowTo ? p.slowRate : p.fastRate;
}

/**
 * Real seconds the plan takes to play.
 *
 * @param p - Plan.
 */
export function playbackRealSeconds(p: ElimPlayback): number {
  const slow = Math.max(0, p.slowTo - p.slowFrom);
  return slow / p.slowRate + Math.max(0, p.end - p.start - slow) / p.fastRate;
}

/**
 * Plans the elimination replay for a recording.
 *
 * @param data - The round's recording (full offline, the ring buffer's online).
 * @param facts - Obstacles, teams and finish gap from the live round.
 * @returns The plan, or null when the recording doesn't cover the knock-out.
 */
export function planElimination(data: ReplayData, facts: EliminationFacts): EliminationPlan | null {
  const h = data.header;
  if (h.localId < 0 || h.frameCount < 2) return null;
  const events = timedEvents(data);
  let eliminatedAt = Number.NaN;
  for (const { t, e } of events)
    if (e.type === 'eliminated' && e.player === h.localId) {
      eliminatedAt = t;
      break;
    }
  if (Number.isNaN(eliminatedAt)) eliminatedAt = facts.eliminatedAt ?? Number.NaN;
  const rel = eliminatedAt - h.startTime;
  // The knock-out must lie inside what was recorded (a ring buffer may have rolled past it).
  if (!Number.isFinite(rel) || rel < 0 || rel > h.duration + ELIM_TAIL_S) return null;
  const cause = attributeElimination(events, {
    localId: h.localId,
    roundType: h.roundType,
    isFinal: h.isFinal,
    eliminatedAt,
    teams: facts.teams,
    obstacles: facts.obstacles,
    finishGap: facts.finishGap,
    ...(facts.atRoundEnd !== undefined ? { atRoundEnd: facts.atRoundEnd } : {}),
  });
  const window = selectEliminationWindow(h.duration, rel, cause.at - h.startTime);
  if (window.end - window.start < 1) return null;
  return { cause, playback: planElimPlayback(window), follow: causeFocusPlayer(cause, h.localId) };
}
