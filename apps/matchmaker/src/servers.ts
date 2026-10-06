/**
 * Game-server registry: servers register and heartbeat with capacity and
 * load; lobbies go to the least-loaded live server in their region, or, after
 * a wait, in the nearest region that has room.
 *
 * Capacity is counted in seats (humans and bots: bots cost the server as much
 * simulation as players) and, when a server reports it, in rooms.
 */

/** A registered game server. */
export interface GameServer {
  id: string;
  /** WebSocket URL clients connect to, e.g. `wss://eu-1.example.com`. */
  url: string;
  /** HTTP base for signed control calls (host kicks); derived from `url` when absent. */
  controlUrl?: string;
  region: string;
  /** Maximum concurrent seats (humans and bots). */
  capacity: number;
  /** Seats in use, as last reported (plus pending reservations when picking). */
  load: number;
  /** Humans connected to its rooms at the last heartbeat (unlike `load`, never counts bots or reservations). */
  humans?: number;
  /** Maximum concurrent rooms; absent when the server does not report one. */
  maxRooms?: number;
  /** Rooms open, as last reported (plus pending reservations when picking). */
  rooms?: number;
  /** Epoch ms of the last heartbeat. */
  lastSeen: number;
}

/** A server is considered dead after this long without a heartbeat. */
export const SERVER_TTL_MS = 15_000;

/**
 * Humans in game-server rooms right now, from live servers' heartbeats.
 * Servers that don't report `humans` count as 0: their `load` includes bots.
 *
 * @param servers - Registry snapshot.
 * @param now - Current time (epoch ms).
 * @returns Player count.
 */
export function humansInRooms(servers: readonly GameServer[], now: number): number {
  let n = 0;
  for (const s of servers) if (now - s.lastSeen <= SERVER_TTL_MS) n += s.humans ?? 0;
  return n;
}

/**
 * Regions ordered by rough network distance from each region (nearest first,
 * excluding itself). Regions not listed fall back to any region with room.
 */
export const REGION_PROXIMITY: Readonly<Record<string, readonly string[]>> = {
  na: ['sa', 'eu', 'oce', 'asia'],
  sa: ['na', 'eu', 'oce', 'asia'],
  eu: ['na', 'asia', 'sa', 'oce'],
  asia: ['oce', 'eu', 'na', 'sa'],
  oce: ['asia', 'na', 'eu', 'sa'],
};

/**
 * Candidate regions for a lobby: its own, then (when `fallback`) the nearest
 * ones, then any other region a live server is in.
 *
 * @param region - The lobby's region.
 * @param fallback - Whether other regions may be used yet.
 * @param known - Regions of the live servers.
 */
export function candidateRegions(region: string, fallback: boolean, known: Iterable<string> = []): string[] {
  if (!fallback) return [region];
  const out = [region, ...(REGION_PROXIMITY[region] ?? [])];
  for (const r of [...new Set(known)].sort()) if (!out.includes(r)) out.push(r);
  return out;
}

/** True when a live server has room for `seats` more seats and one more room. */
export function hasRoom(s: GameServer, seats: number, now: number): boolean {
  if (now - s.lastSeen > SERVER_TTL_MS) return false;
  if (s.capacity - s.load < seats) return false;
  return s.maxRooms === undefined || (s.rooms ?? 0) < s.maxRooms;
}

/**
 * Picks the least-loaded live server with room for `seats`, trying regions in order.
 *
 * @param servers - Registry snapshot (load and rooms should include reservations).
 * @param regions - Regions to try, best first (see {@link candidateRegions}).
 * @param seats - Seats to place (humans + bots).
 * @param now - Current time (epoch ms).
 * @returns The chosen server, or null when none fits.
 */
export function pickServer(
  servers: readonly GameServer[],
  regions: string | readonly string[],
  seats: number,
  now: number,
): GameServer | null {
  for (const region of typeof regions === 'string' ? [regions] : regions) {
    let best: GameServer | null = null;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (const s of servers) {
      if (s.region !== region || !hasRoom(s, seats, now)) continue;
      const ratio = s.load / s.capacity;
      if (ratio < bestRatio || (ratio === bestRatio && best && s.id < best.id)) {
        best = s;
        bestRatio = ratio;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Live game-server capacity of one region. */
export interface RegionCapacity {
  region: string;
  /** Live servers. */
  servers: number;
  /** Seats across them. */
  capacity: number;
  /** Seats in use (humans and bots). */
  load: number;
}

/**
 * Sums live servers per region, regions sorted by id. Counts only, never a
 * server's id or address: this feeds the public status page.
 *
 * @param servers - Live servers (already filtered by heartbeat age).
 * @returns One entry per region with at least one server.
 */
export function capacityByRegion(servers: readonly GameServer[]): RegionCapacity[] {
  const by = new Map<string, RegionCapacity>();
  for (const s of servers) {
    const r = by.get(s.region) ?? { region: s.region, servers: 0, capacity: 0, load: 0 };
    r.servers += 1;
    r.capacity += s.capacity;
    r.load += Math.min(s.load, s.capacity);
    by.set(s.region, r);
  }
  return [...by.values()].sort((a, b) => a.region.localeCompare(b.region));
}
