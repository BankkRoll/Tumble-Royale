/**
 * Many rooms per process: accepts connections, runs the Hello handshake,
 * places clients into rooms (or resumes them), and drives every room from one
 * shared drift-free 30 Hz scheduler. Also owns periodic profiling output.
 */
import {
  BitReader,
  BitWriter,
  KickReason,
  MsgType,
  PROTOCOL_VERSION,
  readHello,
  writeKick,
  type KickReasonId,
} from '@tumble/netcode';
import { SERVER_TICK_HZ } from '@tumble/shared';
import { DEFAULT_LIMITS, type ConnectionLimits } from '../antiCheat.ts';
import type { ServerMetrics } from '../metrics.ts';
import { TickScheduler } from '../scheduler.ts';
import type { Connection, Transport } from '../transport/types.ts';
import { verifyJoinTicket, type JoinTicketClaims } from '../tickets.ts';
import { Room, type RoomInfo } from './Room.ts';
import { ClientSession } from './session.ts';
import { DEFAULT_ROOM_CONFIG, type MatchSettings, type RoomConfig, type RoomDeps } from './types.ts';

/** Options for {@link RoomManager}. */
export interface RoomManagerOptions {
  config?: Partial<RoomConfig>;
  limits?: ConnectionLimits;
  /**
   * Hello must arrive within this long or the connection is dropped (5 s).
   * Clients send it as soon as the socket opens, so anything slower is an
   * idle socket holding a slot.
   */
  helloTimeoutMs?: number;
  /** Connections from one address still waiting for their Hello (8); more are closed at once. */
  maxPendingPerIp?: number;
  /** Profiling log interval; 0 disables. */
  profileLogMs?: number;
  /** Cap on concurrent rooms. */
  maxRooms?: number;
  /** Join ticket policy; absent = unticketed joins only (tests, old tools). */
  tickets?: TicketPolicy;
}

/** How Hello tickets are checked. */
export interface TicketPolicy {
  /** `GAME_TICKET_SECRET` shared with the matchmaker. */
  secret: string;
  /** Accept Hellos without a ticket into public dev rooms (never in production). */
  allowUnticketed: boolean;
  /** Wall clock for ticket expiry (tests). */
  now?: () => number;
  /**
   * This server's id as registered with the matchmaker. When set, tickets for
   * matches placed on another server (`sid`) are refused, so a leaked or
   * replayed ticket cannot open a duplicate room for someone else's match.
   */
  serverId?: string;
  /** Also accept `sid: "default"`, the matchmaker's unregistered development fallback. */
  allowDefaultSid?: boolean;
}

const MAX_PENDING_JOINS = 10_000;

/** Load summary sent to the matchmaker on every heartbeat. */
export interface CapacityReport {
  /** Seats in use, humans and bots (matchmade rooms count their full planned size). */
  load: number;
  rooms: number;
  /** Match ids of ticketed rooms, so the matchmaker can release their reservations. */
  matches: string[];
}

/**
 * Routes connections to rooms and ticks them.
 *
 * @example
 * const rooms = new RoomManager(deps, metrics, transport, { config: { fillWaitMs: 5000 } });
 * rooms.start();
 */
export class RoomManager {
  readonly config: RoomConfig;
  readonly scheduler: TickScheduler;
  private readonly rooms = new Map<string, Room>();
  /** Match id → room id for ticketed rooms. */
  private readonly matchRooms = new Map<string, string>();
  /** Match id → accounts the host removed; their still-valid tickets are refused. */
  private readonly bannedFromMatch = new Map<string, Set<string>>();
  private readonly tickets: TicketPolicy | null;
  private readonly pending = new Set<ClientSession>();
  private readonly joined: { matchId: string; userId: string }[] = [];
  private readonly limits: ConnectionLimits;
  private readonly helloTimeoutMs: number;
  private readonly maxPendingPerIp: number;
  /** Unhandshaken connections per remote address. */
  private readonly pendingByIp = new Map<string, number>();
  private readonly profileLogMs: number;
  private readonly maxRooms: number;
  private readonly writer = new BitWriter(512);
  private readonly reader = new BitReader();
  private nextRoomId = 1;
  private lastProfileLog = 0;
  private lastRateUpdate = 0;

