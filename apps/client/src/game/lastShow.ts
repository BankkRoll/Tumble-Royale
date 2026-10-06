/**
 * "Play again" memory: the exact kind of show the player last started, so a
 * replay never silently switches mode (a Vs Bots show queueing online, an
 * offline private show turning into the default playlist, a private online
 * show turning into public matchmaking).
 */
import type { CustomLobbyOptions } from '@tumble/ui';

/** How the last show was started. */
export type LastShow =
  /** Play with the default routing: matchmaking when reachable, else bots (also `?online=1`). */
  | { kind: 'auto'; playlistId: string | null }
  /** Vs Bots on a playlist. */
  | { kind: 'offline'; playlistId: string | null }
  /**
   * A private show. Without `lobby` it ran offline vs bots; with it, it was an
   * online private show from a matchmaker lobby (`code` null when the lobby is
   * unknown, e.g. the show was rejoined after a reload).
   */
  | {
      kind: 'custom';
      options: CustomLobbyOptions | null;
      lobby?: { code: string | null; host: boolean };
    }
  /** A matchmade online show (public queue, solo or party). */
  | { kind: 'matchmade'; playlistId: string }
  /** The round editor's Test play (the draft is read again, so edits show up). */
  | { kind: 'playtest' };

/** What Play again does. */
export type PlayAgainAction =
  /** Start an offline show vs bots on this playlist, right away. */
  | { action: 'offline'; playlistId: string | null }
  /** Test play the editor's draft again. */
  | { action: 'playtest' }
  /** Start an offline private show with these options. */
  | { action: 'custom'; options: CustomLobbyOptions }
  /** Go through the normal Play routing (queues online when it can). */
  | { action: 'play'; playlistId: string | null }
  /** Host of a private online show: open the same lobby again (a new one with these options if it expired). */
  | { action: 'reopenLobby'; code: string; options: CustomLobbyOptions | null }
  /** Member of a private online show: back into its lobby with the code. */
  | { action: 'rejoinLobby'; code: string }
  /** Nothing to replay on our own: back to the menu, saying why. */
  | { action: 'menu'; title: string; body: string };

/** What Play again needs to know about right now (not about the last show). */
export interface PlayAgainContext {
  /** In a party with others and not its leader: the leader starts shows. */
  partyMember: boolean;
}

/**
 * Decides how to replay the last show.
 *
 * @param last - The last show (null before any, e.g. right after the tutorial).
 * @param ctx - The player's situation now.
 * @returns The action; with no last show, a normal Play on the default playlist.
 *
 * @example
 * playAgainAction({ kind: 'offline', playlistId: 'main-show' });
 * // → { action: 'offline', playlistId: 'main-show' }, even when online is reachable
 */
export function playAgainAction(
  last: LastShow | null,
  ctx: PlayAgainContext = { partyMember: false },
): PlayAgainAction {
  const waitForLeader: PlayAgainAction = {
    action: 'menu',
    title: 'The leader starts the next show',
    body: 'Hit Ready in the menu and hang tight.',
  };
  if (!last) return ctx.partyMember ? waitForLeader : { action: 'play', playlistId: null };
  switch (last.kind) {
    case 'offline':
      return { action: 'offline', playlistId: last.playlistId };
    case 'custom': {
      if (last.lobby) {
        if (!last.lobby.code)
          return {
            action: 'menu',
            title: 'Back to the menu',
            body: 'Ask the host for the private show code to play again.',
          };
        return last.lobby.host
          ? {
              action: 'reopenLobby',
              code: last.lobby.code,
              options: last.options ? copyOptions(last.options) : null,
            }
          : { action: 'rejoinLobby', code: last.lobby.code };
      }
      if (!last.options) return { action: 'play', playlistId: null };
      // Copy so a later edit of the private show dialog can't change the replayed show.
      return { action: 'custom', options: copyOptions(last.options) };
    }
    case 'playtest':
      return { action: 'playtest' };
    case 'matchmade':
    case 'auto':
      return ctx.partyMember ? waitForLeader : { action: 'play', playlistId: last.playlistId };
  }
}

function copyOptions(o: CustomLobbyOptions): CustomLobbyOptions {
  return { ...o, rounds: [...o.rounds] };
}
