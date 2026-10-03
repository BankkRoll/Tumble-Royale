/**
 * Matchmaking service: queue state, the release tick, game-server placement,
 * join tickets and custom lobbies. State lives in an {@link MMStore}; realtime
 * events go out on per-user channels that the WebSocket layer relays.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { NO_BANS, type BanLookup } from './bans.ts';
import type { MatchmakerConfig } from './config.ts';
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

/** Error with an HTTP status and stable code. */
export class MMError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
    /** Chat-suspended; carried to the game server in the join ticket. */
    muted?: boolean;
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
  | { type: 'lobby_kicked'; code: string };

/** A custom/private lobby. */
export interface CustomLobby {
  code: string;
  hostId: string;
  region: string;
  settings: CustomSettings;
  players: { userId: string; name: string; joinedAt: number }[];
  spectators: { userId: string; name: string; joinedAt: number }[];
  status: 'open' | 'started';
  matchId: string | null;
  createdAt: number;
}

/** Channel for a user's events. */
export const userChannel = (userId: string): string => `user:${userId}`;

const ENTRIES = 'entries';
const SERVERS = 'servers';
const MATCH_TTL_MS = 30 * 60_000;
const LOBBY_TTL_MS = 2 * 3_600_000;
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
};

/** The matchmaking service. */
export class Matchmaker {
  readonly engine: EngineConfig;

