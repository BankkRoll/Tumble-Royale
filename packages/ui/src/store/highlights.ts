/**
 * Words for the show's automatic highlights: one line per highlight, with
 * names masked by Streamer Mode the same way as everywhere else.
 */
import { streamerSafeName } from '../names.ts';
import type { HighlightEntry, HighlightKind, HighlightPlayer } from './types.ts';

/** Short heading per kind (chips, the viewer badge). */
export const HIGHLIGHT_HEADINGS: Readonly<Record<HighlightKind, string>> = {
  finalWin: 'Crowned',
  closeFinish: 'Photo finish',
  lastSecondQualify: 'Last-gasp qualify',
  bigFall: 'Big fall',
  chainGrab: 'Grab chain',
  comeback: 'Comeback',
  clutchSurvival: 'Clutch survival',
  decisiveScore: 'Decider',
};

function who(p: HighlightPlayer | null, streamer: boolean): string {
  if (!p) return 'Someone';
  if (p.isLocal) return 'You';
  return streamerSafeName(p, streamer);
}

function lower(name: string, p: HighlightPlayer | null): string {
  return p?.isLocal ? 'you' : name;
}

/**
 * One line describing a highlight.
 *
 * @param h - The highlight.
 * @param streamer - Settings → Streamer mode (other players' names masked).
 * @returns Text such as "Photo finish: Bean edged you by 0.12 s".
 * @example
 * highlightTitle({ kind: 'finalWin', player: { id: 0, name: 'Bean', isBot: false, isLocal: true }, ... }, false);
 * // 'You won the Crown!'
 */
export function highlightTitle(h: HighlightEntry, streamer: boolean): string {
  const a = who(h.player, streamer);
  const b = lower(who(h.other, streamer), h.other);
  switch (h.kind) {
    case 'finalWin':
      return h.player?.isLocal ? 'You won the Crown!' : `${a} won the Crown`;
    case 'closeFinish':
      return `Photo finish: ${a} edged ${b} by ${h.value.toFixed(2)} s`;
    case 'lastSecondQualify':
      return h.value > 0 ? `${a} qualified with ${h.value.toFixed(1)} s left` : `${a} took the last spot`;
    case 'bigFall':
      return `Big fall for ${lower(a, h.player)}`;
    case 'chainGrab':
      return `${Math.round(h.value)}-Tumbler grab chain started by ${lower(a, h.player)}`;
    case 'comeback':
      return `${a} came back from ${Math.round(h.value)} setbacks to qualify`;
    case 'clutchSurvival':
      return h.value > 0
        ? `${a} survived to the end with ${Math.round(h.value)} left`
        : `${a} saved it with a ledge grab`;
    default:
      return `${a} scored the decider (${Math.round(h.value)})`;
  }
}

/**
 * Where a highlight happened ("Final · Crown Climb", "R2 · Slime Slide").
 *
 * @param h - The highlight.
 */
export function highlightPlace(h: Pick<HighlightEntry, 'isFinal' | 'roundIndex' | 'roundName'>): string {
  return `${h.isFinal ? 'Final' : `R${h.roundIndex + 1}`} · ${h.roundName}`;
}
