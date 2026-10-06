/**
 * Custom rounds the client can build this session: shared rounds a game
 * server sent in `joinRound`, rounds the player looked up by code for a
 * private show, and the editor's Test play round. Built-in rounds come from
 * the content registry; this module answers for both.
 */
import { playableCustomRound, type CustomRoundIssue } from '@tumble/content/custom';
import { getRound, showRoundCatalog } from '@tumble/content/rounds';
import type { RoundDefinition } from '@tumble/shared';

const custom = new Map<string, RoundDefinition>();

/**
 * Validates a custom round and keeps it for this session.
 *
 * @param raw - Untrusted definition (from a server, the API or local storage).
 * @param id - Id to play it under (`custom:<CODE>` or the playtest id).
 * @returns The playable round, or the errors that stop it.
 */
export function registerCustomRound(
  raw: unknown,
  id: string,
): { ok: true; round: RoundDefinition } | { ok: false; issues: CustomRoundIssue[] } {
  // SECURITY: the same validation the game servers run; a hostile server or
  // stale cache cannot hand the sim a round the rules would refuse.
  const r = playableCustomRound(raw, id);
  if (!r.ok) return r;
  custom.set(id, r.round);
  return { ok: true, round: r.round };
}

/**
 * A round by id: built-in first, then this session's custom rounds.
 *
 * @param id - Round id.
 */
export function lookupRound(id: string): RoundDefinition | undefined {
  return getRound(id) ?? custom.get(id);
}

/** The offline show catalogue plus every custom round registered this session. */
export function catalogWithCustomRounds(): ReadonlyMap<string, RoundDefinition> {
  if (custom.size === 0) return showRoundCatalog();
  return new Map([...showRoundCatalog(), ...custom]);
}

/** Forgets every registered custom round (tests). */
export function clearCustomRounds(): void {
  custom.clear();
}
