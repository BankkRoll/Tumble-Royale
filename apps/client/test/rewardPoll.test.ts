/**
 * Waiting for a signed-in player's show reward from the API when the game
 * server's forward is late or lost: retries through 404s and network blips,
 * stops when the wait no longer matters, and ends honestly when it never
 * comes (the local guest profile is never used as a fallback).
 */
import type { PlayerRewardMsg } from '@tumble/netcode';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/game/api.ts';
import { REWARD_RETRY_MS, pollShowReward } from '../src/game/online/rewardPoll.ts';

const reward = { placement: 1, crowned: true } as PlayerRewardMsg;
const notYet = () => Promise.reject(new ApiError(404, 'not_found', 'Match not found'));

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };
}

describe('show reward polling', () => {
  it('returns the reward on the first try without waiting', async () => {
    const { waits, sleep } = sleeper();
    const r = await pollShowReward({ fetch: () => Promise.resolve(reward), sleep, cancelled: () => false });
    expect(r).toEqual({ status: 'ready', reward });
    expect(waits).toEqual([]);
  });

  it('keeps asking while the results have not landed, then shows them', async () => {
    const { waits, sleep } = sleeper();
    const fetch = vi
      .fn()
      .mockImplementationOnce(notYet)
      .mockImplementationOnce(notYet)
      .mockResolvedValue(reward);
    const r = await pollShowReward({ fetch, sleep, cancelled: () => false });
    expect(r.status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(waits).toEqual(REWARD_RETRY_MS.slice(1, 3));
  });

  it('rides out network errors the same way', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, 'network', 'offline'))
      .mockResolvedValue(reward);
    const r = await pollShowReward({ fetch, sleep: sleeper().sleep, cancelled: () => false });
    expect(r.status).toBe('ready');
  });

  it('times out after every attempt instead of spinning forever', async () => {
    const fetch = vi.fn(notYet);
    const r = await pollShowReward({
      fetch,
      sleep: sleeper().sleep,
      cancelled: () => false,
      delays: [0, 10, 10],
    });
    expect(r).toEqual({ status: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports a recorded show that carried no reward', async () => {
    const r = await pollShowReward({
      fetch: () => Promise.resolve(null),
      sleep: sleeper().sleep,
      cancelled: () => false,
    });
    expect(r).toEqual({ status: 'none' });
  });

  it('stops once cancelled, before or after a request', async () => {
    let cancelled = false;
    const fetch = vi.fn(() => {
      cancelled = true;
      return Promise.resolve(reward);
    });
    expect(await pollShowReward({ fetch, sleep: sleeper().sleep, cancelled: () => cancelled })).toEqual({
      status: 'cancelled',
    });
    const never = vi.fn(notYet);
    expect(await pollShowReward({ fetch: never, sleep: sleeper().sleep, cancelled: () => true })).toEqual({
      status: 'cancelled',
    });
    expect(never).not.toHaveBeenCalled();
  });

  it('waits about forty seconds in all by default', () => {
    const total = REWARD_RETRY_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThanOrEqual(60_000);
  });
});
