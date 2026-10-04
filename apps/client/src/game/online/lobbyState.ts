/**
 * Pure custom-lobby logic between the matchmaker stream and the UI store:
 *
 * - {@link toCustomLobbyState}: matchmaker lobby → the lobby view's state;
 * - {@link optionsToSettings}: the UI's option names → matchmaker settings;
 * - {@link reduceLobbyEvent}: folds `lobby_update` / `lobby_closed` /
 *   `lobby_kicked` into the next lobby plus what to tell the player;
 * - {@link liveStartedLobby}: a running show's roster as its host's tools list it.
 *
 * No DOM, store or network here, so the rules are unit-tested directly.
 */
import { MAX_PLAYERS } from '@tumble/shared';
import type { CustomLobbyOptions, CustomLobbyState, TumblerColors } from '@tumble/ui';
import type { Lobby, LobbySeat, LobbySettings } from './matchmaker.ts';

/** Matchmaker events that change the local player's lobby. */
export type LobbyEvent =
  | { type: 'lobby_update'; lobby: Lobby }
  | { type: 'lobby_closed'; code: string }
  | { type: 'lobby_kicked'; code: string; reason?: 'kicked' | 'away' };

/** What to tell the player after an event. */
export interface LobbyNotice {
  kind: 'info' | 'warning' | 'success';
  title: string;
  body?: string;
  /** Show as a dialog (the player must acknowledge it) rather than a toast. */
  dialog: boolean;
}

/** Result of {@link reduceLobbyEvent}. */
export interface LobbyReduction {
  /** Lobby to show next (null = none). */
  next: Lobby | null;
  notice: LobbyNotice | null;
  /** The player was taken out of the lobby (close the dialog, back to the menu). */
  removed: boolean;
}

/** Message shown to a player the host removed. */
export const KICKED_TITLE = 'You were removed from the show by the host';

/**
 * Folds one stream event into the current lobby.
 *
 * @param current - Lobby shown now.
 * @param event - Matchmaker event.
 * @param me - Local user id.
 */
export function reduceLobbyEvent(
  current: Lobby | null,
  event: LobbyEvent,
  me: string | null,
): LobbyReduction {
  switch (event.type) {
    case 'lobby_update': {
      const lobby = event.lobby;
      // A started lobby moves to the game server; `match_found` takes over from here.
      if (lobby.status !== 'open') return { next: null, notice: null, removed: false };
      const isMember = [...lobby.players, ...lobby.spectators].some((s) => s.userId === me);
      if (me && !isMember) return { next: current, notice: null, removed: false };
      let notice: LobbyNotice | null = null;
      if (current && me) {
        if (current.hostId !== me && lobby.hostId === me)
          notice = { kind: 'success', title: "You're the host now", dialog: false };
        else if (current.code !== lobby.code && lobby.hostId !== me)
          notice = {
            kind: 'info',
            title: 'The host made a new invite code',
            body: `Share ${lobby.code} from now on.`,
            dialog: false,
          };
      }
      return { next: lobby, notice, removed: false };
    }
    case 'lobby_closed':
      if (current && current.code !== event.code) return { next: current, notice: null, removed: false };
      return {
        next: null,
        notice: { kind: 'info', title: 'The private show closed', dialog: false },
        removed: current !== null,
      };
    case 'lobby_kicked':
      // A late event from a lobby the player already left (or was moved out of) changes nothing.
      if (current && current.code !== event.code) return { next: current, notice: null, removed: false };
      return {
        next: null,
        notice:
          event.reason === 'away'
            ? {
                kind: 'warning',
                title: 'You left the private show',
                body: 'You were disconnected for too long. Ask for the code to join again.',
                dialog: false,
              }
            : {
                kind: 'warning',
                title: KICKED_TITLE,
                body: "You can't rejoin this show with its code unless the host lets you back in.",
                dialog: true,
              },
        removed: true,
      };
  }
}

