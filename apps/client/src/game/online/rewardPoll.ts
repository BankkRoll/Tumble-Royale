/**
 * Waiting for a signed-in player's show reward. The game server forwards the
 * API's grant a moment after the show ends; when that forward is late or
 * lost the client asks the API itself, with backoff, instead of banking the
 * show on the local guest profile (which would put online progress in the
 * wrong place).
 */
import type { PlayerRewardMsg } from '@tumble/netcode';

/** Gaps between attempts (ms): about 40 s in all, enough for a slow results ingest. */
export const REWARD_RETRY_MS: readonly number[] = [0, 1500, 2500, 4000, 6000, 10000, 15000];

/** How the wait ended. */
export type RewardPollResult =
  | { status: 'ready'; reward: PlayerRewardMsg }
  /** The show is recorded but carried no reward for this player. */
  | { status: 'none' }
  /** Still nothing after every attempt; the profile will show it once it lands. */
  | { status: 'timeout' }
  | { status: 'cancelled' };

/** Polling dependencies (injectable for tests). */
export interface RewardPollDeps {
  /** One lookup: the reward, null for none, or a throw (404 until recorded, network…). */
  fetch(): Promise<PlayerRewardMsg | null>;
  sleep(ms: number): Promise<void>;
  /** True once the wait no longer matters (another show started, sign-out). */
  cancelled(): boolean;
  delays?: readonly number[];
}

/**
 * Asks for the reward until it arrives or the attempts run out. Every
 * failure is retried: 404 means the results have not landed yet, and a
 * network blip is as likely as a missing result.
 *
 * @example
 * const r = await pollShowReward({ fetch: () => api.matchReward(id).then((x) => x.reward), sleep, cancelled });
 */
export async function pollShowReward(deps: RewardPollDeps): Promise<RewardPollResult> {
  for (const delay of deps.delays ?? REWARD_RETRY_MS) {
    if (delay > 0) await deps.sleep(delay);
    if (deps.cancelled()) return { status: 'cancelled' };
    try {
      const reward = await deps.fetch();
      if (deps.cancelled()) return { status: 'cancelled' };
      return reward ? { status: 'ready', reward } : { status: 'none' };
    } catch {
      // Not recorded yet, or unreachable: try again after the next gap.
    }
  }
  return { status: 'timeout' };
}
