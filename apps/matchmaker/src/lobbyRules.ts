/**
 * Pure rules for custom (private) lobbies: who may do what, how settings are
 * validated, who inherits the crown, and what blocks a start. The
 * {@link Matchmaker} loads a lobby, applies one of these, saves it and sends
 * the side effects (events, game-server calls); keeping the decisions here
 * makes every permission check unit-testable without a store.
 */
import { MMError } from './errors.ts';
import type { CustomLobby, LobbySeat } from './matchmaker.ts';
import type { CustomSettings } from './tickets.ts';

/** A member who closed every matchmaker socket is dropped after this long (a reload reconnects well within it). */
export const LOBBY_AWAY_GRACE_MS = 90_000;

/**
 * Fills fields added after a lobby was stored (Redis keeps lobbies across
 * deploys), so every rule can rely on them.
 *
 * @param raw - Lobby as parsed from the store.
 * @returns The same object, completed.
 */
export function normalizeLobby(raw: CustomLobby): CustomLobby {
  const seat = (s: Partial<LobbySeat> & { userId: string; name: string; joinedAt: number }): LobbySeat => ({
    userId: s.userId,
    name: s.name,
    joinedAt: s.joinedAt,
    ready: s.ready ?? s.userId === raw.hostId,
    awaySince: s.awaySince ?? null,
  });
  raw.players = raw.players.map(seat);
  raw.spectators = raw.spectators.map(seat);
  raw.locked ??= false;
  raw.banned ??= [];
  raw.settings.minPlayers ??= 1;
  raw.settings.roundVoting ??= true;
  raw.settings.spectatorChat ??= false;
  return raw;
}

/** Every member, players first. */
export function members(lobby: CustomLobby): LobbySeat[] {
  return [...lobby.players, ...lobby.spectators];
}

/** The member's seat, or undefined. */
export function seatOf(lobby: CustomLobby, userId: string): LobbySeat | undefined {
  return members(lobby).find((s) => s.userId === userId);
}

/**
 * Throws unless `userId` hosts the lobby.
 *
 * @throws {MMError} 403 `not_host`.
 */
export function assertHost(lobby: CustomLobby, userId: string): void {
  if (lobby.hostId !== userId) throw new MMError(403, 'not_host', 'Only the host can do that');
}

/**
 * Throws unless the lobby still takes changes (it has not moved to a game server).
 *
 * @throws {MMError} 409 `lobby_started`.
 */
export function assertOpen(lobby: CustomLobby): void {
  if (lobby.status !== 'open') throw new MMError(409, 'lobby_started', 'The show already started');
}

/**
 * Validates a settings change against the lobby as it is now.
 *
 * @param lobby - Current lobby.
 * @param next - Settings after the change.
 * @throws {MMError} 409 when the change would strand current members.
 */
export function validateSettings(lobby: CustomLobby, next: CustomSettings): void {
  if (next.maxPlayers < lobby.players.length)
    throw new MMError(
      409,
      'too_many_players',
      `${lobby.players.length} players are already in; raise the limit or remove someone first`,
    );
  if (next.spectatorSlots < lobby.spectators.length)
    throw new MMError(
      409,
      'too_many_spectators',
      `${lobby.spectators.length} spectators are already watching; keep at least that many slots`,
    );
  if (next.minPlayers > next.maxPlayers)
    throw new MMError(400, 'min_over_max', 'Minimum players cannot exceed the player limit');
}

/**
 * The member who inherits hosting: the longest-present connected player,
 * else the longest-present player at all.
 *
 * @returns The new host's user id, or null when no player is left.
 */
export function nextHost(lobby: CustomLobby): string | null {
  const byAge = [...lobby.players].sort((a, b) => a.joinedAt - b.joinedAt);
  return (byAge.find((p) => p.awaySince === null) ?? byAge[0])?.userId ?? null;
}

/**
 * Removes a member and passes the crown on when the host left.
 *
 * @returns `closed` when no player is left (spectators alone cannot run a show).
 */
export function removeMember(lobby: CustomLobby, userId: string): { closed: boolean } {
  lobby.players = lobby.players.filter((x) => x.userId !== userId);
  lobby.spectators = lobby.spectators.filter((x) => x.userId !== userId);
  if (lobby.players.length === 0) return { closed: true };
  if (lobby.hostId === userId) {
    lobby.hostId = nextHost(lobby)!;
    const seat = seatOf(lobby, lobby.hostId);
    if (seat) seat.ready = true;
  }
  return { closed: false };
}

/**
 * Hands the crown to another player.
 *
 * @throws {MMError} 400 self, 404 not a player.
 */
export function transferHost(lobby: CustomLobby, hostId: string, targetId: string): void {
  assertHost(lobby, hostId);
  if (targetId === hostId) throw new MMError(400, 'already_host', 'You already host this show');
  const target = lobby.players.find((p) => p.userId === targetId);
  if (!target) throw new MMError(404, 'not_a_player', 'Only players (not spectators) can host');
  lobby.hostId = targetId;
  target.ready = true;
}

