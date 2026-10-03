/**
 * Matchmaker client (apps/matchmaker, `:7370`): queue with an API party
 * ticket, the per-user status stream (`queued`, `status`, `match_found`,
 * `lobby_update`…) and custom lobbies.
 */
import { ApiError, type ApiClient } from '../api.ts';
import { JsonSocket, type TypedMessage } from './jsonSocket.ts';

/** `match_found` from the matchmaker stream. */
export interface MatchFound {
  matchId: string;
  server: { id: string; url: string; region: string };
  ticket: string;
  expiresIn: number;
  playlistId: string;
  queue: string;
  team: number | null;
  role: 'player' | 'spectator';
}

/** Queue status (1 Hz while searching). */
export interface QueueStatus {
  /** Players searching in the same bucket. */
  searching: number;
  waitedSec: number;
  /** Seconds until a lobby is released (with bots if needed). */
  etaSec: number;
}

/** Custom lobby settings (matchmaker `CustomSettings`). */
export interface LobbySettings {
  playlistId: string;
  rounds: string[];
  maxPlayers: number;
  bots: boolean;
  roundTimeScale: number;
  lobbyCountdownSec: number;
  spectatorSlots: number;
}

/** A custom lobby (matchmaker `CustomLobby`). */
export interface Lobby {
  code: string;
  hostId: string;
  region: string;
  settings: LobbySettings;
  players: { userId: string; name: string }[];
  spectators: { userId: string; name: string }[];
  status: 'open' | 'started';
  matchId: string | null;
}

const PROBE_TIMEOUT_MS = 900;

/**
 * Matchmaker client bound to the API session.
 *
 * @example
 * const mm = new MatchmakerClient('http://localhost:7370', api);
 * mm.socket.on('match_found', (m) => join(m as unknown as MatchFound));
 * await mm.queue((await api.queueTicket('main-show')).ticket);
 */
export class MatchmakerClient {
  /** True after a successful health probe. */
  online = false;
  /** Players searching right now (from the last probe). */
  searching = 0;
  readonly socket: JsonSocket;

  constructor(
    readonly baseUrl: string,
    private readonly api: ApiClient,
  ) {
    this.socket = new JsonSocket({
      label: 'matchmaker',
      url: async () => {
        const token = await api.accessToken();
        return token ? `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}` : null;
      },
    });
  }

  /** Checks the matchmaker answers. */
  async probe(): Promise<boolean> {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      this.online = res.ok;
      if (res.ok) this.searching = Number(((await res.json()) as { queued?: number }).queued ?? 0);
    } catch {
      this.online = false;
    } finally {
      window.clearTimeout(t);
    }
    return this.online;
  }

  /** Subscribes to a stream message type. */
  on(type: string, fn: (m: TypedMessage) => void): () => void {
    return this.socket.on(type, fn);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.api.accessToken();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!res.ok)
      throw new ApiError(res.status, data?.error ?? 'http_error', data?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** Enqueues the party (leader) with an API queue ticket. */
  queue = (ticket: string): Promise<{ entryId: string }> => this.call('POST', '/queue', { ticket });
  /** Cancels the search for the whole party. */
  cancel = (): Promise<void> => this.call('DELETE', '/queue');
  createLobby = (settings: Partial<LobbySettings>, region?: string): Promise<{ lobby: Lobby }> =>
    this.call('POST', '/lobbies', region ? { settings, region } : { settings });
  joinLobby = (code: string): Promise<{ lobby: Lobby }> => this.call('POST', `/lobbies/${code}/join`, {});
  updateLobby = (code: string, settings: Partial<LobbySettings>): Promise<{ lobby: Lobby }> =>
    this.call('PATCH', `/lobbies/${code}`, settings);
  leaveLobby = (code: string): Promise<void> => this.call('POST', `/lobbies/${code}/leave`, {});
  startLobby = (code: string): Promise<{ matchId: string }> =>
    this.call('POST', `/lobbies/${code}/start`, {});
}

/**
 * The game server WebSocket URL from a `match_found` server URL (the
 * matchmaker's dev default omits the `/ws` path).
 *
 * @param url - `server.url` from `match_found`.
 */
export function gameSocketUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
    return u.toString();
  } catch {
    return url;
  }
}
