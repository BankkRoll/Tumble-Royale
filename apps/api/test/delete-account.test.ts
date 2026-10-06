import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authIdentities,
  currenciesLedger,
  events,
  friendships,
  inventoryItems,
  matchParticipants,
  profiles,
  sessions,
  users,
} from '../src/db/schema.ts';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // Asserts realtime events right after each call: in-process pub/sub delivers synchronously.
  api = await createTestApi(undefined, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await api.req('POST', '/friends/request', {
    token: a.accessToken,
    body: { nameTag: `${b.displayName}#${b.tag}` },
  });
  await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
}

describe('DELETE /me', () => {
  it('requires an explicit confirmation', async () => {
    const u = await api.guest();
    expect((await api.req('DELETE', '/me', { token: u.accessToken })).statusCode).toBe(400);
    expect(
      (await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'yes' } })).statusCode,
    ).toBe(400);
    expect((await api.req('DELETE', '/me', { body: { confirm: 'DELETE' } })).statusCode).toBe(401);
    expect((await api.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(200);
  });

  it('deletes the account and everything it owns', async () => {
    const doomed = await api.guest();
    const friend = await api.guest();
    await befriend(doomed, friend);
    await api.grant(doomed.id, 'gumballs', 50);
    await api.grant(friend.id, 'gumballs', 20);
    const show = buildShow({
      humans: [
        { userId: doomed.id, placement: 1 },
        { userId: friend.id, placement: 2 },
      ],
    });
    expect((await api.postMatch(show)).statusCode).toBe(200);
    const code = (await api.req('POST', '/party', { token: friend.accessToken })).json().party.code;
    await api.req('POST', '/party/join', { token: doomed.accessToken, body: { code } });

    const seen: RealtimeEvent[] = [];
    await api.ctx.kv.subscribe(userChannel(friend.id), (m) => seen.push(JSON.parse(m) as RealtimeEvent));

    const res = await api.req('DELETE', '/me', { token: doomed.accessToken, body: { confirm: 'DELETE' } });
    expect(res.statusCode).toBe(204);

    const db = api.ctx.db;
    for (const [table, col] of [
      [users, users.id],
      [profiles, profiles.userId],
      [sessions, sessions.userId],
      [authIdentities, authIdentities.userId],
      [inventoryItems, inventoryItems.userId],
      [currenciesLedger, currenciesLedger.userId],
      [matchParticipants, matchParticipants.userId],
    ] as const) {
      expect(await db.select().from(table).where(eq(col, doomed.id))).toHaveLength(0);
    }
    expect(await db.select().from(friendships).where(eq(friendships.friendId, doomed.id))).toHaveLength(0);
    // Other players' history and balances are untouched; the deleted player is anonymised.
    const history = (await api.req('GET', `/matches/${show.matchId}`, { token: friend.accessToken })).json();
    expect(history.participants[0]).toMatchObject({ userId: null, name: 'Deleted player', placement: 1 });
    expect(
      await db.select().from(currenciesLedger).where(eq(currenciesLedger.userId, friend.id)),
    ).not.toHaveLength(0);
    await expect(db.execute(sql`delete from currencies_ledger`)).rejects.toThrow();

    const [audit] = await db.select().from(events).where(eq(events.name, 'audit.account_deleted'));
    expect(audit).toMatchObject({ userId: doomed.id });

    await vi.waitFor(() => expect(seen).toContainEqual({ type: 'friend_removed', userId: doomed.id }));
    const party = (await api.req('GET', '/party', { token: friend.accessToken })).json().party;
    expect(party.members.map((m: { userId: string }) => m.userId)).toEqual([friend.id]);
    const board = (await api.req('GET', '/leaderboards/crowns', { token: friend.accessToken })).json();
    expect(board.entries.some((e: { userId: string }) => e.userId === doomed.id)).toBe(false);
  });

  it('revokes sessions and outstanding access tokens', async () => {
    const u = await api.guest();
    await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect((await api.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(401);
    expect(
      (await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).statusCode,
    ).toBe(401);
    const lookup = await api.internal('/internal/bans/lookup', { userIds: [u.id] });
    expect(lookup.json().bans[u.id]).toEqual([expect.objectContaining({ scope: 'all' })]);
    // The old device token no longer finds the account; a fresh guest is created instead.
    const again = await api.req('POST', '/auth/guest', { body: { deviceToken: u.deviceToken } });
    expect(again.json()).toMatchObject({ created: true });
    expect(again.json().user.id).not.toBe(u.id);
  });
});
