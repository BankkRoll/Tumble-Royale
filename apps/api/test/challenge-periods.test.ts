/**
 * Seasonal and milestone challenges plus every rollover boundary: UTC days,
 * ISO weeks (week 53 across New Year), DST changes, season end with
 * settlement of completed-but-unclaimed seasonal challenges, permanent
 * milestones, and the fake clock stepping backwards.
 * Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { challengeProgress, currenciesLedger } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { MILESTONE_PERIOD_KEY, periodKey } from '../src/progression/challenges.ts';
import { dayKey, isoWeekKey, nextIsoWeekStart, nextUtcMidnight } from '../src/util/time.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

interface Row {
  id: string;
  challengeId: string;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  reward: { xp: number; gumballs: number; gems: number; cosmetic: { id: string } | null };
}

describe('UTC period boundaries', () => {
  const cases: [iso: string, day: string, week: string, nextDay: string, nextWeek: string][] = [
    // EU clocks fall back on 2026-10-25 (a Sunday); the week still ends at Monday 00:00 UTC.
    [
      '2026-10-25T23:59:59.999Z',
      '2026-10-25',
      '2026-W43',
      '2026-10-26T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ],
    [
      '2026-10-26T00:00:00.000Z',
      '2026-10-26',
      '2026-W44',
      '2026-10-27T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ],
    // US clocks fall back on 2026-11-01.
    [
      '2026-11-01T06:59:59.000Z',
      '2026-11-01',
      '2026-W44',
      '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ],
    // Month end.
    [
      '2026-11-30T23:59:59.999Z',
      '2026-11-30',
      '2026-W49',
      '2026-12-01T00:00:00.000Z',
      '2026-12-07T00:00:00.000Z',
    ],
    // 2026 has 53 ISO weeks; New Year's Day 2027 is still in 2026-W53.
    [
      '2026-12-31T23:59:59.999Z',
      '2026-12-31',
      '2026-W53',
      '2027-01-01T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ],
    [
      '2027-01-03T23:59:59.999Z',
      '2027-01-03',
      '2026-W53',
      '2027-01-04T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ],
    [
      '2027-01-04T00:00:00.000Z',
      '2027-01-04',
      '2027-W01',
      '2027-01-05T00:00:00.000Z',
      '2027-01-11T00:00:00.000Z',
    ],
    // US and EU spring forward.
    [
      '2027-03-14T07:00:00.000Z',
      '2027-03-14',
      '2027-W10',
      '2027-03-15T00:00:00.000Z',
      '2027-03-15T00:00:00.000Z',
    ],
    [
      '2027-03-28T01:30:00.000Z',
      '2027-03-28',
      '2027-W12',
      '2027-03-29T00:00:00.000Z',
      '2027-03-29T00:00:00.000Z',
    ],
    // Leap day.
    [
      '2028-02-29T12:00:00.000Z',
      '2028-02-29',
      '2028-W09',
      '2028-03-01T00:00:00.000Z',
      '2028-03-06T00:00:00.000Z',
    ],
  ];
  it.each(cases)('%s', (iso, day, week, nextDay, nextWeek) => {
    const d = new Date(iso);
    expect(dayKey(d)).toBe(day);
    expect(isoWeekKey(d)).toBe(week);
    expect(nextUtcMidnight(d).toISOString()).toBe(nextDay);
    expect(nextIsoWeekStart(d).toISOString()).toBe(nextWeek);
  });
});

describe.each(BACKENDS)('seasonal and milestone challenges ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2026-11-30T12:00:00.000Z', backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  let ipNo = 0;
  async function at(iso: string, u: TestUser): Promise<void> {
    api.clock.set(iso);
    ipNo++;
    const r = await api.req('POST', '/auth/refresh', {
      body: { refreshToken: u.refreshToken },
      ip: `10.88.${Math.floor(ipNo / 250)}.${ipNo % 250}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    u.accessToken = r.json().accessToken;
    u.refreshToken = r.json().refreshToken;
  }
  async function guestAt(iso: string): Promise<TestUser> {
    api.clock.set(iso);
    return api.guest();
  }
  const board = async (u: TestUser) => {
    const res = await api.req('GET', '/challenges', { token: u.accessToken });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      daily: Row[];
      weekly: Row[];
      seasonal: Row[];
      milestone: Row[];
      season: { id: string; name: string; endsAt: string };
      seasonalRefreshesAt: string;
      dailyRefreshesAt: string;
      weeklyRefreshesAt: string;
      settled: { id: string; challengeId: string; gumballs: number; gems: number; cosmetic: string | null }[];
    };
  };
  const complete = (rowId: string, target: number) =>
    api.ctx.db
      .update(challengeProgress)
      .set({ progress: target, completedAt: api.clock.now() })
      .where(eq(challengeProgress.id, rowId));
  /** What challenge claims alone paid (level-up Gumballs and Gems from claim XP are excluded). */
  const challengePay = async (u: TestUser) => {
    const rows = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'challenge_reward')));
    const sum = (c: string) => rows.filter((r) => r.currency === c).reduce((s, r) => s + r.delta, 0);
    return { gumballs: sum('gumballs'), gems: sum('gems') };
  };

  it('assigns the season set and every milestone, with their refresh times', async () => {
    const u = await guestAt('2026-11-30T12:00:00.000Z');
    const b = await board(u);
    expect(b.seasonal.map((c) => c.challengeId)).toEqual(
      api.ctx.catalog.pickChallenges('seasonal', 's1').map((c) => c.id),
    );
    expect(b.milestone.map((c) => c.challengeId)).toEqual(
      api.ctx.catalog.milestoneChallenges.map((c) => c.id),
    );
    expect(b.season).toMatchObject({ id: 's1', endsAt: '2026-12-01T00:00:00.000Z' });
    expect(b.seasonalRefreshesAt).toBe('2026-12-01T00:00:00.000Z');
    expect(b.dailyRefreshesAt).toBe('2026-12-01T00:00:00.000Z');
    expect(b.weeklyRefreshesAt).toBe('2026-12-07T00:00:00.000Z');
    const rows = await api.ctx.db.select().from(challengeProgress).where(eq(challengeProgress.userId, u.id));
    expect(new Set(rows.filter((r) => r.period === 'seasonal').map((r) => r.periodKey))).toEqual(
      new Set(['s1']),
    );
    expect(new Set(rows.filter((r) => r.period === 'milestone').map((r) => r.periodKey))).toEqual(
      new Set([MILESTONE_PERIOD_KEY]),
    );
    const milestoneWithItem = b.milestone.find((c) => c.reward.cosmetic);
    expect(milestoneWithItem?.reward.cosmetic?.id).toBeTruthy();
  });

  it('rolls daily and weekly sets at 00:00 UTC on the server clock', async () => {
    const u = await guestAt('2026-12-06T23:59:59.999Z');
    const sunday = await board(u);
    await at('2026-12-07T00:00:00.000Z', u);
    const monday = await board(u);
    expect(monday.dailyRefreshesAt).toBe('2026-12-08T00:00:00.000Z');
    expect(monday.weeklyRefreshesAt).toBe('2026-12-14T00:00:00.000Z');
    const ids = (b: typeof sunday) => [...b.daily, ...b.weekly].map((c) => c.id);
    expect(ids(monday).some((id) => ids(sunday).includes(id))).toBe(false);
    const keys = await api.ctx.db
      .select({ period: challengeProgress.period, key: challengeProgress.periodKey })
      .from(challengeProgress)
      .where(eq(challengeProgress.userId, u.id));
    expect(new Set(keys.filter((k) => k.period === 'daily').map((k) => k.key))).toEqual(
      new Set(['2026-12-06', '2026-12-07']),
    );
    expect(new Set(keys.filter((k) => k.period === 'weekly').map((k) => k.key))).toEqual(
      new Set(['2026-W49', '2026-W50']),
    );
    expect(monday.seasonal.map((c) => c.id)).toEqual(sunday.seasonal.map((c) => c.id));
  });

  it('expires seasonal challenges with the season and settles completed ones', async () => {
    const u = await guestAt('2026-11-30T20:00:00.000Z');
    const s1 = await board(u);
    const [done, open] = s1.seasonal;
    await complete(done!.id, done!.target);
    const milestone = s1.milestone[0]!;
    await api.postMatch(
      buildShow({ humans: [{ userId: u.id, placement: 1 }], startIso: '2026-11-30T20:00:00.000Z' }),
    );
    const mid = await board(u);
    const openMid = mid.seasonal.find((c) => c.id === open!.id)!;
    const milestoneMid = mid.milestone.find((c) => c.id === milestone.id)!;
    expect(milestoneMid.progress).toBeGreaterThan(0);

    const before = await challengePay(u);
    await at('2026-12-01T00:00:00.000Z', u);
    const s2 = await board(u);
    expect(s2.season.id).toBe('s2');
    expect(s2.seasonalRefreshesAt).toBe('2027-03-01T00:00:00.000Z');
    expect(s2.seasonal.map((c) => c.challengeId)).toEqual(
      api.ctx.catalog.pickChallenges('seasonal', 's2').map((c) => c.id),
    );
    expect(s2.seasonal.some((c) => c.id === done!.id || c.id === open!.id)).toBe(false);
    expect(s2.settled).toHaveLength(1);
    const def = api.ctx.catalog.challenges.find((c) => c.id === done!.challengeId)!;
    expect(s2.settled[0]).toMatchObject({
      id: done!.id,
      gumballs: def.rewardGumballs,
      gems: def.rewardGems,
    });
    const after = await challengePay(u);
    expect(after.gumballs - before.gumballs).toBe(def.rewardGumballs);
    expect(after.gems - before.gems).toBe(def.rewardGems);
    expect((await board(u)).settled).toEqual([]);

    // Milestones carry over; the old season's unfinished challenge stops counting.
    expect(s2.milestone.find((c) => c.id === milestone.id)!.progress).toBe(milestoneMid.progress);
    await api.postMatch(
      buildShow({ humans: [{ userId: u.id, placement: 1 }], startIso: '2026-12-01T00:00:00.000Z' }),
    );
    const [stale] = await api.ctx.db
      .select()
      .from(challengeProgress)
      .where(eq(challengeProgress.id, open!.id));
    expect(stale!.progress).toBe(openMid.progress);
    expect(stale!.claimedAt).toBeNull();
    const late = await api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id: open!.id } });
    expect(late.json().error).toBe('not_completed');
    const [paid] = await api.ctx.db
      .select()
      .from(challengeProgress)
      .where(eq(challengeProgress.id, done!.id));
    expect(paid!.claimedAt).not.toBeNull();
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('never settles a later season when the clock steps back', async () => {
    const u = await guestAt('2026-12-02T10:00:00.000Z');
    const b = await board(u);
    await complete(b.seasonal[0]!.id, b.seasonal[0]!.target);
    await at('2026-11-30T10:00:00.000Z', u);
    const back = await board(u);
    expect(back.season.id).toBe('s1');
    expect(back.settled).toEqual([]);
    const [row] = await api.ctx.db
      .select()
      .from(challengeProgress)
      .where(eq(challengeProgress.id, b.seasonal[0]!.id));
    expect(row!.claimedAt).toBeNull();
  });

  it('claims seasonal Gems and milestone cosmetics exactly once', async () => {
    const u = await guestAt('2026-12-10T10:00:00.000Z');
    const b = await board(u);
    const seasonal = b.seasonal[0]!;
    const milestone = b.milestone.find((c) => c.reward.cosmetic)!;
    await complete(seasonal.id, seasonal.target);
    await complete(milestone.id, milestone.target);
    const before = await challengePay(u);

    const s = await api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id: seasonal.id } });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ gumballs: seasonal.reward.gumballs, gems: seasonal.reward.gems });
    const m = await api.req('POST', '/challenges/claim', {
      token: u.accessToken,
      body: { id: milestone.id },
    });
    expect(m.json().cosmetic).toBe(milestone.reward.cosmetic!.id);
    const inv = (await api.req('GET', '/inventory', { token: u.accessToken })).json();
    expect(inv.items.some((i: { id: string }) => i.id === milestone.reward.cosmetic!.id)).toBe(true);

    const races = await Promise.all(
      [seasonal.id, milestone.id].map((id) =>
        api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id } }),
      ),
    );
    expect(races.map((r) => r.json().error)).toEqual(['already_claimed', 'already_claimed']);
    const after = await challengePay(u);
    expect(after.gems - before.gems).toBe(seasonal.reward.gems + milestone.reward.gems);
    expect(after.gumballs - before.gumballs).toBe(seasonal.reward.gumballs + milestone.reward.gumballs);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('only rerolls dailies', async () => {
    const u = await guestAt('2026-12-10T10:00:00.000Z');
    const b = await board(u);
    for (const id of [b.seasonal[0]!.id, b.milestone[0]!.id, b.weekly[0]!.id]) {
      const r = await api.req('POST', '/challenges/reroll', { token: u.accessToken, body: { id } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('not_rerollable');
    }
  });

  it('fills in a milestone that is missing without touching the rest', async () => {
    const u = await guestAt('2026-12-10T10:00:00.000Z');
    const b = await board(u);
    const gone = b.milestone[2]!;
    await api.ctx.db
      .delete(challengeProgress)
      .where(and(eq(challengeProgress.userId, u.id), eq(challengeProgress.id, gone.id)));
    const again = await board(u);
    expect(again.milestone.map((c) => c.challengeId)).toEqual(b.milestone.map((c) => c.challengeId));
    expect(
      again.milestone.filter((c) => c.id !== b.milestone.find((x) => x.challengeId === c.challengeId)!.id),
    ).toHaveLength(1);
    expect(periodKey(api.ctx.catalog, 'milestone', api.clock.now())).toBe(MILESTONE_PERIOD_KEY);
  });
});
