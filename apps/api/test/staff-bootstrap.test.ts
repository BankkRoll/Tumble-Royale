/**
 * First-admin bootstrap and one-time staff sign-in links: creating or finding
 * the account, the admin grant, link redemption into a game session and then
 * a console session, single use, expiry, replacement, hashing at rest, the
 * audit trail, the operator-token-only rule, rate limits and the development
 * seed.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/auth/tokens.ts';
import { adminAuditLog, authIdentities, staffMembers } from '../src/db/schema.ts';
import { seedDevAdmin, STAFF_LINK_TTL_MS } from '../src/staff/bootstrap.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // The fake clock drives link expiry, so keep the in-process KV.
  api = await createTestApi('2026-10-06T09:00:00.000Z', {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

let ipNo = 0;
const freshIp = () => `10.77.${Math.floor(++ipNo / 250)}.${ipNo % 250}`;
let n = 0;
const address = () => `owner-${++n}@example.com`;

const asAdmin = (method: 'POST' | 'PUT' | 'GET' | 'DELETE', url: string, body?: unknown) =>
  api.req(method, url, {
    token: ADMIN_TOKEN,
    ip: freshIp(),
    ...(body !== undefined ? { body } : {}),
  });

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;
const redeem = (token: string) =>
  api.req('POST', '/auth/staff-link', { body: { token }, ip: freshIp() });
const auditRows = (action: string) =>
  api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, action));

describe('POST /internal/staff/bootstrap', () => {
  it('creates a full account for the address, makes it admin and returns a one-time link', async () => {
    const email = address();
    const res = await asAdmin('POST', '/internal/staff/bootstrap', { email, displayName: 'Owner' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ email, created: true, role: 'admin', previousRole: null });
    expect(body.label).toMatch(/^Owner#\d{4}$/);
    const link = new URL(body.link);
    expect(link.pathname).toBe('/auth/staff');
    expect(Date.parse(body.expiresAt) - api.clock.now().getTime()).toBe(STAFF_LINK_TTL_MS);

    const [staff] = await api.ctx.db.select().from(staffMembers).where(eq(staffMembers.userId, body.userId));
    expect(staff).toMatchObject({ role: 'admin', grantedBy: 'operator token' });
    const ids = await api.ctx.db.select().from(authIdentities).where(eq(authIdentities.userId, body.userId));
    expect(ids.map((i) => [i.provider, i.subject])).toEqual([['email', email]]);
    expect((await auditRows('staff.bootstrap')).some((r) => r.targetId === body.userId)).toBe(true);
    expect((await auditRows('staff.link_issue')).some((r) => r.targetId === body.userId)).toBe(true);
  });

  it('keeps only the hash of the token at rest', async () => {
    const body = (await asAdmin('POST', '/internal/staff/bootstrap', { email: address() })).json();
    const token = tokenOf(body.link);
    expect(await api.ctx.kv.get(`staff-link:${token}`)).toBeNull();
    expect(await api.ctx.kv.get(`staff-link:${sha256(token)}`)).toContain(body.userId);
    const audits = await api.ctx.db.select().from(adminAuditLog);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('promotes the existing account that uses the address', async () => {
    const player = await api.account(address());
    const res = await asAdmin('POST', '/internal/staff/bootstrap', { email: player.email.toUpperCase() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: player.id, created: false, previousRole: null });
    const again = await asAdmin('POST', '/internal/staff/bootstrap', { email: player.email });
    expect(again.json()).toMatchObject({ userId: player.id, previousRole: 'admin' });
  });

  it('rejects a bad address or name', async () => {
    expect((await asAdmin('POST', '/internal/staff/bootstrap', { email: 'nope' })).statusCode).toBe(400);
    const bad = await asAdmin('POST', '/internal/staff/bootstrap', { email: address(), displayName: '!!' });
    expect(bad.json().error).toBe('invalid_name');
  });

  it('accepts only ADMIN_TOKEN, never a console session or a player token', async () => {
    const body = (await asAdmin('POST', '/internal/staff/bootstrap', { email: address() })).json();
    const signedIn = (await redeem(tokenOf(body.link))).json();
    const console = await api.req('POST', '/admin/session', { token: signedIn.accessToken, ip: freshIp() });
    const session = console.json().token as string;
    for (const token of [session, signedIn.accessToken, 'wrong-token-0123456789']) {
      const res = await api.req('POST', '/internal/staff/bootstrap', {
        token,
        ip: freshIp(),
        body: { email: address() },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      expect(res.statusCode).toBeLessThanOrEqual(403);
    }
    const viaConsole = await api.req('POST', `/internal/staff/${body.userId}/link`, { token: session, ip: freshIp() });
    expect(viaConsole.json().error).toBe('operator_token_required');
  });

  it('is rate limited per address', async () => {
    const ip = '10.78.0.1';
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api.req('POST', '/internal/staff/bootstrap', {
        token: ADMIN_TOKEN,
        ip,
        body: { email: address() },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c < 300)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('staff sign-in links', () => {
  async function bootstrap() {
    return (await asAdmin('POST', '/internal/staff/bootstrap', { email: address() })).json() as {
      userId: string;
      link: string;
    };
  }

  it('sign in to the game once, and that session opens the console', async () => {
    const b = await bootstrap();
    const res = await redeem(tokenOf(b.link));
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s).toMatchObject({ outcome: 'signedIn', provider: 'link', user: { id: b.userId, isGuest: false } });
    const console = await api.req('POST', '/admin/session', { token: s.accessToken, ip: freshIp() });
    expect(console.statusCode).toBe(201);
    expect(console.json().actor.role).toBe('admin');
    expect((await auditRows('staff.link_use')).some((r) => r.actorUserId === b.userId)).toBe(true);

    const replay = await redeem(tokenOf(b.link));
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_token');
  });

  it('expire after 15 minutes', async () => {
    const b = await bootstrap();
    api.clock.advance(STAFF_LINK_TTL_MS + 1000);
    expect((await redeem(tokenOf(b.link))).json().error).toBe('invalid_token');
  });

  it('a new link replaces the previous unused one', async () => {
    const b = await bootstrap();
    const next = await asAdmin('POST', `/internal/staff/${b.userId}/link`);
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ userId: b.userId, role: 'admin' });
    expect((await redeem(tokenOf(b.link))).statusCode).toBe(400);
    expect((await redeem(tokenOf(next.json().link))).statusCode).toBe(200);
  });

  it('stop working when the role is revoked', async () => {
    const b = await bootstrap();
    expect((await asAdmin('DELETE', `/internal/staff/${b.userId}`)).statusCode).toBe(204);
    expect((await redeem(tokenOf(b.link))).json().error).toBe('invalid_token');
  });

  it('are only minted for staff accounts', async () => {
    const player = await api.account(address());
    const res = await asAdmin('POST', `/internal/staff/${player.id}/link`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_staff');
    expect((await asAdmin('POST', '/internal/staff/00000000-0000-4000-8000-000000000000/link')).statusCode).toBe(
      404,
    );
  });

  it('refuse a made-up token', async () => {
    expect((await redeem('x'.repeat(43))).json().error).toBe('invalid_token');
  });
});

describe('development seed (DEV_ADMIN_EMAIL)', () => {
  it('makes the address admin only while no staff exist, and logs a fresh link each boot', async () => {
    const fresh = await createTestApi('2026-10-06T09:00:00.000Z', {}, { memoryKv: true });
    try {
      const lines: string[] = [];
      const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) };
      const dev = { ...fresh.ctx, config: { ...fresh.ctx.config, env: 'development' as const, devAdminEmail: 'dev@localhost.test' } };
      const first = await seedDevAdmin(dev, log);
      expect(first?.url).toMatch(/\/auth\/staff\?token=/);
      expect(lines.join('\n')).toContain('dev@localhost.test is now an admin');
      const second = await seedDevAdmin(dev, log);
      expect(second?.url).not.toBe(first?.url);
      expect(await fresh.ctx.db.select().from(staffMembers)).toHaveLength(1);

      const other = { ...dev, config: { ...dev.config, devAdminEmail: 'someone-else@localhost.test' } };
      expect(await seedDevAdmin(other, log)).toBeNull();
      expect(lines.at(-1)).toMatch(/^WARN .*not staff and other staff exist/);

      const prod = { ...dev, config: { ...dev.config, env: 'production' as const } };
      expect(await seedDevAdmin(prod, log)).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});
