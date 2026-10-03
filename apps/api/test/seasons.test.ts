import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seasonPassProgress, seasonRollovers } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import type { SeasonChange } from '../src/progression/seasons.ts';
import { addPassXp } from '../src/progression/xp.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';

const changes: SeasonChange[] = [];
let api: TestApi;
beforeAll(async () => {
  api = await createTestApi('2026-11-28T12:00:00.000Z', {
    seasonListeners: [
      (c) => {
        changes.push(c);
      },
    ],
  });
});
afterAll(async () => {
  await api.close();
});

async function inventory(u: TestUser): Promise<Set<string>> {
  const r = (await api.req('GET', '/inventory', { token: u.accessToken })).json();
  return new Set((r.items as { id: string }[]).map((i) => i.id));
}

async function wallet(u: TestUser) {
  return (await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet;
}

async function s1Row(userId: string) {
  const [row] = await api.ctx.db
    .select()
    .from(seasonPassProgress)
    .where(and(eq(seasonPassProgress.userId, userId), eq(seasonPassProgress.seasonId, 's1')));
  return row;
}

describe('season schedule', () => {
  it('serves the live season and the next one', async () => {
    const r = (await api.req('GET', '/seasons')).json();
    expect(r.current).toMatchObject({ id: 's1', number: 1, endsAt: '2026-12-01T00:00:00.000Z' });
    expect(r.next).toMatchObject({ id: 's2', number: 2, startsAt: '2026-12-01T00:00:00.000Z' });
    expect(r.secondsRemaining).toBe(2.5 * 86_400);
  });
});

describe('season rollover', () => {
  let opener: TestUser;
  let player: TestUser;
  const s1 = () => api.ctx.catalog.seasonById('s1')!;
  const xpForTiers = (n: number) =>
    s1()
      .tiers.slice(0, n)
      .reduce((sum, t) => sum + t.xp, 0);

  it('records progress during season 1', async () => {
    opener = await api.guest();
    player = await api.guest();
    await api.grant(opener.id, 'gems', 2000);
    const unlock = await api.req('POST', '/pass/premium', {
      token: opener.accessToken,
      headers: { 'idempotency-key': 'rollover-premium' },
    });
    expect(unlock.statusCode).toBe(200);
    for (const u of [opener, player])
      await api.ctx.db.transaction((tx) => addPassXp(tx, api.ctx.catalog, u.id, xpForTiers(3)));
    const claim = await api.req('POST', '/pass/claim', {
      token: opener.accessToken,
      body: { tier: 1, track: 'free' },
    });
    expect(claim.statusCode).toBe(200);
    const pass = (await api.req('GET', '/pass', { token: opener.accessToken })).json();
    expect(pass).toMatchObject({ seasonId: 's1', seasonNumber: 1, tier: 3, premium: true, settled: [] });
    expect(pass.next).toMatchObject({ id: 's2', number: 2, startsAt: '2026-12-01T00:00:00.000Z' });
    expect(changes).toHaveLength(0);
  });

  it('fires the season-change hook exactly once when season 2 goes live', async () => {
    api.clock.set('2026-12-01T00:00:05.000Z');
    await Promise.all(Array.from({ length: 5 }, () => api.req('GET', '/seasons')));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.previous?.id).toBe('s1');
    expect(changes[0]!.current.id).toBe('s2');
    const rows = await api.ctx.db.select().from(seasonRollovers);
    expect(rows.find((r) => r.seasonId === 's2')).toMatchObject({ previousSeasonId: 's1' });
    // A clock stepping back and forth again must not re-announce a season.
    api.clock.set('2026-11-30T00:00:00.000Z');
    await api.req('GET', '/seasons');
    api.clock.set('2026-12-01T00:00:05.000Z');
    await api.req('GET', '/seasons');
    expect(changes).toHaveLength(1);
  });

  it('auto-grants unlocked unclaimed rewards once and starts a fresh pass', async () => {
    // The clock jumped days ahead, past the access-token lifetime.
    for (const u of [opener, player]) {
      const r = (await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).json();
      u.accessToken = r.accessToken;
      u.refreshToken = r.refreshToken;
    }
    const before = await wallet(opener);
    const pass = (await api.req('GET', '/pass', { token: opener.accessToken })).json();
    expect(pass).toMatchObject({ seasonId: 's2', seasonNumber: 2, tier: 0, xp: 0, premium: false });
    // Free tiers 2–3 and premium tiers 1–3; tier 1 free was claimed by hand.
    expect(pass.settled).toEqual([{ seasonId: 's1', name: s1().name, autoGranted: 5 }]);

    const owned = await inventory(opener);
    for (const t of s1().tiers.slice(0, 3))
      for (const r of [...t.free, ...t.premium])
        if (r.type === 'cosmetic') expect(owned.has(r.id)).toBe(true);
    const gumballs = s1()
      .tiers.slice(0, 3)
      .flatMap((t) => [...t.free, ...t.premium])
      .reduce((s, r) => s + (r.type === 'gumballs' ? r.amount : 0), 0);
    expect((await wallet(opener)).gumballs).toBe(before.gumballs + gumballs);

    const row = await s1Row(opener.id);
    expect(row?.settledAt).not.toBeNull();
    expect(row).toMatchObject({
      xp: xpForTiers(3),
      premium: true,
      claimedFree: [1, 2, 3],
      claimedPremium: [1, 2, 3],
    });

    const again = (await api.req('GET', '/pass', { token: opener.accessToken })).json();
    expect(again.settled).toEqual([]);
    expect(await wallet(opener)).toEqual(await wallet(opener));
    expect((await wallet(opener)).gumballs).toBe(before.gumballs + gumballs);
    expect((await verifyLedger(api.ctx.db, opener.id)).ok).toBe(true);
    const old = await api.req('POST', '/pass/claim', {
      token: opener.accessToken,
      body: { tier: 2, track: 'free' },
    });
    expect(old.json().error).toBe('tier_locked');
  });

  it('settles a player who never opens the pass when their next show is ingested', async () => {
    expect((await s1Row(player.id))?.settledAt).toBeNull();
    const res = await api.postMatch(
      buildShow({ humans: [{ userId: player.id, placement: 20 }], startIso: '2026-12-01T00:00:00.000Z' }),
    );
    expect(res.statusCode).toBe(200);
    const row = await s1Row(player.id);
    expect(row?.settledAt).not.toBeNull();
    expect(row?.autoGranted).toBe(3);
    const owned = await inventory(player);
    const free = s1()
      .tiers.slice(0, 3)
      .flatMap((t) => t.free);
    for (const r of free) if (r.type === 'cosmetic') expect(owned.has(r.id)).toBe(true);
    const pass = (await api.req('GET', '/pass', { token: player.accessToken })).json();
    expect(pass.seasonId).toBe('s2');
    expect(pass.xp).toBeGreaterThan(0);
    expect(pass.settled).toEqual([]);
  });

  it('pays Gumballs for pass cosmetics already owned when a track repeats', async () => {
    const u = await api.guest();
    const s2 = api.ctx.catalog.season;
    const firstCosmetic = s2.tiers.find((t) => t.free[0]?.type === 'cosmetic')!;
    const item = firstCosmetic.free[0] as { type: 'cosmetic'; id: string };
    await api.ctx.db.transaction((tx) =>
      addPassXp(
        tx,
        api.ctx.catalog,
        u.id,
        s2.tiers.slice(0, firstCosmetic.tier).reduce((s, t) => s + t.xp, 0),
      ),
    );
    await api.ctx.db.transaction(async (tx) => {
      const { grantCosmetic } = await import('../src/economy/wallet.ts');
      await grantCosmetic(tx, u.id, item.id, 'store');
    });
    const before = (await wallet(u)).gumballs;
    const claim = (
      await api.req('POST', '/pass/claim', {
        token: u.accessToken,
        body: { tier: firstCosmetic.tier, track: 'free' },
      })
    ).json();
    expect(claim.rewards[0]).toMatchObject({ type: 'cosmetic', granted: false, duplicateGumballs: 100 });
    expect((await wallet(u)).gumballs).toBe(before + 100);
  });
});
