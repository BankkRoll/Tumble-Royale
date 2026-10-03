/**
 * Matchmaking service: queue state, the release tick, game-server placement,
 * join tickets and custom lobbies. State lives in an {@link MMStore}; realtime
 * events go out on per-user channels that the WebSocket layer relays.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { MatchmakerConfig } from './config.ts';
import { MMError } from './errors.ts';
import { httpGameControl, type GameControl } from './gameControl.ts';
import * as rules from './lobbyRules.ts';
import {
  DEFAULT_ENGINE,
  formLobbies,
  queueStatus,
  type EngineConfig,
  type FormedLobby,
  type QueueEntry,
  type QueueStatus,
} from './engine.ts';
import { pickServer, SERVER_TTL_MS, type GameServer } from './servers.ts';
import type { MMStore } from './store.ts';
import {
  JOIN_TICKET_TTL_SEC,
  signJoinTicket,
  type CustomSettings,
  type JoinTicketClaims,
  type Player,
  type QueueTicket,
} from './tickets.ts';

export { MMError };

/** Server-side record of a placed match (served to game servers). */
export interface MatchRecord {
  matchId: string;
  serverId: string;
  serverUrl: string;
  playlistId: string;
  queue: 'casual' | 'ranked' | 'custom';
  region: string;
  size: number;
  teamSize: number;
  humans: number;
  botFill: number;
  /** Each human with party and team. */
  roster: {
    userId: string;
    name: string;
    partyId: string;
    team: number | null;
    role: 'player' | 'spectator';
  }[];
  custom: CustomSettings | null;
  createdAt: number;
}

/** Events pushed to a user's WebSocket. */
export type MMEvent =
  | { type: 'queued'; entryId: string; playlistId: string; queue: string }
  | ({ type: 'status' } & QueueStatus)
  | { type: 'waiting_for_server' }
  | { type: 'queue_cancelled'; reason: string }
  | {
      type: 'match_found';
      matchId: string;
      server: { id: string; url: string; region: string };
      ticket: string;
      expiresIn: number;
      playlistId: string;
      queue: string;
      team: number | null;
      role: 'player' | 'spectator';
    }
  | { type: 'lobby_update'; lobby: CustomLobby }
  | { type: 'lobby_closed'; code: string }
  | { type: 'lobby_kicked'; code: string; reason: 'kicked' | 'away' };

/** A member's seat in a custom lobby. */
export interface LobbySeat {
  userId: string;
  name: string;
  /** When they first joined; the longest-present player inherits the crown. */
  joinedAt: number;
  /** Ready check (the host is always ready; spectators are not asked). */
  ready: boolean;
  /** When their last matchmaker socket closed, or null while connected. */
  awaySince: number | null;
}

/** A custom/private lobby. */
export interface CustomLobby {
  code: string;
  hostId: string;
  region: string;
  settings: CustomSettings;
  players: LobbySeat[];
  spectators: LobbySeat[];
  status: 'open' | 'started';
  matchId: string | null;
  /** Locked lobbies refuse code joins (members already inside stay). */
  locked: boolean;
  /** Removed by the host; the code no longer lets them in until unbanned. */
  banned: { userId: string; name: string }[];
  createdAt: number;
}

/** Channel for a user's events. */
export const userChannel = (userId: string): string => `user:${userId}`;

const ENTRIES = 'entries';
const SERVERS = 'servers';
const MATCH_TTL_MS = 30 * 60_000;
const LOBBY_TTL_MS = 2 * 3_600_000;
/** Hash of live lobby codes, walked by the away sweep. */
const LOBBY_INDEX = 'lobby-index';
const LOBBY_LOCK_TTL_MS = 5000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Default custom lobby settings. */
export const DEFAULT_CUSTOM: CustomSettings = {
  playlistId: 'main-show',
  rounds: [],
  maxPlayers: 40,
  bots: true,
  roundTimeScale: 1,
  lobbyCountdownSec: 10,
  spectatorSlots: 2,
  minPlayers: 1,
};

/** The matchmaking service. */
export class Matchmaker {
  readonly engine: EngineConfig;

  private readonly control: GameControl;

