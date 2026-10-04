/**
 * Daily login streak: one claim per UTC day from the server clock, the 7-day
 * ladder, breaks after a missed day, month/year/DST boundaries, concurrent
 * claims paying once, a clock stepping back, guests and upgraded accounts.
 * Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currenciesLedger, loginStreaks } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

describe.each(BACKENDS)('login streak ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2026-10-02T12:00:00.000Z', backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  let ipNo = 0;
  /** The fake clock jumps days at a time, far past the 15-minute access token. */
  async function refresh(u: TestUser): Promise<void> {
    ipNo++;
    const r = await api.req('POST', '/auth/refresh', {
      body: { refreshToken: u.refreshToken },
      ip: `10.77.${Math.floor(ipNo / 250)}.${ipNo % 250}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    u.accessToken = r.json().accessToken;
    u.refreshToken = r.json().refreshToken;
  }
  async function at(iso: string, u: TestUser): Promise<void> {
    api.clock.set(iso);
    await refresh(u);
  }
  /** A guest created at `iso`, so its 30-day refresh token covers the test's dates. */
  async function guestAt(iso: string): Promise<TestUser> {
    api.clock.set(iso);
    return api.guest();
  }
  const claim = (u: TestUser) => api.req('POST', '/streak/claim', { token: u.accessToken });
  const state = async (u: TestUser) => (await api.req('GET', '/streak', { token: u.accessToken })).json();

  it('requires a signed-in player and no input', async () => {
    expect((await api.req('POST', '/streak/claim')).statusCode).toBe(401);
    expect((await api.req('GET', '/streak')).statusCode).toBe(401);
    const u = await api.guest();
    const junk = await api.req('POST', '/streak/claim', {
      token: u.accessToken,
      body: { day: '2030-01-01' },
    });
    expect(junk.statusCode).toBe(400);
    expect((await api.req('GET', '/streak?day=2030-01-01', { token: u.accessToken })).statusCode).toBe(400);
    expect((await state(u)).claims).toBe(0);
  });

  it('starts at zero with day 1 claimable today', async () => {
    api.clock.set('2026-10-02T12:00:00.000Z');
    const u = await api.guest();
    const s = await state(u);
    expect(s).toMatchObject({
      streak: 0,
      best: 0,
      claimedToday: false,
      canClaim: true,
      today: '2026-10-02',
      breaksAt: null,
      next: { streak: 1, day: 1 },
    });
    expect(s.ladder).toHaveLength(7);
    expect(s.ladder.map((d: { state: string }) => d.state)).toEqual([
      'today',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });

  it('pays once per UTC day and reports when the next claim opens', async () => {
    api.clock.set('2026-10-02T12:00:00.000Z');
    const u = await api.guest();
    const res = await claim(u);
    expect(res.statusCode).toBe(200);
    const day1 = api.ctx.catalog.loginLadder[0]!;
    expect(res.json()).toMatchObject({ day: '2026-10-02', streak: 1, best: 1, ladderDay: 1 });
    expect(res.json().rewards).toEqual(day1.rewards.map((r) => ({ ...r, granted: true })));
    expect(res.json().wallet.gumballs).toBe(50);
    expect(res.json().view).toMatchObject({ claimedToday: true, canClaim: false });

    const again = await claim(u);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_claimed');
    await at('2026-10-02T23:59:59.999Z', u);
    expect((await claim(u)).statusCode).toBe(409);
    const s = await state(u);
    expect(s).toMatchObject({
      streak: 1,
      claimedToday: true,
      nextClaimAt: '2026-10-03T00:00:00.000Z',
      breaksAt: '2026-10-04T00:00:00.000Z',
      next: { streak: 2, day: 2 },
    });
    expect(s.ladder[0].state).toBe('claimed');
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('grows on consecutive days, across month, year and DST changes', async () => {
    // US clocks fall back on 2026-11-01 and spring forward on 2027-03-14; EU on
    // 2026-10-25 and 2027-03-28. Claims are keyed by UTC day, so none of it matters.
    const u = await guestAt('2026-10-24T23:59:59.000Z');
    expect((await claim(u)).json().streak).toBe(1);
    await at('2026-10-25T00:00:00.000Z', u);
    expect((await claim(u)).json().streak).toBe(2);
    await at('2026-10-26T23:30:00.000Z', u);
    expect((await claim(u)).json().streak).toBe(3);

    const v = await guestAt('2026-10-31T23:59:59.000Z');
    expect((await claim(v)).json()).toMatchObject({ day: '2026-10-31', streak: 1 });
    await at('2026-11-01T00:00:00.000Z', v);
    expect((await claim(v)).json()).toMatchObject({ day: '2026-11-01', streak: 2 });
    await at('2026-11-02T06:30:00.000Z', v);
    expect((await claim(v)).json().streak).toBe(3);

    const w = await guestAt('2026-12-31T23:59:00.000Z');
    expect((await claim(w)).json().streak).toBe(1);
    await at('2027-01-01T00:00:01.000Z', w);
    expect((await claim(w)).json()).toMatchObject({ day: '2027-01-01', streak: 2 });

    const x = await guestAt('2027-03-13T22:00:00.000Z');
    expect((await claim(x)).json().streak).toBe(1);
    await at('2027-03-14T10:00:00.000Z', x);
    expect((await claim(x)).json().streak).toBe(2);
    await at('2027-03-15T01:00:00.000Z', x);
    expect((await claim(x)).json()).toMatchObject({ day: '2027-03-15', streak: 3 });
  });

  it('breaks after a missed day', async () => {
    const u = await guestAt('2026-10-10T08:00:00.000Z');
    await claim(u);
    await at('2026-10-11T08:00:00.000Z', u);
    await claim(u);
    await at('2026-10-12T20:00:00.000Z', u);
    expect(await state(u)).toMatchObject({ streak: 2, breaksAt: '2026-10-13T00:00:00.000Z' });
    await at('2026-10-13T00:00:00.000Z', u);
    const broken = await state(u);
    expect(broken).toMatchObject({ streak: 0, best: 2, breaksAt: null, next: { streak: 1, day: 1 } });
    const res = (await claim(u)).json();
    expect(res).toMatchObject({ streak: 1, best: 2, ladderDay: 1 });
  });

  it('runs the 7-day ladder, pays the big day 7 and starts over', async () => {
    const u = await guestAt('2026-10-20T15:00:00.000Z');
    const start = Date.parse('2026-10-20T15:00:00.000Z');
    const paid: number[] = [];
    let unlocked: string[] = [];
    for (let d = 0; d < 8; d++) {
      await at(new Date(start + d * 86_400_000).toISOString(), u);
      const r = (await claim(u)).json();
      paid.push(r.ladderDay);
      unlocked = unlocked.concat(r.achievements.map((a: { id: string }) => a.id));
      if (d === 6) {
        expect(r.rewards).toEqual(
          api.ctx.catalog.loginLadder[6]!.rewards.map((x) => ({ ...x, granted: true })),
        );
        expect(r.view.ladder.every((x: { state: string }) => x.state === 'claimed')).toBe(true);
      }
    }
    expect(paid).toEqual([1, 2, 3, 4, 5, 6, 7, 1]);
    expect(unlocked).toContain('regular-1');
    const s = await state(u);
    expect(s).toMatchObject({ streak: 8, best: 8, claims: 8, next: { streak: 9, day: 2 } });
    expect(s.ladder.map((x: { state: string }) => x.state)).toEqual([
      'claimed',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    const gems = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(
        and(
          eq(currenciesLedger.userId, u.id),
          eq(currenciesLedger.currency, 'gems'),
          eq(currenciesLedger.reason, 'login_reward'),
        ),
      );
    expect(gems).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('pays exactly once when claims race', async () => {
    const u = await guestAt('2026-11-05T09:00:00.000Z');
    await at('2026-11-05T09:00:00.000Z', u);
    const results = await Promise.all(Array.from({ length: 6 }, () => claim(u)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    const rows = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'login_reward')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe('login:2026-11-05');
    const [row] = await api.ctx.db.select().from(loginStreaks).where(eq(loginStreaks.userId, u.id));
    expect(row).toMatchObject({ current: 1, claims: 1, lastClaimDay: '2026-11-05' });
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('refuses to rewind when the clock steps back a day', async () => {
    const u = await guestAt('2026-11-09T09:00:00.000Z');
    await at('2026-11-09T09:00:00.000Z', u);
    await claim(u);
    await at('2026-11-10T09:00:00.000Z', u);
    await claim(u);
    await at('2026-11-09T22:00:00.000Z', u);
    const back = await claim(u);
    expect(back.statusCode).toBe(409);
    expect(await state(u)).toMatchObject({ streak: 2, claimedToday: true, canClaim: false });
    await at('2026-11-11T09:00:00.000Z', u);
    expect((await claim(u)).json().streak).toBe(3);
  });

  it('rate-limits claim attempts per player', async () => {
    const u = await guestAt('2026-11-25T09:00:00.000Z');
    const other = await api.guest();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await claim(u)).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.slice(1, 20).every((c) => c === 409)).toBe(true);
    expect(codes[20]).toBe(429);
    expect((await claim(other)).statusCode).toBe(200);
  });

  it('works for upgraded accounts too', async () => {
    api.clock.set('2026-11-20T09:00:00.000Z');
    const u = await api.account();
    const res = await claim(u);
    expect(res.statusCode).toBe(200);
    expect(res.json().streak).toBe(1);
  });
});
