/**
 * `GET /me/matches/:id/reward`: the rewards screen's fallback when the game
 * server's `showRewards` forward is late or lost. 404 until the results land,
 * then the caller's own stored grant (never someone else's).
 * Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';
import { BACKENDS } from './infra.ts';

describe.each(BACKENDS)('show reward lookup ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(undefined, backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  it('is 404 until the results land, then returns exactly what ingest granted', async () => {
    const winner = await api.guest();
    const loser = await api.guest();
    const show = buildShow({
      humans: [
        { userId: winner.id, placement: 1 },
        { userId: loser.id, placement: 50 },
      ],
    });
    const early = await api.req('GET', `/me/matches/${show.matchId}/reward`, { token: winner.accessToken });
    expect(early.statusCode).toBe(404);

    const ingest = (await api.postMatch(show)).json();
    const res = await api.req('GET', `/me/matches/${show.matchId}/reward`, { token: winner.accessToken });
    expect(res.statusCode).toBe(200);
    const granted = ingest.rewards.find((r: { userId: string }) => r.userId === winner.id);
    expect(res.json()).toEqual({ matchId: show.matchId, reward: granted });

    const theirs = (
      await api.req('GET', `/me/matches/${show.matchId}/reward`, { token: loser.accessToken })
    ).json();
    expect(theirs.reward.userId).toBe(loser.id);
    expect(theirs.reward.crowned).toBe(false);
  });

  it('answers null for a player who was not in the show', async () => {
    const player = await api.guest();
    const stranger = await api.guest();
    const show = buildShow({ humans: [{ userId: player.id, placement: 3 }] });
    await api.postMatch(show);
    const res = await api.req('GET', `/me/matches/${show.matchId}/reward`, { token: stranger.accessToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().reward).toBeNull();
  });

  it('rejects malformed ids and anonymous callers', async () => {
    const u = await api.guest();
    expect((await api.req('GET', '/me/matches/x/reward', { token: u.accessToken })).statusCode).toBe(400);
    expect((await api.req('GET', '/me/matches/m_abcdef/reward')).statusCode).toBe(401);
  });
});