  /**
   * @param cfg - Configuration.
   * @param store - Shared state.
   * @param now - Clock (ms).
   * @param control - Game-server control channel (tests inject a fake).
   */
  constructor(
    private readonly cfg: MatchmakerConfig,
    private readonly store: MMStore,
    private readonly now: () => number = Date.now,
    control?: GameControl,
  ) {
    this.control = control ?? httpGameControl(cfg.gameServerSecret, now);
    this.engine = {
      ...DEFAULT_ENGINE,
      maxWaitMs: cfg.maxWaitMs,
      hotMaxWaitMs: cfg.hotMaxWaitMs,
      hotThreshold: cfg.hotThreshold,
    };
  }

  private async emit(userId: string, event: MMEvent): Promise<void> {
    await this.store.publish(userChannel(userId), JSON.stringify(event));
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  /** Every queued entry. */
  async entries(): Promise<QueueEntry[]> {
    return Object.values(await this.store.hgetall(ENTRIES)).map((v) => JSON.parse(v) as QueueEntry);
  }

  /** The entry containing a user, if queued. */
  async entryFor(userId: string): Promise<QueueEntry | null> {
    const id = await this.store.get(`user-entry:${userId}`);
    if (!id) return null;
    const all = await this.store.hgetall(ENTRIES);
    return all[id] ? (JSON.parse(all[id]) as QueueEntry) : null;
  }

  private async removeEntry(e: QueueEntry): Promise<void> {
    await this.store.hdel(ENTRIES, e.id);
    for (const m of e.members) {
      if ((await this.store.get(`user-entry:${m.userId}`)) === e.id)
        await this.store.del(`user-entry:${m.userId}`);
    }
  }

  /**
   * Queues a party (or solo) from an API-issued ticket. Only the ticket's
   * leader may submit it; any previous entry of a member is replaced.
   *
   * @throws {MMError} 403 when the caller is not the ticket's leader, 409 when in a custom lobby.
   */
  async enqueue(caller: Player, ticket: QueueTicket): Promise<QueueEntry> {
    if (ticket.sub !== caller.userId || ticket.leaderId !== caller.userId) {
      throw new MMError(403, 'not_leader', 'Only the party leader can queue the party');
    }
    for (const m of ticket.members) {
      if (await this.store.get(`lobby-user:${m.userId}`))
        throw new MMError(409, 'in_lobby', 'Leave the custom lobby before queueing');
      const prev = await this.entryFor(m.userId);
      if (prev) await this.removeEntry(prev);
    }
    const entry: QueueEntry = {
      id: randomUUID(),
      partyId: ticket.pid,
      leaderId: ticket.leaderId,
      members: ticket.members.map((m) => ({ userId: m.userId, name: m.name, ordinal: m.ordinal })),
      playlistId: ticket.playlistId,
      queue: ticket.queue,
      region: ticket.region,
      teamSize: ticket.teamSize,
      lobbySize: ticket.maxPlayers ?? this.cfg.targetSize,
      minPlayers: ticket.minPlayers ?? 1,
      botsAllowed: ticket.botsAllowed ?? true,
      enqueuedAt: this.now(),
    };
    await this.store.hset(ENTRIES, entry.id, JSON.stringify(entry));
    for (const m of entry.members) {
      await this.store.set(`user-entry:${m.userId}`, entry.id);
      await this.emit(m.userId, {
        type: 'queued',
        entryId: entry.id,
        playlistId: entry.playlistId,
        queue: entry.queue,
      });
    }
    return entry;
  }

  /** Cancels the queue entry containing `userId` (the whole party leaves). */
  async cancel(userId: string, reason = 'cancelled'): Promise<boolean> {
    const e = await this.entryFor(userId);
    if (!e) return false;
    await this.removeEntry(e);
    for (const m of e.members) await this.emit(m.userId, { type: 'queue_cancelled', reason });
    return true;
  }

  /** Queue status for a user, or null when not queued. */
  async status(userId: string): Promise<(QueueStatus & { entryId: string; playlistId: string }) | null> {
    const e = await this.entryFor(userId);
    if (!e) return null;
    return {
      entryId: e.id,
      playlistId: e.playlistId,
      ...queueStatus(e, await this.entries(), this.now(), this.engine),
    };
  }

  /** Pushes a status update to every queued player. */
  async broadcastStatus(): Promise<void> {
    const all = await this.entries();
    const now = this.now();
    for (const e of all) {
      const s = queueStatus(e, all, now, this.engine);
      for (const m of e.members) await this.emit(m.userId, { type: 'status', ...s });
    }
  }

  /**
   * Forms and places every releasable lobby. Guarded by a store lock so only
   * one matchmaker instance ticks at a time.
   *
   * @returns The matches created this tick.
   */
  async tick(): Promise<MatchRecord[]> {
    if (!(await this.store.setNX('tick-lock', '1', 5000))) return [];
    try {
      const lobbies = formLobbies(await this.entries(), this.now(), this.engine);
      const created: MatchRecord[] = [];
      for (const lobby of lobbies) {
        const server = await this.allocateServer(lobby.region, lobby.size);
        if (!server) {
          for (const e of lobby.entries)
            for (const m of e.members) await this.emit(m.userId, { type: 'waiting_for_server' });
          continue;
        }
        for (const e of lobby.entries) await this.removeEntry(e);
        created.push(await this.placeMatch(lobby, server));
      }
      return created;
    } finally {
      await this.store.del('tick-lock');
    }
  }

  private async placeMatch(lobby: FormedLobby, server: GameServer): Promise<MatchRecord> {
    const teamOf = new Map<string, number>();
    if (lobby.teamSize > 1) lobby.teams.forEach((t, i) => t.forEach((u) => teamOf.set(u, i)));
    const record: MatchRecord = {
      matchId: `m_${randomUUID().replace(/-/g, '')}`,
      serverId: server.id,
      serverUrl: server.url,
      playlistId: lobby.playlistId,
      queue: lobby.queue,
      region: lobby.region,
      size: lobby.size,
      teamSize: lobby.teamSize,
      humans: lobby.humans,
      botFill: lobby.botFill,
      roster: lobby.entries.flatMap((e) =>
        e.members.map((m) => ({
          userId: m.userId,
          name: m.name,
          partyId: e.partyId,
          team: teamOf.get(m.userId) ?? null,
          role: 'player' as const,
        })),
      ),
      custom: null,
      createdAt: this.now(),
    };
    await this.publishMatch(record, server);
    return record;
  }

  /** Stores the match, signs join tickets and notifies every participant. */
  private async publishMatch(record: MatchRecord, server: GameServer): Promise<void> {
    await this.store.set(`match:${record.matchId}`, JSON.stringify(record), MATCH_TTL_MS);
    const now = new Date(this.now());
    for (const r of record.roster) {
      const claims: JoinTicketClaims = {
        sub: r.userId,
        name: r.name,
        mid: record.matchId,
        sid: server.id,
        pid: r.partyId,
        team: r.team,
        role: r.role,
        playlistId: record.playlistId,
        queue: record.queue,
        region: record.region,
        size: record.size,
        humans: record.humans,
        bots: record.botFill,
        teamSize: record.teamSize,
        ...(record.custom ? { custom: record.custom } : {}),
      };
      const ticket = await signJoinTicket(this.cfg.gameTicketSecret, claims, now);
      await this.emit(r.userId, {
        type: 'match_found',
        matchId: record.matchId,
        server: { id: server.id, url: server.url, region: server.region },
        ticket,
        expiresIn: JOIN_TICKET_TTL_SEC,
        playlistId: record.playlistId,
        queue: record.queue,
        team: r.team,
        role: r.role,
      });
    }
  }

  /** A placed match, for game servers. */
  async getMatch(matchId: string): Promise<MatchRecord | null> {
    const raw = await this.store.get(`match:${matchId}`);
    return raw ? (JSON.parse(raw) as MatchRecord) : null;
  }

  // ---------------------------------------------------------------------------
  // Game servers
  // ---------------------------------------------------------------------------

  /** Registers or refreshes a game server. */
  async registerServer(s: Omit<GameServer, 'lastSeen'>): Promise<GameServer> {
    const server: GameServer = { ...s, lastSeen: this.now() };
    await this.store.hset(SERVERS, s.id, JSON.stringify(server));
    return server;
  }

  /**
   * Heartbeat with the server's real load (replaces any reservation).
   *
   * @throws {MMError} 404 when unknown (the server should re-register).
   */
  async heartbeat(id: string, load: number): Promise<GameServer> {
    const raw = (await this.store.hgetall(SERVERS))[id];
    if (!raw) throw new MMError(404, 'unknown_server', 'Register first');
    const server = { ...(JSON.parse(raw) as GameServer), load, lastSeen: this.now() };
    await this.store.hset(SERVERS, id, JSON.stringify(server));
    return server;
  }

  /** Removes a server (graceful shutdown). */
  async removeServer(id: string): Promise<void> {
    await this.store.hdel(SERVERS, id);
  }

  /** Live servers. */
  async servers(): Promise<GameServer[]> {
    const now = this.now();
    return Object.values(await this.store.hgetall(SERVERS))
      .map((v) => JSON.parse(v) as GameServer)
      .filter((s) => now - s.lastSeen <= SERVER_TTL_MS);
  }

  /** Picks a server and reserves seats on it until its next heartbeat. */
  private async allocateServer(region: string, seats: number): Promise<GameServer | null> {
    const server = pickServer(await this.servers(), region, seats, this.now());
    if (server) {
      const reserved = { ...server, load: server.load + seats };
      await this.store.hset(SERVERS, server.id, JSON.stringify(reserved));
      return reserved;
    }
    if (this.cfg.defaultGameServerUrl) {
      return {
        id: 'default',
        url: this.cfg.defaultGameServerUrl,
        region,
        capacity: 10_000,
        load: 0,
        lastSeen: this.now(),
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Custom lobbies
  // ---------------------------------------------------------------------------

  private async loadLobby(code: string): Promise<CustomLobby> {
    const raw = await this.store.get(`lobby:${code}`);
    if (!raw) throw new MMError(404, 'lobby_not_found', 'No lobby with that code');
    return rules.normalizeLobby(JSON.parse(raw) as CustomLobby);
  }

  private async saveLobby(l: CustomLobby): Promise<void> {
    await this.store.set(`lobby:${l.code}`, JSON.stringify(l), LOBBY_TTL_MS);
    await this.store.hset(LOBBY_INDEX, l.code, String(l.createdAt));
    for (const p of rules.members(l)) await this.emit(p.userId, { type: 'lobby_update', lobby: l });
  }

  private async dropLobby(code: string): Promise<void> {
    await this.store.del(`lobby:${code}`);
    await this.store.hdel(LOBBY_INDEX, code);
  }

  /**
   * Runs a read-modify-write on one lobby under a short store lock, so two
   * members acting at once (a join racing a kick, a settings change racing a
   * leave) cannot overwrite each other's change.
   */
  private async withLobby<T>(code: string, fn: (lobby: CustomLobby) => Promise<T>): Promise<T> {
    const key = `lobby-lock:${code}`;
    for (let i = 0; !(await this.store.setNX(key, '1', LOBBY_LOCK_TTL_MS)); i++) {
      if (i >= 100) throw new MMError(503, 'lobby_busy', 'The lobby is busy, try again');
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      return await fn(await this.loadLobby(code));
    } finally {
      await this.store.del(key);
    }
  }

  private async freshCode(): Promise<string> {
    let code = '';
    for (let i = 0; i < 20; i++) {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (!(await this.store.get(`lobby:${code}`))) break;
    }
    return code;
  }

  /** Removes a member inside a held lock; closes the lobby when no player is left. */
  private async removeFromLobby(lobby: CustomLobby, userId: string): Promise<void> {
    if ((await this.store.get(`lobby-user:${userId}`)) === lobby.code)
      await this.store.del(`lobby-user:${userId}`);
    const { closed } = rules.removeMember(lobby, userId);
    if (!closed) {
      await this.saveLobby(lobby);
      return;
    }
    await this.dropLobby(lobby.code);
    for (const s of lobby.spectators) {
      await this.store.del(`lobby-user:${s.userId}`);
      await this.emit(s.userId, { type: 'lobby_closed', code: lobby.code });
    }
  }

  /** Creates a lobby hosted by the caller. */
  async createLobby(host: Player, settings: Partial<CustomSettings>, region?: string): Promise<CustomLobby> {
    await this.leaveLobby(host.userId);
    await this.cancel(host.userId, 'joined_custom_lobby');
    const now = this.now();
    const lobby: CustomLobby = {
      code: await this.freshCode(),
      hostId: host.userId,
      region: region ?? host.region,
      settings: { ...DEFAULT_CUSTOM, ...settings },
      players: [{ userId: host.userId, name: host.name, joinedAt: now, ready: true, awaySince: null }],
      spectators: [],
      status: 'open',
      matchId: null,
      locked: false,
      banned: [],
      createdAt: now,
    };
    rules.validateSettings(lobby, lobby.settings);
    await this.store.set(`lobby-user:${host.userId}`, lobby.code, LOBBY_TTL_MS);
    await this.saveLobby(lobby);
    return lobby;
  }

  /** Reads a lobby by code. */
  async getLobby(code: string): Promise<CustomLobby> {
    return this.loadLobby(code);
  }

  /** The open lobby a user is a member of, or null (reloads restore it from this). */
  async lobbyOf(userId: string): Promise<CustomLobby | null> {
    const code = await this.store.get(`lobby-user:${userId}`);
    if (!code) return null;
    try {
      const lobby = await this.loadLobby(code);
      return rules.seatOf(lobby, userId) && lobby.status === 'open' ? lobby : null;
    } catch {
      return null;
    }
  }

  /**
   * Joins a lobby as a player (or spectator). A current member calling again
   * (reload, second tab) keeps their seat, role and place in the host line.
   *
   * @throws {MMError} 404 unknown code, 403 banned/locked, 409 started/full.
   */
  async joinLobby(p: Player, code: string, spectator: boolean): Promise<CustomLobby> {
    const preview = await this.loadLobby(code);
    rules.assertOpen(preview);
    if (!rules.seatOf(preview, p.userId)) rules.assertCanEnter(preview, p.userId);
    const current = await this.store.get(`lobby-user:${p.userId}`);
    if (current && current !== code) await this.leaveLobby(p.userId);
    const lobby = await this.withLobby(code, async (lobby) => {
      rules.assertOpen(lobby);
      const seat = rules.seatOf(lobby, p.userId);
      if (seat) {
        seat.awaySince = null;
      } else {
        rules.assertCanEnter(lobby, p.userId);
        const fresh = { userId: p.userId, name: p.name, joinedAt: this.now(), ready: false, awaySince: null };
        if (spectator) {
          if (lobby.spectators.length >= lobby.settings.spectatorSlots)
            throw new MMError(409, 'spectators_full', 'No spectator slots left');
          lobby.spectators.push(fresh);
        } else {
          if (lobby.players.length >= lobby.settings.maxPlayers)
            throw new MMError(409, 'lobby_full', 'Lobby is full');
          lobby.players.push(fresh);
        }
      }
      await this.store.set(`lobby-user:${p.userId}`, code, LOBBY_TTL_MS);
      await this.saveLobby(lobby);
      return lobby;
    });
    await this.cancel(p.userId, 'joined_custom_lobby');
    return lobby;
  }

  /** Leaves the caller's lobby; hosting passes to the longest-present player, an empty lobby closes. */
  async leaveLobby(userId: string): Promise<void> {
    const code = await this.store.get(`lobby-user:${userId}`);
    if (!code) return;
    await this.store.del(`lobby-user:${userId}`);
    if (!(await this.store.get(`lobby:${code}`))) return;
    await this.withLobby(code, async (lobby) => {
      if (rules.seatOf(lobby, userId)) await this.removeFromLobby(lobby, userId);
    }).catch((err: unknown) => {
      if (!(err instanceof MMError && err.status === 404)) throw err;
    });
  }

  /** Runs a host-only change on an open lobby and broadcasts the result. */
  private hostChange(
    hostId: string,
    code: string,
    fn: (lobby: CustomLobby) => void | Promise<void>,
  ): Promise<CustomLobby> {
    return this.withLobby(code, async (lobby) => {
      rules.assertHost(lobby, hostId);
      rules.assertOpen(lobby);
      await fn(lobby);
      await this.saveLobby(lobby);
      return lobby;
    });
  }

  /**
   * Updates settings (host only) while the lobby is open; members see the
   * change through `lobby_update`.
   *
   * @throws {MMError} 403 not host, 409 started or the change strands members.
   */
  async updateLobby(hostId: string, code: string, settings: Partial<CustomSettings>): Promise<CustomLobby> {
    return this.hostChange(hostId, code, (lobby) => {
      const next = { ...lobby.settings, ...settings };
      rules.validateSettings(lobby, next);
      lobby.settings = next;
    });
  }

  /**
   * Removes a player or spectator (host only) and bans them from the code.
   * After the show moved to a game server the kick is forwarded there too, so
   * the player is despawned for everyone and cannot reconnect with their ticket.
   *
   * @returns The lobby and, for started shows, whether the game server confirmed.
   */
  async kickFromLobby(
    hostId: string,
    code: string,
    userId: string,
  ): Promise<{ lobby: CustomLobby; removedFromMatch: boolean | null }> {
    const lobby = await this.withLobby(code, async (lobby) => {
      rules.kickMember(lobby, hostId, userId);
      if ((await this.store.get(`lobby-user:${userId}`)) === code)
        await this.store.del(`lobby-user:${userId}`);
      await this.saveLobby(lobby);
      return lobby;
    });
    await this.emit(userId, { type: 'lobby_kicked', code: lobby.code, reason: 'kicked' });
    const removedFromMatch =
      lobby.status === 'started' && lobby.matchId ? await this.kickFromMatch(lobby.matchId, userId) : null;
    return { lobby, removedFromMatch };
  }

  /** Forwards a kick to the game server hosting a match. */
  private async kickFromMatch(matchId: string, userId: string): Promise<boolean> {
    const record = await this.getMatch(matchId);
    if (!record) return false;
    const raw = (await this.store.hgetall(SERVERS))[record.serverId];
    const server = raw ? (JSON.parse(raw) as GameServer) : null;
    return this.control.kick({ matchId, serverUrl: record.serverUrl, server }, userId);
  }

  /** Lifts a ban so the player can use the code again (host only). */
  async unbanFromLobby(hostId: string, code: string, userId: string): Promise<CustomLobby> {
    return this.hostChange(hostId, code, (lobby) => rules.unban(lobby, hostId, userId));
  }

  /** Hands the crown to another player (host only). */
  async transferLobbyHost(hostId: string, code: string, userId: string): Promise<CustomLobby> {
    return this.hostChange(hostId, code, (lobby) => rules.transferHost(lobby, hostId, userId));
  }

  /** Locks or unlocks code joins (host only). */
  async setLobbyLocked(hostId: string, code: string, locked: boolean): Promise<CustomLobby> {
    return this.hostChange(hostId, code, (lobby) => {
      lobby.locked = locked;
    });
  }

  /**
   * Replaces the invite code (host only), e.g. after it leaked on stream. The
   * old code stops working at once; members follow via `lobby_update`.
   */
  async regenerateLobbyCode(hostId: string, code: string): Promise<CustomLobby> {
    return this.withLobby(code, async (lobby) => {
      rules.assertHost(lobby, hostId);
      rules.assertOpen(lobby);
      const next = await this.freshCode();
      await this.dropLobby(code);
      lobby.code = next;
      for (const m of rules.members(lobby))
        await this.store.set(`lobby-user:${m.userId}`, next, LOBBY_TTL_MS);
      await this.saveLobby(lobby);
      return lobby;
    });
  }

  /** Member ready toggle (the host is always ready). */
  async setLobbyReady(userId: string, code: string, ready: boolean): Promise<CustomLobby> {
    return this.withLobby(code, async (lobby) => {
      rules.assertOpen(lobby);
      const seat = lobby.players.find((p) => p.userId === userId);
      if (!seat) throw new MMError(404, 'not_a_player', 'Only players ready up');
      seat.ready = userId === lobby.hostId ? true : ready;
      await this.saveLobby(lobby);
      return lobby;
    });
  }

  /** Switches the caller between playing and spectating. */
  async setLobbyRole(userId: string, code: string, spectator: boolean): Promise<CustomLobby> {
    return this.withLobby(code, async (lobby) => {
      rules.assertOpen(lobby);
      rules.setRole(lobby, userId, spectator);
      await this.saveLobby(lobby);
      return lobby;
    });
  }

  /**
   * Marks a member connected or away (their last matchmaker socket closed).
   * Away members are dropped by {@link sweepLobbies} after the grace period.
   *
   * @returns The lobby, or null when the user is in none.
   */
  async setLobbyPresence(userId: string, online: boolean): Promise<CustomLobby | null> {
    const code = await this.store.get(`lobby-user:${userId}`);
    if (!code) return null;
    return this.withLobby(code, async (lobby) => {
      const seat = rules.seatOf(lobby, userId);
      if (!seat || lobby.status !== 'open') return lobby;
      const awaySince = online ? null : this.now();
      if ((seat.awaySince === null) !== (awaySince === null)) {
        seat.awaySince = awaySince;
        await this.saveLobby(lobby);
      }
      return lobby;
    }).catch(() => null);
  }

  /** Drops members who stayed away past the grace period from every open lobby. */
  async sweepLobbies(): Promise<void> {
    const now = this.now();
    for (const code of Object.keys(await this.store.hgetall(LOBBY_INDEX))) {
      if (!(await this.store.get(`lobby:${code}`))) {
        await this.store.hdel(LOBBY_INDEX, code);
        continue;
      }
      await this.withLobby(code, async (lobby) => {
        if (lobby.status !== 'open') return;
        for (const userId of rules.expiredMembers(lobby, now)) {
          if (!rules.seatOf(lobby, userId)) continue;
          await this.emit(userId, { type: 'lobby_kicked', code, reason: 'away' });
          await this.removeFromLobby(lobby, userId);
          if (!(await this.store.get(`lobby:${code}`))) return;
        }
      }).catch(() => undefined);
    }
  }

  /**
   * Starts the lobby (host only): places it on a server and sends every
   * player and spectator a join ticket.
   *
   * @param force - Start even though some players are not ready.
   * @throws {MMError} 409 too few players / not ready, 503 when no game server is available.
   */
  async startLobby(hostId: string, code: string, force = false): Promise<MatchRecord> {
    const { lobby, record, server } = await this.withLobby(code, async (lobby) => {
      rules.assertHost(lobby, hostId);
      rules.assertOpen(lobby);
      const blocker = rules.startBlocker(lobby, force);
      if (blocker) throw blocker;
      const size = lobby.settings.maxPlayers;
      const server = await this.allocateServer(lobby.region, size + lobby.spectators.length);
      if (!server) throw new MMError(503, 'no_server', 'No game server available in this region');
      const record: MatchRecord = {
        matchId: `m_${randomUUID().replace(/-/g, '')}`,
        serverId: server.id,
        serverUrl: server.url,
        playlistId: lobby.settings.playlistId,
        queue: 'custom',
        region: lobby.region,
        size,
        teamSize: 1,
        humans: lobby.players.length,
        botFill: lobby.settings.bots ? Math.max(0, size - lobby.players.length) : 0,
        roster: [
          ...lobby.players.map((p) => ({
            userId: p.userId,
            name: p.name,
            partyId: `custom:${code}`,
            team: null,
            role: 'player' as const,
          })),
          ...lobby.spectators.map((p) => ({
            userId: p.userId,
            name: p.name,
            partyId: `custom:${code}`,
            team: null,
            role: 'spectator' as const,
          })),
        ],
        custom: lobby.settings,
        createdAt: this.now(),
      };
      lobby.status = 'started';
      lobby.matchId = record.matchId;
      await this.saveLobby(lobby);
      return { lobby, record, server };
    });
    for (const p of rules.members(lobby)) await this.store.del(`lobby-user:${p.userId}`);
    await this.publishMatch(record, server);
    return record;
  }
}
