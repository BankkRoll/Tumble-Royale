/**
 * Profile cards for Tumblers met in offline shows. This device only knows
 * what happened in shows played together, so the card carries exactly that
 * ({@link MetOfflineInfo}) and the UI hides level, XP, rank and lifetime
 * stats instead of showing made-up ones.
 */
import type { ProfileData } from '@tumble/ui';
import type { OpponentRecord } from './profile.ts';

/**
 * Builds the card for a Hall of Fame row.
 *
 * @param playerId - Row id (`faced:<name>`).
 * @param name - Display name.
 * @param o - What the local profile recorded about them.
 * @returns A card flagged `metOffline`; the required numeric fields are zero
 *   placeholders the UI never shows for such cards.
 *
 * @example
 * facedCard('faced:Gizmo', 'Gizmo', profile.opponents().Gizmo);
 */
export function facedCard(playerId: string, name: string, o: OpponentRecord): ProfileData {
  return {
    id: playerId,
    name,
    tag: '',
    level: 0,
    xp: 0,
    xpToNext: 0,
    gumballs: 0,
    gems: 0,
    crowns: o.crowns,
    colors: o.colors,
    isGuest: !o.isBot,
    stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0 },
    metOffline: {
      isBot: o.isBot,
      showsTogether: o.faced,
      bestPlace: o.best,
      crownsTogether: o.crowns,
      ...(o.ahead !== undefined ? { aheadOfYou: o.ahead } : {}),
      lastSeen: o.lastSeen,
    },
  };
}
