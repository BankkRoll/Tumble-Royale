/**
 * Friend requests sent both ways at once settle into one friendship, and a
 * blocked pair cannot read each other's profile card.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbOrTx } from '../src/db/client.ts';
import { lockXact } from '../src/db/locks.ts';
import { friendships } from '../src/db/schema.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

const post = (u: TestUser, url: string, body: unknown) =>
  api.req('POST', url, { token: u.accessToken, body });

describe('mutual friend requests', () => {
  it('end as one accepted friendship when both players ask at once', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await api.guest();
      const b = await api.guest();
      const results = await Promise.all([
        post(a, '/friends/request', { userId: b.id }),
        post(b, '/friends/request', { userId: a.id }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(results.map((r) => r.json().status).sort()).toEqual(['accepted', 'pending']);
      const rows = await api.ctx.db
        .select({ status: friendships.status })
        .from(friendships)
        .where(
          or(
            and(eq(friendships.userId, a.id), eq(friendships.friendId, b.id)),
            and(eq(friendships.userId, b.id), eq(friendships.friendId, a.id)),
          ),
        );
      expect(rows).toEqual([{ status: 'accepted' }]);
    }
  });
});

describe('lockXact', () => {
  // NOTE: PGlite runs one transaction at a time, so the race above only bites on Postgres; this checks the lock itself.
  it('holds an advisory lock until the transaction ends', async () => {
    const held = async (db: DbOrTx) => {
      const res = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n;
    };
    const inside = await api.ctx.db.transaction(async (tx) => {
      await lockXact(tx, 'friend-pair', 'a', 'b');
      return held(tx);
    });
    expect(inside).toBeGreaterThan(0);
    expect(await held(api.ctx.db)).toBe(0);
  });
});

describe('profile cards', () => {
  it('read as missing between a blocked pair, in both directions', async () => {
    const a = await api.guest();
    const b = await api.guest();
    const card = (viewer: TestUser, of: TestUser) =>
      api.req('GET', `/profile/${of.id}`, { token: viewer.accessToken });
    expect((await card(b, a)).statusCode).toBe(200);
    expect((await post(a, '/friends/block', { userId: b.id })).statusCode).toBe(200);
    const fromBlocked = await card(b, a);
    expect(fromBlocked.statusCode).toBe(404);
    expect(fromBlocked.json().error).toBe('not_found');
    expect((await card(a, b)).statusCode).toBe(404);
    expect((await api.req('DELETE', `/friends/block/${b.id}`, { token: a.accessToken })).statusCode).toBe(
      204,
    );
    expect((await card(b, a)).statusCode).toBe(200);
  });
});
