/**
 * Which part of a recorded round becomes a clip.
 *
 * Responsibilities:
 * - read the local player's qualification / elimination moments straight
 *   from a recording's event stream (no full timeline decode, so offering
 *   clips on the rewards screen costs next to nothing);
 * - describe each recorded round as a clip candidate;
 * - pick the default: the round the player won, else the last one they
 *   qualified from, ending just after the moment they made it;
 * - clamp any window the trimmer asks for to 5–15 s inside the recording.
 *
 * Pure: no DOM, no three.
 */
import { ByteReader } from '../replay/codec.ts';
import { TIME_SCALE, readEvent, type ReplayData } from '../replay/format.ts';

/** Shortest clip (s). */
export const CLIP_MIN_SECONDS = 5;
/** Longest clip (s). */
export const CLIP_MAX_SECONDS = 15;
/** Default clip length (s). */
export const CLIP_DEFAULT_SECONDS = 10;
/** The default window keeps rolling this long after the player qualifies (s). */
export const CLIP_TAIL_SECONDS = 1.5;

/** A recorded round offered for clipping. */
export interface ClipCandidate {
  /** Replay library key. */
  key: string;
  roundIndex: number;
  name: string;
  isFinal: boolean;
  /** The local player's fate in the round. */
  outcome: 'qualified' | 'eliminated' | 'spectated';
  /** Recording length (s). */
  duration: number;
  /** Seconds from the start of the recording when the local player qualified, or null. */
  qualifiedAt: number | null;
}

/** A clip window in recording time. */
export interface ClipWindow {
  /** Seconds from the start of the recording. */
  start: number;
  /** Seconds. */
  length: number;
}

/**
 * When the local player qualified and was eliminated, from the event stream.
 *
 * @param data - Recording.
 * @returns Times in seconds from the start of the recording (null when it did not happen).
 */
export function localMoments(data: ReplayData): { qualifiedAt: number | null; eliminatedAt: number | null } {
  const h = data.header;
  let qualifiedAt: number | null = null;
  let eliminatedAt: number | null = null;
  if (h.localId < 0) return { qualifiedAt, eliminatedAt };
  const r = new ByteReader(data.events);
  let cs = 0;
  try {
    for (let i = 0; i < h.eventCount; i++) {
      cs += r.varint();
      const e = readEvent(r, h.strings);
      if (e.type === 'qualified' && e.player === h.localId && qualifiedAt === null)
        qualifiedAt = cs / TIME_SCALE;
      else if (e.type === 'eliminated' && e.player === h.localId && eliminatedAt === null)
        eliminatedAt = cs / TIME_SCALE;
    }
  } catch {
    // A damaged stream only loses the moments; the round itself stays clippable.
  }
  return { qualifiedAt, eliminatedAt };
}

/**
 * A recording as a clip candidate.
 *
 * @param key - Replay library key.
 * @param data - Recording.
 */
export function clipCandidate(key: string, data: ReplayData): ClipCandidate {
  const h = data.header;
  const { qualifiedAt } = localMoments(data);
  const outcome: ClipCandidate['outcome'] =
    h.localId < 0
      ? 'spectated'
      : h.outcome?.qualified.includes(h.localId) || qualifiedAt !== null
        ? 'qualified'
        : h.outcome?.eliminated.includes(h.localId)
          ? 'eliminated'
          : 'spectated';
  return {
    key,
    roundIndex: h.roundIndex,
    name: h.roundName,
    isFinal: h.isFinal,
    outcome,
    duration: h.duration,
    qualifiedAt,
  };
}

/**
 * Clamps a window to 5–15 s (or the whole recording when shorter) inside
 * the recording.
 *
 * @param w - Requested window.
 * @param duration - Recording length (s).
 * @returns A valid window.
 * @example
 * clampClipWindow({ start: 58, length: 20 }, 60); // { start: 45, length: 15 }
 */
export function clampClipWindow(w: ClipWindow, duration: number): ClipWindow {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const want = Number.isFinite(w.length) ? w.length : CLIP_DEFAULT_SECONDS;
  const length = Math.min(d, Math.max(CLIP_MIN_SECONDS, Math.min(CLIP_MAX_SECONDS, want)));
  const start = Math.max(0, Math.min(d - length, Number.isFinite(w.start) ? w.start : 0));
  return { start, length };
}

/**
 * The default window for a round: the last 10 s up to just after the local
 * player qualified, or the last 10 s of the recording otherwise.
 *
 * @param c - Candidate.
 */
export function defaultClipWindow(c: ClipCandidate): ClipWindow {
  const end = c.qualifiedAt !== null ? Math.min(c.duration, c.qualifiedAt + CLIP_TAIL_SECONDS) : c.duration;
  return clampClipWindow({ start: end - CLIP_DEFAULT_SECONDS, length: CLIP_DEFAULT_SECONDS }, c.duration);
}

/**
 * The round a clip defaults to: a won final, else the latest round the
 * player qualified from, else null (nothing worth clipping by default).
 *
 * @param candidates - Recorded rounds, any order.
 */
export function defaultClipRound(candidates: readonly ClipCandidate[]): ClipCandidate | null {
  const qualified = candidates
    .filter((c) => c.outcome === 'qualified')
    .sort((a, b) => Number(b.isFinal) - Number(a.isFinal) || b.roundIndex - a.roundIndex);
  return qualified[0] ?? null;
}

/** A clip candidate with its suggested window. */
export interface ClipOfferRound extends ClipCandidate {
  defaultStart: number;
  defaultLength: number;
}

/**
 * Every recorded round as a clip offer, plus the round the clip tab starts on.
 *
 * @param entries - Replay library entries (oldest first).
 * @returns Rounds in show order and the default key (the won or latest
 *   qualified round, else the latest round; null when nothing was recorded).
 */
export function clipOffer(entries: readonly { key: string; data: ReplayData }[]): {
  rounds: ClipOfferRound[];
  defaultKey: string | null;
} {
  const rounds = entries
    .map((e) => clipCandidate(e.key, e.data))
    .filter((c) => c.duration >= 1)
    .sort((a, b) => a.roundIndex - b.roundIndex)
    .map((c): ClipOfferRound => {
      const w = defaultClipWindow(c);
      return { ...c, defaultStart: w.start, defaultLength: w.length };
    });
  const best = defaultClipRound(rounds) ?? rounds[rounds.length - 1] ?? null;
  return { rounds, defaultKey: best?.key ?? null };
}
