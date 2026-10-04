/**
 * Getting back into a running online show after a reload.
 *
 * While connected, the show's server, resume token, match id and join ticket
 * are kept in sessionStorage (this tab only; a reload keeps it, closing the
 * tab forgets it). On boot {@link planRejoin} decides how to get back in:
 * inside the game server's 30 s resume window the resume token puts the
 * player back in their own seat; after it, the matchmaker re-issues a ticket
 * (`POST /queue/rejoin`) for a show that is still running.
 *
 * Ended matches are remembered so a replayed `match_found` (the matchmaker
 * keeps one until the ticket expires) never drops the player back into a
 * show they already finished or left.
 */

/** The game server keeps a dropped player's seat this long (`RESUME_WINDOW_MS` there). */
export const RESUME_WINDOW_MS = 30_000;
/** Older records are a show that is long over (the matchmaker keeps matches 2 h). */
export const REJOIN_MAX_AGE_MS = 2 * 3_600_000;
/** How many ended match ids to remember. */
export const ENDED_MATCHES_KEPT = 20;

const LIVE_KEY = 'tumble.liveShow';
const ENDED_KEY = 'tumble.endedShows';

/** A show this tab is (or was, before a reload) connected to. */
export interface LiveShowRecord {
  /** Game server WebSocket URL. */
  serverUrl: string;
  /** From the server's Welcome; resumes the same seat inside the resume window. */
  resumeToken: string;
  matchId: string;
  /** The join ticket the show was entered with. */
  ticket: string;
  /** Epoch ms the ticket stops being accepted. */
  expiresAt: number;
  playlistId: string;
  /** `custom` for a private show (Play again returns to its lobby). */
  queue: string;
  /** Epoch ms the connection was last known alive (the resume window counts from here). */
  lastSeenAt: number;
}

/** The subset of `Storage` used (injectable for tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** How to get back into a show. */
export type RejoinPlan =
  | { kind: 'none' }
  /**
   * Back into the same show. `resumeToken` is set inside the resume window;
   * `freshTicket` asks the matchmaker for a new join ticket first (the stored
   * one expired, or the seat is gone and the player joins as a rejoin).
   */
  | { kind: 'rejoin'; record: LiveShowRecord; resumeToken: string | null; freshTicket: boolean };

const isRecord = (v: unknown): v is LiveShowRecord => {
  const r = v as Partial<LiveShowRecord> | null;
  return (
    !!r &&
    typeof r.serverUrl === 'string' &&
    typeof r.resumeToken === 'string' &&
    typeof r.matchId === 'string' &&
    typeof r.ticket === 'string' &&
    typeof r.expiresAt === 'number' &&
    typeof r.playlistId === 'string' &&
    typeof r.queue === 'string' &&
    typeof r.lastSeenAt === 'number'
  );
};

/**
 * Decides how to rejoin a stored show.
 *
 * @param record - The stored show, if any.
 * @param now - Epoch ms.
 * @param ended - Whether a match is known to be over for this player.
 */
export function planRejoin(
  record: LiveShowRecord | null,
  now: number,
  ended: (matchId: string) => boolean,
): RejoinPlan {
  if (!record || ended(record.matchId)) return { kind: 'none' };
  const idle = now - record.lastSeenAt;
  if (idle < 0 || idle > REJOIN_MAX_AGE_MS) return { kind: 'none' };
  const resumable = idle < RESUME_WINDOW_MS && record.resumeToken !== '';
  return {
    kind: 'rejoin',
    record,
    resumeToken: resumable ? record.resumeToken : null,
    // With a live seat an unexpired ticket is only the fallback; without one a rejoin ticket is required.
    freshTicket: !resumable || record.expiresAt <= now,
  };
}

/**
 * The live-show record and the ended-match memory in sessionStorage.
 * Storage failures (private mode, quota) are swallowed: rejoining is a
 * convenience and must never break a show.
 */
export class RejoinStore {
  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** The stored show, or null (missing, malformed or unreadable). */
  load(): LiveShowRecord | null {
    try {
      const raw = this.storage?.getItem(LIVE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Records the show the player just reached. */
  save(record: Omit<LiveShowRecord, 'lastSeenAt'>): void {
    this.write(LIVE_KEY, JSON.stringify({ ...record, lastSeenAt: this.now() }));
  }

  /** The connection is still alive (moves the resume window forward). */
  touch(matchId: string): void {
    const r = this.load();
    if (r?.matchId === matchId) this.write(LIVE_KEY, JSON.stringify({ ...r, lastSeenAt: this.now() }));
  }

  /** Forgets the live show. */
  clear(): void {
    try {
      this.storage?.removeItem(LIVE_KEY);
    } catch {
      // Unwritable storage just means there is nothing to forget.
    }
  }

  /** The show is over for this player: forget it and never re-enter it. */
  finish(matchId: string): void {
    if (this.load()?.matchId === matchId) this.clear();
    const ids = this.endedIds().filter((id) => id !== matchId);
    ids.push(matchId);
    this.write(ENDED_KEY, JSON.stringify(ids.slice(-ENDED_MATCHES_KEPT)));
  }

  /** Whether this player already finished or left a match. */
  isEnded(matchId: string): boolean {
    return this.endedIds().includes(matchId);
  }

  private endedIds(): string[] {
    try {
      const raw = this.storage?.getItem(ENDED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Quota or private mode: the show still works, only a reload cannot rejoin.
    }
  }
}

/** sessionStorage when the browser allows it. */
export function sessionStore(): KeyValueStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
