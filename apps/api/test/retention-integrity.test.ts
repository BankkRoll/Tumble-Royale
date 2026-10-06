/**
 * Data the retention job now ages out, and the catalog sync: expired club
 * kicks, handled club reports, shows past the history window (with their
 * rank history and event credits), leaderboards of past weeks, metrics for
 * every kind, refusing reports too old to recognise as replays, invites
 * whose officer is gone, and catalog rows content no longer has.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncCatalog } from '../src/app.ts';
import {
  challenges,
  clubInvites,
  clubKicks,
  clubReports,
  cosmeticsCatalog,
  eventMatchCredits,
  matches,
  rankHistory,
  users,
} from '../src/db/schema.ts';
import { boardKey } from '../src/leaderboards/service.ts';
import { MATCH_HISTORY_RETENTION_DAYS } from '../src/matches/ingest.ts';
import { CLUB_REPORT_RETENTION_DAYS } from '../src/ops/retention.ts';
import { createClub, player } from './clubHelpers.ts';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const DAY = 86_400_000;

describe.each(BACKENDS)('retention ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2027-12-15T12:00:00.000Z', backend.env, { memoryKv: true });
  });
  afterAll(async () => {
    await api.close();
  });
  const ago = (days: number) => new Date(api.clock.now().getTime() - days * DAY);

  it('ages out kicks, handled reports, old shows and past boards, and counts each kind', async () => {
    const owner = await player(api);
    const kicked = await player(api);
    const club = await createClub(api, owner);
    await api.ctx.db.insert(clubKicks).values([
      { clubId: club.id, userId: kicked.id, until: ago(1) },
      { clubId: club.id, userId: owner.id, until: new Date(api.clock.now().getTime() + DAY) },
    ]);
    const report = (status: string, days: number) => ({
      reporterId: owner.id,
      clubId: club.id,
      reason: 'name',
      snapshot: {},
      status,
      createdAt: ago(days),
    });
    await api.ctx.db
      .insert(clubReports)
      .values([
        report('resolved', CLUB_REPORT_RETENTION_DAYS + 1),
        report('open', CLUB_REPORT_RETENTION_DAYS + 1),
        report('dismissed', 1),
      ]);

    const show = (id: string, days: number, seasonId: string) => ({
      id,
      queue: 'ranked',
      playlistId: 'ranked',
      seasonId,
      region: 'na',
      playerCount: 1,
      botCount: 0,
      startedAt: ago(days),
      endedAt: ago(days),
      rewards: [],
    });
    const live = api.ctx.catalog.season.id;
    await api.ctx.db
      .insert(matches)
      .values([show('m_old_show', MATCH_HISTORY_RETENTION_DAYS + 5, 's1'), show('m_new_show', 3, live)]);
    const rank = (matchId: string) => ({
      userId: owner.id,
      seasonId: 's1',
      queue: 'ranked',
      matchId,
      placement: 1,
      muBefore: 25,
      muAfter: 26,
      sigmaBefore: 8,
      sigmaAfter: 7,
      rpBefore: 0,
      rpAfter: 10,
      tier: 'bronze',
      division: 3,
    });
    await api.ctx.db.insert(rankHistory).values([rank('m_old_show'), rank('m_new_show')]);
    await api.ctx.db.insert(eventMatchCredits).values([
      { userId: owner.id, eventId: 'e', matchId: 'm_old_show', points: 1 },
      { userId: owner.id, eventId: 'e', matchId: 'm_new_show', points: 1 },
    ]);

    const oldWeek = boardKey(api.ctx, 'crowns_weekly', 'global', { at: ago(21) });
    const thisWeek = boardKey(api.ctx, 'crowns_weekly', 'global');
    await api.ctx.kv.zadd(oldWeek, 1, owner.id);
    await api.ctx.kv.zadd(thisWeek, 1, owner.id);

    const r = await api.ops.runRetention();
    expect(r).toMatchObject({ ran: true, clubKicks: 1, clubReports: 1, matches: 1 });
    expect(r.boards).toBeGreaterThan(0);

    const kicks = await api.ctx.db.select().from(clubKicks).where(eq(clubKicks.clubId, club.id));
    expect(kicks.map((k) => k.userId)).toEqual([owner.id]);
    const reports = await api.ctx.db.select().from(clubReports).where(eq(clubReports.clubId, club.id));
    expect(reports.map((x) => x.status).sort()).toEqual(['dismissed', 'open']);
    const left = await api.ctx.db
      .select({ id: matches.id })
      .from(matches)
      .where(inArray(matches.id, ['m_old_show', 'm_new_show']));
    expect(left.map((m) => m.id)).toEqual(['m_new_show']);
    expect(
      (await api.ctx.db.select().from(rankHistory).where(eq(rankHistory.userId, owner.id))).map(
        (x) => x.matchId,
      ),
    ).toEqual(['m_new_show']);
    expect(
      (await api.ctx.db.select().from(eventMatchCredits).where(eq(eventMatchCredits.userId, owner.id))).map(
        (x) => x.matchId,
      ),
    ).toEqual(['m_new_show']);
    expect(await api.ctx.kv.zscore(oldWeek, owner.id)).toBeNull();
    expect(await api.ctx.kv.zscore(thisWeek, owner.id)).toBe(1);

    const metrics = (await api.req('GET', '/metrics')).body;
    for (const kind of ['clubMessages', 'gifts', 'clubKicks', 'clubReports', 'matches', 'boards'])
      expect(metrics).toContain(`tumble_retention_deleted_total{kind="${kind}"}`);
  });

  it('refuses a show report older than the history window', async () => {
    const u = await api.guest();
    const m = buildShow({
      humans: [{ userId: u.id, placement: 1 }],
      startIso: ago(MATCH_HISTORY_RETENTION_DAYS + 2).toISOString(),
    });
    const res = await api.postMatch(m);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('result_too_old');
  });

  it('never leaves an invite naming an inviter whose account is gone', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    const invite = async () => {
      const officer = await player(api);
      const invitee = await player(api);
      await api.ctx.db
        .insert(clubInvites)
        .values({ clubId: club.id, userId: invitee.id, kind: 'invite', invitedBy: officer.id });
      const find = async () =>
        (await api.ctx.db.select().from(clubInvites).where(eq(clubInvites.userId, invitee.id)))[0];
      return { officer, find };
    };
    // Account deletion takes the invites the officer sent with it.
    const a = await invite();
    const del = await api.req('DELETE', '/me', { token: a.officer.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode, del.body).toBe(204);
    expect(await a.find()).toBeUndefined();
    // Any other way the user row goes, the foreign key clears the inviter.
    const b = await invite();
    await api.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('tumble.erase_user', ${b.officer.id}, true)`);
      await tx.delete(users).where(eq(users.id, b.officer.id));
    });
    expect(await b.find()).toMatchObject({ kind: 'invite', invitedBy: null });
  });

  it('marks catalog rows content no longer has as inactive', async () => {
    await api.ctx.db.insert(cosmeticsCatalog).values({
      id: 'hat.retired',
      name: 'Retired Hat',
      slot: 'headwear',
      rarity: 'common',
      source: 'store',
    });
    await api.ctx.db.insert(challenges).values({
      id: 'd-retired',
      period: 'daily',
      title: 'Retired',
      metric: 'showsPlayed',
      target: 1,
      rewardXp: 1,
    });
    await syncCatalog(api.ctx);
    const [hat] = await api.ctx.db
      .select()
      .from(cosmeticsCatalog)
      .where(eq(cosmeticsCatalog.id, 'hat.retired'));
    expect(hat!.active).toBe(false);
    const [ch] = await api.ctx.db.select().from(challenges).where(eq(challenges.id, 'd-retired'));
    expect(ch!.active).toBe(false);
    const live = await api.ctx.db
      .select()
      .from(cosmeticsCatalog)
      .where(eq(cosmeticsCatalog.id, api.ctx.catalog.cosmetics[0]!.id));
    expect(live[0]!.active).toBe(true);
  });
});
