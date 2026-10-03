/**
 * Game-server registry: servers register and heartbeat with capacity and
 * load; lobbies go to the least-loaded live server in their region.
 */

/** A registered game server. */
export interface GameServer {
  id: string;
  /** WebSocket URL clients connect to, e.g. `wss://eu-1.example.com`. */
  url: string;
  /** HTTP base for signed control calls (host kicks); derived from `url` when absent. */
  controlUrl?: string;
  region: string;
  /** Maximum concurrent players. */
  capacity: number;
  /** Players currently hosted or reserved. */
  load: number;
  /** Epoch ms of the last heartbeat. */
  lastSeen: number;
}

/** A server is considered dead after this long without a heartbeat. */
export const SERVER_TTL_MS = 15_000;

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
