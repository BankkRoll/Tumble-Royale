/**
 * Club chat and moderation: the chat filter, mutes, rate limits and blocks
 * in club chat, chat evidence on player and club reports, the admin
 * console's club routes (authorisation and audit rows), and delivery and
 * sanctions across two API instances sharing one database and KV.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_CLUB_EMBLEM } from '@tumble/shared';
import { sendClubChat } from '../src/clubs/chat.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { adminAuditLog, clubs, reports } from '../src/db/schema.ts';
import { createKV, type KV } from '../src/kv/index.ts';
import { RedisKV } from '../src/kv/redis.ts';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import { createScratchDatabase } from './backing.ts';
import { ageAccount, befriend, createClub, joinClub, myClub, player, type Account } from './clubHelpers.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const START = '2026-10-02T12:00:00.000Z';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(START, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (u: TestUser, method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token: u.accessToken, ...(body !== undefined ? { body } : {}) });
const say = (u: TestUser, text: string) => call(u, 'POST', '/clubs/me/chat', { text });

async function events(u: TestUser): Promise<RealtimeEvent[]> {
  const seen: RealtimeEvent[] = [];
  await api.ctx.kv.subscribe(userChannel(u.id), (m) => seen.push(JSON.parse(m) as RealtimeEvent));
  return seen;
}

async function pair(): Promise<{ id: string; name: string; owner: Account; member: Account }> {
  const owner = await player(api);
  const member = await player(api);
  const club = await createClub(api, owner);
  await joinClub(api, member, club.id);
  return { ...club, owner, member };
}

let ipNo = 0;
async function staff(role: 'admin' | 'moderator'): Promise<string> {
  const u = await api.account();
  await api.req('PUT', `/internal/staff/${u.id}`, { token: ADMIN_TOKEN, body: { role } });
  const res = await api.req('POST', '/admin/session', { token: u.accessToken, ip: `10.250.0.${++ipNo}` });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

describe('club chat', () => {
  it('relays filtered lines to members, keeps history and tags the sender', async () => {
    const c = await pair();
    const seen = await events(c.member);
    const res = await say(c.owner, 'what the fuck, gg');
    expect(res.statusCode, res.body).toBe(200);
    const line = res.json().message;
    expect(line).toMatchObject({ clubId: c.id, text: 'what the fuck, gg' });
    expect(line.masked).toMatch(/^what the \*{4}/);
    expect(line.from).toMatchObject({ userId: c.owner.id, club: (await myClub(api, c.owner)).club.tag });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'club_chat', id: line.id }));
    const history = (await call(c.member, 'GET', '/clubs/me/chat')).json().lines as { id: string }[];
    expect(history.map((l) => l.id)).toEqual([line.id]);
    const outsider = await player(api);
    expect((await say(outsider, 'hi')).statusCode).toBe(404);
    expect((await say(c.owner, '   ')).json().error).toBe('empty_message');
  });

  it('refuses muted members, rate limits and hides blocked senders', async () => {
    const c = await pair();
    for (let i = 0; i < 6; i++) expect((await say(c.member, `line ${i}`)).statusCode).toBe(200);
    expect((await say(c.member, 'one too many')).json().error).toBe('chat_rate');

    const blocker = await player(api);
    await joinClub(api, blocker, c.id);
    const seen = await events(blocker);
    expect((await call(blocker, 'POST', '/friends/block', { userId: c.owner.id })).statusCode).toBe(200);
    await say(c.owner, 'can you see me');
    expect(seen.some((e) => e.type === 'club_chat')).toBe(false);
    const history = (await call(blocker, 'GET', '/clubs/me/chat')).json().lines as {
      from: { userId: string };
    }[];
    expect(history.some((l) => l.from.userId === c.owner.id)).toBe(false);

    await api.ban(c.owner.id, 'chat');
    const muted = await say(c.owner, 'hello?');
    expect(muted.statusCode).toBe(403);
    expect(muted.json().error).toBe('chat_banned');
  });
});

describe('reports', () => {
  it('attaches club chat to a player report only when the reporter shares the club', async () => {
    const c = await pair();
    await say(c.owner, 'rude line here');
    const mine = await call(c.member, 'POST', '/report', { targetUserId: c.owner.id, reason: 'harassment' });
    expect(mine.statusCode).toBe(201);
    const outsider = await player(api);
    const theirs = await call(outsider, 'POST', '/report', {
      targetUserId: c.owner.id,
      reason: 'harassment',
    });
    const rows = await api.ctx.db.select().from(reports).where(eq(reports.targetUserId, c.owner.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mine.json().id)!.evidence).toEqual([
      expect.objectContaining({ channel: 'club', text: 'rude line here', club: c.id }),
    ]);
    expect(byId.get(theirs.json().id)!.evidence).toBeNull();
  });

  it('snapshots a reported club, with chat only for a member reporter', async () => {
    const c = await pair();
    await say(c.owner, 'spammy spam');
    const fromMember = await call(c.member, 'POST', `/clubs/${c.id}/report`, {
      reason: 'chat',
      details: 'spam',
    });
    expect(fromMember.statusCode).toBe(201);
    const outsider = await player(api);
    const fromOutsider = await call(outsider, 'POST', `/clubs/${c.id}/report`, { reason: 'name' });
    expect(fromOutsider.statusCode).toBe(201);
    const mod = await staff('moderator');
    const queue = (await api.req('GET', `/internal/club-reports?clubId=${c.id}`, { token: mod })).json()
      .reports as {
      id: string;
      evidence: unknown;
      snapshot: { name: string };
    }[];
    const one = queue.find((r) => r.id === fromMember.json().id)!;
    expect(one.snapshot.name).toBe(c.name);
    expect(one.evidence).toEqual([expect.objectContaining({ text: 'spammy spam' })]);
    expect(queue.find((r) => r.id === fromOutsider.json().id)!.evidence).toBeNull();
  });
});

describe('admin console: clubs', () => {
  it('is for staff only', async () => {
    const u = await player(api);
    expect((await call(u, 'GET', '/internal/clubs')).statusCode).toBe(401);
    expect((await api.req('GET', '/internal/clubs')).statusCode).toBe(401);
    const mod = await staff('moderator');
    expect((await api.req('GET', '/internal/clubs', { token: mod })).statusCode).toBe(200);
  });

  it('renames, resets, clears and disbands with a reason, each audited in the same breath', async () => {
    const c = await pair();
    const mod = await staff('moderator');
    const act = (path: string, body: unknown) =>
      api.req('POST', `/internal/clubs/${c.id}/${path}`, { token: mod, body });
    await call(c.owner, 'PATCH', '/clubs/me', {
      description: 'a description',
      emblem: { motif: 'waves', primary: '#ff4f9a', secondary: '#ffffff' },
    });
    expect((await act('rename', { name: 'Fine Name', tag: 'FINE' })).statusCode).toBe(400);
    expect((await act('rename', { name: 'Fuck Club', reason: 'offensive name' })).statusCode).toBe(400);
    expect(
      (await act('rename', { name: 'Fine Name', tag: 'FINE', reason: 'offensive name' })).statusCode,
    ).toBe(200);
    const reset = await act('reset-name', { reason: 'offensive again' });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().to.name).toMatch(/^Club [B-Z2-9]{6}$/);
    expect((await act('clear-description', { reason: 'spam link' })).statusCode).toBe(200);
    expect((await act('reset-emblem', { reason: 'rude combination' })).statusCode).toBe(200);
    const [row] = await api.ctx.db.select().from(clubs).where(eq(clubs.id, c.id));
    expect(row).toMatchObject({ description: '', emblem: DEFAULT_CLUB_EMBLEM });

    const page = (await api.req('GET', `/internal/clubs/${c.id}`, { token: mod })).json();
    expect(page.members).toHaveLength(2);
    expect(page.audit.map((a: { action: string }) => a.action)).toEqual([
      'club.reset_emblem',
      'club.clear_description',
      'club.reset_name',
      'club.rename',
    ]);

    const seen = await events(c.member);
    expect((await act('disband', {})).statusCode).toBe(400);
    expect((await act('disband', { reason: 'hate club' })).statusCode).toBe(200);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'club_removed', reason: 'disbanded' }));
    expect((await myClub(api, c.member)).club).toBeNull();
    expect((await act('clear-description', { reason: 'too late' })).json().error).toBe('club_disbanded');
    const audit = await api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, c.id));
    expect(audit.find((a) => a.action === 'club.disband')).toMatchObject({
      reason: 'hate club',
      targetType: 'club',
    });
    const after = (await api.req('GET', `/internal/clubs/${c.id}`, { token: mod })).json();
    expect(after.club.disbandReason).toBe('hate club');
    expect(after.chat).toEqual([]);
  });

  it('closes club reports in bulk with an audit row each', async () => {
    const c = await pair();
    const r1 = (await call(c.member, 'POST', `/clubs/${c.id}/report`, { reason: 'name' })).json()
      .id as string;
    const mod = await staff('moderator');
    const res = await api.req('POST', '/internal/club-reports/action', {
      token: mod,
      body: { reportIds: [r1], action: 'resolve', reason: 'renamed it' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toEqual([r1]);
    const audit = await api.ctx.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'club_report.resolve'));
    expect(audit.some((a) => (a.details as { reportId?: string }).reportId === r1)).toBe(true);
    const listed = (await api.req('GET', '/internal/clubs?reported=1', { token: mod })).json().clubs;
    expect(listed.length).toBeGreaterThan(0);
  });

  it('keeps friends-only invites working after a rename', async () => {
    const c = await pair();
    const friend = await player(api);
    await befriend(api, c.owner, friend);
    await api.req('POST', `/internal/clubs/${c.id}/reset-name`, {
      token: ADMIN_TOKEN,
      body: { reason: 'cleanup' },
    });
    expect((await call(c.owner, 'POST', '/clubs/me/invites', { userId: friend.id })).statusCode).toBe(201);
    const invite = (await myClub(api, friend)).invites[0];
    expect(invite.club.name).toMatch(/^Club /);
  });
});

/** Two API instances over one database and one KV, as two processes behind a load balancer. */
async function twoInstances(backend: (typeof BACKENDS)[number]) {
  const redis = backend.env.REDIS_URL;
  const pg = backend.env.DATABASE_URL;
  const scratch = pg ? await createScratchDatabase(pg) : null;
  const database: Database = await openDatabase({ databaseUrl: scratch?.url, pgliteDir: 'memory://' });
  const db = { ...database, close: async () => undefined };
  const prefix = `tumble-test:${randomBytes(6).toString('hex')}:`;
  const kvs: KV[] = redis
    ? [new RedisKV(redis, prefix), new RedisKV(redis, prefix)]
    : [createKV(undefined, () => Date.parse(START))];
  const env = { DATABASE_URL: '', REDIS_URL: '' };
  const a = await createTestApi(START, env, { kv: kvs[0]!, database: db });
  const b = await createTestApi(START, env, { kv: kvs[1] ?? kvs[0]!, database: db });
  return {
    a,
    b,
    close: async () => {
      await a.close();
      await b.close().catch(() => undefined);
      await database.close();
      await scratch?.drop();
    },
  };
}

