import { NEWS_POSTS } from '@tumble/content/news';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { REFRESH_TOKEN_TTL_MS } from '../src/auth/tokens.ts';
import { adminAuditLog, events, purchases, sessions, users } from '../src/db/schema.ts';
import { runRetention } from '../src/ops/retention.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

const DAY = 86_400_000;
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
let api: TestApi;

afterEach(async () => {
  await api?.close();
});

describe('health, readiness and request ids', () => {
  it('separates liveness from readiness', async () => {
    api = await createTestApi();
    expect((await api.req('GET', '/health')).statusCode).toBe(200);
    const ready = await api.req('GET', '/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, checks: { db: 'ok', kv: 'ok' } });
    api.ops.setDraining();
    expect((await api.req('GET', '/ready')).statusCode).toBe(503);
    // Liveness stays green while draining, so orchestrators do not kill it mid-shutdown.
    expect((await api.req('GET', '/health')).statusCode).toBe(200);
  });

  it('reports a failing dependency as not ready', async () => {
    api = await createTestApi();
    const original = api.ctx.kv.ping.bind(api.ctx.kv);
    api.ctx.kv.ping = () => Promise.reject(new Error('redis down'));
    const res = await api.req('GET', '/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.kv).toBe('redis down');
    api.ctx.kv.ping = original;
  });

  it('echoes a safe x-request-id and replaces an unsafe one', async () => {
    api = await createTestApi();
    const kept = await api.req('GET', '/health', { headers: { 'x-request-id': 'match-abc_123' } });
    expect(kept.headers['x-request-id']).toBe('match-abc_123');
    const replaced = await api.req('GET', '/health', { headers: { 'x-request-id': 'bad id\nwith newline' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const minted = await api.req('GET', '/health');
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('/metrics', () => {
  it('records latency by route template and counts ingests', async () => {
    api = await createTestApi();
    const u = await api.guest();
    await api.req('GET', '/me', { token: u.accessToken });
    await api.req('GET', '/matches/does-not-exist', { token: u.accessToken });
    await api.postMatch({} as never);
    const res = await api.req('GET', '/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;
    expect(text).toContain(
      'tumble_http_request_duration_seconds_count{method="GET",route="/me",status="200"} 1',
    );
    expect(text).toContain('route="/matches/:id"');
    expect(text).not.toContain('does-not-exist');
    expect(text).toContain('tumble_results_ingest_total{outcome="rejected"} 1');
    expect(text).toContain('tumble_ws_connections 0');
    expect(text).toContain('tumble_process_resident_memory_bytes');
  });

  it('requires the token when one is configured', async () => {
    api = await createTestApi(undefined, { METRICS_TOKEN: 'scrape-token-0123456789' });
    expect((await api.req('GET', '/metrics')).statusCode).toBe(401);
    expect(
      (await api.req('GET', '/metrics', { headers: { authorization: 'Bearer wrong-token!' } })).statusCode,
    ).toBe(401);
    expect(
      (await api.req('GET', '/metrics', { headers: { authorization: 'Bearer scrape-token-0123456789' } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('retention', () => {
  const policy = { intervalMs: 0, sessionGraceDays: 7, eventsDays: 30, guestDays: 0 };

  it('deletes only sessions expired beyond the grace period', async () => {
    api = await createTestApi();
    const old = await api.guest();
    api.clock.advance(REFRESH_TOKEN_TTL_MS + 8 * DAY);
    const fresh = await api.guest();
    const r = await runRetention(api.ctx, policy);
    expect(r).toMatchObject({ ran: true, sessions: 1 });
    expect(await api.ctx.db.select().from(sessions).where(eq(sessions.userId, old.id))).toHaveLength(0);
    expect(await api.ctx.db.select().from(sessions).where(eq(sessions.userId, fresh.id))).toHaveLength(1);
    // Fresh tokens still work after a pass.
    expect(
      (await api.req('POST', '/auth/refresh', { body: { refreshToken: fresh.refreshToken } })).statusCode,
    ).toBe(200);
  });

  it('keeps sessions within the grace period, even expired ones', async () => {
    api = await createTestApi();
    await api.guest();
    api.clock.advance(REFRESH_TOKEN_TTL_MS + 2 * DAY);
    expect((await runRetention(api.ctx, policy)).sessions).toBe(0);
  });

  it('deletes old events but never audit events', async () => {
    api = await createTestApi();
    const longAgo = new Date(api.clock.now().getTime() - 40 * DAY);
    await api.ctx.db.insert(events).values([
      { name: 'menu.open', createdAt: longAgo },
      { name: 'client.error', createdAt: longAgo },
      { name: 'audit.account_deleted', createdAt: longAgo },
      { name: 'menu.open', createdAt: api.clock.now() },
    ]);
    expect((await runRetention(api.ctx, policy)).events).toBe(2);
    const left = (await api.ctx.db.select({ name: events.name }).from(events)).map((e) => e.name).sort();
    expect(left).toEqual(['audit.account_deleted', 'menu.open']);
    expect((await runRetention(api.ctx, { ...policy, eventsDays: 0 })).events).toBe(0);
  });

  it('deletes stale guests only when nothing ties them to the game', async () => {
    api = await createTestApi();
    const stale = await api.guest();
    const paid = await api.guest();
    const banned = await api.guest();
    await api.ban(banned.id);
    await api.ctx.db.insert(purchases).values({
      userId: paid.id,
      idempotencyKey: 'k1',
      kind: 'gems',
      itemId: 'pack',
      currency: 'usd',
      price: 499,
      status: 'completed',
      provider: 'stripe',
    });
    api.clock.advance(REFRESH_TOKEN_TTL_MS + 100 * DAY);
    const active = await api.guest();
    const r = await runRetention(api.ctx, { ...policy, guestDays: 90 });
    expect(r.guests).toBe(1);
    const ids = (await api.ctx.db.select({ id: users.id }).from(users)).map((u) => u.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toEqual(expect.arrayContaining([paid.id, banned.id, active.id]));
  });

  it('runs on one instance at a time', async () => {
    api = await createTestApi();
    await api.ctx.kv.setNX('ops:retention:lock', 'other-instance', 60_000);
    expect((await runRetention(api.ctx, policy)).ran).toBe(false);
    expect(await api.ctx.kv.get('ops:retention:lock')).toBe('other-instance');
  });
});

describe('admin routes', () => {
  it('rejects missing and wrong admin tokens', async () => {
    api = await createTestApi();
    expect((await api.req('GET', '/internal/bans')).statusCode).toBe(401);
    expect(
      (await api.req('GET', '/internal/flags', { headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
  });

  it('lists bans, resolves reports and lists flags', async () => {
    api = await createTestApi();
    const a = await api.guest();
    const b = await api.guest();
    await api.ban(a.id, 'chat');
    const bans = await api.req('GET', `/internal/bans?userId=${a.id}`, { headers: admin });
    expect(bans.json().bans).toEqual([expect.objectContaining({ userId: a.id, scope: 'chat' })]);

    const report = await api.req('POST', '/report', {
      token: b.accessToken,
      body: { targetUserId: a.id, reason: 'spam' },
    });
    const id = report.json().id as string;
    const patched = await api.req('PATCH', `/internal/reports/${id}`, {
      headers: admin,
      body: { status: 'dismissed' },
    });
    expect(patched.json().report).toMatchObject({ id, status: 'dismissed' });
    expect((await api.req('GET', '/internal/reports', { headers: admin })).json().reports).toEqual([]);
    expect(
      (
        await api.req('PATCH', '/internal/reports/00000000-0000-4000-8000-000000000000', {
          headers: admin,
          body: { status: 'resolved' },
        })
      ).statusCode,
    ).toBe(404);

    await api.req('PUT', '/internal/flags/new_menu', { headers: admin, body: { enabled: true } });
    const flags = await api.req('GET', '/internal/flags', { headers: admin });
    expect(flags.json().flags).toEqual([expect.objectContaining({ key: 'new_menu', enabled: true })]);
  });

  it('hides and restores a bundled news post', async () => {
    api = await createTestApi();
    const post = NEWS_POSTS[0]!;
    const hide = await api.req('PATCH', `/internal/news/${post.id}`, {
      headers: admin,
      body: { hidden: true },
    });
    expect(hide.statusCode).toBe(200);
    expect((await api.req('GET', '/news')).json().withdrawn).toContain(post.id);
    await api.req('PATCH', `/internal/news/${post.id}`, { headers: admin, body: { hidden: false } });
    const feed = (await api.req('GET', '/news')).json();
    expect(feed.withdrawn).not.toContain(post.id);
    expect(feed.posts.map((p: { id: string }) => p.id)).toContain(post.id);
    expect(
      (await api.req('PATCH', '/internal/news/no-such-post', { headers: admin, body: { hidden: true } }))
        .statusCode,
    ).toBe(404);
  });

  it('looks users up and force-renames them', async () => {
    api = await createTestApi();
    const u = await api.guest('Rude_Name');
    const byTag = await api.req(
      'GET',
      `/internal/users/lookup?q=${encodeURIComponent(`Rude_Name#${u.tag}`)}`,
      {
        headers: admin,
      },
    );
    expect(byTag.json().users).toEqual([expect.objectContaining({ id: u.id, providers: ['device'] })]);
    const byId = await api.req('GET', `/internal/users/lookup?q=${u.id}`, { headers: admin });
    expect(byId.json().users).toHaveLength(1);

    const renamed = await api.req('POST', `/internal/users/${u.id}/rename`, {
      headers: admin,
      body: { displayName: 'Polite Name' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ userId: u.id, displayName: 'Polite Name' });
    // Moderator renames ignore the cooldown.
    const again = await api.req('POST', `/internal/users/${u.id}/rename`, {
      headers: admin,
      body: { displayName: 'Another Name' },
    });
    expect(again.statusCode).toBe(200);
    const audit = await api.ctx.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'player.rename'));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorLabel: 'operator token', targetId: u.id });
    const bad = await api.req('POST', `/internal/users/${u.id}/rename`, {
      headers: admin,
      body: { displayName: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
