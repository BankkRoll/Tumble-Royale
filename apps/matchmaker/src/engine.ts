/**
 * Pure lobby formation. No I/O, no clocks: callers pass `now`.
 *
 * Algorithm, per bucket (playlist × region × queue), oldest entry first:
 * 1. The oldest unassigned entry is the anchor. Ranked buckets only consider
 *    entries whose rating lies within the anchor's band, which widens with the
 *    anchor's wait time.
 * 2. Entries (whole parties; never split) are packed oldest-first. Solo
 *    playlists just fill seats. Team playlists assemble teams of `teamSize`
 *    with best-fit packing (a party goes to the fullest team that still has
 *    room), so a duo plus two solos make one squad.
 * 3. A lobby is released when every seat is taken, or when the anchor has
 *    waited `maxWait` (`hotMaxWait` when the region is busy) — the remaining
 *    seats become bots. Playlists that forbid bots release on timeout only once
 *    `minPlayers` humans are present.
 * 4. Repeat with the next unassigned anchor.
 */

/** A queued party member. */
export interface QueueMember {
  userId: string;
  name: string;
  /** Conservative skill (OpenSkill ordinal) used for ranked bands. */
  ordinal: number;
}

/** A party (or solo) waiting in the queue. */
export interface QueueEntry {
  id: string;
  /** Party id from the queue ticket (`solo:<userId>` for solos). */
  partyId: string;
  leaderId: string;
  members: QueueMember[];
  playlistId: string;
  queue: 'casual' | 'ranked';
  region: string;
  teamSize: number;
  /** Lobby size for this playlist. */
  lobbySize: number;
  minPlayers: number;
  botsAllowed: boolean;
  /** Epoch ms. */
  enqueuedAt: number;
}

/** Tuning for lobby formation. */
export interface EngineConfig {
  maxWaitMs: number;
  hotMaxWaitMs: number;
  /** Searching players in a region at which it counts as busy. */
  hotThreshold: number;
  /** Ranked band: half-width in ordinal points = min(max, base + perSecond × waitSec). */
  band: { base: number; perSecond: number; max: number };
}

/** Defaults used by the service. */
export const DEFAULT_ENGINE: EngineConfig = {
  maxWaitMs: 25_000,
  hotMaxWaitMs: 12_000,
  hotThreshold: 80,
  band: { base: 3, perSecond: 0.6, max: 30 },
};

/** A lobby ready to be placed on a game server. */
export interface FormedLobby {
  playlistId: string;
  queue: 'casual' | 'ranked';
  region: string;
  teamSize: number;
  size: number;
  entries: QueueEntry[];
  /** User ids per team (team modes), else one team with everyone. */
  teams: string[][];
  humans: number;
  botFill: number;
  reason: 'full' | 'timeout';
}

/** Bucket key shared by entries that may be matched together. */
export function bucketKey(e: Pick<QueueEntry, 'playlistId' | 'region' | 'queue'>): string {
  return `${e.queue}|${e.playlistId}|${e.region}`;
}

/** Ranked band half-width after waiting `waitMs`. */
export function ratingBand(cfg: EngineConfig, waitMs: number): number {
  return Math.min(cfg.band.max, cfg.band.base + cfg.band.perSecond * (waitMs / 1000));
}

/** Mean ordinal of a party. */
export function entryRating(e: QueueEntry): number {
  return e.members.reduce((s, m) => s + m.ordinal, 0) / e.members.length;
}

/** Effective release wait for a region given how many players are searching there. */
export function effectiveMaxWait(cfg: EngineConfig, searchingInRegion: number): number {
  return searchingInRegion >= cfg.hotThreshold ? Math.min(cfg.hotMaxWaitMs, cfg.maxWaitMs) : cfg.maxWaitMs;
}

/**
 * Packs entries into a lobby without splitting parties.
 *
 * @returns The chosen entries and team assignment.
 */
function pack(candidates: readonly QueueEntry[], size: number, teamSize: number): { chosen: QueueEntry[]; teams: string[][] } {
  const chosen: QueueEntry[] = [];
  if (teamSize <= 1) {
    let seats = size;
    for (const e of candidates) {
      if (e.members.length <= seats) {
        chosen.push(e);
        seats -= e.members.length;
      }
      if (seats === 0) break;
    }
    return { chosen, teams: [chosen.flatMap((e) => e.members.map((m) => m.userId))] };
  }
  const maxTeams = Math.floor(size / teamSize);
  const teams: string[][] = [];
  for (const e of candidates) {
    if (e.members.length > teamSize) continue;
    let best = -1;
    for (let t = 0; t < teams.length; t++) {
      const room = teamSize - teams[t]!.length;
      if (room >= e.members.length && (best < 0 || teams[t]!.length > teams[best]!.length)) best = t;
    }
    if (best < 0) {
      if (teams.length >= maxTeams) continue;
      teams.push([]);
      best = teams.length - 1;
    }
    teams[best]!.push(...e.members.map((m) => m.userId));
    chosen.push(e);
  }
  return { chosen, teams };
}

