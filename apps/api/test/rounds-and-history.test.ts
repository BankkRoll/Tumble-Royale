/**
 * Shared-round slots and paged lists: taken-down rounds stop using a share
 * slot, the per-account cap holds under concurrent shares, match history
 * pages without gaps, and the moderation list has a stable order.
 */
import { randomInt } from 'node:crypto';
import { CUSTOM_ROUND_LIMITS, randomShareCode, starterRound } from '@tumble/content/custom';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customRounds } from '../src/db/schema.ts';
import { ADMIN_TOKEN, buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';
import { holdLocks, postgresUrl, waitForLockWaiters } from './pglocks.ts';

describe.each(BACKENDS)('shared rounds and history ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2026-10-06T12:00:00.000Z', backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  const publish = (u: TestUser) =>
    api.req('POST', '/custom-rounds', {
      token: u.accessToken,
      body: { round: starterRound(), description: 'A short hop' },
    });

  /** Fills an account's slots up to `n` rounds with the given status. */
  async function fill(u: TestUser, n: number, status = 'published'): Promise<void> {
    const first = await publish(u);
    expect(first.statusCode, first.body).toBe(201);
    const [row] = await api.ctx.db.select().from(customRounds).where(eq(customRounds.ownerId, u.id));
    if (n <= 1) return;
    await api.ctx.db.insert(customRounds).values(
      Array.from({ length: n - 1 }, (_, i) => ({
        code: randomShareCode(randomInt),
        ownerId: u.id,
        name: `Filler ${i}`,
        roundType: 'race',
        definition: row!.definition as object,
        sizeBytes: 10,
        status,
      })),
    );
  }

  it('frees a share slot when moderators take a round down', async () => {
    const u = await api.account();
    await fill(u, CUSTOM_ROUND_LIMITS.maxPerAccount);
    expect((await publish(u)).json().error).toBe('round_limit');
    const [one] = await api.ctx.db.select().from(customRounds).where(eq(customRounds.ownerId, u.id)).limit(1);
    const down = await api.req('POST', `/internal/custom-rounds/${one!.code}/takedown`, {
      token: ADMIN_TOKEN,
      body: { reason: 'Offensive text' },
    });
    expect(down.statusCode, down.body).toBe(200);
    expect((await publish(u)).statusCode).toBe(201);
    const mine = (await api.req('GET', '/custom-rounds/mine', { token: u.accessToken })).json().rounds as {
      status: string;
    }[];
    expect(mine).toHaveLength(CUSTOM_ROUND_LIMITS.maxPerAccount + 1);
    expect(mine.at(-1)!.status).toBe('taken_down');
  });

  it('keeps the share cap when two shares race for the last slot', async () => {
    const u = await api.account();
    await fill(u, CUSTOM_ROUND_LIMITS.maxPerAccount - 1);
    const url = postgresUrl(api);
    const held = url
      ? await holdLocks(url, [['select pg_advisory_xact_lock(hashtext($1))', [`custom-rounds:${u.id}`]]])
      : null;
    const racing = [publish(u), publish(u)];
    if (url && held) {
      await waitForLockWaiters(url, 2);
      await held.release();
    }
    const codes = (await Promise.all(racing)).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
  });

  it('pages through match history without gaps or repeats', async () => {
    const u = await api.guest();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = buildShow({
        humans: [{ userId: u.id, placement: 10 }],
        startIso: new Date(Date.parse('2026-10-06T10:00:00.000Z') + i * 60_000).toISOString(),
      });
      expect((await api.postMatch(m)).statusCode).toBe(200);
      ids.unshift(m.matchId);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/me/matches?limit=2${cursor ? `&before=${cursor}` : ''}`;
      const j = (await api.req('GET', url, { token: u.accessToken })).json();
      seen.push(...(j.matches as { id: string }[]).map((m) => m.id));
      cursor = j.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
  });

  it('lists shared rounds for moderators in a stable order when they share a timestamp', async () => {
    const u = await api.account();
    await fill(u, 3);
    await api.ctx.db
      .update(customRounds)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(customRounds.ownerId, u.id));
    const list = async () =>
      (
        (await api.req('GET', '/internal/custom-rounds?limit=200', { token: ADMIN_TOKEN })).json().rounds as {
          code: string;
          ownerId: string;
        }[]
      )
        .filter((r) => r.ownerId === u.id)
        .map((r) => r.code);
    const first = await list();
    expect(first).toHaveLength(3);
    expect(await list()).toEqual(first);
    const [row] = await api.ctx.db.select().from(customRounds).where(eq(customRounds.code, first[0]!));
    const others = await api.ctx.db.select().from(customRounds).where(eq(customRounds.ownerId, u.id));
    expect(others.every((o) => o.id <= row!.id)).toBe(true);
  });
});
