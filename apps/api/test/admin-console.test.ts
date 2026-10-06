/**
 * The admin console's API: staff sessions and roles, the report queue and its
 * bulk actions, the player page, the audit log, and authorisation of every
 * admin route for guests, players, moderators and admins.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog, inventoryItems, loadouts, nameHistory } from '../src/db/schema.ts';
import { openDatabase } from '../src/db/client.ts';
import { createKV } from '../src/kv/index.ts';
import { chatEvidence, rememberChatLine } from '../src/social/chatEvidence.ts';
import { sendGlobalChat } from '../src/social/globalChat.ts';
import { STAFF_SESSION_TTL_MS } from '../src/staff/auth.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

const START = '2026-10-04T12:00:00.000Z';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(START);
});
afterAll(async () => {
  await api.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let ipNo = 0;
const freshIp = () => `10.200.${Math.floor(++ipNo / 250)}.${ipNo % 250}`;

const asToken = (token: string) => (method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token, ...(body !== undefined ? { body } : {}) });
const admin = asToken(ADMIN_TOKEN);

/** A full (non-guest) account holding `role`, signed in to the console. */
async function staff(role: 'admin' | 'moderator'): Promise<TestUser & { session: string; email: string }> {
  const u = await api.account();
  expect((await admin('PUT', `/internal/staff/${u.id}`, { role })).statusCode).toBe(200);
  const res = await api.req('POST', '/admin/session', { token: u.accessToken, ip: freshIp() });
  expect(res.statusCode).toBe(201);
  return { ...u, session: res.json().token as string };
}

