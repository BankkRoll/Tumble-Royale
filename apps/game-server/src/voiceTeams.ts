/**
 * Team rounds → account API (`POST {API_URL}/internal/voice/teams`), so the
 * API can put opted-in teammates into one voice squad for the round.
 *
 * The game server is the only party that knows team assignments, and the
 * API only trusts them from a request signed with `INTERNAL_HMAC_SECRET`.
 * Delivery is best effort: a lost report leaves players in their party voice
 * room (the fallback), and a lost "round over" expires on the API.
 */
import { signInternal } from './results.ts';

/** One human in a team round. */
export interface VoiceTeamEntry {
  userId: string;
  team: number;
  /** Queue party, so friends who queued together share a squad. */
  partyId: string | null;
}

/** Where rooms report team assignments. */
export interface VoiceTeamsSink {
  /**
   * Reports a round's teams, or that it ended (`players` empty).
   *
   * @param matchId - Room id.
   * @param round - Round index.
   * @param players - Humans with their team.
   */
  report(matchId: string, round: number, players: readonly VoiceTeamEntry[]): void;
}

/** Options for {@link HttpVoiceTeams}. */
export interface HttpVoiceTeamsOptions {
  apiUrl: string;
  secret: string;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
}

/**
 * Posts team assignments to the API, signed, without blocking the room.
 *
 * @example
 * const voiceTeams = new HttpVoiceTeams({ apiUrl, secret });
 * voiceTeams.report(roomId, 2, [{ userId, team: 0, partyId: null }]);
 */
export class HttpVoiceTeams implements VoiceTeamsSink {
  constructor(private readonly opts: HttpVoiceTeamsOptions) {}

  report(matchId: string, round: number, players: readonly VoiceTeamEntry[]): void {
    void this.send(matchId, round, players);
  }

  /**
   * One delivery attempt.
   *
   * @returns Whether the API accepted it.
   */
  async send(matchId: string, round: number, players: readonly VoiceTeamEntry[]): Promise<boolean> {
    const body = JSON.stringify({ matchId, round, players });
    try {
      const res = await (this.opts.fetch ?? fetch)(
        `${this.opts.apiUrl.replace(/\/$/, '')}/internal/voice/teams`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signInternal(this.opts.secret, body, Date.now()),
          },
          body,
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) this.opts.log?.(`[voice] ${matchId}: team report answered ${res.status}`);
      return res.ok;
    } catch (err) {
      this.opts.log?.(
        `[voice] ${matchId}: team report failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }
  }
}