  /**
   * @param cfg - Configuration.
   * @param store - Shared state.
   * @param now - Clock (ms).
   * @param bans - Ban lookups; {@link NO_BANS} skips the checks.
   */
  constructor(
    private readonly cfg: MatchmakerConfig,
    private readonly store: MMStore,
    private readonly now: () => number = Date.now,
    private readonly bans: BanLookup = NO_BANS,
  ) {
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

  /**
   * Checks players against active bans.
   *
   * @param userIds - Players about to queue or join a lobby together.
   * @param ranked - True for the ranked queue, where `ranked` bans also apply.
   * @returns The chat-suspended players among them.
   * @throws {MMError} 403 `banned` / `ranked_banned`.
   */
  async checkStanding(userIds: readonly string[], ranked = false): Promise<Set<string>> {
    const scopes = await this.bans.scopes(userIds);
    const muted = new Set<string>();
    const many = userIds.length > 1;
    for (const id of userIds) {
      const s = scopes.get(id);
      if (!s) continue;
      if (s.has('all'))
        throw new MMError(403, 'banned', many ? 'A party member is suspended' : 'This account is suspended');
      if (ranked && s.has('ranked'))
        throw new MMError(
          403,
          'ranked_banned',
          many
            ? 'A party member is suspended from ranked play'
            : 'This account is suspended from ranked play',
        );
      if (s.has('chat')) muted.add(id);
    }
    return muted;
  }

  /** True when the player has an active `all` ban (used to refuse the status stream). */
  async isSuspended(userId: string): Promise<boolean> {
    return (await this.bans.scopes([userId])).get(userId)?.has('all') ?? false;
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
    const muted = await this.checkStanding(
      ticket.members.map((m) => m.userId),
      ticket.queue === 'ranked',
    );
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
      members: ticket.members.map((m) => ({
        userId: m.userId,
        name: m.name,
        ordinal: m.ordinal,
        ...(muted.has(m.userId) ? { muted: true } : {}),
      })),
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
          ...(m.muted ? { muted: true } : {}),
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
        ...(r.muted ? { mute: true } : {}),
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
    return JSON.parse(raw) as CustomLobby;
  }

  private async saveLobby(l: CustomLobby): Promise<void> {
    await this.store.set(`lobby:${l.code}`, JSON.stringify(l), LOBBY_TTL_MS);
    for (const p of [...l.players, ...l.spectators])
      await this.emit(p.userId, { type: 'lobby_update', lobby: l });
  }

  /** Creates a lobby hosted by the caller. */
  async createLobby(host: Player, settings: Partial<CustomSettings>, region?: string): Promise<CustomLobby> {
    await this.checkStanding([host.userId]);
    await this.leaveLobby(host.userId);
    await this.cancel(host.userId, 'joined_custom_lobby');
    let code = '';
    for (let i = 0; i < 20; i++) {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (!(await this.store.get(`lobby:${code}`))) break;
    }
    const now = this.now();
    const lobby: CustomLobby = {
      code,
      hostId: host.userId,
      region: region ?? host.region,
      settings: { ...DEFAULT_CUSTOM, ...settings },
      players: [{ userId: host.userId, name: host.name, joinedAt: now }],
      spectators: [],
      status: 'open',
      matchId: null,
      createdAt: now,
    };
    await this.store.set(`lobby-user:${host.userId}`, code, LOBBY_TTL_MS);
    await this.saveLobby(lobby);
    return lobby;
  }

  /** Reads a lobby by code. */
  async getLobby(code: string): Promise<CustomLobby> {
    return this.loadLobby(code);
  }

  /**
   * Joins a lobby as a player (or spectator).
   *
   * @throws {MMError} 404 unknown code, 409 started/full.
   */
  async joinLobby(p: Player, code: string, spectator: boolean): Promise<CustomLobby> {
    await this.checkStanding([p.userId]);
    const lobby = await this.loadLobby(code);
    if (lobby.status !== 'open') throw new MMError(409, 'lobby_started', 'That lobby already started');
    const current = await this.store.get(`lobby-user:${p.userId}`);
    if (current && current !== code) await this.leaveLobby(p.userId);
    lobby.players = lobby.players.filter((x) => x.userId !== p.userId);
    lobby.spectators = lobby.spectators.filter((x) => x.userId !== p.userId);
    const seat = { userId: p.userId, name: p.name, joinedAt: this.now() };
    if (spectator) {
      if (lobby.spectators.length >= lobby.settings.spectatorSlots)
        throw new MMError(409, 'spectators_full', 'No spectator slots left');
      lobby.spectators.push(seat);
    } else {
      if (lobby.players.length >= lobby.settings.maxPlayers)
        throw new MMError(409, 'lobby_full', 'Lobby is full');
      lobby.players.push(seat);
    }
    await this.cancel(p.userId, 'joined_custom_lobby');
    await this.store.set(`lobby-user:${p.userId}`, code, LOBBY_TTL_MS);
    await this.saveLobby(lobby);
    return lobby;
  }

  /** Leaves the caller's lobby; hosting passes on, an empty lobby closes. */
  async leaveLobby(userId: string): Promise<void> {
    const code = await this.store.get(`lobby-user:${userId}`);
    if (!code) return;
    await this.store.del(`lobby-user:${userId}`);
    const raw = await this.store.get(`lobby:${code}`);
    if (!raw) return;
    const lobby = JSON.parse(raw) as CustomLobby;
    lobby.players = lobby.players.filter((x) => x.userId !== userId);
    lobby.spectators = lobby.spectators.filter((x) => x.userId !== userId);
    if (lobby.players.length === 0) {
      await this.store.del(`lobby:${code}`);
      for (const s of lobby.spectators) {
        await this.store.del(`lobby-user:${s.userId}`);
        await this.emit(s.userId, { type: 'lobby_closed', code });
      }
      return;
    }
    if (lobby.hostId === userId) lobby.hostId = lobby.players[0]!.userId;
    await this.saveLobby(lobby);
  }

  private async hostLobby(hostId: string, code: string): Promise<CustomLobby> {
    const lobby = await this.loadLobby(code);
    if (lobby.hostId !== hostId) throw new MMError(403, 'not_host', 'Only the host can do that');
    if (lobby.status !== 'open') throw new MMError(409, 'lobby_started', 'Lobby already started');
    return lobby;
  }

  /** Updates settings (host only). */
  async updateLobby(hostId: string, code: string, settings: Partial<CustomSettings>): Promise<CustomLobby> {
    const lobby = await this.hostLobby(hostId, code);
    const next = { ...lobby.settings, ...settings };
    if (next.maxPlayers < lobby.players.length)
      throw new MMError(409, 'too_many_players', 'More players than the new limit');
    lobby.settings = next;
    await this.saveLobby(lobby);
    return lobby;
  }

  /** Removes a player or spectator (host only). */
  async kickFromLobby(hostId: string, code: string, userId: string): Promise<CustomLobby> {
    if (hostId === userId) throw new MMError(400, 'self_kick', 'Use leave instead');
    const lobby = await this.hostLobby(hostId, code);
    lobby.players = lobby.players.filter((x) => x.userId !== userId);
    lobby.spectators = lobby.spectators.filter((x) => x.userId !== userId);
    await this.store.del(`lobby-user:${userId}`);
    await this.emit(userId, { type: 'lobby_kicked', code });
    await this.saveLobby(lobby);
    return lobby;
  }

  /**
   * Starts the lobby (host only): places it on a server and sends every
   * player and spectator a join ticket.
   *
   * @throws {MMError} 503 when no game server is available.
   */
  async startLobby(hostId: string, code: string): Promise<MatchRecord> {
    const lobby = await this.hostLobby(hostId, code);
    // Bans can land after someone joined: suspended players are left out, chat-suspended ones muted.
    const scopes = await this.bans.scopes([...lobby.players, ...lobby.spectators].map((p) => p.userId));
    if (scopes.get(hostId)?.has('all')) throw new MMError(403, 'banned', 'This account is suspended');
    const inGoodStanding = (p: { userId: string }) => !scopes.get(p.userId)?.has('all');
    const mute = (userId: string) => (scopes.get(userId)?.has('chat') ? { muted: true } : {});
    lobby.players = lobby.players.filter(inGoodStanding);
    lobby.spectators = lobby.spectators.filter(inGoodStanding);
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
          ...mute(p.userId),
        })),
        ...lobby.spectators.map((p) => ({
          userId: p.userId,
          name: p.name,
          partyId: `custom:${code}`,
          team: null,
          role: 'spectator' as const,
          ...mute(p.userId),
        })),
      ],
      custom: lobby.settings,
      createdAt: this.now(),
    };
    lobby.status = 'started';
    lobby.matchId = record.matchId;
    await this.saveLobby(lobby);
    for (const p of [...lobby.players, ...lobby.spectators]) await this.store.del(`lobby-user:${p.userId}`);
    await this.publishMatch(record, server);
    return record;
  }
}