async function report(reporter: TestUser, target: TestUser, reason = 'harassment') {
  const res = await api.req('POST', '/report', {
    token: reporter.accessToken,
    body: { targetUserId: target.id, reason, details: 'was rude', matchId: 'm_1' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const auditRows = (action: string) =>
  api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, action));

describe('console sessions', () => {
  it('signs a staff account in and reports who it acts as', async () => {
    const mod = await staff('moderator');
    const me = await asToken(mod.session)('GET', '/internal/admin/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().actor).toMatchObject({ kind: 'staff', userId: mod.id, role: 'moderator' });
    expect(me.json().actor.label).toMatch(/#\d{4}$/);
    const started = await auditRows('session.start');
    expect(started.some((r) => r.actorUserId === mod.id)).toBe(true);
  });

  it('refuses guests and accounts without a role', async () => {
    const guest = await api.guest();
    const g = await api.req('POST', '/admin/session', { token: guest.accessToken, ip: freshIp() });
    expect(g.statusCode).toBe(403);
    expect(g.json().error).toBe('not_staff');
    const player = await api.account();
    const p = await api.req('POST', '/admin/session', { token: player.accessToken, ip: freshIp() });
    expect(p.statusCode).toBe(403);
    expect((await api.req('POST', '/admin/session', { ip: freshIp() })).statusCode).toBe(401);
    expect((await admin('PUT', `/internal/staff/${guest.id}`, { role: 'moderator' })).json().error).toBe(
      'guest_account',
    );
  });

  it('never accepts a staff player access token on admin routes', async () => {
    const boss = await staff('admin');
    expect((await asToken(boss.accessToken)('GET', '/internal/reports')).statusCode).toBe(401);
  });

  it('expires after a fixed lifetime', async () => {
    const mod = await staff('moderator');
    api.clock.advance(STAFF_SESSION_TTL_MS - 1000);
    expect((await asToken(mod.session)('GET', '/internal/admin/me')).statusCode).toBe(200);
    api.clock.advance(2000);
    expect((await asToken(mod.session)('GET', '/internal/admin/me')).statusCode).toBe(401);
  });

  it('dies at once when the role is revoked, the account is suspended, or on sign-out', async () => {
    const a = await staff('moderator');
    expect((await admin('DELETE', `/internal/staff/${a.id}`)).statusCode).toBe(204);
    expect((await asToken(a.session)('GET', '/internal/admin/me')).statusCode).toBe(401);
    expect((await auditRows('staff.revoke')).some((r) => r.targetId === a.id)).toBe(true);

    const b = await staff('moderator');
    await api.ban(b.id);
    expect((await asToken(b.session)('GET', '/internal/admin/me')).statusCode).toBe(401);

    const c = await staff('moderator');
    expect((await asToken(c.session)('DELETE', '/admin/session')).statusCode).toBe(204);
    expect((await asToken(c.session)('GET', '/internal/admin/me')).statusCode).toBe(401);
  });

  it('rejects made-up console tokens', async () => {
    expect((await asToken('tra_not-a-real-session')('GET', '/internal/admin/me')).statusCode).toBe(401);
  });

  it('keeps console sessions working when ADMIN_TOKEN is unset, and nothing else', async () => {
    const solo = await createTestApi(START, { ADMIN_TOKEN: '' });
    try {
      const u = await solo.account();
      await solo.ctx.db
        .insert((await import('../src/db/schema.ts')).staffMembers)
        .values({ userId: u.id, role: 'admin', grantedBy: 'test' });
      const s = await solo.req('POST', '/admin/session', { token: u.accessToken });
      expect(s.statusCode).toBe(201);
      const token = s.json().token as string;
      expect((await solo.req('GET', '/internal/flags', { token })).statusCode).toBe(200);
      const plain = await solo.req('GET', '/internal/flags', { token: 'anything' });
      expect(plain.statusCode).toBe(503);
      expect(plain.json().error).toBe('admin_disabled');
    } finally {
      await solo.close();
    }
  });
});

describe('authorisation of every admin route', () => {
  const uuid = randomUUID();
  const moderatorRoutes: [Method, string, unknown?][] = [
    ['GET', '/internal/admin/me'],
    ['GET', '/internal/reports'],
    ['POST', '/internal/reports/action', { reportIds: [uuid], action: 'dismiss', reason: 'nope' }],
    ['PATCH', `/internal/reports/${uuid}`, { status: 'dismissed' }],
    ['GET', '/internal/bans'],
    ['POST', '/internal/bans', { userId: uuid, reason: 'nope' }],
    ['DELETE', `/internal/bans/${uuid}`],
    ['GET', '/internal/users/lookup?q=abc'],
    ['GET', `/internal/users/${uuid}`],
    ['GET', `/internal/users/${uuid}/gifts`],
    ['POST', `/internal/users/${uuid}/rename`, { displayName: 'Polite' }],
    ['POST', `/internal/users/${uuid}/warn`, { reason: 'nope' }],
    ['POST', `/internal/users/${uuid}/reset-name`, { reason: 'nope' }],
    ['GET', '/internal/audit'],
  ];
  const adminRoutes: [Method, string, unknown?][] = [
    ['GET', '/internal/flags'],
    ['PUT', '/internal/flags/some.flag', { enabled: true }],
    ['POST', '/internal/news', {}],
    ['PATCH', '/internal/news/x', { hidden: true }],
    ['GET', '/internal/playlists'],
    ['PUT', '/internal/playlists/duos', { hidden: true }],
    ['DELETE', '/internal/playlists/duos'],
    ['PUT', '/internal/maintenance', { enabled: false }],
    ['DELETE', '/internal/maintenance'],
    ['GET', '/internal/errors/top'],
    ['GET', `/internal/ledger/${uuid}`],
    ['POST', `/internal/payments/debt/${uuid}/forgive`],
    ['POST', `/internal/users/${uuid}/currency`, { currency: 'gems', delta: 1, reason: 'nope' }],
    ['DELETE', `/internal/users/${uuid}/inventory/x`, { reason: 'nope' }],
    ['POST', `/internal/gifts/${uuid}/reverse`, { reason: 'nope' }],
    ['GET', '/internal/staff'],
    ['PUT', `/internal/staff/${uuid}`, { role: 'admin' }],
    ['DELETE', `/internal/staff/${uuid}`],
  ];

  it('refuses anonymous callers, guests and signed-in players everywhere', async () => {
    const guest = await api.guest();
    const player = await api.account();
    for (const [method, url, body] of [...moderatorRoutes, ...adminRoutes]) {
      for (const token of [undefined, guest.accessToken, player.accessToken]) {
        const res = await api.req(method, url, { ...(token ? { token } : {}), ...(body ? { body } : {}) });
        expect(res.statusCode, `${method} ${url} as ${token ? 'player' : 'anonymous'}`).toBe(401);
      }
    }
  });

  it('keeps admin-only routes from moderators and lets admins through', async () => {
    const mod = await staff('moderator');
    const boss = await staff('admin');
    for (const [method, url, body] of adminRoutes) {
      const res = await asToken(mod.session)(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe('insufficient_role');
    }
    for (const [method, url, body] of [...moderatorRoutes, ...adminRoutes]) {
      if (url === '/admin/session') continue;
      const res = await asToken(boss.session)(method, url, body);
      expect([401, 403], `${method} ${url}`).not.toContain(res.statusCode);
    }
    for (const [method, url, body] of moderatorRoutes) {
      const res = await asToken(mod.session)(method, url, body);
      expect([401, 403], `${method} ${url}`).not.toContain(res.statusCode);
    }
  });
});

describe('report queue', () => {
  it('lists reports with names, counts, sanctions and chat evidence, filtered and paged', async () => {
    const mod = await staff('moderator');
    const as = asToken(mod.session);
    const target = await api.guest('Loud_Mouth');
    const r1 = await api.guest();
    const r2 = await api.guest();
    await sendGlobalChat(api.ctx, target.id, 'you are all terrible');
    await report(r1, target);
    await report(r2, target, 'spam');

    const res = await as('GET', `/internal/reports?targetUserId=${target.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.reports[0]).toMatchObject({
      reason: 'harassment',
      matchId: 'm_1',
      reporter: { id: r1.id, displayName: r1.displayName },
      target: { id: target.id, displayName: 'Loud_Mouth', openReports: 2, activeSanctions: [] },
      evidence: [expect.objectContaining({ channel: 'global', text: 'you are all terrible' })],
    });

    const spam = await as('GET', `/internal/reports?targetUserId=${target.id}&reason=spam`);
    expect(spam.json().reports).toHaveLength(1);
    const paged = await as(
      'GET',
      `/internal/reports?targetUserId=${target.id}&limit=1&offset=1&order=newest`,
    );
    expect(paged.json()).toMatchObject({
      total: 2,
      reports: [expect.objectContaining({ reason: 'harassment' })],
    });
    expect((await as('GET', '/internal/reports?status=bogus')).statusCode).toBe(400);
    expect((await as('GET', '/internal/reports?limit=1000')).statusCode).toBe(400);
  });

  it('validates bulk actions', async () => {
    const mod = await staff('moderator');
    const as = asToken(mod.session);
    const id = await report(await api.guest(), await api.guest());
    const bad: unknown[] = [
      { reportIds: [id], action: 'dismiss' },
      { reportIds: [id], action: 'dismiss', reason: 'x' },
      { reportIds: [], action: 'dismiss', reason: 'fine reason' },
      { reportIds: ['nope'], action: 'dismiss', reason: 'fine reason' },
      { reportIds: [id], action: 'mute', reason: 'fine reason' },
      { reportIds: [id], action: 'warn', reason: 'fine reason', durationHours: 2 },
      { reportIds: [id], action: 'nuke', reason: 'fine reason' },
      {
        reportIds: Array.from({ length: 101 }, () => randomUUID()),
        action: 'dismiss',
        reason: 'fine reason',
      },
      { reportIds: [id], action: 'dismiss', reason: 'fine reason', extra: true },
    ];
    for (const body of bad) expect((await as('POST', '/internal/reports/action', body)).statusCode).toBe(400);
    const none = await as('POST', '/internal/reports/action', {
      reportIds: [randomUUID()],
      action: 'dismiss',
      reason: 'fine reason',
    });
    expect(none.statusCode).toBe(404);
  });

  it('dismisses in bulk and audits each report', async () => {
    const mod = await staff('moderator');
    const target = await api.guest();
    const ids = [await report(await api.guest(), target), await report(await api.guest(), target)];
    const res = await asToken(mod.session)('POST', '/internal/reports/action', {
      reportIds: [...ids, randomUUID()],
      action: 'dismiss',
      reason: 'no evidence of abuse',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated.sort()).toEqual([...ids].sort());
    expect(res.json().missing).toHaveLength(1);
    const left = await asToken(mod.session)('GET', `/internal/reports?targetUserId=${target.id}`);
    expect(left.json().total).toBe(0);
    const rows = (await auditRows('report.dismiss')).filter((r) => ids.includes(r.targetId!));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorUserId: mod.id,
      actorRole: 'moderator',
      reason: 'no evidence of abuse',
    });
  });

  it('warns once per target, records the warning and notifies the player', async () => {
    const mod = await staff('moderator');
    const target = await api.guest();
    const ids = [await report(await api.guest(), target), await report(await api.guest(), target)];
    const seen: string[] = [];
    await api.ctx.kv.subscribe(`user:${target.id}`, (m) => seen.push(m));
    const res = await asToken(mod.session)('POST', '/internal/reports/action', {
      reportIds: ids,
      action: 'warn',
      reason: 'keep chat friendly',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sanctions).toEqual([expect.objectContaining({ userId: target.id, kind: 'warn' })]);
    expect(seen.some((m) => m.includes('keep chat friendly'))).toBe(true);
    const page = await asToken(mod.session)('GET', `/internal/users/${target.id}`);
    expect(page.json().warnings).toEqual([expect.objectContaining({ reason: 'keep chat friendly' })]);
    expect(page.json().reportsAgainst.byStatus).toMatchObject({ actioned: 2 });
    expect((await auditRows('player.warn')).some((r) => r.targetId === target.id)).toBe(true);
  });
});

describe('sanctions take effect on every instance at once', () => {
  it('mutes and bans through one instance and the other refuses straight away', async () => {
    const database = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    const db = { ...database, close: async () => undefined };
    const kv = createKV(undefined, () => Date.parse(START));
    const a = await createTestApi(START, { DATABASE_URL: '', REDIS_URL: '' }, { kv, database: db });
    const b = await createTestApi(START, { DATABASE_URL: '', REDIS_URL: '' }, { kv, database: db });
    try {
      const target = await a.guest();
      const reporter = await a.guest();
      // Warm instance B's cache with "no bans".
      expect((await b.req('GET', '/me', { token: target.accessToken })).statusCode).toBe(200);
      await expect(sendGlobalChat(b.ctx, target.id, 'hello')).resolves.toBeTruthy();

      const file = async () =>
        (
          await a.req('POST', '/report', {
            token: reporter.accessToken,
            body: { targetUserId: target.id, reason: 'harassment' },
          })
        ).json().id as string;
      const act = (body: Record<string, unknown>) =>
        a.req('POST', '/internal/reports/action', { token: ADMIN_TOKEN, body });

      const mute = await act({
        reportIds: [await file()],
        action: 'mute',
        reason: 'abusive chat',
        durationHours: 24,
      });
      expect(mute.statusCode).toBe(200);
      await expect(sendGlobalChat(b.ctx, target.id, 'hello again')).rejects.toMatchObject({
        code: 'chat_banned',
      });
      expect((await b.req('GET', '/me', { token: target.accessToken })).statusCode).toBe(200);

      const ban = await act({
        reportIds: [await file()],
        action: 'ban',
        reason: 'repeat abuse',
        durationHours: 72,
      });
      expect(ban.statusCode).toBe(200);
      expect(ban.json().sanctions[0].expiresAt).toBe(
        new Date(Date.parse(START) + 72 * 3_600_000).toISOString(),
      );
      const refused = await b.req('GET', '/me', { token: target.accessToken });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: 'banned', details: { reason: 'repeat abuse' } });

      // Lifting is just as immediate.
      const bans = (await b.req('GET', `/internal/bans?userId=${target.id}`, { token: ADMIN_TOKEN })).json()
        .bans;
      for (const banRow of bans as { id: string }[]) {
        const lift = await a.req('DELETE', `/internal/bans/${banRow.id}`, {
          token: ADMIN_TOKEN,
          body: { reason: 'appeal accepted' },
        });
        expect(lift.statusCode).toBe(204);
      }
      expect((await b.req('GET', '/me', { token: target.accessToken })).statusCode).toBe(200);
      const lifted = await a.ctx.db
        .select()
        .from(adminAuditLog)
        .where(eq(adminAuditLog.action, 'player.unban'));
      expect(lifted).toHaveLength(2);
      expect(lifted[0]).toMatchObject({ reason: 'appeal accepted', actorLabel: 'operator token' });
    } finally {
      await a.close();
      await b.close();
      await kv.close();
      await database.close();
    }
  });

  it('bans permanently when no duration is given', async () => {
    const target = await api.guest();
    const id = await report(await api.guest(), target);
    const res = await admin('POST', '/internal/reports/action', {
      reportIds: [id],
      action: 'ban',
      reason: 'cheating software',
    });
    expect(res.json().sanctions[0]).toMatchObject({ kind: 'ban', expiresAt: null });
    expect((await api.req('GET', '/me', { token: target.accessToken })).statusCode).toBe(403);
  });
});

describe('player page', () => {
  it('summarises an account', async () => {
    const mod = await staff('moderator');
    const u = await api.account();
    await api.grant(u.id, 'gems', 50);
    const other = await api.guest();
    await report(other, u);
    await report(u, other, 'spam');
    const res = await asToken(mod.session)('GET', `/internal/users/${u.id}`);
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.account).toMatchObject({ id: u.id, isGuest: false, gems: 50, staffRole: null });
    expect(page.account.providers).toContain('email');
    expect(page.reportsAgainst.byStatus).toEqual({ open: 1 });
    expect(page.reportsAgainst.recent[0].reporter).toBe(`${other.displayName}#${other.tag}`);
    expect(page.reportsBy.total).toBe(1);
    expect(page.inventory.length).toBeGreaterThan(0);
    expect(page.inventory.every((i: { starter: boolean }) => i.starter)).toBe(true);
    expect(page).toHaveProperty('matches.total', 0);
    expect(page).toHaveProperty('purchases.total', 0);
    expect((await asToken(mod.session)('GET', `/internal/users/${randomUUID()}`)).statusCode).toBe(404);
    expect((await asToken(mod.session)('GET', '/internal/users/not-a-uuid')).statusCode).toBe(400);
  });

  it('finds players by name prefix and by name#tag', async () => {
    const u = await api.guest('Prefix_Pal');
    const byPrefix = await admin('GET', '/internal/users/lookup?q=prefix_p');
    expect(byPrefix.json().users.map((x: { id: string }) => x.id)).toContain(u.id);
    const wildcard = await admin('GET', '/internal/users/lookup?q=%25%25%25');
    expect(wildcard.json().users).toEqual([]);
    const byTag = await admin('GET', `/internal/users/lookup?q=${encodeURIComponent(`Prefix_Pal#${u.tag}`)}`);
    expect(byTag.json().users).toHaveLength(1);
  });

  it('resets a name to a generated one and keeps the history', async () => {
    const mod = await staff('moderator');
    const u = await api.guest('Bad_Name');
    expect((await asToken(mod.session)('POST', `/internal/users/${u.id}/reset-name`, {})).statusCode).toBe(
      400,
    );
    const res = await asToken(mod.session)('POST', `/internal/users/${u.id}/reset-name`, {
      reason: 'offensive name',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).not.toBe('Bad_Name');
    const history = await api.ctx.db.select().from(nameHistory).where(eq(nameHistory.userId, u.id));
    expect(history).toEqual([expect.objectContaining({ displayName: 'Bad_Name', changedBy: 'staff' })]);
    const [row] = (await auditRows('player.reset_name')).filter((r) => r.targetId === u.id);
    expect(row).toMatchObject({ reason: 'offensive name', actorUserId: mod.id });
    expect(row!.details).toMatchObject({ from: `Bad_Name#${u.tag}` });

    const own = await api.req('PATCH', '/me', { token: u.accessToken, body: { displayName: 'Nicer_Name' } });
    if (own.statusCode === 200) {
      const page = (await asToken(mod.session)('GET', `/internal/users/${u.id}`)).json();
      expect(page.nameHistory[0]).toMatchObject({ changedBy: 'player' });
    }
  });

  it('adjusts currency through the ledger (admins only)', async () => {
    const boss = await staff('admin');
    const mod = await staff('moderator');
    const u = await api.guest();
    const url = `/internal/users/${u.id}/currency`;
    expect(
      (await asToken(mod.session)('POST', url, { currency: 'gems', delta: 5, reason: 'refund' })).statusCode,
    ).toBe(403);
    for (const body of [
      { currency: 'gems', delta: 0, reason: 'refund' },
      { currency: 'gems', delta: 1.5, reason: 'refund' },
      { currency: 'gems', delta: 5_000_000, reason: 'refund' },
      { currency: 'gold', delta: 5, reason: 'refund' },
      { currency: 'gems', delta: 5 },
    ])
      expect((await asToken(boss.session)('POST', url, body)).statusCode).toBe(400);
    const credit = await asToken(boss.session)('POST', url, {
      currency: 'gems',
      delta: 40,
      reason: 'lost purchase',
    });
    expect(credit.statusCode).toBe(200);
    expect(credit.json()).toMatchObject({ balance: 40, wallet: { gems: 40 } });
    const overdraw = await asToken(boss.session)('POST', url, {
      currency: 'gems',
      delta: -100,
      reason: 'clawback',
    });
    expect(overdraw.statusCode).toBe(402);
    const debit = await asToken(boss.session)('POST', url, {
      currency: 'gems',
      delta: -15,
      reason: 'clawback',
    });
    expect(debit.json().balance).toBe(25);
    expect((await admin('GET', `/internal/ledger/${u.id}`)).json()).toMatchObject({ ok: true });
    const rows = (await auditRows('player.currency_adjust')).filter((r) => r.targetId === u.id);
    expect(rows).toHaveLength(2);
  });

  it('revokes a cosmetic and takes it off every loadout', async () => {
    const boss = await staff('admin');
    const u = await api.guest();
    const item = api.ctx.catalog.cosmetics.find((c) => c.source === 'store' && c.slot === 'headwear');
    expect(item).toBeTruthy();
    await api.ctx.db.insert(inventoryItems).values({ userId: u.id, cosmeticId: item!.id, source: 'store' });
    const [slot0] = await api.ctx.db.select().from(loadouts).where(eq(loadouts.userId, u.id));
    await api.ctx.db
      .update(loadouts)
      .set({ items: { ...(slot0!.items as object), headwear: item!.id } })
      .where(and(eq(loadouts.userId, u.id), eq(loadouts.slotIndex, slot0!.slotIndex)));

    const url = `/internal/users/${u.id}/inventory/${item!.id}`;
    expect((await asToken(boss.session)('DELETE', url, {})).statusCode).toBe(400);
    const res = await asToken(boss.session)('DELETE', url, { reason: 'refunded purchase' });
    expect(res.statusCode).toBe(200);
    expect(res.json().loadoutsChanged).toEqual([slot0!.slotIndex]);
    const [after] = await api.ctx.db.select().from(loadouts).where(eq(loadouts.userId, u.id));
    expect((after!.items as { headwear: string | null }).headwear).toBe(
      api.ctx.catalog.defaultLoadout().headwear,
    );
    expect((await asToken(boss.session)('DELETE', url, { reason: 'again' })).statusCode).toBe(404);

    const starter = api.ctx.catalog.defaultLoadout().face;
    const refused = await asToken(boss.session)('DELETE', `/internal/users/${u.id}/inventory/${starter}`, {
      reason: 'nope nope',
    });
    expect(refused.json().error).toBe('starter_item');
  });
});

describe('bans and audit', () => {
  it('lists bans with names, filtered by scope and state', async () => {
    const mod = await staff('moderator');
    const u = await api.guest('Banned_Bob');
    await api.ban(u.id, 'chat');
    const res = await asToken(mod.session)('GET', `/internal/bans?userId=${u.id}&scope=chat`);
    expect(res.json().bans).toEqual([expect.objectContaining({ displayName: 'Banned_Bob', scope: 'chat' })]);
    expect(
      (await asToken(mod.session)('GET', `/internal/bans?userId=${u.id}&scope=all`)).json().bans,
    ).toEqual([]);
    api.clock.advance(2 * 3_600_000);
    // The console session lapsed with the clock; the CLI token still reads.
    const expired = await admin('GET', `/internal/bans?userId=${u.id}&active=expired`);
    expect(expired.json().bans).toHaveLength(1);
    expect((await admin('GET', '/internal/bans?scope=everything')).statusCode).toBe(400);
  });

  it('records the actor, target and reason of a direct ban and pages the log', async () => {
    const mod = await staff('moderator');
    const u = await api.guest();
    const ban = await asToken(mod.session)('POST', '/internal/bans', {
      userId: u.id,
      scope: 'ranked',
      reason: 'win trading',
      durationHours: 48,
    });
    expect(ban.statusCode).toBe(201);
    const unknown = await asToken(mod.session)('POST', '/internal/bans', {
      userId: randomUUID(),
      reason: 'nobody',
    });
    expect(unknown.statusCode).toBe(404);

    const log = await asToken(mod.session)('GET', `/internal/audit?targetId=${u.id}`);
    expect(log.json().entries[0]).toMatchObject({
      action: 'player.ranked_ban',
      actorUserId: mod.id,
      actorRole: 'moderator',
      targetType: 'user',
      reason: 'win trading',
    });
    const prefix = await asToken(mod.session)('GET', '/internal/audit?action=player.&limit=1');
    expect(prefix.json().entries).toHaveLength(1);
    const next = await asToken(mod.session)(
      'GET',
      `/internal/audit?limit=1&before=${prefix.json().nextBefore}`,
    );
    expect(next.json().entries[0].id).toBeLessThan(prefix.json().nextBefore);
    expect((await asToken(mod.session)('GET', '/internal/audit?action=DROP TABLE')).statusCode).toBe(400);
  });

  it('survives deleting the staff member and the player involved', async () => {
    const mod = await staff('moderator');
    const target = await api.guest('Gone_Soon');
    await asToken(mod.session)('POST', `/internal/users/${target.id}/warn`, { reason: 'first strike' });
    await asToken(mod.session)('POST', `/internal/users/${target.id}/reset-name`, { reason: 'rude name' });
    const erase = (u: TestUser) =>
      api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect((await erase(target)).statusCode).toBe(204);
    expect((await erase(mod)).statusCode).toBe(204);
    const rows = await api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, target.id));
    expect(rows.map((r) => r.action).sort()).toEqual(['player.reset_name', 'player.warn']);
    expect(rows.every((r) => r.actorUserId === mod.id)).toBe(true);
    expect(await api.ctx.db.select().from(nameHistory).where(eq(nameHistory.userId, target.id))).toEqual([]);
    expect(
      (await admin('GET', '/internal/staff')).json().staff.map((s: { userId: string }) => s.userId),
    ).not.toContain(mod.id);
  });

  it('cannot be rewritten', async () => {
    await expect(api.ctx.db.update(adminAuditLog).set({ reason: 'edited' })).rejects.toThrow();
    await expect(api.ctx.db.delete(adminAuditLog)).rejects.toThrow();
  });

  it('audits live-ops changes made from the console', async () => {
    const boss = await staff('admin');
    await asToken(boss.session)('PUT', '/internal/flags/store.enabled', { enabled: false });
    await asToken(boss.session)('PUT', '/internal/flags/store.enabled', { enabled: true });
    const rows = (await auditRows('flag.set')).filter((r) => r.actorUserId === boss.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ targetType: 'flag', targetId: 'store.enabled' });
  });
});

describe('chat evidence', () => {
  it('keeps public lines and only the whispers sent to the reporter', async () => {
    const kv = api.ctx.kv;
    const target = randomUUID();
    const reporter = randomUUID();
    await rememberChatLine(kv, target, { channel: 'global', text: 'public', at: 1 });
    await rememberChatLine(kv, target, { channel: 'whisper', text: 'to reporter', at: 2, to: reporter });
    await rememberChatLine(kv, target, {
      channel: 'whisper',
      text: 'to someone else',
      at: 3,
      to: randomUUID(),
    });
    const lines = await chatEvidence(kv, target, reporter);
    expect(lines?.map((l) => l.text)).toEqual(['public', 'to reporter']);
    expect(await chatEvidence(kv, randomUUID(), reporter)).toBeNull();
  });
});
