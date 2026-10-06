/**
 * Optional registration with the matchmaker (`POST /servers/register`, then a
 * heartbeat every 5 s, `DELETE /servers/:id` on shutdown). Without it the
 * matchmaker falls back to its `DEFAULT_GAME_SERVER_URL` in development.
 *
 * Capacity is reported in seats (humans and bots) and rooms, the same units
 * the matchmaker reserves when it places a match here.
 */
import type { CapacityReport } from './room/RoomManager.ts';

/** Matches the matchmaker's heartbeat schema limit. */
const MAX_JOINED = 10_000;

/** Options for {@link startMatchmakerLink}. */
export interface MatchmakerLinkOptions {
  matchmakerUrl: string;
  /** `GAME_SERVER_SECRET` bearer. */
  secret: string;
  serverId: string;
  /** Public WebSocket URL clients connect to (e.g. `ws://localhost:7350/ws`). */
  publicUrl: string;
  /** HTTP base for the matchmaker's signed control calls (host kicks). */
  controlUrl?: string;
  region: string;
  /** Maximum concurrent seats (humans and bots). */
  capacity: number;
  /** Maximum concurrent rooms (the room manager's cap). */
  maxRooms?: number;
  /** Current seats, rooms and hosted match ids. */
  report: () => CapacityReport;
  /** Humans connected to rooms (the matchmaker's public "online" count). */
  humans?: () => number;
  /** Show results not yet delivered to the API (reported for monitoring). */
  outbox?: () => number;
  /** Drains ticketed joins since the last call, so the matchmaker stops replaying their `match_found`. */
  joined?: () => { matchId: string; userId: string }[];
  log?: (msg: string) => void;
  /** HTTP client (tests). */
  fetch?: typeof fetch;
  /** Heartbeat interval; the matchmaker drops servers silent for 15 s. */
  intervalMs?: number;
}

/** A running link. */
export interface MatchmakerLink {
  /** Sends one registration or heartbeat now (tests; the timer does this every 5 s). */
  beat(): Promise<void>;
  /**
   * Reports the server as draining (now and on every later heartbeat): the
   * matchmaker places no new matches here but keeps routing rejoins and
   * kicks to the shows still running.
   */
  drain(): Promise<void>;
  /** Stops heartbeating and deregisters. */
  stop(): Promise<void>;
  /**
   * Matches the matchmaker placed here that no player has reached yet, as of
   * the last heartbeat it answered; null before one was answered.
   */
  pendingMatches(): number | null;
}

/**
 * Registers and keeps heartbeating; failures are logged and retried on the next beat.
 *
 * @example
 * const link = startMatchmakerLink({ matchmakerUrl, secret, serverId: 'gs-1', publicUrl, region: 'na',
 *   capacity: 400, maxRooms: 10, report: () => rooms.capacityReport() });
 */
export function startMatchmakerLink(opts: MatchmakerLinkOptions): MatchmakerLink {
  const base = opts.matchmakerUrl.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${opts.secret}`, 'content-type': 'application/json' };
  const fetchFn = opts.fetch ?? fetch;
  let registered = false;
  let draining = false;
  let stopped = false;
  let inflight: Promise<void> | null = null;
  let pending: number | null = null;
  // Joins from a failed heartbeat ride along on the next one.
  let unsent: { matchId: string; userId: string }[] = [];
  const call = async (
    path: string,
    method: string,
    body?: unknown,
    onAnswer?: (json: unknown) => void,
  ): Promise<boolean> => {
    try {
      const res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok && onAnswer) onAnswer(await res.json().catch(() => null));
      return res.ok;
    } catch {
      return false;
    }
  };
  const notePending = (json: unknown): void => {
    const n = (json as { pendingMatches?: unknown } | null)?.pendingMatches;
    pending = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const beatOnce = async (): Promise<void> => {
    if (stopped) return;
    const r = opts.report();
    if (!registered) {
      registered = await call('/servers/register', 'POST', {
        serverId: opts.serverId,
        url: opts.publicUrl,
        ...(opts.controlUrl ? { controlUrl: opts.controlUrl } : {}),
        region: opts.region,
        capacity: opts.capacity,
        load: r.load,
        rooms: r.rooms,
        ...(opts.maxRooms !== undefined ? { maxRooms: opts.maxRooms } : {}),
        ...(opts.humans ? { humans: opts.humans() } : {}),
        ...(draining ? { draining: true } : {}),
      });
      if (registered) opts.log?.(`[matchmaker] registered ${opts.serverId} at ${opts.publicUrl}`);
      return;
    }
    const joined = [...unsent, ...(opts.joined?.() ?? [])].slice(-MAX_JOINED);
    unsent = [];
    // A matchmaker restart forgets us; re-register when the heartbeat is refused.
    if (
      !(await call(
        '/servers/heartbeat',
        'POST',
        {
          serverId: opts.serverId,
          load: r.load,
          rooms: r.rooms,
          matches: r.matches,
          ...(opts.humans ? { humans: opts.humans() } : {}),
          ...(opts.outbox ? { outbox: opts.outbox() } : {}),
          ...(joined.length ? { joined } : {}),
          ...(draining ? { draining: true } : {}),
        },
        notePending,
      ))
    ) {
      registered = false;
      unsent = joined;
    }
  };
  // One beat at a time, so stop() can wait for a registration in flight instead of racing its DELETE.
  const beat = (): Promise<void> => {
    inflight ??= beatOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  void beat();
  const timer = setInterval(() => void beat(), opts.intervalMs ?? 5000);
  timer.unref?.();
  return {
    beat,
    pendingMatches: () => pending,
    async drain(): Promise<void> {
      draining = true;
      await inflight;
      await beat();
      // A first beat that only registered carried no answer about pending matches; ask once more.
      if (registered && pending === null) await beat();
    },
    async stop(): Promise<void> {
      clearInterval(timer);
      await inflight;
      stopped = true;
      // Unconditional: a registration whose answer was lost still left an entry behind.
      await call(`/servers/${encodeURIComponent(opts.serverId)}`, 'DELETE');
    },
  };
}
