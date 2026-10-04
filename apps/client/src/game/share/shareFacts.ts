/**
 * From a finished show to what the share sheet offers: whether the result
 * deserves a card, the card's data, the offer headline and file names.
 *
 * Pure: no DOM.
 */
import type { ShowResultForProfile } from '../profile.ts';
import { cardPlayerName, ordinal, type ShareCardData } from './cardLayout.ts';

/** The show facts the share card needs (a subset of the profile's). */
export type ShareShowFacts = Pick<
  ShowResultForProfile,
  'playlistName' | 'rounds' | 'reachedFinal' | 'wonCrown' | 'place' | 'participants'
>;

/**
 * Whether the result earns a share card: a Crown, a final, or a top-quarter
 * placement (at least top 3 in small shows).
 *
 * @param f - Show facts.
 */
export function isShareworthy(f: ShareShowFacts): boolean {
  if (f.wonCrown || f.reachedFinal) return true;
  if (!(f.place > 0) || !(f.participants > 0)) return false;
  return f.place <= Math.max(3, Math.ceil(f.participants / 4));
}

/**
 * The sheet title and Share button hint.
 *
 * @param f - Show facts.
 */
export function offerHeadline(f: ShareShowFacts): string {
  if (f.wonCrown) return 'Crowned!';
  if (f.reachedFinal) return 'Finalist!';
  return isShareworthy(f) ? `${ordinal(f.place)} place` : 'Your show';
}

/**
 * Card data for a show.
 *
 * @param f - Show facts.
 * @param playerName - The player's display name.
 * @param includeName - The "show my name" toggle.
 * @param date - When the show ended (epoch ms).
 */
export function cardDataFromFacts(
  f: ShareShowFacts,
  playerName: string,
  includeName: boolean,
  date: number,
): ShareCardData {
  return {
    showName: f.playlistName,
    playerName: cardPlayerName(playerName, includeName),
    wonCrown: f.wonCrown,
    reachedFinal: f.reachedFinal,
    place: f.place,
    participants: f.participants,
    rounds: f.rounds.map((r) => ({ name: r.name, qualified: r.qualified, isFinal: r.type === 'final' })),
    date,
  };
}

/**
 * A file-name-safe slug.
 *
 * @param text - Any text.
 * @param fallback - Used when nothing ASCII survives.
 */
export function slug(text: string, fallback = 'show'): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || fallback
  );
}

/**
 * Download name of a share card.
 *
 * @param showName - Show (playlist) name.
 * @param format - Card variant.
 * @param date - Epoch ms.
 */
export function cardFileName(showName: string, format: string, date: number): string {
  return `tumble-royale-${slug(showName)}-${new Date(date).toISOString().slice(0, 10)}-${format}.png`;
}

/**
 * Download name of a clip.
 *
 * @param roundName - Round name.
 * @param extension - `mp4` or `webm`.
 * @param date - Epoch ms.
 */
export function clipFileName(roundName: string, extension: string, date: number): string {
  return `tumble-royale-${slug(roundName, 'round')}-${new Date(date).toISOString().slice(0, 10)}.${extension}`;
}
