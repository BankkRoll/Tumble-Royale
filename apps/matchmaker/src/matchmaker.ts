/**
 * Matchmaking service: queue state, the release tick, game-server placement,
 * join tickets and custom lobbies. State lives in an {@link MMStore}; realtime
 * events go out on per-user channels that the WebSocket layer relays.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_SHOW_PLAYERS, filterChat } from '@tumble/shared';
import { STATIC_LIVEOPS, type LiveOpsSource } from '@tumble/shared/liveops-client';
import { NO_BANS, type BanLookup } from './bans.ts';
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
import { SharedRateLimiter } from './rateLimit.ts';
import { candidateRegions, humansInRooms, pickServer, SERVER_TTL_MS, type GameServer } from './servers.ts';
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

/**
 * Stable id of a signed queue ticket for single-use checks (tickets carry no `jti`).
 *
 * @param token - The ticket as the client sent it.
 */
export function queueTicketId(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
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

/** A placed match and the join ticket for one player. */
export interface MatchFoundEvent {
  type: 'match_found';
  matchId: string;
  server: { id: string; url: string; region: string };
  /** Signed join ticket for the game server. */
  ticket: string;
  /** Seconds the ticket stays valid from when this event was produced. */
  expiresIn: number;
  playlistId: string;
  queue: string;
  team: number | null;
  role: 'player' | 'spectator';
}

/** A `match_found` kept until the player reaches the game server (`user-match:<userId>`). */
interface PendingMatch extends MatchFoundEvent {
  /** Ticket expiry, epoch ms. */
  expiresAt: number;
}

const userMatchKey = (userId: string): string => `user-match:${userId}`;

/** Events pushed to a user's WebSocket. */
export type MMEvent =
  | { type: 'queued'; entryId: string; playlistId: string; queue: string }
  | ({ type: 'status' } & QueueStatus)
  | {
      type: 'waiting_for_server';
      /** The lobby's home region. */
      region: string;
      /** True once servers in other regions are being tried ("Finding a server in another region"). */
      otherRegions: boolean;
    }
  | { type: 'queue_cancelled'; reason: string }
  | MatchFoundEvent
  | { type: 'lobby_update'; lobby: CustomLobby }
  | { type: 'lobby_closed'; code: string }
  | { type: 'lobby_kicked'; code: string; reason: 'kicked' | 'away' }
  | ({ type: 'lobby_chat' } & LobbyChatLine);

/** A chat line in a private-show lobby. */
export interface LobbyChatLine {
  /** Unique id (dedupe across tabs). */
  id: string;
  code: string;
  from: { userId: string; name: string };
  /** Slurs masked; shown with the chat filter off. */
  text: string;
  /** Fully masked copy, when it differs from `text`. */
  masked?: string;
  /** Epoch ms. */
  at: number;
}

/** Lobby chat lines allowed per member per {@link LOBBY_CHAT_WINDOW_MS}. */
export const LOBBY_CHAT_MAX = 6;
/** Lobby chat rate-limit window. */
export const LOBBY_CHAT_WINDOW_MS = 10_000;

/** What a non-member holding the code sees of a custom lobby (`GET /lobbies/:code`). */
export interface PublicLobby {
  code: string;
  region: string;
  settings: CustomSettings;
  status: CustomLobby['status'];
  locked: boolean;
  /** Players seated. */
  players: number;
  /** Spectators seated. */
  spectators: number;
  createdAt: number;
  /** Marks the reduced view. */
  public: true;
}

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

/** `GET /stats`: cheap public player counts. */
export interface MatchmakerStats {
  /** Players waiting in the matchmaking queue (party members counted). */
  queued: number;
  /** Humans in game-server rooms, from the latest heartbeats. */
  inGame: number;
  /** Live game servers. */
  servers: number;
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

/** Seats held on a server for a placed match until the server reports its room. */
export interface Reservation {
  serverId: string;
  /** Seats (humans + bots + spectators). */
  seats: number;
  /** Epoch ms. */
  at: number;
}

/** What a game server reports on every heartbeat. */
export interface ServerReport {
  /** Seats in use (humans + bots) across its rooms. */
  load: number;
  /** Rooms open. */
  rooms?: number;
  /** Match ids it hosts; their reservations are released because `load` now counts them. */
  matches?: readonly string[];
  /** Humans connected to its rooms (the public "online" count). */
  humans?: number;
  /** Ticketed players who reached a room since the last report; their pending `match_found` is cleared. */
  joined?: readonly { matchId: string; userId: string }[];
  /** The server is shutting down: no new matches, but its running shows stay reachable. */
  draining?: boolean;
}

/** What a game server learns from its heartbeat. */
export interface HeartbeatAnswer extends GameServer {
  /**
   * Matches placed on this server that no player has reached yet. A draining
   * server waits for this to reach 0 (or the join tickets to expire) before
   * it stops waiting for late arrivals.
   */
  pendingMatches: number;
}

/**
 * What the API checks show results against: where the matchmaker placed the
 * match and who it sent there.
 */
export interface MatchPlacement {
  matchId: string;
  serverId: string;
  queue: MatchRecord['queue'];
  playlistId: string;
  /** Accounts placed as players. */
  players: string[];
  /** Accounts placed as spectators (they never appear in results). */
  spectators: string[];
}

const ENTRIES = 'entries';
const SERVERS = 'servers';
/** Seats promised to placed matches whose room the server has not reported yet. */
const RESERVATIONS = 'reservations';
/**
 * A reservation outlives the join tickets (90 s) by a margin: if no ticketed
 * player has reached the server by then, the room will never be created.
 */
export const RESERVATION_TTL_MS = JOIN_TICKET_TTL_SEC * 1000 + 30_000;
const SERVER_WAIT_TTL_MS = 30 * 60_000;
/** Match records live this long after placement, renewed by every heartbeat that reports the match. */
const MATCH_TTL_MS = 30 * 60_000;
/**
 * Placements stay checkable this long: a game server whose results waited in
 * its outbox through an API outage must still be able to deliver them.
 */
export const MATCH_PLACEMENT_TTL_MS = 24 * 3_600_000;
/** Registry entries of servers silent this long are deleted (they are ignored after {@link SERVER_TTL_MS}). */
export const SERVER_PRUNE_MS = 10 * 60_000;
/**
 * Serializes "pick a server, reserve its seats" across matchmaker instances
 * and between the queue tick and private-show starts, so two placements
 * never both see the same free capacity.
 */
const PLACEMENT_LOCK = 'placement-lock';
const PLACEMENT_LOCK_TTL_MS = 5000;
const LOBBY_TTL_MS = 2 * 3_600_000;
/** Hash of live lobby codes, walked by the away sweep. */
const LOBBY_INDEX = 'lobby-index';
const LOBBY_LOCK_TTL_MS = 5000;
const TICK_LOCK = 'tick-lock';
/** Tick lock lifetime; renewed every {@link TICK_LOCK_RENEW_MS} while a tick runs. */
export const TICK_LOCK_TTL_MS = 5000;
const TICK_LOCK_RENEW_MS = 1500;
const newMatchId = (): string => `m_${randomUUID().replace(/-/g, '')}`;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Default custom lobby settings. */
export const DEFAULT_CUSTOM: CustomSettings = {
  playlistId: 'main-show',
  rounds: [],
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  bots: true,
  roundTimeScale: 1,
  lobbyCountdownSec: 10,
  spectatorSlots: 2,
  minPlayers: 1,
  roundVoting: true,
  spectatorChat: false,
};

/** Receives placement events (metrics). */
export interface MatchmakerObserver {
  /**
   * A match was placed on a server.
   *
   * @param record - The placed match.
   * @param waitedMs - Queue time of each human placed from the queue (empty for custom lobbies).
   */
  placed(record: MatchRecord, waitedMs: readonly number[]): void;
}

/** The matchmaking service. */
export class Matchmaker {
  readonly engine: EngineConfig;
  /** Optional placement observer (set by the app for metrics). */
  observer: MatchmakerObserver | undefined;

  private readonly control: GameControl;

  /**
   * @param cfg - Configuration.
   * @param store - Shared state.
   * @param now - Clock (ms).
   * @param bans - Ban lookups; {@link NO_BANS} skips the checks.
   * @param control - Game-server control channel (tests inject a fake).
   * @param liveOps - Maintenance and playlist schedules; the defaults (always open) without an API.
   */
  constructor(
    private readonly cfg: MatchmakerConfig,
    private readonly store: MMStore,
    private readonly now: () => number = Date.now,
    private readonly bans: BanLookup = NO_BANS,
    control?: GameControl,
    private readonly liveOps: LiveOpsSource = STATIC_LIVEOPS,
  ) {
    this.control = control ?? httpGameControl(cfg.gameServerSecret, now);
    this.chatLimiter = new SharedRateLimiter(store, 'rl:chat', LOBBY_CHAT_MAX, LOBBY_CHAT_WINDOW_MS, now);
    this.engine = {
      ...DEFAULT_ENGINE,
      maxWaitMs: cfg.maxWaitMs,
      hotMaxWaitMs: cfg.hotMaxWaitMs,
      hotThreshold: cfg.hotThreshold,
    };
  }

  private readonly chatLimiter: SharedRateLimiter;

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

  /**
   * Refuses new queues and lobbies while an operator's maintenance window is
   * active. Shows already placed keep running on their game servers.
   *
   * @throws {MMError} 503 `maintenance` with the operator's message.
   */
  async assertNotInMaintenance(): Promise<void> {
    const m = (await this.liveOps.get()).maintenance(this.now());
    if (m.phase === 'active') throw new MMError(503, 'maintenance', m.message);
  }

  /**
   * Refuses a playlist outside its live window or withdrawn by an operator.
   * The API checks the same when it issues the ticket; this catches a ticket
   * issued just before the playlist closed.
   *
   * @throws {MMError} 409 `playlist_unavailable`.
   */
  private async assertPlaylistLive(playlistId: string): Promise<void> {
    const phase = (await this.liveOps.get()).playlist(playlistId, null, this.now());
    if (phase === 'live') return;
    throw new MMError(
      409,
      'playlist_unavailable',
      phase === 'upcoming'
        ? 'That playlist has not started yet'
        : phase === 'ended'
          ? 'That playlist has ended'
          : 'That playlist is not available right now',
    );
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

  /**
   * Removes an entry from the queue.
   *
   * @returns False when it was already gone (a concurrent tick claimed it for
   *   a match, or another request removed it first).
   */
  private async removeEntry(e: QueueEntry): Promise<boolean> {
    const removed = await this.store.hdel(ENTRIES, e.id);
    await this.clearEntryKeys(e);
    return removed;
  }

  private async clearEntryKeys(e: QueueEntry): Promise<void> {
    await this.store.del(`server-wait:${e.id}`);
    await this.store.del(`server-fallback:${e.id}`);
    for (const m of e.members) await this.store.delIfEquals(`user-entry:${m.userId}`, e.id);
  }

  /**
   * Queues a party (or solo) from an API-issued ticket. Only the ticket's
   * leader may submit it; any previous entry of a member is replaced.
   *
   * SECURITY: a ticket queues once. Replaying an old party ticket would
   * otherwise drag members who have since left the party back into a queue.
   *
   * @param ticketId - A stable id of the signed ticket (see {@link queueTicketId}); omitted, replays are not checked.
   * @throws {MMError} 403 when the caller is not the ticket's leader, 409 when in a custom lobby,
   *   401 `invalid_ticket` when the ticket was already used.
   */
  async enqueue(caller: Player, ticket: QueueTicket, ticketId?: string): Promise<QueueEntry> {
    if (ticket.sub !== caller.userId || ticket.leaderId !== caller.userId) {
      throw new MMError(403, 'not_leader', 'Only the party leader can queue the party');
    }
    await this.assertNotInMaintenance();
    await this.assertPlaylistLive(ticket.playlistId);
    const muted = await this.checkStanding(
      ticket.members.map((m) => m.userId),
      ticket.queue === 'ranked',
    );
    // Every member is checked before any previous entry is touched: a refusal must leave the queue as it was.
    const previous: QueueEntry[] = [];
    for (const m of ticket.members) {
      if (await this.store.get(`lobby-user:${m.userId}`))
        throw new MMError(409, 'in_lobby', 'Leave the custom lobby before queueing');
      const prev = await this.entryFor(m.userId);
      if (prev) {
        if (!previous.some((p) => p.id === prev.id)) previous.push(prev);
      } else if (await this.store.get(`user-entry:${m.userId}`))
        throw new MMError(409, 'match_forming', 'A match is being formed for you; try again in a moment');
    }
    if (ticketId !== undefined) {
      const ttl = ticket.exp ? Math.max(1000, ticket.exp * 1000 - this.now() + 60_000) : 15 * 60_000;
      if (!(await this.store.setNX(`queue-ticket:${ticketId}`, '1', ttl)))
        throw new MMError(401, 'invalid_ticket', 'Queue ticket already used; request a new one from the API');
    }
    for (const prev of previous) await this.removeEntry(prev);
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
      // Queueing again abandons an unclaimed match; a reconnect must not replay it.
      await this.clearPendingMatch(m.userId);
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
    if (!e) {
      // The pointer without its entry means a tick holds the entry right now.
      // Dropping the pointer stops the tick from putting it back if its lobby
      // falls through; if the lobby is placed, the match stands.
      const id = await this.store.get(`user-entry:${userId}`);
      if (id) await this.store.delIfEquals(`user-entry:${userId}`, id);
      return false;
    }
    if (!(await this.removeEntry(e))) return false;
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
    const token = randomUUID();
    if (!(await this.store.setNX(TICK_LOCK, token, TICK_LOCK_TTL_MS))) return [];
    let owned = true;
    // A slow tick (Redis latency, many lobbies) must not let the lock lapse and
    // a second instance start placing the same entries; renew while working.
    const renew = setInterval(() => {
      void this.store
        .expireIfEquals(TICK_LOCK, token, TICK_LOCK_TTL_MS)
        .then((ok) => {
          if (!ok) owned = false;
        })
        .catch(() => undefined);
    }, TICK_LOCK_RENEW_MS);
    renew.unref?.();
    try {
      // Entries queued before the window opened would otherwise wait forever; send them back to the menu.
      if ((await this.liveOps.get()).maintenance(this.now()).phase === 'active') {
        for (const e of await this.entries()) await this.cancel(e.leaderId, 'maintenance');
        return [];
      }
      const lobbies = formLobbies(await this.entries(), this.now(), this.engine);
      const created: MatchRecord[] = [];
      for (const lobby of lobbies) {
        // Lost the lock (expired during a stall): stop; the new holder re-forms from the store.
        if (!owned || !(await this.store.expireIfEquals(TICK_LOCK, token, TICK_LOCK_TTL_MS))) break;
        const fallback = await this.serverWait(lobby);
        const matchId = newMatchId();
        const server = await this.reserveServer(
          matchId,
          lobby.region,
          lobby.size,
          fallback.otherRegions,
        ).catch((err: unknown) => {
          if (err instanceof MMError && err.code === 'placement_busy') return undefined;
          throw err;
        });
        // Another instance is placing right now; this lobby is formed again on the next tick.
        if (server === undefined) continue;
        if (!server) {
          if (fallback.changed) {
            const event: MMEvent = {
              type: 'waiting_for_server',
              region: lobby.region,
              otherRegions: fallback.otherRegions,
            };
            for (const e of lobby.entries) for (const m of e.members) await this.emit(m.userId, event);
          }
          continue;
        }
        if (!(await this.claimEntries(lobby.entries))) {
          await this.store.hdel(RESERVATIONS, matchId);
          continue;
        }
        created.push(await this.placeMatch(lobby, server, matchId));
      }
      return created;
    } finally {
      clearInterval(renew);
      await this.store.delIfEquals(TICK_LOCK, token);
    }
  }

  /**
   * Takes a formed lobby's entries out of the queue atomically. The lobby was
   * formed from a snapshot; a cancel or re-queue may have removed an entry
   * since, and placing it anyway would send `match_found` to someone who left.
   * Each entry is claimed with an atomic `hdel`; if any is gone the claimed
   * ones go back (unless a member re-queued meanwhile) and the lobby waits for
   * the next tick.
   *
   * @returns True when every entry was claimed.
   */
  private async claimEntries(entries: readonly QueueEntry[]): Promise<boolean> {
    const claimed: QueueEntry[] = [];
    for (const e of entries) if (await this.store.hdel(ENTRIES, e.id)) claimed.push(e);
    if (claimed.length === entries.length) {
      for (const e of claimed) await this.clearEntryKeys(e);
      return true;
    }
    for (const e of claimed) {
      if (await this.entryIsCurrent(e)) {
        await this.store.hset(ENTRIES, e.id, JSON.stringify(e));
        // A cancel that ran between the check and the put-back left this
        // entry without its pointers; take it out again so it is never placed.
        if (!(await this.entryIsCurrent(e)) && (await this.store.hdel(ENTRIES, e.id)))
          await this.clearEntryKeys(e);
      } else await this.clearEntryKeys(e);
    }
    return false;
  }

  private async entryIsCurrent(e: QueueEntry): Promise<boolean> {
    for (const m of e.members) if ((await this.store.get(`user-entry:${m.userId}`)) !== e.id) return false;
    return true;
  }

  /**
   * Tracks how long a released lobby has waited for a server, keyed by its
   * oldest entry (lobbies are re-formed every tick, entries persist).
   *
   * @returns Whether other regions may be tried yet, and whether that state
   *   just changed (so players are told once per phase, not every tick).
   */
  private async serverWait(lobby: FormedLobby): Promise<{ otherRegions: boolean; changed: boolean }> {
    const anchor = lobby.entries[0]!.id;
    const now = this.now();
    const first = await this.store.setNX(`server-wait:${anchor}`, String(now), SERVER_WAIT_TTL_MS);
    const since = first ? now : Number((await this.store.get(`server-wait:${anchor}`)) ?? now);
    if (now - since < this.cfg.regionFallbackMs) return { otherRegions: false, changed: first };
    const fallbackStarted = await this.store.setNX(`server-fallback:${anchor}`, '1', SERVER_WAIT_TTL_MS);
    return { otherRegions: true, changed: fallbackStarted };
  }

  private async placeMatch(lobby: FormedLobby, server: GameServer, matchId: string): Promise<MatchRecord> {
    const teamOf = new Map<string, number>();
    if (lobby.teamSize > 1) lobby.teams.forEach((t, i) => t.forEach((u) => teamOf.set(u, i)));
    const record: MatchRecord = {
      matchId,
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
    this.observer?.placed(
      record,
      lobby.entries.flatMap((e) => e.members.map(() => record.createdAt - e.enqueuedAt)),
    );
    return record;
  }

  /**
   * Stores the match (its seats are already reserved), signs join tickets
   * and notifies every participant. Each `match_found` is also kept per user for the
   * ticket's lifetime: pub/sub is fire-and-forget, so a player whose socket
   * was reconnecting at this moment would otherwise lose the match.
   */
  private async publishMatch(record: MatchRecord, server: GameServer): Promise<void> {
    await this.saveMatch(record);
    for (const r of record.roster) {
      const event = await this.matchFoundFor(record, server, r);
      const pending: PendingMatch = { ...event, expiresAt: this.now() + JOIN_TICKET_TTL_SEC * 1000 };
      await this.store.set(userMatchKey(r.userId), JSON.stringify(pending), JOIN_TICKET_TTL_SEC * 1000);
      await this.emit(r.userId, event);
    }
  }

  /** Signs a join ticket for one roster member and wraps it in a `match_found` event. */
  private async matchFoundFor(
    record: MatchRecord,
    server: Pick<GameServer, 'id' | 'url' | 'region'>,
    r: MatchRecord['roster'][number],
    rejoin = false,
  ): Promise<MatchFoundEvent> {
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
      ...(rejoin ? { rejoin: true } : {}),
    };
    const ticket = await signJoinTicket(this.cfg.gameTicketSecret, claims, new Date(this.now()));
    return {
      type: 'match_found',
      matchId: record.matchId,
      server: { id: server.id, url: server.url, region: server.region },
      ticket,
      expiresIn: JOIN_TICKET_TTL_SEC,
      playlistId: record.playlistId,
      queue: record.queue,
      team: r.team,
      role: r.role,
    };
  }

  /**
   * The `match_found` still waiting for this user, with `expiresIn` counted
   * down to now; null once they joined the game server, declined it, or the
   * ticket expired.
   */
  async pendingMatch(userId: string): Promise<MatchFoundEvent | null> {
    const raw = await this.store.get(userMatchKey(userId));
    if (!raw) return null;
    const { expiresAt, ...event } = JSON.parse(raw) as PendingMatch;
    const expiresIn = Math.floor((expiresAt - this.now()) / 1000);
    if (expiresIn <= 0) {
      await this.store.del(userMatchKey(userId));
      return null;
    }
    return { ...event, expiresIn };
  }

  /**
   * Forgets a user's pending match (they joined it, declined it or queued
   * again).
   *
   * @param matchId - Only clear when the pending match is this one, so a stale
   *   report cannot drop a newer match.
   */
  async clearPendingMatch(userId: string, matchId?: string): Promise<void> {
    if (matchId !== undefined) {
      const raw = await this.store.get(userMatchKey(userId));
      if (!raw || (JSON.parse(raw) as PendingMatch).matchId !== matchId) return;
    }
    await this.store.del(userMatchKey(userId));
  }

  /**
   * Signs a fresh join ticket for a match the caller belongs to (a reload
   * mid-show outlived both the 90 s ticket and the game server's resume
   * window).
   *
   * SECURITY: only roster members of a match their game server still hosts,
   * still in good standing and not removed by a private show's host; the game
   * server re-checks the ticket and its own removal list.
   *
   * @throws {MMError} 404 `match_not_found`, 403 `not_in_match` / `removed_by_host` /
   *   `banned`, 410 `match_over` when no live server hosts it any more.
   */
  async rejoinMatch(userId: string, matchId: string): Promise<MatchFoundEvent> {
    const record = await this.getMatch(matchId);
    if (!record) throw new MMError(404, 'match_not_found', 'That show is over');
    const seat = record.roster.find((r) => r.userId === userId);
    if (!seat) throw new MMError(403, 'not_in_match', 'You are not part of that show');
    if (await this.store.get(`match-kicked:${matchId}:${userId}`))
      throw new MMError(403, 'removed_by_host', 'The host removed you from that show');
    const muted = await this.checkStanding([userId], record.queue === 'ranked');
    const server = await this.liveServerFor(record);
    if (!server) throw new MMError(410, 'match_over', 'That show is no longer running');
    const { muted: _muted, ...rest } = seat;
    return this.matchFoundFor(
      record,
      server,
      { ...rest, ...(muted.has(userId) ? { muted: true } : {}) },
      true,
    );
  }

  /**
   * The server still hosting a match: it reported the match on a recent
   * heartbeat, or holds an unexpired reservation for it (no player has
   * connected yet). Null when the server is gone or dropped the room.
   */
  private async liveServerFor(
    record: MatchRecord,
  ): Promise<Pick<GameServer, 'id' | 'url' | 'region'> | null> {
    if (record.serverId === 'default') return { id: 'default', url: record.serverUrl, region: record.region };
    const server = (await this.servers()).find((s) => s.id === record.serverId);
    if (!server) return null;
    if ((await this.store.get(`match-live:${record.matchId}`)) === server.id) return server;
    const reservation = (await this.store.hgetall(RESERVATIONS))[record.matchId];
    if (reservation && this.now() - (JSON.parse(reservation) as Reservation).at <= RESERVATION_TTL_MS)
      return server;
    return null;
  }

  /** Stores a match record and the placement the API checks its results against. */
  private async saveMatch(record: MatchRecord): Promise<void> {
    await this.store.set(`match:${record.matchId}`, JSON.stringify(record), MATCH_TTL_MS);
    const placement: MatchPlacement = {
      matchId: record.matchId,
      serverId: record.serverId,
      queue: record.queue,
      playlistId: record.playlistId,
      players: record.roster.filter((r) => r.role === 'player').map((r) => r.userId),
      spectators: record.roster.filter((r) => r.role === 'spectator').map((r) => r.userId),
    };
    await this.store.set(
      `match-placement:${record.matchId}`,
      JSON.stringify(placement),
      MATCH_PLACEMENT_TTL_MS,
    );
  }

  /** Where a match was placed and who was sent there (the API's results check); null once forgotten. */
  async getPlacement(matchId: string): Promise<MatchPlacement | null> {
    const raw = await this.store.get(`match-placement:${matchId}`);
    return raw ? (JSON.parse(raw) as MatchPlacement) : null;
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
   * Records a server's real load. Reservations for matches the server now
   * reports as hosted are released (its `load` counts them); the rest keep
   * holding seats until their room appears or they expire.
   *
   * @param report - A bare number is the legacy `load`-only heartbeat.
   * @throws {MMError} 404 when unknown (the server should re-register).
   */
  async heartbeat(id: string, report: number | ServerReport): Promise<HeartbeatAnswer> {
    const r: ServerReport = typeof report === 'number' ? { load: report } : report;
    const raw = (await this.store.hgetall(SERVERS))[id];
    if (!raw) throw new MMError(404, 'unknown_server', 'Register first');
    const server: GameServer = {
      ...(JSON.parse(raw) as GameServer),
      load: r.load,
      ...(r.rooms !== undefined ? { rooms: r.rooms } : {}),
      ...(r.humans !== undefined ? { humans: r.humans } : {}),
      lastSeen: this.now(),
    };
    if (r.draining) server.draining = true;
    else delete server.draining;
    await this.store.hset(SERVERS, id, JSON.stringify(server));
    for (const j of r.joined ?? []) await this.clearPendingMatch(j.userId, j.matchId);
    const hosted = new Set(r.matches ?? []);
    for (const matchId of hosted) {
      // Rejoin tickets are only issued while the hosting server keeps reporting the match.
      await this.store.set(`match-live:${matchId}`, id, SERVER_TTL_MS);
      // A show may outlast the record's TTL; rejoins and host kicks need it until the show ends.
      await this.store.expire(`match:${matchId}`, MATCH_TTL_MS);
    }
    let pendingMatches = 0;
    for (const [matchId, v] of Object.entries(await this.store.hgetall(RESERVATIONS))) {
      const res = JSON.parse(v) as Reservation;
      if (res.serverId !== id) continue;
      if (hosted.has(matchId)) await this.store.hdel(RESERVATIONS, matchId);
      else if (this.now() - res.at <= RESERVATION_TTL_MS) pendingMatches++;
    }
    return { ...server, pendingMatches };
  }

  /**
   * Public player counts for the Play tab: players waiting in queue and
   * humans in game-server rooms (from heartbeats).
   */
  async stats(): Promise<MatchmakerStats> {
    const servers = await this.servers();
    return {
      queued: (await this.entries()).reduce((s, e) => s + e.members.length, 0),
      inGame: humansInRooms(servers, this.now()),
      servers: servers.length,
    };
  }

  /** Removes a server (graceful shutdown). */
  async removeServer(id: string): Promise<void> {
    await this.store.hdel(SERVERS, id);
  }

  /**
   * Live servers as last reported (without reservations). Entries silent for
   * {@link SERVER_PRUNE_MS} are deleted on the way: a server that crashed
   * never sends its DELETE.
   */
  async servers(): Promise<GameServer[]> {
    const now = this.now();
    const live: GameServer[] = [];
    for (const [id, v] of Object.entries(await this.store.hgetall(SERVERS))) {
      const s = JSON.parse(v) as GameServer;
      if (now - s.lastSeen <= SERVER_TTL_MS) live.push(s);
      else if (now - s.lastSeen > SERVER_PRUNE_MS) await this.store.hdel(SERVERS, id);
    }
    return live;
  }

  /** Live reservations per server; expired ones are dropped on the way. */
  private async reservations(): Promise<Map<string, { seats: number; rooms: number }>> {
    const now = this.now();
    const out = new Map<string, { seats: number; rooms: number }>();
    for (const [matchId, v] of Object.entries(await this.store.hgetall(RESERVATIONS))) {
      const r = JSON.parse(v) as Reservation;
      if (now - r.at > RESERVATION_TTL_MS) {
        await this.store.hdel(RESERVATIONS, matchId);
        continue;
      }
      const sum = out.get(r.serverId) ?? { seats: 0, rooms: 0 };
      sum.seats += r.seats;
      sum.rooms += 1;
      out.set(r.serverId, sum);
    }
    return out;
  }

  /**
   * Live servers with pending reservations added to their load and room count,
   * which is what placement must use: a reported load lags placement by up to
   * one heartbeat plus the time players take to connect.
   */
  async effectiveServers(): Promise<GameServer[]> {
    const held = await this.reservations();
    return (await this.servers()).map((s) => {
      const h = held.get(s.id);
      return h ? { ...s, load: s.load + h.seats, rooms: (s.rooms ?? 0) + h.rooms } : s;
    });
  }

  private async reserve(matchId: string, server: GameServer, seats: number): Promise<void> {
    if (server.id === 'default') return;
    const r: Reservation = { serverId: server.id, seats, at: this.now() };
    await this.store.hset(RESERVATIONS, matchId, JSON.stringify(r));
  }

  /**
   * Picks a server and reserves `seats` on it for `matchId` in one step under
   * the placement lock (see {@link PLACEMENT_LOCK}).
   *
   * @returns The server, or null when none has room.
   * @throws {MMError} 503 `placement_busy` when the lock stays taken for ~2 s.
   */
  private async reserveServer(
    matchId: string,
    region: string,
    seats: number,
    otherRegions: boolean,
  ): Promise<GameServer | null> {
    return this.withStoreLock(PLACEMENT_LOCK, PLACEMENT_LOCK_TTL_MS, 'placement_busy', async () => {
      const server = await this.allocateServer(region, seats, otherRegions);
      if (server) await this.reserve(matchId, server, seats);
      return server;
    });
  }

  /**
   * Runs `fn` holding a store lock, renewed while it runs so a slow step
   * (Redis latency, a slow ban lookup) cannot let it lapse into another
   * holder's hands. Only its owner releases it.
   *
   * @throws {MMError} 503 `busyCode` when the lock stays taken for ~2 s.
   */
  private async withStoreLock<T>(
    key: string,
    ttlMs: number,
    busyCode: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    for (let i = 0; !(await this.store.setNX(key, token, ttlMs)); i++) {
      if (i >= 100) throw new MMError(503, busyCode, 'Busy, try again');
      await new Promise((r) => setTimeout(r, 20));
    }
    const renew = setInterval(
      () => void this.store.expireIfEquals(key, token, ttlMs).catch(() => undefined),
      Math.max(100, Math.floor(ttlMs / 3)),
    );
    renew.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      await this.store.delIfEquals(key, token);
    }
  }

  /**
   * Picks a server for `seats`: in the region, or anywhere nearby once
   * `otherRegions` allows it; the development default server as a last resort.
   */
  private async allocateServer(
    region: string,
    seats: number,
    otherRegions = false,
  ): Promise<GameServer | null> {
    const live = await this.effectiveServers();
    const regions = candidateRegions(
      region,
      otherRegions,
      live.map((s) => s.region),
    );
    const server = pickServer(live, regions, seats, this.now());
    if (server) return server;
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
    return this.withStoreLock(`lobby-lock:${code}`, LOBBY_LOCK_TTL_MS, 'lobby_busy', async () =>
      fn(await this.loadLobby(code)),
    );
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
    await this.assertNotInMaintenance();
    await this.checkStanding([host.userId]);
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

  /**
   * A lobby as `viewerId` may see it: members get everything, anyone else
   * holding the code only what the join screen needs.
   *
   * SECURITY: codes get shared on stream; who is in the lobby (account ids)
   * and whom the host banned is for its members only.
   */
  async viewLobby(viewerId: string, code: string): Promise<CustomLobby | PublicLobby> {
    const lobby = await this.loadLobby(code);
    if (rules.seatOf(lobby, viewerId)) return lobby;
    return {
      code: lobby.code,
      region: lobby.region,
      settings: lobby.settings,
      status: lobby.status,
      locked: lobby.locked,
      players: lobby.players.length,
      spectators: lobby.spectators.length,
      createdAt: lobby.createdAt,
      public: true,
    };
  }

  /**
   * Sends a chat line to every member of the caller's open lobby. The text is
   * filtered with the shared chat filter; clients hide lines from players they
   * blocked or muted.
   *
   * @throws {MMError} 404 `no_lobby`, 403 `chat_banned`, 400 `empty_message`, 429 `chat_rate`.
   */
  async lobbyChat(userId: string, raw: unknown): Promise<LobbyChatLine> {
    // PERF: the limiter comes first, so a flood costs one counter hit per line
    // instead of lobby reads, a ban lookup and the filter.
    if (!(await this.chatLimiter.hit(userId)).allowed)
      throw new MMError(429, 'chat_rate', 'Slow down a little');
    const lobby = await this.lobbyOf(userId);
    const seat = lobby ? rules.seatOf(lobby, userId) : undefined;
    if (!lobby || !seat) throw new MMError(404, 'no_lobby', 'You are not in a private show');
    const scopes = (await this.bans.scopes([userId])).get(userId);
    if (scopes?.has('chat') || scopes?.has('all'))
      throw new MMError(403, 'chat_banned', 'Chat is disabled on this account');
    const filtered = filterChat(raw);
    if (!filtered) throw new MMError(400, 'empty_message', 'Say something first');
    const line: LobbyChatLine = {
      id: randomUUID(),
      code: lobby.code,
      from: { userId, name: seat.name },
      ...filtered,
      at: this.now(),
    };
    for (const m of rules.members(lobby)) await this.emit(m.userId, { type: 'lobby_chat', ...line });
    return line;
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
    await this.checkStanding([p.userId]);
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

  /**
   * Takes a spectator seat in a private show that is already running (the
   * code was shared to a broadcaster or a late friend). Seats come from the
   * host's spectator limit, counting the spectators the show started with;
   * a seat taken this way belongs to the account until the show ends, so
   * leaving and coming back does not cost another one. A member of the show
   * gets their own seat back instead.
   *
   * SECURITY: the host's bans, lock and in-show removals apply, and the game
   * server enforces the same limit again from the ticket.
   *
   * @throws {MMError} 404 `lobby_not_found`, 409 `lobby_open` (not started: join instead),
   *   409 `no_spectators` / `spectators_full`, 403 `banned` / `lobby_locked` /
   *   `removed_by_host`, 410 `match_over`.
   */
  async watchLobby(p: Player, code: string): Promise<MatchFoundEvent> {
    const muted = await this.checkStanding([p.userId]);
    return this.withLobby(code, async (lobby) => {
      if (lobby.status !== 'started' || !lobby.matchId)
        throw new MMError(409, 'lobby_open', 'That show has not started yet, join it with the code');
      const record = await this.getMatch(lobby.matchId);
      if (!record) throw new MMError(410, 'match_over', 'That show is over');
      if (await this.store.get(`match-kicked:${record.matchId}:${p.userId}`))
        throw new MMError(403, 'removed_by_host', 'The host removed you from that show');
      if (record.roster.some((r) => r.userId === p.userId)) return this.rejoinMatch(p.userId, record.matchId);
      rules.assertCanEnter(lobby, p.userId);
      const slots = record.custom?.spectatorSlots ?? 0;
      if (slots <= 0) throw new MMError(409, 'no_spectators', 'Spectating is turned off for this show');
      let taken = 0;
      for (const r of record.roster) {
        // A watcher the host removed gives their seat back.
        if (r.role === 'spectator' && !(await this.store.get(`match-kicked:${record.matchId}:${r.userId}`)))
          taken++;
      }
      if (taken >= slots) throw new MMError(409, 'spectators_full', 'No spectator slots left');
      const server = await this.liveServerFor(record);
      if (!server) throw new MMError(410, 'match_over', 'That show is no longer running');
      const seat: MatchRecord['roster'][number] = {
        userId: p.userId,
        name: p.name,
        partyId: `custom:${code}`,
        team: null,
        role: 'spectator',
        ...(muted.has(p.userId) ? { muted: true } : {}),
      };
      record.roster.push(seat);
      await this.saveMatch(record);
      // Listed with the lobby's spectators so the host's in-show tools can remove a watcher too.
      lobby.spectators.push({
        userId: p.userId,
        name: p.name,
        joinedAt: this.now(),
        ready: false,
        awaySince: null,
      });
      await this.saveLobby(lobby);
      return this.matchFoundFor(record, server, seat, true);
    });
  }

  /**
   * Opens a finished private show again under the same code (host only), so
   * "Play again" brings everyone back to the lobby they know instead of a new
   * code. The host is seated; the others rejoin with the code as before.
   * Already open: the host simply takes their seat again.
   *
   * @throws {MMError} 404 `lobby_not_found` once the lobby expired, 403 `not_host` / `banned`.
   */
  async reopenLobby(host: Player, code: string): Promise<CustomLobby> {
    await this.assertNotInMaintenance();
    await this.checkStanding([host.userId]);
    const current = await this.store.get(`lobby-user:${host.userId}`);
    if (current && current !== code) await this.leaveLobby(host.userId);
    const lobby = await this.withLobby(code, async (lobby) => {
      rules.assertHost(lobby, host.userId);
      if (lobby.status === 'started') {
        lobby.status = 'open';
        lobby.matchId = null;
        lobby.players = [];
        lobby.spectators = [];
      }
      if (!rules.seatOf(lobby, host.userId))
        lobby.players.unshift({
          userId: host.userId,
          name: host.name,
          joinedAt: this.now(),
          ready: true,
          awaySince: null,
        });
      await this.store.set(`lobby-user:${host.userId}`, code, LOBBY_TTL_MS);
      await this.saveLobby(lobby);
      return lobby;
    });
    await this.cancel(host.userId, 'joined_custom_lobby');
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
    if (lobby.status === 'started' && lobby.matchId) {
      await this.store.set(`match-kicked:${lobby.matchId}:${userId}`, '1', MATCH_TTL_MS);
      await this.clearPendingMatch(userId, lobby.matchId);
    }
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
    await this.assertNotInMaintenance();
    const { lobby, record, server, seats } = await this.withLobby(code, async (lobby) => {
      rules.assertHost(lobby, hostId);
      rules.assertOpen(lobby);
      // Bans can land after someone joined: suspended players are left out, chat-suspended ones muted.
      const scopes = await this.bans.scopes(rules.members(lobby).map((p) => p.userId));
      if (scopes.get(hostId)?.has('all')) throw new MMError(403, 'banned', 'This account is suspended');
      const inGoodStanding = (p: { userId: string }) => !scopes.get(p.userId)?.has('all');
      const mute = (userId: string) => (scopes.get(userId)?.has('chat') ? { muted: true } : {});
      lobby.players = lobby.players.filter(inGoodStanding);
      lobby.spectators = lobby.spectators.filter(inGoodStanding);
      const blocker = rules.startBlocker(lobby, force);
      if (blocker) throw blocker;
      const size = lobby.settings.maxPlayers;
      const seats = size + lobby.spectators.length;
      // A host pressing Start is waiting on us, so other regions are tried straight away.
      const matchId = newMatchId();
      const server = await this.reserveServer(matchId, lobby.region, seats, true);
      if (!server) throw new MMError(503, 'no_server', 'No game server available');
      const record: MatchRecord = {
        matchId,
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
      return { lobby, record, server, seats };
    });
    for (const p of rules.members(lobby)) await this.store.del(`lobby-user:${p.userId}`);
    await this.publishMatch(record, server);
    this.observer?.placed(record, []);
    return record;
  }
}
