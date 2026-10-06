/**
 * Helpers shared by the club suites: aged full accounts, friendships, clubs
 * and filler members for cap tests.
 */
import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { clubMembers, clubs, users } from '../src/db/schema.ts';
import type { TestApi, TestUser } from './helpers.ts';

/** A full account (not a guest). */
export type Account = TestUser & { email: string };

let clubNo = 0;

/** A fresh, valid club name and tag. */
export function freshIdentity(): { name: string; tag: string } {
  clubNo++;
  return { name: `Wobble Crew ${clubNo}${Math.floor(Math.random() * 1000)}`, tag: `W${clubNo % 1000}` };
}

/**
 * Backdates an account so it may found a club (accounts are created with the
 * database clock, the tests run on a fake one).
 */
export async function ageAccount(api: TestApi, userId: string, days = 30): Promise<void> {
  const at = new Date(api.clock.now().getTime() - days * 86_400_000);
  await api.ctx.db.update(users).set({ createdAt: at }).where(eq(users.id, userId));
}

/** A full account old enough to found a club. */
export async function player(api: TestApi): Promise<Account> {
  const a = await api.account();
  await ageAccount(api, a.id);
  return a;
}

/** Makes two players friends. */
export async function befriend(api: TestApi, a: TestUser, b: TestUser): Promise<void> {
  const r = await api.req('POST', '/friends/request', {
    token: a.accessToken,
    body: { nameTag: `${b.displayName}#${b.tag}` },
  });
  expect(r.statusCode).toBe(200);
  expect(
    (await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } })).statusCode,
  ).toBe(200);
}

/** Founds a club owned by `owner`. */
export async function createClub(
  api: TestApi,
  owner: TestUser,
  over: Record<string, unknown> = {},
): Promise<{ id: string; name: string; tag: string }> {
  const res = await api.req('POST', '/clubs', {
    token: owner.accessToken,
    body: { ...freshIdentity(), ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().club;
}

/** Joins an open club. */
export async function joinClub(api: TestApi, u: TestUser, clubId: string): Promise<void> {
  const res = await api.req('POST', `/clubs/${clubId}/join`, { token: u.accessToken });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().status).toBe('joined');
}

/** The caller's club view. */
export async function myClub(api: TestApi, u: TestUser) {
  const res = await api.req('GET', '/clubs/me', { token: u.accessToken });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/**
 * Fills a club with `n` bare accounts straight in the database, for cap tests
 * that would otherwise sign up dozens of players.
 */
export async function fillClub(api: TestApi, clubId: string, n: number): Promise<void> {
  const rows = await api.ctx.db
    .insert(users)
    .values(Array.from({ length: n }, () => ({ isGuest: false })))
    .returning({ id: users.id });
  await api.ctx.db.insert(clubMembers).values(rows.map((r) => ({ userId: r.id, clubId, role: 'member' })));
  await api.ctx.db
    .update(clubs)
    .set({ memberCount: sql`${clubs.memberCount} + ${n}` })
    .where(eq(clubs.id, clubId));
}
