/**
 * Test play: the editor saves its round to the playtest draft slot and opens
 * the game with `?playtest=1`; the game reads the draft back, validates it
 * and plays it as a one-round show against bots.
 */
import { PLAYTEST_ROUND_ID } from '@tumble/content/custom';
import { ShowPlaylistSchema, type ShowPlaylist } from '@tumble/sim/show';
import { PLAYTEST_DRAFT_ID, type DraftStore } from './drafts.ts';
import { registerCustomRound } from './registry.ts';

/** Bots plus the player in a Test play show: enough to feel a crowd, light enough to restart fast. */
export const PLAYTEST_PLAYERS = 24;

/**
 * Reads, validates and registers the playtest draft.
 *
 * @param drafts - Local draft storage.
 * @returns A one-round playlist, or what stopped it in words for a toast.
 */
export async function loadPlaytest(
  drafts: DraftStore,
): Promise<{ ok: true; playlist: ShowPlaylist } | { ok: false; message: string }> {
  let draft;
  try {
    draft = await drafts.get(PLAYTEST_DRAFT_ID);
  } catch {
    return { ok: false, message: 'Local storage is unavailable in this browser' };
  }
  if (!draft) return { ok: false, message: 'Open the round editor and press Test play' };
  const reg = registerCustomRound(draft.round, PLAYTEST_ROUND_ID);
  if (!reg.ok)
    return { ok: false, message: `The round has errors: ${reg.issues[0]?.message ?? 'see the editor'}` };
  const type = reg.round.type;
  return {
    ok: true,
    playlist: ShowPlaylistSchema.parse({
      id: 'playtest',
      name: 'Test play',
      description: reg.round.name,
      maxPlayers: PLAYTEST_PLAYERS,
      minPlayers: 2,
      minRounds: 1,
      maxRounds: 1,
      pool: [{ roundId: PLAYTEST_ROUND_ID, weight: 1 }],
      ...(type === 'race' || type === 'survival' || type === 'hunt' || type === 'logic'
        ? { firstRoundType: type }
        : {}),
    }),
  };
}
