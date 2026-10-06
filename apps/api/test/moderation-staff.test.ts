/**
 * Staff-on-staff limits: moderators cannot sanction, rename or warn staff of
 * their own rank or above, nor lift bans an admin issued or bans on
 * themselves; duplicate player reports collapse into the open one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi('2026-10-04T12:00:00.000Z');
});
afterAll(async () => {
  await api.close();
});

let ipNo = 0;
const freshIp = () => `10.201.${Math.floor(++ipNo / 250)}.${ipNo % 250}`;
const as = (token: string) => (method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token, ...(body !== undefined ? { body } : {}) });
const operator = as(ADMIN_TOKEN);

async function staff(role: 'admin' | 'moderator'): Promise<TestUser & { console: ReturnType<typeof as> }> {
  const u = await api.account();
  expect((await operator('PUT', `/internal/staff/${u.id}`, { role })).statusCode).toBe(200);
  const res = await api.req('POST', '/admin/session', { token: u.accessToken, ip: freshIp() });
  expect(res.statusCode).toBe(201);
  return { ...u, console: as(res.json().token as string) };
}

async function banId(userId: string): Promise<string> {
  const rows = (await operator('GET', `/internal/bans?userId=${userId}`)).json().bans as {
    id: string;
    revokedAt: string | null;
  }[];
  return rows.find((b) => !b.revokedAt)!.id;
}

describe('staff targets', () => {
  it('refuses moderator actions on admins, other moderators and themselves', async () => {
    const mod = await staff('moderator');
    const otherMod = await staff('moderator');
    const admin = await staff('admin');
    for (const target of [admin, otherMod, mod]) {
      const attempts = [
        mod.console('POST', '/internal/bans', { userId: target.id, scope: 'chat', reason: 'testing' }),
        mod.console('POST', `/internal/users/${target.id}/warn`, { reason: 'testing' }),
        mod.console('POST', `/internal/users/${target.id}/rename`, { displayName: 'Renamed', reason: 'x' }),
        mod.console('POST', `/internal/users/${target.id}/reset-name`, { reason: 'testing' }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('target_is_staff');
      }
    }
    const player = await api.account();
    const ok = await mod.console('POST', `/internal/users/${player.id}/warn`, { reason: 'testing' });
    expect(ok.statusCode).toBe(201);
  });

  it('lets an admin sanction a moderator and the operator token sanction an admin', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const otherAdmin = await staff('admin');
    const byAdmin = await admin.console('POST', '/internal/bans', {
      userId: mod.id,
      scope: 'chat',
      reason: 'testing',
    });
    expect(byAdmin.statusCode).toBe(201);
    const peer = await admin.console('POST', '/internal/bans', {
      userId: otherAdmin.id,
      scope: 'chat',
      reason: 'testing',
    });
    expect(peer.statusCode).toBe(403);
    const root = await operator('POST', '/internal/bans', {
      userId: otherAdmin.id,
      scope: 'chat',
      reason: 'testing',
    });
    expect(root.statusCode).toBe(201);
  });

  it('refuses bulk report sanctions against staff', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const reporter = await api.account();
    const report = await api.req('POST', '/report', {
      token: reporter.accessToken,
      body: { targetUserId: admin.id, reason: 'harassment' },
    });
    const res = await mod.console('POST', '/internal/reports/action', {
      reportIds: [report.json().id],
      action: 'mute',
      reason: 'testing',
      durationHours: 1,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('target_is_staff');
  });
});

describe('lifting bans', () => {
  it('needs an admin to lift a ban an admin issued', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const player = await api.account();
    await admin.console('POST', '/internal/bans', { userId: player.id, reason: 'admin ban' });
    const id = await banId(player.id);
    const refused = await mod.console('DELETE', `/internal/bans/${id}`, { reason: 'appeal' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('ban_issued_by_admin');
    expect((await admin.console('DELETE', `/internal/bans/${id}`, { reason: 'appeal' })).statusCode).toBe(
      204,
    );
  });

  it('lets a moderator lift a moderator-issued ban but not one on themselves', async () => {
    const mod = await staff('moderator');
    const player = await api.account();
    await mod.console('POST', '/internal/bans', { userId: player.id, reason: 'mod ban' });
    expect((await mod.console('DELETE', `/internal/bans/${await banId(player.id)}`)).statusCode).toBe(204);

    const muted = await staff('moderator');
    await operator('POST', '/internal/bans', { userId: muted.id, scope: 'chat', reason: 'muted' });
    const own = await muted.console('DELETE', `/internal/bans/${await banId(muted.id)}`);
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe('target_is_staff');
  });

  it('answers 404 for an unknown ban', async () => {
    const res = await operator('DELETE', `/internal/bans/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('player reports', () => {
  it('returns the open report instead of filing the same one twice', async () => {
    const reporter = await api.account();
    const target = await api.account();
    const send = (reason: string) =>
      api.req('POST', '/report', { token: reporter.accessToken, body: { targetUserId: target.id, reason } });
    const first = await send('harassment');
    expect(first.statusCode).toBe(201);
    const again = await send('harassment');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, duplicate: true });
    const other = await send('cheating');
    expect(other.statusCode).toBe(201);
    expect(other.json().id).not.toBe(first.json().id);
  });
});