/**
 * Forms every releasable lobby from the current queue.
 *
 * @param entries - All queued entries (any bucket).
 * @param now - Current time (epoch ms).
 * @param cfg - Engine tuning.
 * @returns Lobbies to release; entries not included stay queued.
 */
export function formLobbies(entries: readonly QueueEntry[], now: number, cfg: EngineConfig = DEFAULT_ENGINE): FormedLobby[] {
  const searchingByRegion = new Map<string, number>();
  for (const e of entries) searchingByRegion.set(e.region, (searchingByRegion.get(e.region) ?? 0) + e.members.length);

  const buckets = new Map<string, QueueEntry[]>();
  for (const e of entries) {
    const k = bucketKey(e);
    const list = buckets.get(k) ?? [];
    list.push(e);
    buckets.set(k, list);
  }

  const out: FormedLobby[] = [];
  for (const k of [...buckets.keys()].sort()) {
    const bucket = buckets.get(k)!.sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : 1));
    const used = new Set<string>();
    const maxWait = effectiveMaxWait(cfg, searchingByRegion.get(bucket[0]!.region) ?? 0);
    for (const anchor of bucket) {
      if (used.has(anchor.id)) continue;
      const waited = now - anchor.enqueuedAt;
      let pool = bucket.filter((e) => !used.has(e.id));
      if (anchor.queue === 'ranked') {
        const band = ratingBand(cfg, waited);
        const center = entryRating(anchor);
        pool = pool.filter((e) => Math.abs(entryRating(e) - center) <= band);
      }
      const size = anchor.lobbySize;
      const { chosen, teams } = pack(pool, size, anchor.teamSize);
      if (!chosen.includes(anchor)) continue;
      const humans = chosen.reduce((s, e) => s + e.members.length, 0);
      const full = anchor.teamSize > 1 ? teams.length === Math.floor(size / anchor.teamSize) && teams.every((t) => t.length === anchor.teamSize) : humans >= size;
      const timedOut = waited >= maxWait && (anchor.botsAllowed || humans >= anchor.minPlayers);
      if (!full && !timedOut) continue;
      for (const e of chosen) used.add(e.id);
      out.push({
        playlistId: anchor.playlistId,
        queue: anchor.queue,
        region: anchor.region,
        teamSize: anchor.teamSize,
        size,
        entries: chosen,
        teams,
        humans,
        botFill: anchor.botsAllowed ? Math.max(0, size - humans) : 0,
        reason: full ? 'full' : 'timeout',
      });
    }
  }
  return out;
}

/** Status of one entry for the client's "Searching…" screen. */
export interface QueueStatus {
  /** Players searching in the same bucket. */
  searching: number;
  /** Seconds waited so far. */
  waitedSec: number;
  /** Estimated seconds until a lobby is released. */
  etaSec: number;
  /** Current ranked band half-width (ranked only). */
  band: number | null;
}

/**
 * Computes queue status for an entry.
 *
 * ETA is the time until the timeout release for the oldest entry in the
 * bucket (we always release by then), shortened when the bucket is already full.
 */
export function queueStatus(entry: QueueEntry, all: readonly QueueEntry[], now: number, cfg: EngineConfig = DEFAULT_ENGINE): QueueStatus {
  const k = bucketKey(entry);
  const same = all.filter((e) => bucketKey(e) === k);
  const searching = same.reduce((s, e) => s + e.members.length, 0);
  const regionSearching = all.filter((e) => e.region === entry.region).reduce((s, e) => s + e.members.length, 0);
  const oldest = Math.min(...same.map((e) => e.enqueuedAt), entry.enqueuedAt);
  const maxWait = effectiveMaxWait(cfg, regionSearching);
  const etaMs = searching >= entry.lobbySize ? 0 : Math.max(0, oldest + maxWait - now);
  return {
    searching,
    waitedSec: Math.floor((now - entry.enqueuedAt) / 1000),
    etaSec: Math.ceil(etaMs / 1000),
    band: entry.queue === 'ranked' ? ratingBand(cfg, now - entry.enqueuedAt) : null,
  };
}
