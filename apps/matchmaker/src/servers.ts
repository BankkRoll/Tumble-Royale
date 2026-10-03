/**
 * Game-server registry: servers register and heartbeat with capacity and
 * load; lobbies go to the least-loaded live server in their region.
 */

/** A registered game server. */
export interface GameServer {
  id: string;
  /** WebSocket URL clients connect to, e.g. `wss://eu-1.example.com`. */
  url: string;
  region: string;
  /** Maximum concurrent players. */
  capacity: number;
  /** Players currently hosted or reserved. */
  load: number;
  /** Humans connected to its rooms at the last heartbeat (unlike `load`, never includes reservations). */
  humans?: number;
  /** Epoch ms of the last heartbeat. */
  lastSeen: number;
}

/** A server is considered dead after this long without a heartbeat. */
export const SERVER_TTL_MS = 15_000;

/**
 * Humans in game-server rooms right now, from live servers' heartbeats.
 * Servers that predate the `humans` field report their load instead (the
 * game server's load is its connected humans).
 *
 * @param servers - Registry snapshot.
 * @param now - Current time (epoch ms).
 * @returns Player count.
 */
export function humansInRooms(servers: readonly GameServer[], now: number): number {
  let n = 0;
  for (const s of servers) if (now - s.lastSeen <= SERVER_TTL_MS) n += s.humans ?? s.load;
  return n;
}

/**
 * Picks the least-loaded live server in a region with room for `seats`.
 *
 * @param servers - Registry snapshot.
 * @param region - Lobby region.
 * @param seats - Players to place (humans + bots).
 * @param now - Current time (epoch ms).
 * @returns The chosen server, or null when none fits.
 */
export function pickServer(
  servers: readonly GameServer[],
  region: string,
  seats: number,
  now: number,
): GameServer | null {
  let best: GameServer | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const s of servers) {
    if (s.region !== region || now - s.lastSeen > SERVER_TTL_MS) continue;
    if (s.capacity - s.load < seats) continue;
    const ratio = s.load / s.capacity;
    if (ratio < bestRatio || (ratio === bestRatio && best && s.id < best.id)) {
      best = s;
      bestRatio = ratio;
    }
  }
  return best;
}