function connect(base: string, token: string) {
  return new Promise<{ ws: WebSocket; next(type: string): Promise<Record<string, unknown>> }>(
    (resolve, reject) => {
      const ws = new WebSocket(`${base}/ws?token=${token}`);
      const messages: Record<string, unknown>[] = [];
      const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        const i = waiters.findIndex((w) => w.type === msg.type);
        if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
        else messages.push(msg);
      });
      const next = (type: string) =>
        new Promise<Record<string, unknown>>((res) => {
          const seen = messages.findIndex((m) => m.type === type);
          if (seen >= 0) res(messages.splice(seen, 1)[0]!);
          else waiters.push({ type, resolve: res });
        });
      ws.on('open', () => resolve({ ws, next }));
      ws.on('error', reject);
    },
  );
}

describe.each(BACKENDS)('club chat across instances ($name)', (backend) => {
  it('delivers a line sent on one instance to a socket on the other, and a mute applies at once', async () => {
    const pair = await twoInstances(backend);
    const { a, b } = pair;
    let ws: WebSocket | undefined;
    try {
      const owner = await a.account();
      const member = await a.account();
      await ageAccount(a, owner.id);
      const club = (
        await a.req('POST', '/clubs', { token: owner.accessToken, body: { name: 'Two Servers', tag: 'TWO' } })
      ).json().club;
      expect((await b.req('POST', `/clubs/${club.id}/join`, { token: member.accessToken })).statusCode).toBe(
        200,
      );

      await b.app.listen({ host: '127.0.0.1', port: 0 });
      const base = `ws://127.0.0.1:${(b.app.server.address() as AddressInfo).port}`;
      const conn = await connect(base, member.accessToken);
      ws = conn.ws;
      await conn.next('hello');
      // Warms instance B's ban cache with "not muted".
      await expect(sendClubChat(b.ctx, owner.id, 'warm up')).resolves.toBeTruthy();
      await conn.next('club_chat');

      const sent = await a.req('POST', '/clubs/me/chat', {
        token: owner.accessToken,
        body: { text: 'hello other server' },
      });
      expect(sent.statusCode).toBe(200);
      expect(await conn.next('club_chat')).toMatchObject({ text: 'hello other server', clubId: club.id });

      const mute = await a.req('POST', '/internal/bans', {
        token: ADMIN_TOKEN,
        body: { userId: owner.id, scope: 'chat', reason: 'spam', durationHours: 1 },
      });
      expect(mute.statusCode).toBe(201);
      await backend.settle();
      await expect(sendClubChat(b.ctx, owner.id, 'still here?')).rejects.toMatchObject({
        code: 'chat_banned',
      });
    } finally {
      ws?.close();
      await pair.close();
    }
  });
});
