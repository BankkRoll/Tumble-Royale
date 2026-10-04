import { DEFAULT_SHOW_PLAYERS, MAX_PLAYERS } from '@tumble/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLedger } from '../src/economy/ledger.ts';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('match results ingest', () => {
  it(`accepts a show of exactly ${MAX_PLAYERS} participants and refuses one more`, async () => {
    const u = await api.guest();
    const full = buildShow({ humans: [{ userId: u.id, placement: MAX_PLAYERS }], size: MAX_PLAYERS });
    const res = await api.postMatch(full);
    expect(res.statusCode).toBe(200);
    expect(res.json().rewards[0]).toMatchObject({ placement: MAX_PLAYERS });
    const over = buildShow({ humans: [], size: MAX_PLAYERS + 1 });
    expect((await api.postMatch(over)).statusCode).toBe(400);
  });

  it('grants rewards once even when posted twice', async () => {
    const winner = await api.guest();
    const loser = await api.guest();
    const show = buildShow({
      humans: [
        { userId: winner.id, placement: 1 },
        { userId: loser.id, placement: 80 },
      ],
    });

    const first = await api.postMatch(show);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.alreadyProcessed).toBe(false);
    expect(body.rewards).toHaveLength(2);
    const w = body.rewards.find((r: { userId: string }) => r.userId === winner.id);
    expect(w).toMatchObject({ crowned: true, placement: 1, roundsQualified: 4, ranked: null });
    expect(w.xp.lines.map((l: { label: string }) => l.label)).toContain('CROWN!');
    expect(w.xp.total).toBeGreaterThan(1000);

    const second = await api.postMatch(show);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ alreadyProcessed: true });
    expect(second.json().rewards).toEqual(body.rewards);

    const me = (await api.req('GET', '/me', { token: winner.accessToken })).json();
    expect(me.crowns).toBe(1);
    expect(me.stats).toMatchObject({ showsPlayed: 1, wins: 1, finals: 1, currentWinStreak: 1 });
    expect(me.wallet.gumballs).toBe(w.gumballs.total);
    expect(me.xp.total).toBe(w.xp.total);
    expect((await verifyLedger(api.ctx.db, winner.id)).ok).toBe(true);

    const history = (await api.req('GET', '/me/matches', { token: loser.accessToken })).json();
    expect(history.matches).toHaveLength(1);
    expect(history.matches[0]).toMatchObject({ id: show.matchId, placement: 80, crowned: false });
    expect(history.matches[0].rounds.map((r: { qualified: boolean }) => r.qualified)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(history.matches[0].rounds.map((r: { played: boolean }) => r.played)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    const detail = (await api.req('GET', `/matches/${show.matchId}`, { token: loser.accessToken })).json();
    expect(detail.participants).toHaveLength(DEFAULT_SHOW_PLAYERS);
    expect(detail.botCount).toBe(DEFAULT_SHOW_PLAYERS - 2);
  });

  it('replays instead of re-granting when a game-server outbox retries much later', async () => {
    const u = await api.guest();
    const show = buildShow({ humans: [{ userId: u.id, placement: 1 }] });
    const first = (await api.postMatch(show)).json();
    // The response was lost; the outbox keeps the payload across a restart and retries a day later.
    api.clock.advance(24 * 3_600_000);
    const retried = await api.postMatch(show);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ alreadyProcessed: true, rewards: first.rewards });
    api.clock.advance(-24 * 3_600_000);
    const me = (await api.req('GET', '/me', { token: u.accessToken })).json();
    expect(me).toMatchObject({ crowns: 1, stats: { showsPlayed: 1 } });
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('handles concurrent duplicate posts', async () => {
    const u = await api.guest();
    const show = buildShow({ humans: [{ userId: u.id, placement: 5 }] });
    const [a, b] = await Promise.all([api.postMatch(show), api.postMatch(show)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().alreadyProcessed, b.json().alreadyProcessed].sort()).toEqual([false, true]);
    expect((await api.req('GET', '/me', { token: u.accessToken })).json().stats.showsPlayed).toBe(1);
  });

  it('rejects bad signatures, stale timestamps and replayed nonces', async () => {
    const u = await api.guest();
    const show = buildShow({ humans: [{ userId: u.id, placement: 2 }] });
    const forged = await api.postMatch(show, { secret: 'not-the-real-secret-at-all' });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe('bad_signature');
    const stale = await api.postMatch(show, { timestamp: api.clock.now().getTime() - 10 * 60_000 });
    expect(stale.json().error).toBe('stale_request');
    const unsigned = await api.app.inject({
      method: 'POST',
      url: '/internal/match-results',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(show),
    });
    expect(unsigned.statusCode).toBe(401);
    const nonce = 'fixed-nonce-0123456789abcdef';
    expect((await api.postMatch(show, { nonce })).statusCode).toBe(200);
    const replay = await api.postMatch(show, { nonce });
    expect(replay.json().error).toBe('replayed_request');
    expect((await api.req('GET', '/me', { token: u.accessToken })).json().stats.showsPlayed).toBe(1);
  });

  it('rejects inconsistent payloads', async () => {
    const u = await api.guest();
    const show = buildShow({ humans: [{ userId: u.id, placement: 3 }] });
    show.placements[1]!.crowned = true;
    const res = await api.postMatch(show);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('inconsistent_result');
  });

  it('records custom lobbies without granting rewards', async () => {
    const u = await api.guest();
    const res = await api.postMatch(buildShow({ queue: 'custom', humans: [{ userId: u.id, placement: 1 }] }));
    expect(res.json().rewards[0]).toMatchObject({ xp: { total: 0 }, gumballs: { total: 0 }, crownShards: 0 });
    expect((await api.req('GET', '/me', { token: u.accessToken })).json()).toMatchObject({
      crowns: 0,
      stats: { showsPlayed: 1 },
    });
  });

  it('advances challenges from match results and lets the player claim them', async () => {
    const u = await api.guest();
    const before = (await api.req('GET', '/challenges', { token: u.accessToken })).json();
    expect(before.daily).toHaveLength(3);
    expect(before.weekly).toHaveLength(6);
    expect(before.seasonal).toHaveLength(8);
    expect(before.milestone).toHaveLength(api.ctx.catalog.milestoneChallenges.length);

    const res = await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }));
    const updates = res.json().rewards[0].challenges as {
      challengeId: string;
      progress: number;
      before: number;
    }[];
    const all = [...before.daily, ...before.weekly, ...before.seasonal, ...before.milestone];
    // A crowned solo run qualifies every round, so any assigned challenge whose metric this show touches must move.
    const touched = all.filter(
      (c: { metric: string }) =>
        !['huntRoundsQualified', 'logicRoundsQualified', 'partyShows'].includes(c.metric),
    );
    expect(updates.length).toBe(touched.length);
    for (const up of updates) expect(up.progress).toBeGreaterThan(up.before);

    const after = (await api.req('GET', '/challenges', { token: u.accessToken })).json();
    const done = [...after.daily, ...after.weekly].find((c: { completed: boolean }) => c.completed);
    if (done) {
      const claim = await api.req('POST', '/challenges/claim', {
        token: u.accessToken,
        body: { id: done.id },
      });
      expect(claim.statusCode).toBe(200);
      expect(
        (await api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id: done.id } }))
          .statusCode,
      ).toBe(409);
    }
    const open = after.daily.find((c: { completed: boolean }) => !c.completed);
    if (open) {
      const reroll = await api.req('POST', '/challenges/reroll', {
        token: u.accessToken,
        body: { id: open.id },
      });
      expect(reroll.statusCode).toBe(200);
      expect(reroll.json().rerollsLeft).toBe(0);
      const second = after.daily.find(
        (c: { completed: boolean; id: string }) => !c.completed && c.id !== open.id,
      );
      if (second) {
        expect(
          (
            await api.req('POST', '/challenges/reroll', { token: u.accessToken, body: { id: second.id } })
          ).json().error,
        ).toBe('reroll_used');
      }
    }
  });

  it('feeds live leaderboards', async () => {
    const u = await api.guest();
    await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }));
    await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }));
    const board = (await api.req('GET', '/leaderboards/crowns_all_time', { token: u.accessToken })).json();
    expect(board.me).toMatchObject({ userId: u.id, score: 2 });
    const streak = (
      await api.req('GET', '/leaderboards/win_streak?scope=regional', { token: u.accessToken })
    ).json();
    expect(streak.me.score).toBe(2);
    const friends = (
      await api.req('GET', '/leaderboards/crowns?scope=friends', { token: u.accessToken })
    ).json();
    expect(friends.entries).toEqual([expect.objectContaining({ userId: u.id, rank: 1, score: 2 })]);
  });
});
