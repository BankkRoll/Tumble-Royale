/**
 * Weekly club goals: progress from the match ingest (idempotent per match,
 * custom lobbies excluded), member-scaled targets, claims by contributors
 * only, week-end settlement, the contribution board and the one-reward-per-
 * week rule that stops club hopping.
 * Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUB_GOALS, clubGoalTarget } from '@tumble/shared';
import { clubContributions, clubGoalProgress, currenciesLedger } from '../src/db/schema.ts';
import { isoWeekKey } from '../src/util/time.ts';
import { createClub, joinClub, myClub, player, type Account } from './clubHelpers.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

type Goal = { goalId: string; progress: number; target: number; completed: boolean; claimed: boolean };

describe.each(BACKENDS)('club goals ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(undefined, backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  const goals = async (u: TestUser) => {
    const res = await api.req('GET', '/clubs/me/goals', { token: u.accessToken });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      week: string;
      eligible: boolean;
      goals: Goal[];
      contributions: { userId: string; shows: number; crowns: number; rounds: number }[];
      settled: { goalId: string; week: string; auto: boolean }[];
    };
  };
  const goal = async (u: TestUser, id: string) => (await goals(u)).goals.find((g) => g.goalId === id)!;
  const claim = (u: TestUser, week: string, goalId: string) =>
    api.req('POST', '/clubs/me/goals/claim', { token: u.accessToken, body: { week, goalId } });

  /** One show: `winner` first, `runner` second. */
  const show = async (winner: TestUser, runner: TestUser, queue: 'casual' | 'custom' = 'casual') => {
    const m = buildShow({
      queue,
      humans: [
        { userId: winner.id, placement: 1 },
        { userId: runner.id, placement: 2 },
      ],
    });
    const res = await api.postMatch(m);
    expect(res.statusCode, res.body).toBe(200);
    return { match: m, body: res.json() };
  };

  async function clubOfTwo(): Promise<{ id: string; a: Account; b: Account }> {
    const a = await player(api);
    const b = await player(api);
    const club = await createClub(api, a);
    await joinClub(api, b, club.id);
    return { id: club.id, a, b };
  }

  it('counts granting shows once and ignores custom lobbies', async () => {
    const { a, b } = await clubOfTwo();
    const shows = CLUB_GOALS.find((g) => g.id === 'shows')!;
    const { match, body } = await show(a, b);
    const mine = body.rewards.find((r: { userId: string }) => r.userId === a.id);
    expect(mine.club.goals).toContainEqual(
      expect.objectContaining({ goalId: 'shows', before: 0, progress: 1 }),
    );
    expect(await goal(a, 'shows')).toMatchObject({ progress: 2, target: clubGoalTarget(shows, 2) });

    const replay = await api.postMatch(match);
    expect(replay.json().alreadyProcessed).toBe(true);
    await show(a, b, 'custom');
    expect((await goal(a, 'shows')).progress).toBe(2);
    const board = (await goals(b)).contributions;
    expect(board.map((r) => r.userId)).toEqual([a.id, b.id]);
    expect(board[0]).toMatchObject({ shows: 1, crowns: 1, rounds: 4 });
    expect(board[1]).toMatchObject({ shows: 1, crowns: 0, rounds: 3 });
  });

  it('pays contributors once and refuses members who did not play', async () => {
    const { a, b } = await clubOfTwo();
    const idle = await player(api);
    await joinClub(api, idle, (await myClub(api, a)).club.id);
    const { week } = await goals(a);
    expect((await claim(a, week, 'crowns')).json().error).toBe('not_completed');
    await show(a, b);
    await show(b, a);
    expect(await goal(a, 'crowns')).toMatchObject({ completed: true, claimed: false });

    const paid = await claim(b, week, 'crowns');
    expect(paid.statusCode, paid.body).toBe(200);
    const crowns = CLUB_GOALS.find((g) => g.id === 'crowns')!;
    expect(paid.json().payout).toMatchObject({
      xp: crowns.rewardXp,
      gumballs: crowns.rewardGumballs,
      auto: false,
    });
    expect((await claim(b, week, 'crowns')).json().error).toBe('already_claimed');
    const lazy = await claim(idle, week, 'crowns');
    expect(lazy.statusCode).toBe(403);
    expect(lazy.json().error).toBe('not_eligible');
    expect((await goals(idle)).eligible).toBe(false);

    const ledger = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, b.id), eq(currenciesLedger.reason, 'club_reward')));
    const clubId = (await myClub(api, b)).club.id as string;
    expect(ledger.map((l) => l.ref)).toEqual([`club:${clubId}:${week}:crowns`]);
  });

  it('settles unclaimed goals of past weeks for members still in the club', async () => {
    const { id, a, b } = await clubOfTwo();
    await show(a, b);
    await show(a, b);
    const week = isoWeekKey(api.clock.now());
    // "Next week" by moving the club's week back: advancing the clock would expire the access tokens.
    const past = '2020-W01';
    await api.ctx.db.update(clubGoalProgress).set({ week: past }).where(eq(clubGoalProgress.clubId, id));
    await api.ctx.db.update(clubContributions).set({ week: past }).where(eq(clubContributions.clubId, id));
    const view = await goals(a);
    expect(view.settled).toEqual([expect.objectContaining({ goalId: 'crowns', week: past, auto: true })]);
    expect((await goals(a)).settled).toEqual([]);
    // B left before the settlement, so the reward is forfeit.
    expect((await api.req('POST', '/clubs/me/leave', { token: b.accessToken })).statusCode).toBe(204);
    expect(view.week).toBe(week);
  });

  it('pays a goal once per week however many clubs a player hops through', async () => {
    const first = await clubOfTwo();
    await show(first.a, first.b);
    await show(first.a, first.b);
    const week = isoWeekKey(api.clock.now());
    expect((await claim(first.a, week, 'crowns')).statusCode).toBe(200);

    expect((await api.req('POST', '/clubs/me/leave', { token: first.a.accessToken })).statusCode).toBe(204);
    const second = await clubOfTwo();
    await joinClub(api, first.a, second.id);
    await show(first.a, second.b);
    await show(first.a, second.b);
    expect((await goal(first.a, 'crowns')).completed).toBe(true);
    const twice = await claim(first.a, week, 'crowns');
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe('already_claimed');
    expect((await claim(second.b, week, 'crowns')).statusCode).toBe(200);
  });

  it('fixes the target when the week starts counting', async () => {
    const { a, b } = await clubOfTwo();
    await show(a, b);
    const before = (await goal(a, 'qualify')).target;
    const more = await player(api);
    await joinClub(api, more, (await myClub(api, a)).club.id);
    expect((await goal(a, 'qualify')).target).toBe(before);
  });
});
