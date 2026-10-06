/**
 * "Join with a code": one dialog for both kinds of six-character code the
 * game hands out, a private show's lobby code (matchmaker) and a party's
 * invite code (account API). The lobby is tried first; a code no lobby owns
 * is looked up as a party.
 *
 * Kept free of the UI and the network so every branch is testable: the
 * caller supplies the calls and renders the outcome.
 */
import { ApiError, type ApiParty, type ApiPartyPreview } from '../api.ts';
import type { Lobby } from './matchmaker.ts';

/** The calls a join needs. */
export interface JoinCodeDeps {
  /** Joins a private show by code; null when the matchmaker is unreachable. */
  joinLobby: ((code: string) => Promise<{ lobby: Lobby }>) | null;
  /** Who is behind a party code (404 when nobody). */
  partyByCode(code: string): Promise<ApiPartyPreview>;
  /** Joins the party (the API leaves any previous party first). */
  joinParty(code: string): Promise<{ party: ApiParty }>;
  /** The party the player is in right now, if any. */
  currentParty(): ApiParty | null;
}

/** What happened, for the caller to show. */
export type JoinCodeOutcome =
  | { kind: 'lobby'; lobby: Lobby }
  | { kind: 'party'; party: ApiParty }
  /** The code is the player's own party. */
  | { kind: 'alreadyInParty' }
  /** Joining would leave a party with other people in it: ask first, then call again with `leaveParty`. */
  | { kind: 'confirmLeaveParty'; preview: ApiPartyPreview; currentSize: number }
  | { kind: 'error'; title: string; body: string; code: string };

/** Characters both code kinds are drawn from (no 0/O, 1/I). */
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** The answer for a code nobody owns. */
export const NO_CODE_MATCH: Extract<JoinCodeOutcome, { kind: 'error' }> = {
  kind: 'error',
  title: 'No party or show with that code',
  body: 'Check the code with whoever sent it. Codes stop working when the party or show ends.',
  code: 'E-CODE-404',
};

/**
 * Whose party the leave-and-join question names.
 *
 * @param leader - The preview's `name#tag` of the leader, if any.
 * @param streamer - Settings → Streamer mode.
 * @returns e.g. `Wobbleton's party`, or `that party`.
 */
export function partyOwnerLabel(leader: string | null, streamer: boolean): string {
  // SECURITY: the preview names the leader by Name#tag only, with no account id to mask by,
  // so Streamer Mode drops the name entirely.
  if (!leader || streamer) return 'that party';
  return `${leader.split('#')[0]}'s party`;
}

const unreachable = (body: string): Extract<JoinCodeOutcome, { kind: 'error' }> => ({
  kind: 'error',
  title: "Couldn't check that code",
  body,
  code: 'E-CODE-NET',
});

const errorCode = (err: unknown): string => (err instanceof ApiError ? err.code : '');
const isNotFound = (err: unknown): boolean =>
  err instanceof ApiError &&
  (err.status === 404 || err.code === 'lobby_not_found' || err.code === 'not_found');
const isNetwork = (err: unknown): boolean => err instanceof ApiError && err.status === 0;
const message = (err: unknown): string =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong.';

/** A lobby refusal worth telling the player about (the code was right). */
function lobbyRefusal(err: unknown): Extract<JoinCodeOutcome, { kind: 'error' }> {
  const titles: Record<string, string> = {
    lobby_started: 'That show already started',
    lobby_full: 'That show is full',
    lobby_locked: 'The host locked that show',
    banned: 'You were removed from that show',
  };
  return {
    kind: 'error',
    title: titles[errorCode(err)] ?? "Couldn't join that show",
    body: message(err),
    code: 'E-LOBBY',
  };
}

/** A party refusal (the code was right). */
function partyRefusal(err: unknown): Extract<JoinCodeOutcome, { kind: 'error' }> {
  const code = errorCode(err);
  if (code === 'party_full')
    return {
      kind: 'error',
      title: 'That party is full',
      body: 'Parties hold up to 4 Tumblers.',
      code: 'E-PARTY-FULL',
    };
  if (code === 'kicked')
    return { kind: 'error', title: 'You were removed from that party', body: message(err), code: 'E-PARTY' };
  return { kind: 'error', title: "Couldn't join that party", body: message(err), code: 'E-PARTY' };
}

/**
 * Resolves a typed code to a private show or a party and joins it.
 *
 * @param raw - What the player typed (case and spaces are forgiven).
 * @param deps - Matchmaker and API calls.
 * @param opts.leaveParty - The player confirmed leaving their current party.
 *
 * @example
 * const r = await joinWithCode('abc234', deps);
 * if (r.kind === 'confirmLeaveParty') ask(...).then(() => joinWithCode('ABC234', deps, { leaveParty: true }));
 */
export async function joinWithCode(
  raw: string,
  deps: JoinCodeDeps,
  opts: { leaveParty?: boolean } = {},
): Promise<JoinCodeOutcome> {
  const code = raw.trim().toUpperCase();
  if (!CODE_RE.test(code)) return NO_CODE_MATCH;
  const current = deps.currentParty();
  if (current?.code === code) return { kind: 'alreadyInParty' };

  let lobbyUnreachable = deps.joinLobby === null;
  if (deps.joinLobby) {
    try {
      return { kind: 'lobby', lobby: (await deps.joinLobby(code)).lobby };
    } catch (err) {
      if (isNetwork(err)) lobbyUnreachable = true;
      else if (!isNotFound(err)) return lobbyRefusal(err);
    }
  }

  let preview: ApiPartyPreview;
  try {
    preview = await deps.partyByCode(code);
  } catch (err) {
    if (isNetwork(err)) return unreachable('The servers could not be reached. Try again in a moment.');
    if (isNotFound(err))
      return lobbyUnreachable
        ? unreachable('Private shows are offline right now, and no party uses that code.')
        : NO_CODE_MATCH;
    return partyRefusal(err);
  }
  if (preview.size >= preview.maxSize) return partyRefusal(new ApiError(409, 'party_full', 'Party is full'));
  const others = (current?.members.length ?? 0) > 1;
  if (others && !opts.leaveParty)
    return { kind: 'confirmLeaveParty', preview, currentSize: current?.members.length ?? 1 };
  try {
    return { kind: 'party', party: (await deps.joinParty(code)).party };
  } catch (err) {
    if (isNotFound(err)) return NO_CODE_MATCH;
    return partyRefusal(err);
  }
}