/**
 * Removes a member for good: they land on the ban list so the code no longer lets them in.
 *
 * @returns The removed seat.
 * @throws {MMError} 400 self-kick, 404 not a member.
 */
export function kickMember(lobby: CustomLobby, hostId: string, targetId: string): LobbySeat {
  assertHost(lobby, hostId);
  if (targetId === hostId) throw new MMError(400, 'self_kick', 'Use leave instead');
  const seat = seatOf(lobby, targetId);
  if (!seat) throw new MMError(404, 'not_a_member', 'That player is not in this show');
  lobby.players = lobby.players.filter((x) => x.userId !== targetId);
  lobby.spectators = lobby.spectators.filter((x) => x.userId !== targetId);
  if (!lobby.banned.some((b) => b.userId === targetId))
    lobby.banned.push({ userId: targetId, name: seat.name });
  return seat;
}

/**
 * Lifts a ban (host only).
 *
 * @throws {MMError} 404 when the user is not banned.
 */
export function unban(lobby: CustomLobby, hostId: string, targetId: string): void {
  assertHost(lobby, hostId);
  if (!lobby.banned.some((b) => b.userId === targetId))
    throw new MMError(404, 'not_banned', 'That player is not banned');
  lobby.banned = lobby.banned.filter((b) => b.userId !== targetId);
}

/**
 * Checks whether `userId` may take a seat via the code.
 *
 * @throws {MMError} 403 banned / locked.
 */
export function assertCanEnter(lobby: CustomLobby, userId: string): void {
  if (lobby.banned.some((b) => b.userId === userId))
    throw new MMError(403, 'banned', 'You were removed from this show by the host');
  if (lobby.locked) throw new MMError(403, 'lobby_locked', 'The host locked this show');
}

/**
 * Moves a member between the player and spectator lists.
 *
 * @throws {MMError} 400 host spectating, 404 not a member, 409 no free slot.
 */
export function setRole(lobby: CustomLobby, userId: string, spectator: boolean): void {
  const seat = seatOf(lobby, userId);
  if (!seat) throw new MMError(404, 'not_a_member', 'Join the show first');
  const isSpectator = lobby.spectators.includes(seat);
  if (isSpectator === spectator) return;
  if (spectator) {
    if (userId === lobby.hostId)
      throw new MMError(400, 'host_must_play', 'Hand the crown to someone else before spectating');
    if (lobby.settings.spectatorSlots === 0)
      throw new MMError(409, 'no_spectators', 'Spectating is turned off for this show');
    if (lobby.spectators.length >= lobby.settings.spectatorSlots)
      throw new MMError(409, 'spectators_full', 'No spectator slots left');
    lobby.players = lobby.players.filter((x) => x !== seat);
    seat.ready = false;
    lobby.spectators.push(seat);
  } else {
    if (lobby.players.length >= lobby.settings.maxPlayers)
      throw new MMError(409, 'lobby_full', 'Every player slot is taken');
    lobby.spectators = lobby.spectators.filter((x) => x !== seat);
    seat.ready = false;
    lobby.players.push(seat);
  }
}

/** Ready summary of the players (the host always counts as ready; spectators are not asked). */
export function readiness(lobby: CustomLobby): { ready: number; total: number; waitingOn: string[] } {
  const waiting = lobby.players.filter((p) => p.userId !== lobby.hostId && !p.ready);
  return {
    ready: lobby.players.length - waiting.length,
    total: lobby.players.length,
    waitingOn: waiting.map((p) => p.name),
  };
}

/**
 * Why the host cannot start right now, or null.
 *
 * @param force - Start even when some players have not readied up.
 */
export function startBlocker(lobby: CustomLobby, force: boolean): MMError | null {
  const min = Math.max(1, lobby.settings.minPlayers);
  if (lobby.players.length < min)
    return new MMError(
      409,
      'not_enough_players',
      `Needs at least ${min} players (${lobby.players.length} in)`,
    );
  if (!lobby.settings.bots && lobby.players.length < 2)
    return new MMError(409, 'not_enough_players', 'Turn bots on or wait for a second player');
  const r = readiness(lobby);
  if (!force && r.waitingOn.length > 0)
    return new MMError(409, 'not_ready', `Not ready yet: ${r.waitingOn.join(', ')}`);
  return null;
}

/**
 * Members whose sockets have been gone longer than the grace period.
 *
 * @param now - Current time (ms).
 */
export function expiredMembers(lobby: CustomLobby, now: number, graceMs = LOBBY_AWAY_GRACE_MS): string[] {
  return members(lobby)
    .filter((s) => s.awaySince !== null && now - s.awaySince >= graceMs)
    .map((s) => s.userId);
}