const isAway = (s: LobbySeat): boolean => s.awaySince !== undefined && s.awaySince !== null;
/** Strips the `#tag` from `name#tag` for display. */
const display = (name: string): string => name.replace(/#\d+$/, '');

/**
 * Builds the lobby view's state.
 *
 * @param lobby - Matchmaker lobby.
 * @param me - Local user id.
 * @param colorsOf - Avatar colours for a member.
 */
export function toCustomLobbyState(
  lobby: Lobby,
  me: string | null,
  colorsOf: (seat: LobbySeat, self: boolean) => TumblerColors,
): CustomLobbyState {
  const member = (s: LobbySeat) => {
    const self = s.userId === me;
    const isHost = s.userId === lobby.hostId;
    return {
      id: s.userId,
      name: display(s.name),
      colors: colorsOf(s, self),
      isHost,
      isSelf: self,
      ready: isHost || s.ready === true,
      away: isAway(s),
    };
  };
  return {
    code: lobby.code,
    isHost: lobby.hostId === me,
    players: lobby.players.map(member),
    spectators: lobby.spectators.map(member),
    options: lobbyOptions(lobby.settings),
    locked: lobby.locked ?? false,
    banned: (lobby.banned ?? []).map((b) => ({ id: b.userId, name: display(b.name) })),
  };
}

/**
 * Matchmaker lobby settings as the private show dialog's options (also what
 * Play again recreates a lobby with).
 */
export function lobbyOptions(st: LobbySettings): CustomLobbyOptions {
  return {
    rounds: [...st.rounds],
    bots: st.bots,
    maxPlayers: st.maxPlayers,
    timerScale: st.roundTimeScale,
    spectators: st.spectatorSlots > 0,
    spectatorSlots: st.spectatorSlots,
    countdownSec: st.lobbyCountdownSec,
    minPlayers: st.minPlayers ?? 1,
    isPrivate: true,
  };
}

/**
 * The running private show as its host's tools should list it: the lobby
 * roster freezes when the show starts, so members who have since left the
 * game server would still be offered for removal. Keeps the host and every
 * member the server still has in the show.
 *
 * @param lobby - The started lobby.
 * @param present - Account ids the game server lists right now; null before its first roster.
 */
export function liveStartedLobby(lobby: Lobby, present: ReadonlySet<string> | null): Lobby {
  if (!present) return lobby;
  const keep = (s: LobbySeat): boolean => s.userId === lobby.hostId || present.has(s.userId);
  return { ...lobby, players: lobby.players.filter(keep), spectators: lobby.spectators.filter(keep) };
}

/**
 * Maps a (partial) UI options change onto matchmaker settings, clamped to
 * what the matchmaker accepts.
 *
 * @example optionsToSettings({ timerScale: 3 }) // { roundTimeScale: 2 }
 */
export function optionsToSettings(o: Partial<CustomLobbyOptions>): Partial<LobbySettings> {
  const out: Partial<LobbySettings> = {};
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  if (o.rounds !== undefined) out.rounds = o.rounds.slice(0, 10);
  if (o.bots !== undefined) out.bots = o.bots;
  if (o.maxPlayers !== undefined) out.maxPlayers = clamp(Math.round(o.maxPlayers), 2, MAX_PLAYERS);
  if (o.timerScale !== undefined) out.roundTimeScale = clamp(o.timerScale, 0.5, 2);
  if (o.countdownSec !== undefined) out.lobbyCountdownSec = clamp(Math.round(o.countdownSec), 0, 120);
  if (o.minPlayers !== undefined) out.minPlayers = clamp(Math.round(o.minPlayers), 1, MAX_PLAYERS);
  if (o.spectatorSlots !== undefined) out.spectatorSlots = clamp(Math.round(o.spectatorSlots), 0, 10);
  else if (o.spectators !== undefined) out.spectatorSlots = o.spectators ? 2 : 0;
  return out;
}
