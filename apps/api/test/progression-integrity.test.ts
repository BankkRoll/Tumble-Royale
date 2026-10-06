/**
 * Progression, leaderboards and match ingest under retention, races, late
 * results and partial failures: the tutorial reward survives event pruning,
 * custom lobbies keep the first-show bonus, daily rerolls and match progress
 * cannot step on each other, finished challenges pay after their period ends,
 * Crown League shows up, leaderboards are idempotent and partitioned by the
 * show, a failed leaderboard write is finished by the retry, and deleted
 * players vanish from stored rewards, report evidence and every board.
 *
 * Races only reproduce on real Postgres; there the tests hold locks on a
 * connection of their own (`pglocks.ts`) to force the interleaving. On PGlite
 * the same requests run in order and must give the same answer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELETED_PLAYER_NAME } from '../src/accounts/erase.ts';
import {
  challengeProgress,
  clubReports,
  events,
  matches,
  matchParticipants,
  profiles,
  ratings,
} from '../src/db/schema.ts';
import { boardKey, compareEntries, recordLeaderboards } from '../src/leaderboards/service.ts';
import { TUTORIAL_GRANT_EVENT } from '../src/progression/tutorial.ts';
import { TIER_WIDTH } from '../src/ranked/tiers.ts';
import { createClub, joinClub, player } from './clubHelpers.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';
import { holdLocks, postgresUrl, waitForLockWaiters } from './pglocks.ts';

interface BoardRow {
  id: string;
  challengeId: string;
  metric: string | null;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  rerolled: boolean;
}

describe.each(BACKENDS)('progression integrity ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2026-11-10T12:00:00.000Z', backend.env);
  });
  afterAll(async () => {
    await api.close();
  });
  const pgOnly = () => postgresUrl(api);

  let ipNo = 0;
  async function relog(u: TestUser): Promise<void> {
    ipNo++;
    const r = await api.req('POST', '/auth/refresh', {
      body: { refreshToken: u.refreshToken },
      ip: `10.77.${Math.floor(ipNo / 250)}.${ipNo % 250}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    u.accessToken = r.json().accessToken;
    u.refreshToken = r.json().refreshToken;
  }
  const board = async (u: TestUser) =>
    (await api.req('GET', '/challenges', { token: u.accessToken })).json() as {
      daily: BoardRow[];
      settled: { id: string; period: string; gumballs: number }[];
    };
  const show = (u: TestUser, placement: number, over: Parameters<typeof buildShow>[0] = { humans: [] }) =>
    buildShow({
      startIso: new Date(api.clock.now().getTime() - 10 * 60_000).toISOString(),
      ...over,
      humans: [{ userId: u.id, placement }],
    });
  const lb = async (u: TestUser, type: string, scope = 'global') =>
    (await api.req('GET', `/leaderboards/${type}?scope=${scope}`, { token: u.accessToken })).json() as {
      entries: { userId: string; score: number; rank: number }[];
      me: { score: number; rank: number } | null;
    };

  // ---------------------------------------------------------------------------
  // Tutorial (P1)
  // ---------------------------------------------------------------------------

  it('grants the tutorial reward once even after its analytics event is pruned', async () => {
    const u = await api.guest();
    expect((await api.req('POST', '/me/tutorial-complete', { token: u.accessToken })).json().granted).toBe(
      true,
    );
    await api.ctx.db.delete(events).where(eq(events.userId, u.id));
    const again = await api.req('POST', '/me/tutorial-complete', { token: u.accessToken });
    expect(again.json()).toMatchObject({ granted: false, xp: 0 });
  });

  it('backfills the tutorial grant from existing event rows', async () => {
    const u = await api.guest();
    await api.ctx.db
      .insert(events)
      .values({ userId: u.id, name: TUTORIAL_GRANT_EVENT, createdAt: new Date('2026-01-02T03:04:05Z') });
    const file = fileURLToPath(
      new URL('../drizzle/0015_payment_snapshot_tutorial_grant.sql', import.meta.url),
    );
    const backfill = readFileSync(file, 'utf8').split('--> statement-breakpoint').at(-1)!;
    await api.ctx.db.execute(sql.raw(backfill));
    const [p] = await api.ctx.db.select().from(profiles).where(eq(profiles.userId, u.id));
    expect(p!.tutorialGrantedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect((await api.req('POST', '/me/tutorial-complete', { token: u.accessToken })).json().granted).toBe(
      false,
    );
  });

  // ---------------------------------------------------------------------------
  // First show of the day (P4)
  // ---------------------------------------------------------------------------

  it('keeps the first-show-of-day bonus after a custom lobby', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 5, { queue: 'custom', humans: [] }));
    const res = await api.postMatch(show(u, 5));
    const lines = res.json().rewards[0].xp.lines as { label: string }[];
    expect(lines.map((l) => l.label)).toContain('First show of the day');
  });

  // ---------------------------------------------------------------------------
  // Rerolls (P5 / M2, P6)
  // ---------------------------------------------------------------------------

  it('allows one reroll a day even when two race', async () => {
    const u = await api.guest();
    const [a, b] = (await board(u)).daily;
    const reroll = (id: string) =>
      api.req('POST', '/challenges/reroll', { token: u.accessToken, body: { id } });
    const url = pgOnly();
    const held = url
      ? await holdLocks(url, [['select 1 from challenge_progress where id = $1 for update', [a!.id]]])
      : null;
    const racing = [reroll(a!.id), reroll(b!.id)];
    if (url && held) {
      await waitForLockWaiters(url, 2);
      await held.release();
    }
    const results = await Promise.all(racing);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await board(u)).daily.filter((r) => r.rerolled)).toHaveLength(1);
  });

  it('never credits a show to the challenge a concurrent reroll swapped in', async () => {
    const url = pgOnly();
    if (!url) return;
    const u = await api.guest();
    const daily = (await board(u)).daily;
    const counted = daily.find(
      (r) => r.metric === 'showsPlayed' || r.metric === 'dives' || r.metric === 'jumps',
    );
    if (!counted) return;
    const replacement = api.ctx.catalog.challenges.find(
      (c) => c.period === 'daily' && !daily.some((r) => r.challengeId === c.id),
    )!;
    const reroll = await holdLocks(url, [
      ['select 1 from challenge_progress where id = $1 for update', [counted.id]],
    ]);
    const ingest = api.postMatch(show(u, 3));
    await waitForLockWaiters(url, 1);
    await reroll.query(
      'update challenge_progress set challenge_id = $2, target = $3, progress = 0, rerolled = true where id = $1',
      [counted.id, replacement.id, replacement.target],
    );
    await reroll.commit();
    expect((await ingest).statusCode).toBe(200);
    const [row] = await api.ctx.db
      .select()
      .from(challengeProgress)
      .where(eq(challengeProgress.id, counted.id));
    expect(row).toMatchObject({ challengeId: replacement.id, progress: 0, completedAt: null });
  });

  // ---------------------------------------------------------------------------
  // Settling ended periods (P7)
  // ---------------------------------------------------------------------------

  it('pays a daily challenge finished but not claimed before the day ended', async () => {
    const u = await api.guest();
    const [row] = (await board(u)).daily;
    await api.ctx.db
      .update(challengeProgress)
      .set({ progress: row!.target, completedAt: api.clock.now() })
      .where(eq(challengeProgress.id, row!.id));
    const before = api.clock.now().getTime();
    api.clock.set(new Date(before + 86_400_000).toISOString());
    try {
      await relog(u);
      const next = await board(u);
      expect(next.settled.map((s) => [s.id, s.period])).toContainEqual([row!.id, 'daily']);
      const [paid] = await api.ctx.db
        .select()
        .from(challengeProgress)
        .where(eq(challengeProgress.id, row!.id));
      expect(paid!.claimedAt).not.toBeNull();
      expect((await board(u)).settled).toEqual([]);
    } finally {
      api.clock.set(new Date(before).toISOString());
      await relog(u);
    }
  });

  // ---------------------------------------------------------------------------
  // Crown League (P8)
  // ---------------------------------------------------------------------------

  it('shows Crown League to Champions at the top of their region', async () => {
    const u = await api.guest();
    const champion = TIER_WIDTH * 5 + 100;
    await api.ctx.db.insert(ratings).values({
      userId: u.id,
      seasonId: api.ctx.catalog.season.id,
      queue: 'ranked',
      mu: 40,
      sigma: 1,
      rp: champion,
      tier: 'champion',
      division: 3,
      placementsLeft: 0,
    });
    const card = (await api.req('GET', `/profile/${u.id}`, { token: u.accessToken })).json();
    expect(card.ranked[0]).toMatchObject({ tier: 'crown_league', rp: champion });
    const res = await api.postMatch(show(u, 1, { queue: 'ranked', humans: [] }));
    expect(res.json().rewards[0].ranked).toMatchObject({
      tierAfter: { tier: 'crown_league' },
      label: 'CROWN LEAGUE',
    });
  });

  // ---------------------------------------------------------------------------
  // Leaderboards (P2, P3, P11, P12, P13, P14, P15)
  // ---------------------------------------------------------------------------

  it('rebuilds crown boards without custom-lobby crowns or double-counted shard Crowns', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    await api.postMatch(show(u, 1, { queue: 'custom', humans: [] }));
    // Shard Crowns count toward the all-time board once, however it was built.
    await api.ctx.db
      .update(profiles)
      .set({ crownShards: api.ctx.catalog.shardsPerCrown - 1 })
      .where(eq(profiles.userId, u.id));
    for (const type of ['crowns', 'crowns_weekly', 'crowns_all_time'] as const) {
      const key = boardKey(api.ctx, type, 'global');
      await api.ctx.kv.del(key, `${key}:built`);
    }
    await api.postMatch(show(u, 1));
    const [p] = await api.ctx.db.select().from(profiles).where(eq(profiles.userId, u.id));
    expect((await lb(u, 'crowns_all_time')).me?.score).toBe(p!.crowns);
    expect((await lb(u, 'crowns')).me?.score).toBe(2);
    expect((await lb(u, 'crowns_weekly')).me?.score).toBe(2);
  });

  it('writes the same scores however often a show is recorded', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, 1));
    const update = {
      userId: u.id,
      region: 'na',
      boards: ['crowns', 'crowns_all_time', 'win_streak'] as const,
    };
    await recordLeaderboards(api.ctx, { ...update, boards: [...update.boards] });
    await recordLeaderboards(api.ctx, { ...update, boards: [...update.boards] });
    expect((await lb(u, 'crowns')).me?.score).toBe(1);
    expect((await lb(u, 'crowns_all_time')).me?.score).toBe(1);
  });

  it('finishes a failed leaderboard write when the game server retries the report', async () => {
    const u = await api.guest();
    const m = show(u, 1);
    const spy = vi.spyOn(api.ctx.kv, 'zadd').mockRejectedValue(new Error('kv down'));
    try {
      expect((await api.postMatch(m)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect((await lb(u, 'crowns')).entries.some((e) => e.userId === u.id)).toBe(false);
    const retry = await api.postMatch(m);
    expect(retry.json().alreadyProcessed).toBe(true);
    expect((await lb(u, 'crowns')).me?.score).toBe(1);
  });

  it('files a late show on the week and season it was played in', async () => {
    const u = await api.guest();
    const lastWeek = new Date(api.clock.now().getTime() - 7 * 86_400_000);
    const late = buildShow({
      startIso: lastWeek.toISOString(),
      humans: [{ userId: u.id, placement: 1 }],
    });
    late.seasonId = 's0-old';
    expect((await api.postMatch(late)).statusCode).toBe(200);
    expect((await lb(u, 'crowns_weekly')).entries.some((e) => e.userId === u.id)).toBe(false);
    expect((await lb(u, 'crowns')).entries.some((e) => e.userId === u.id)).toBe(false);
    const oldWeek = await api.ctx.kv.zscore(
      boardKey(api.ctx, 'crowns_weekly', 'global', { at: lastWeek }),
      u.id,
    );
    expect(oldWeek).toBe(1);
    const oldSeason = await api.ctx.kv.zscore(
      boardKey(api.ctx, 'crowns', 'global', { seasonId: 's0-old' }),
      u.id,
    );
    expect(oldSeason).toBe(1);
  });

  it('orders ties the same way on friends and global boards', () => {
    const rows = [
      { userId: 'a', score: 3 },
      { userId: 'c', score: 3 },
      { userId: 'b', score: 5 },
    ];
    expect([...rows].sort(compareEntries).map((r) => r.userId)).toEqual(['b', 'c', 'a']);
  });

  // ---------------------------------------------------------------------------
  // Deleted players (P9, P16, cross-cutting 1 and 2)
  // ---------------------------------------------------------------------------

  it('scrubs a deleted player from stored rewards, club report evidence and every board', async () => {
    const owner = await player(api);
    const gone = await player(api);
    const club = await createClub(api, owner);
    await joinClub(api, gone, club.id);
    const other = await api.guest();
    const m = buildShow({
      startIso: new Date(api.clock.now().getTime() - 600_000).toISOString(),
      humans: [
        { userId: gone.id, placement: 1 },
        { userId: other.id, placement: 2 },
      ],
    });
    await api.postMatch(m);
    const line = (userId: string, text: string) => ({
      id: text,
      clubId: club.id,
      from: { userId, name: 'X', tag: '0001' },
      text,
      at: 1,
    });
    await api.ctx.db.insert(clubReports).values({
      reporterId: owner.id,
      clubId: club.id,
      reason: 'chat',
      snapshot: {},
      evidence: [line(gone.id, 'mine'), line(owner.id, 'theirs')],
    });
    // A region the player is not in, and last week's board, still hold them.
    const elsewhere = boardKey(api.ctx, 'crowns', 'eu');
    await api.ctx.kv.zadd(elsewhere, 1, gone.id);
    const lastWeek = boardKey(api.ctx, 'crowns_weekly', 'global', {
      at: new Date(api.clock.now().getTime() - 7 * 86_400_000),
    });
    await api.ctx.kv.zadd(lastWeek, 1, gone.id);

    const del = await api.req('DELETE', '/me', { token: gone.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode, del.body).toBe(204);

    const [stored] = await api.ctx.db.select().from(matches).where(eq(matches.id, m.matchId));
    expect((stored!.rewards as { userId: string }[]).map((r) => r.userId)).toEqual([other.id]);
    const [report] = await api.ctx.db.select().from(clubReports).where(eq(clubReports.clubId, club.id));
    expect((report!.evidence as { text: string }[]).map((l) => l.text)).toEqual(['theirs']);
    expect(await api.ctx.kv.zscore(elsewhere, gone.id)).toBeNull();
    expect(await api.ctx.kv.zscore(lastWeek, gone.id)).toBeNull();

    // A result for the deleted account arriving late keeps it anonymous.
    const late = buildShow({ humans: [{ userId: gone.id, placement: 3 }] });
    expect((await api.postMatch(late)).statusCode).toBe(200);
    const [anon] = await api.ctx.db
      .select()
      .from(matchParticipants)
      .where(and(eq(matchParticipants.matchId, late.matchId), eq(matchParticipants.placement, 3)));
    expect(anon).toMatchObject({ userId: null, name: DELETED_PLAYER_NAME });
  });
});