  /**
   * @param deps - Collaborators for every room.
   * @param metrics - Process metrics.
   * @param transport - Connection source (its `onConnection` is taken over).
   * @param opts - Options.
   */
  constructor(
    private readonly deps: RoomDeps,
    private readonly metrics: ServerMetrics,
    private readonly transport: Transport | null,
    opts: RoomManagerOptions = {},
  ) {
    this.config = { ...DEFAULT_ROOM_CONFIG, ...opts.config };
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
    this.maxPendingPerIp = opts.maxPendingPerIp ?? 8;
    this.profileLogMs = opts.profileLogMs ?? 5000;
    this.maxRooms = opts.maxRooms ?? 64;
    this.tickets = opts.tickets ?? null;
    this.scheduler = new TickScheduler({ hz: SERVER_TICK_HZ, now: deps.now }, () => this.tick());
    if (transport) transport.onConnection = (conn) => this.accept(conn);
  }

  /** Starts the tick loop. */
  start(): void {
    this.scheduler.start();
  }

  /** Stops ticking and closes every room. */
  stop(): void {
    this.scheduler.stop();
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }

  /** Summaries for `/rooms`. */
  list(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => r.info());
  }

  /**
   * Removes an account from a match and refuses its join ticket afterwards
   * (a private show's host kicked them; relayed by the matchmaker).
   *
   * @returns True when the match is hosted here (the ban holds even if the
   *   player had not connected yet).
   */
  kickUser(matchId: string, userId: string): boolean {
    const roomId = this.matchRooms.get(matchId);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    let banned = this.bannedFromMatch.get(matchId);
    if (!banned) {
      banned = new Set();
      this.bannedFromMatch.set(matchId, banned);
      // Bans for matches that never got a room here are not cleaned up by the tick; cap them.
      if (this.bannedFromMatch.size > 1024) {
        const oldest = this.bannedFromMatch.keys().next().value;
        if (oldest !== undefined) this.bannedFromMatch.delete(oldest);
      }
    }
    banned.add(userId);
    if (!room) return false;
    room.removeUser(userId);
    return true;
  }

  /** Connections from `ip` that have not completed their Hello yet. */
  pendingFrom(ip: string): number {
    return this.pendingByIp.get(ip) ?? 0;
  }

  /** Upper bound on concurrent rooms; reported to the matchmaker at registration. */
  get roomLimit(): number {
    return this.maxRooms;
  }

  /**
   * What this process hosts, in the matchmaker's units: seats (humans and
   * bots) and rooms. A matchmade room counts its full planned size from the
   * first ticket on, because the matchmaker reserved that many seats for it
   * and bots join later.
   */
  capacityReport(): CapacityReport {
    let load = 0;
    const matches: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.state === 'closed') continue;
      const info = room.info();
      const live = info.humans + info.bots;
      load += room.match ? Math.max(live, room.match.humans + room.match.bots) : live;
      if (room.match) matches.push(room.match.matchId);
    }
    return { load, rooms: this.rooms.size, matches };
  }

  /** Looks up a room (tests, tools). */
  room(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** Takes ownership of a new connection and waits for its Hello. */
  accept(conn: Connection): void {
    const ip = conn.remoteAddress;
    // SECURITY: sockets that never say Hello cost memory and a timer each; cap them per address.
    if (this.pendingFrom(ip) >= this.maxPendingPerIp) {
      conn.close(1013, 'too many pending connections');
      return;
    }
    const now = this.deps.now();
    const session = new ClientSession(conn, now, this.config.snapshotByteBudget, this.limits);
    this.pending.add(session);
    this.pendingByIp.set(ip, this.pendingFrom(ip) + 1);
    let counted = true;
    const settle = (): void => {
      if (!counted) return;
      counted = false;
      const left = this.pendingFrom(ip) - 1;
      if (left > 0) this.pendingByIp.set(ip, left);
      else this.pendingByIp.delete(ip);
    };
    const timer = setTimeout(() => {
      if (this.pending.delete(session)) {
        settle();
        conn.close(4000, 'hello timeout');
      }
    }, this.helloTimeoutMs);
    conn.onClose = () => {
      clearTimeout(timer);
      this.pending.delete(session);
      settle();
    };
    conn.onMessage = (data) => {
      const t = this.deps.now();
      if (!session.guard.admit(t, data.length)) return;
      if (data[0] !== MsgType.Hello) return;
      this.reader.reset(data).readBits(8);
      const hello = readHello(this.reader);
      if (this.reader.overflow) return this.reject(conn, KickReason.BadMessage, 'bad hello');
      if (hello.version !== PROTOCOL_VERSION) {
        return this.reject(conn, KickReason.VersionMismatch, `server speaks protocol ${PROTOCOL_VERSION}`);
      }
      clearTimeout(timer);
      this.pending.delete(session);
      settle();
      const placed = this.place(session, hello.resumeToken, hello, t);
      if (!(placed instanceof Room)) {
        const reason = placed ?? (hello.resumeToken ? KickReason.ResumeExpired : KickReason.ServerFull);
        return this.reject(
          conn,
          reason,
          reason === KickReason.BadTicket
            ? 'join ticket missing, invalid or expired'
            : reason === KickReason.RemovedByHost
              ? 'removed by the host'
              : 'no room',
        );
      }
      const room = placed;
      conn.onMessage = (d) => room.onMessage(session, d, this.deps.now());
      conn.onClose = () => room.onClose(session, this.deps.now());
    };
  }

  /**
   * Finds the session a room: resume token first, then the join ticket's
   * match (created on the first ticket seen), then — dev only — any public room.
   *
   * @returns The room, or a kick reason / null (no room) on failure.
   */
  private place(
    session: ClientSession,
    token: string,
    hello: Parameters<Room['join']>[1],
    now: number,
  ): Room | KickReasonId | null {
    if (token) {
      for (const room of this.rooms.values()) {
        if (room.state !== 'closed' && room.hasToken(token) && room.resume(session, token)) return room;
      }
      // An expired token falls through to a fresh join rather than failing the player.
    }
    const policy = this.tickets;
    if (hello.ticket && policy) {
      // SECURITY: the ticket is the only proof of which account and match this connection belongs to.
      const claims = verifyJoinTicket(policy.secret, hello.ticket, (policy.now ?? Date.now)());
      if (!claims) return KickReason.BadTicket;
      if (this.bannedFromMatch.get(claims.mid)?.has(claims.sub)) return KickReason.RemovedByHost;
      if (
        policy.serverId &&
        claims.sid !== policy.serverId &&
        !(policy.allowDefaultSid && claims.sid === 'default')
      )
        return KickReason.BadTicket;
      return this.placeTicketed(session, hello, claims, now);
    }
    if (policy && !policy.allowUnticketed) return KickReason.BadTicket;
    let target: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.canAcceptPlayer()) {
        target = room;
        break;
      }
    }
    if (!target) {
      if (this.rooms.size >= this.maxRooms) return null;
      const id = `r${this.nextRoomId++}`;
      const createdAtTick = this.scheduler.tick;
      target = new Room(id, this.deps, this.config, this.metrics, () =>
        this.scheduler.dueTime(createdAtTick),
      );
      this.rooms.set(id, target);
      this.deps.log?.(`[rooms] created ${id}`);
    }
    target.join(session, hello, now);
    return target;
  }

  private placeTicketed(
    session: ClientSession,
    hello: Parameters<Room['join']>[1],
    claims: JoinTicketClaims,
    now: number,
  ): Room | null {
    const existingId = this.matchRooms.get(claims.mid);
    let room = existingId ? this.rooms.get(existingId) : undefined;
    if (room && room.state === 'closed') room = undefined;
    if (room) {
      if (room.rejoinUser(session, claims.sub)) return this.noteJoined(claims, room);
      if (room.state === 'ended') return null;
      room.join(session, hello, now, claims);
      return this.noteJoined(claims, room);
    }
    // A rejoin ticket returns to a running show; without its room (this
    // process restarted, the show ended and closed) there is nothing to return to.
    if (claims.rejoin) return null;
    if (this.rooms.size >= this.maxRooms) return null;
    const id = `r${this.nextRoomId++}`;
    const createdAtTick = this.scheduler.tick;
    const match: MatchSettings = {
      matchId: claims.mid,
      playlistId: claims.playlistId,
      queue: claims.queue,
      region: claims.region,
      humans: Math.max(1, claims.humans),
      bots: claims.custom && !claims.custom.bots ? 0 : Math.max(0, claims.bots),
      teamSize: Math.max(1, Math.min(4, claims.teamSize)),
      custom: claims.custom ?? null,
    };
    room = new Room(
      id,
      this.deps,
      this.config,
      this.metrics,
      () => this.scheduler.dueTime(createdAtTick),
      match,
    );
    this.rooms.set(id, room);
    this.matchRooms.set(claims.mid, id);
    this.deps.log?.(
      `[rooms] created ${id} for match ${claims.mid} (${claims.playlistId}, ${match.humans} humans + ${match.bots} bots)`,
    );
    room.join(session, hello, now, claims);
    return this.noteJoined(claims, room);
  }

  private noteJoined(claims: JoinTicketClaims, room: Room): Room {
    // Bounded so a matchmaker outage (no heartbeats drain it) cannot grow it forever.
    if (this.joined.length < MAX_PENDING_JOINS) this.joined.push({ matchId: claims.mid, userId: claims.sub });
    return room;
  }

  /**
   * Ticketed joins since the last call, for the matchmaker heartbeat (it stops
   * replaying `match_found` to players who arrived). Drains the list.
   */
  takeJoined(): { matchId: string; userId: string }[] {
    return this.joined.splice(0, this.joined.length);
  }

  private reject(conn: Connection, reason: KickReasonId, detail: string): void {
    const w = this.writer.reset();
    writeKick(w, reason, detail);
    conn.send(w.finish().slice());
    conn.close(4000 + reason, detail);
    this.metrics.kicks++;
  }

  /** One scheduler tick: every room, then metrics. */
  tick(): void {
    const now = this.deps.now();
    for (const [id, room] of this.rooms) {
      try {
        room.tick(now);
      } catch (err) {
        // One broken round (bad content, sim bug) must not take every other room in the process down with it.
        this.deps.log?.(
          `[rooms] ${id} crashed and was closed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        this.metrics.roomCrashes++;
        try {
          room.dispose();
        } catch {
          room.state = 'closed';
        }
      }
      if (room.state === 'closed') {
        this.rooms.delete(id);
        if (room.match && this.matchRooms.get(room.match.matchId) === id) {
          this.matchRooms.delete(room.match.matchId);
          this.bannedFromMatch.delete(room.match.matchId);
        }
        this.deps.log?.(`[rooms] removed ${id}`);
      }
    }
    this.updateMetrics(now);
  }

  private updateMetrics(now: number): void {
    const m = this.metrics;
    m.rooms = this.rooms.size;
    let humans = 0;
    let players = 0;
    let bots = 0;
    for (const r of this.rooms.values()) {
      const info = r.info();
      humans += info.connected;
      bots += info.bots;
      players += info.humans + info.bots;
    }
    m.humans = humans;
    m.bots = bots;
    m.players = players;
    if (now - this.lastRateUpdate >= 1000) {
      this.lastRateUpdate = now;
      m.updateRates(now, this.transport?.bytesOut ?? 0, this.transport?.bytesIn ?? 0);
      for (const r of this.rooms.values()) {
        for (const rtt of r.sessionRtts()) m.rtt.add(rtt);
        const inputs = r.takeInputStats();
        m.inputMissed += inputs.missed;
        m.inputLate += inputs.late;
      }
    }
    if (this.profileLogMs > 0 && now - this.lastProfileLog >= this.profileLogMs) {
      this.lastProfileLog = now;
      if (this.rooms.size > 0) this.deps.log?.(`[tick] ${m.summary()}`);
    }
  }
}
