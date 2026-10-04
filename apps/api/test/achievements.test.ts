/**
 * Achievements: progress from reported shows only, exactly-once unlocks and
 * grants (replayed and concurrent duplicate reports, custom lobbies), hidden
 * achievements that never leak, gauge unlocks on read, the history backfill
 * and the collection log. Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { achievementStats, currenciesLedger, inventoryItems, playerAchievements } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { grantCosmetic } from '../src/economy/wallet.ts';
import type { MatchResultInput } from '../src/matches/schema.ts';
import { HIDDEN_DESCRIPTION } from '../src/progression/achievements.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

interface ViewEntry {
  id: string;
  title: string;
  description: string;
  category: string;
  hidden: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
  progress: number | null;
  target: number | null;
  rewards: unknown[];
}

describe.each(BACKENDS)('achievements ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(undefined, backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  const view = async (u: TestUser) => {
    const res = await api.req('GET', '/achievements', { token: u.accessToken });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      achievements: ViewEntry[];
      categories: { id: string; unlocked: number; total: number }[];
      unlocked: number;
      total: number;
      newlyUnlocked: { id: string; title: string }[];
    };
  };
  const entry = async (u: TestUser, id: string) => (await view(u)).achievements.find((a) => a.id === id);
  const inventory = async (u: TestUser) =>
    new Set(
      ((await api.req('GET', '/inventory', { token: u.accessToken })).json().items as { id: string }[]).map(
        (i) => i.id,
      ),
    );
  const wallet = async (u: TestUser) =>
    (await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet;
  const show = (u: TestUser, placement: number, edit?: (m: MatchResultInput) => void) => {
    const m = buildShow({ humans: [{ userId: u.id, placement }] });
    edit?.(m);
    return m;
  };

  it('requires a signed-in player', async () => {
    for (const url of ['/achievements', '/collection', '/streak'])
      expect((await api.req('GET', url)).statusCode).toBe(401);
    expect((await api.req('GET', '/achievements', { token: 'not-a-token' })).statusCode).toBe(401);
  });

  it('rejects unexpected input', async () => {
    const u = await api.guest();
    expect((await api.req('GET', '/achievements?debug=1', { token: u.accessToken })).statusCode).toBe(400);
    for (const q of ['slot=hat', 'rarity=shiny', 'owned=maybe', 'page=2'])
      expect((await api.req('GET', `/collection?${q}`, { token: u.accessToken })).json().error).toBe(
        'invalid_request',
      );
  });

  it('starts every achievement locked and never reveals hidden ones', async () => {
    const u = await api.guest();
    const res = await api.req('GET', '/achievements', { token: u.accessToken });
    const v = res.json();
    expect(v.total).toBe(api.ctx.catalog.achievements.length);
    expect(v.unlocked).toBe(0);
    expect(v.newlyUnlocked).toEqual([]);
    expect(v.achievements).toHaveLength(api.ctx.catalog.achievements.length);
    const hidden = api.ctx.catalog.achievements.filter((a) => a.hidden);
    const shown = (v.achievements as ViewEntry[]).filter((a) => a.hidden);
    expect(shown).toHaveLength(hidden.length);
    for (const a of shown) {
      expect(a).toMatchObject({
        title: '???',
        description: HIDDEN_DESCRIPTION,
        progress: null,
        target: null,
        rewards: [],
      });
      expect(a.id).toMatch(/^hidden-\d+$/);
    }
    for (const h of hidden) {
      expect(res.body).not.toContain(h.title);
      expect(res.body).not.toContain(h.description);
      expect(res.body).not.toContain(`"${h.id}"`);
    }
    const first = (v.achievements as ViewEntry[]).find((a) => a.id === 'showtime-1')!;
    expect(first).toMatchObject({ unlocked: false, unlockedAt: null, progress: 0, target: 1 });
  });

  it('unlocks from a reported show, grants once and lists the unlocks in the reward', async () => {
    const u = await api.guest();
    const before = await wallet(u);
    const res = await api.postMatch(show(u, 1));
    expect(res.statusCode).toBe(200);
    const reward = res.json().rewards[0];
    const ids = (reward.achievements as { id: string }[]).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['showtime-1', 'crown-collector-1', 'finalist-1']));
    expect(reward.xp.lines).toContainEqual({ label: 'Achievement: Showtime I', amount: 250 });
    expect(reward.gumballs.lines).toContainEqual({ label: 'Achievement: Crown Collector I', amount: 200 });
    expect(reward.gumballs.lines).toContainEqual({ label: 'Achievement: Finalist I', amount: 100 });

    const owned = await inventory(u);
    expect(owned.has('trail.bubbles')).toBe(true);
    expect(owned.has('upper.medal')).toBe(true);
    const after = await wallet(u);
    expect(after.gumballs - before.gumballs).toBe(reward.gumballs.total);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);

    const e = await entry(u, 'crown-collector-1');
    expect(e).toMatchObject({ unlocked: true, progress: 1, target: 1 });
    expect(e!.unlockedAt).toBe(api.clock.now().toISOString());
    expect((await entry(u, 'crown-collector-2'))!.progress).toBe(1);
    expect((await view(u)).newlyUnlocked).toEqual([]);
  });

  it('never double counts a replayed or concurrently duplicated report', async () => {
    const u = await api.guest();
    const m = show(u, 1);
    const [a, b] = await Promise.all([api.postMatch(m), api.postMatch(m)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().alreadyProcessed, b.json().alreadyProcessed].sort()).toEqual([false, true]);
    const replay = await api.postMatch(m);
    expect(replay.json().alreadyProcessed).toBe(true);
    expect(replay.json().rewards[0].achievements).toEqual(a.json().rewards[0].achievements);

    expect((await entry(u, 'showtime-2'))!.progress).toBe(1);
    expect((await entry(u, 'grabby-hands-1'))!.progress).toBe(30);
    const unlockRows = await api.ctx.db
      .select()
      .from(playerAchievements)
      .where(eq(playerAchievements.userId, u.id));
    expect(new Set(unlockRows.map((r) => r.achievementId)).size).toBe(unlockRows.length);
    const ledger = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'achievement_reward')));
    expect(ledger.filter((l) => l.ref === 'achievement:crown-collector-1')).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('ignores custom lobbies', async () => {
    const u = await api.guest();
    const res = await api.postMatch(buildShow({ queue: 'custom', humans: [{ userId: u.id, placement: 1 }] }));
    expect(res.json().rewards[0].achievements).toEqual([]);
    expect((await entry(u, 'showtime-1'))!.unlocked).toBe(false);
    expect(await api.ctx.db.select().from(achievementStats).where(eq(achievementStats.userId, u.id))).toEqual(
      [],
    );
  });

  it('adds up across shows and unlocks a tier when the total crosses it', async () => {
    const u = await api.guest();
    for (let i = 0; i < 3; i++) await api.postMatch(show(u, 30));
    expect(await entry(u, 'grabby-hands-1')).toMatchObject({ progress: 90, unlocked: false });
    const fourth = (await api.postMatch(show(u, 30))).json().rewards[0];
    expect(fourth.achievements.map((a: { id: string }) => a.id)).toContain('grabby-hands-1');
    expect(await entry(u, 'grabby-hands-1')).toMatchObject({ progress: 100, unlocked: true });
  });

  it('tracks best streaks and single-show records as maxima', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    const second = (await api.postMatch(show(u, 1))).json().rewards[0];
    expect(second.achievements.map((a: { id: string }) => a.id)).toContain('on-a-roll-1');
    await api.postMatch(show(u, 20));
    expect((await entry(u, 'on-a-roll-2'))!.progress).toBe(2);
    await api.postMatch(show(u, 1));
    expect((await entry(u, 'on-a-roll-2'))!.progress).toBe(2);
  });

  it('reveals a hidden achievement once it is unlocked', async () => {
    const u = await api.guest();
    const clingy = api.ctx.catalog.achievements.find((a) => a.id === 'clingy')!;
    const res = await api.postMatch(
      show(u, 2, (m) => {
        m.participants.find((p) => p.userId === u.id)!.stats = { grabs: clingy.target + 5 };
      }),
    );
    const ids = res.json().rewards[0].achievements.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['so-close', 'clingy']));
    const v = await view(u);
    expect(v.achievements.find((a) => a.id === 'clingy')).toMatchObject({
      title: clingy.title,
      hidden: true,
      unlocked: true,
      progress: clingy.target,
    });
    expect(v.achievements.filter((a) => a.title === '???')).toHaveLength(
      api.ctx.catalog.achievements.filter((a) => a.hidden).length - 2,
    );
  });

  it('counts shows queued with a party', async () => {
    const u = await api.guest();
    const res = await api.postMatch(
      show(u, 10, (m) => {
        m.participants.find((p) => p.userId === u.id)!.party = true;
      }),
    );
    expect(res.json().rewards[0].achievements.map((a: { id: string }) => a.id)).toContain('party-animal-1');
    expect((await inventory(u)).has('headwear.flower')).toBe(true);
    const solo = await api.guest();
    await api.postMatch(show(solo, 10));
    expect((await entry(solo, 'party-animal-1'))!.progress).toBe(0);
  });

  it('unlocks collection achievements on the next read and notifies once', async () => {
    const u = await api.guest();
    const wardrobe = api.ctx.catalog.achievements.find((a) => a.id === 'wardrobe-1')!;
    const items = api.ctx.catalog.cosmetics.filter((c) => c.source === 'store').slice(0, wardrobe.target);
    await api.ctx.db.transaction(async (tx) => {
      for (const c of items) await grantCosmetic(tx, u.id, c.id, 'store');
    });
    const seen: string[] = [];
    await api.ctx.kv.subscribe(`user:${u.id}`, (msg) => {
      const e = JSON.parse(msg) as { type: string; achievementId?: string };
      if (e.achievementId) seen.push(e.achievementId);
    });
    const first = await view(u);
    expect(first.newlyUnlocked.map((a) => a.id)).toContain('wardrobe-1');
    expect(first.achievements.find((a) => a.id === 'wardrobe-1')).toMatchObject({ unlocked: true });
    expect((await view(u)).newlyUnlocked).toEqual([]);
    await backend.settle();
    expect(seen.filter((id) => id === 'wardrobe-1')).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('reports per-category tallies', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    const v = await view(u);
    const crowns = v.categories.find((c) => c.id === 'crowns')!;
    expect(crowns.total).toBe(api.ctx.catalog.achievements.filter((a) => a.category === 'crowns').length);
    expect(crowns.unlocked).toBe(1);
    expect(v.categories.reduce((s, c) => s + c.total, 0)).toBe(v.total);
    expect(v.unlocked).toBe(v.achievements.filter((a) => a.unlocked).length);
  });

  it('backfills totals from match history recorded before achievements existed', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    await api.postMatch(show(u, 2));
    await api.postMatch(buildShow({ queue: 'custom', humans: [{ userId: u.id, placement: 1 }] }));
    const counted = await api.ctx.db.select().from(achievementStats).where(eq(achievementStats.userId, u.id));
    await api.ctx.db.delete(achievementStats).where(eq(achievementStats.userId, u.id));

    const file = fileURLToPath(new URL('../drizzle/0007_achievements_streaks.sql', import.meta.url));
    const backfill = readFileSync(file, 'utf8').split('-- achievement-backfill')[1]!;
    await api.ctx.db.execute(sql.raw(backfill));
    await api.ctx.db.execute(sql.raw(backfill));

    const rows = await api.ctx.db.select().from(achievementStats).where(eq(achievementStats.userId, u.id));
    const value = (metric: string) => rows.find((r) => r.metric === metric)?.value ?? 0;
    for (const metric of [
      'showsPlayed',
      'crowns',
      'runnerUps',
      'finalsReached',
      'roundsQualified',
      'racesQualified',
      'survivalsQualified',
      'teamRoundsWon',
      'bestWinStreak',
    ])
      expect(value(metric), metric).toBe(counted.find((r) => r.metric === metric)?.value ?? 0);
    expect(value('showsPlayed')).toBe(2);
    expect(value('grabs')).toBe(0);
  });

  it('goes away with the account', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    await api.req('POST', '/streak/claim', { token: u.accessToken });
    const res = await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect(res.statusCode).toBe(204);
    for (const table of [achievementStats, playerAchievements] as const)
      expect(await api.ctx.db.select().from(table).where(eq(table.userId, u.id))).toEqual([]);
  });
});

describe.each(BACKENDS)('collection log ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(undefined, backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  it('lists every cosmetic with ownership, sources and completion', async () => {
    const u = await api.guest();
    const res = await api.req('GET', '/collection', { token: u.accessToken });
    expect(res.statusCode).toBe(200);
    const log = res.json();
    expect(log.total).toBe(api.ctx.catalog.cosmetics.length);
    expect(log.entries).toHaveLength(log.total);
    const owned = await api.ctx.db.select().from(inventoryItems).where(eq(inventoryItems.userId, u.id));
    const ownedIds = new Set(owned.map((o) => o.cosmeticId));
    for (const c of api.ctx.catalog.cosmetics) if (c.source === 'default') ownedIds.add(c.id);
    expect(log.owned).toBe(ownedIds.size);
    expect(log.percent).toBe(Math.floor((ownedIds.size * 1000) / log.total) / 10);
    for (const e of log.entries) {
      expect(e.sources.length).toBeGreaterThan(0);
      expect(e.owned).toBe(ownedIds.has(e.id));
      if (e.owned && e.acquiredAt) expect(Date.parse(e.acquiredAt)).not.toBeNaN();
    }
    const medal = log.entries.find((e: { id: string }) => e.id === 'upper.medal');
    expect(medal).toMatchObject({ owned: false, acquiredAt: null });
    expect(medal.sources).toEqual([{ kind: 'achievement', label: 'Achievement: Crown Collector I' }]);
  });

  it('filters by slot, rarity and ownership without changing the totals', async () => {
    const u = await api.guest();
    await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }));
    const all = (await api.req('GET', '/collection', { token: u.accessToken })).json();
    const hats = (
      await api.req('GET', '/collection?slot=headwear&rarity=common', { token: u.accessToken })
    ).json();
    expect(hats.entries.length).toBeGreaterThan(0);
    expect(
      hats.entries.every(
        (e: { slot: string; rarity: string }) => e.slot === 'headwear' && e.rarity === 'common',
      ),
    ).toBe(true);
    expect(hats.owned).toBe(all.owned);
    expect(hats.total).toBe(all.total);
    const mine = (await api.req('GET', '/collection?owned=true', { token: u.accessToken })).json();
    expect(mine.entries).toHaveLength(all.owned);
    const medal = mine.entries.find((e: { id: string }) => e.id === 'upper.medal');
    expect(Date.parse(medal.acquiredAt)).not.toBeNaN();
    const missing = (await api.req('GET', '/collection?owned=false', { token: u.accessToken })).json();
    expect(missing.entries).toHaveLength(all.total - all.owned);
    expect(all.bySlot.headwear.total).toBe(
      api.ctx.catalog.cosmetics.filter((c) => c.slot === 'headwear').length,
    );
  });
});
