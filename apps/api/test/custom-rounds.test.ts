/**
 * Shared custom rounds: publishing (accounts only, server-side validation,
 * size and rate limits, per-account cap), code lookup, the owner's list,
 * unpublish/publish/update/delete, reports, the game-server resolve route,
 * and moderation (list, inspect, takedown with audit, restore, role checks).
 */
import { randomInt } from 'node:crypto';
import { CUSTOM_ROUND_LIMITS, randomShareCode, starterRound } from '@tumble/content/custom';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog, customRoundReports, customRounds } from '../src/db/schema.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi('2026-10-06T12:00:00.000Z');
});
afterAll(async () => {
  await api.close();
});

let ipNo = 0;
const freshIp = () => `10.210.${Math.floor(++ipNo / 250)}.${ipNo % 250}`;

async function publish(user: TestUser, round: unknown = starterRound(), description = 'A short hop') {
  return api.req('POST', '/custom-rounds', { token: user.accessToken, body: { round, description } });
}

async function published(user: TestUser): Promise<string> {
  const res = await publish(user);
  expect(res.statusCode).toBe(201);
  return res.json().round.code as string;
}

async function staff(role: 'admin' | 'moderator'): Promise<string> {
  const u = await api.account();
  expect(
    (await api.req('PUT', `/internal/staff/${u.id}`, { token: ADMIN_TOKEN, body: { role } })).statusCode,
  ).toBe(200);
  const res = await api.req('POST', '/admin/session', { token: u.accessToken, ip: freshIp() });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

describe('publishing', () => {
  it('needs a signed-in, non-guest account', async () => {
    expect((await api.req('POST', '/custom-rounds', { body: { round: starterRound() } })).statusCode).toBe(
      401,
    );
    const guest = await api.guest();
    const res = await publish(guest);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('guest_account');
  });

  it('publishes a valid round under a fresh share code', async () => {
    const u = await api.account();
    const res = await publish(u);
    expect(res.statusCode).toBe(201);
    const round = res.json().round;
    expect(round.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(round).toMatchObject({
      name: 'My Race',
      type: 'race',
      status: 'published',
      description: 'A short hop',
    });
    const [row] = await api.ctx.db.select().from(customRounds).where(eq(customRounds.code, round.code));
    expect((row!.definition as { id: string }).id).toBe(`custom:${round.code}`);
  });

  it('validates on the server and lists the errors', async () => {
    const u = await api.account();
    const bad = starterRound();
    bad.triggers = [];
    const res = await publish(u, bad);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_round');
    expect(res.json().details.map((d: { code: string }) => d.code)).toContain('no_finish');
    const junk = await api.req('POST', '/custom-rounds', { token: u.accessToken, body: { round: 'nope' } });
    expect(junk.statusCode).toBe(400);
    const extra = await api.req('POST', '/custom-rounds', {
      token: u.accessToken,
      body: { round: starterRound(), owner: 'someone' },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('filters names and descriptions', async () => {
    const u = await api.account();
    const rude = starterRound();
    rude.name = 'shit run';
    expect((await publish(u, rude)).json().details[0].code).toBe('name');
    const res = await publish(u, starterRound(), 'what the fuck');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('description_filtered');
  });

  it('refuses oversized bodies', async () => {
    const u = await api.account();
    const big = starterRound();
    big.designNotes = 'x'.repeat(CUSTOM_ROUND_LIMITS.maxBytes + 10);
    const res = await publish(u, big);
    expect(res.statusCode).toBe(422);
    expect(res.json().details[0].code).toBe('too_large');
    const huge = starterRound();
    huge.designNotes = 'x'.repeat(200 * 1024);
    expect((await publish(u, huge)).statusCode).toBe(413);
  });

  it('caps rounds per account', async () => {
    const u = await api.account();
    const [row] = await api.ctx.db.select().from(customRounds).limit(1);
    await api.ctx.db.insert(customRounds).values(
      Array.from({ length: CUSTOM_ROUND_LIMITS.maxPerAccount }, (_, i) => ({
        code: randomShareCode(randomInt),
        ownerId: u.id,
        name: `Filler ${i}`,
        roundType: 'race',
        definition: row!.definition as object,
        sizeBytes: 10,
      })),
    );
    const res = await publish(u);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('round_limit');
  });

  it('rate-limits publishing per account', async () => {
    const u = await api.account();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await publish(u)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('loading and managing', () => {
  it('loads a published round by code for anyone, in any case', async () => {
    const u = await api.account();
    const code = await published(u);
    const res = await api.req('GET', `/custom-rounds/${code.toLowerCase()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code, name: 'My Race', type: 'race' });
    expect(res.json().author).toMatch(/#\d{4}$/);
    expect(res.json().definition.geometry.length).toBe(4);
    expect((await api.req('GET', '/custom-rounds/ZZZZZZZZ')).statusCode).toBe(404);
    expect((await api.req('GET', '/custom-rounds/not-a-code!')).statusCode).toBe(404);
  });

  it('lists my rounds and lets the owner unpublish, republish, update and delete', async () => {
    const u = await api.account();
    const other = await api.account();
    const code = await published(u);
    const mine = await api.req('GET', '/custom-rounds/mine', { token: u.accessToken });
    expect(mine.json().rounds.map((r: { code: string }) => r.code)).toEqual([code]);

    expect(
      (await api.req('POST', `/custom-rounds/${code}/unpublish`, { token: other.accessToken })).statusCode,
    ).toBe(404);
    expect(
      (await api.req('POST', `/custom-rounds/${code}/unpublish`, { token: u.accessToken })).statusCode,
    ).toBe(200);
    expect((await api.req('GET', `/custom-rounds/${code}`)).statusCode).toBe(404);
    expect((await api.req('GET', `/custom-rounds/${code}`, { token: u.accessToken })).statusCode).toBe(200);
    expect(
      (await api.req('POST', `/custom-rounds/${code}/publish`, { token: u.accessToken })).statusCode,
    ).toBe(200);

    const next = starterRound('survival');
    next.name = 'Second Draft';
    const put = await api.req('PUT', `/custom-rounds/${code}`, {
      token: u.accessToken,
      body: { round: next, description: '' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().round).toMatchObject({ code, name: 'Second Draft', type: 'survival' });

    expect((await api.req('DELETE', `/custom-rounds/${code}`, { token: other.accessToken })).statusCode).toBe(
      404,
    );
    expect((await api.req('DELETE', `/custom-rounds/${code}`, { token: u.accessToken })).statusCode).toBe(
      204,
    );
    expect((await api.req('GET', `/custom-rounds/${code}`)).statusCode).toBe(404);
  });
});

describe('reports and moderation', () => {
  it('takes a reported round down everywhere, with an audit row', async () => {
    const author = await api.account();
    const reporter = await api.guest();
    const code = await published(author);

    expect(
      (
        await api.req('POST', `/custom-rounds/${code}/report`, {
          token: author.accessToken,
          body: { reason: 'spam' },
        })
      ).statusCode,
    ).toBe(400);
    const rep = await api.req('POST', `/custom-rounds/${code}/report`, {
      token: reporter.accessToken,
      body: { reason: 'offensive', details: 'rude words on the floor' },
    });
    expect(rep.statusCode).toBe(201);
    const again = await api.req('POST', `/custom-rounds/${code}/report`, {
      token: reporter.accessToken,
      body: { reason: 'offensive' },
    });
    expect(again.json().error).toBe('already_reported');

    const mod = await staff('moderator');
    const list = await api.req('GET', '/internal/custom-rounds?reported=1', { token: mod });
    expect(list.statusCode).toBe(200);
    const listed = list.json().rounds.find((r: { code: string }) => r.code === code);
    expect(listed).toMatchObject({ openReports: 1, status: 'published' });

    const detail = await api.req('GET', `/internal/custom-rounds/${code}`, { token: mod });
    expect(detail.json().round.definition.id).toBe(`custom:${code}`);
    expect(detail.json().reports).toHaveLength(1);

    expect(
      (
        await api.req('POST', `/internal/custom-rounds/${code}/takedown`, {
          token: mod,
          body: { reason: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    const down = await api.req('POST', `/internal/custom-rounds/${code}/takedown`, {
      token: mod,
      body: { reason: 'Offensive text' },
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().reportsClosed).toBe(1);
    const audit = await api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, code));
    expect(audit.map((a) => a.action)).toEqual(['custom_round.takedown']);
    const reports = await api.ctx.db.select().from(customRoundReports);
    expect(reports.find((r) => r.reporterId === reporter.id)?.status).toBe('actioned');

    // Taken down: the code stops working for players, game servers and the owner's edits.
    const gone = await api.req('GET', `/custom-rounds/${code}`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe('taken_down');
    const resolved = await api.internal('/internal/custom-rounds/resolve', { codes: [code] });
    expect(resolved.json()).toEqual({ rounds: [], missing: [code] });
    expect(
      (
        await api.req('PUT', `/custom-rounds/${code}`, {
          token: author.accessToken,
          body: { round: starterRound() },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api.req('DELETE', `/custom-rounds/${code}`, { token: author.accessToken })).statusCode,
    ).toBe(409);
    const mine = await api.req('GET', '/custom-rounds/mine', { token: author.accessToken });
    expect(mine.json().rounds[0]).toMatchObject({ status: 'taken_down', takedownReason: 'Offensive text' });

    // Restoring needs an admin.
    expect(
      (
        await api.req('POST', `/internal/custom-rounds/${code}/restore`, {
          token: mod,
          body: { reason: 'Appeal ok' },
        })
      ).statusCode,
    ).toBe(403);
    const boss = await staff('admin');
    const restored = await api.req('POST', `/internal/custom-rounds/${code}/restore`, {
      token: boss,
      body: { reason: 'Appeal accepted' },
    });
    expect(restored.statusCode).toBe(200);
    expect((await api.req('GET', `/custom-rounds/${code}`)).statusCode).toBe(200);
  });

  it('dismisses reports with an audit row', async () => {
    const author = await api.account();
    const reporter = await api.guest();
    const code = await published(author);
    await api.req('POST', `/custom-rounds/${code}/report`, {
      token: reporter.accessToken,
      body: { reason: 'broken' },
    });
    const mod = await staff('moderator');
    const res = await api.req('POST', `/internal/custom-rounds/${code}/dismiss-reports`, {
      token: mod,
      body: { reason: 'Works fine' },
    });
    expect(res.json()).toEqual({ reportsClosed: 1 });
    const audit = await api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, code));
    expect(audit.map((a) => a.action)).toEqual(['custom_round.dismiss_reports']);
  });

  it('keeps moderation routes for staff', async () => {
    const player = await api.account();
    expect((await api.req('GET', '/internal/custom-rounds', { token: player.accessToken })).statusCode).toBe(
      401,
    );
    expect(
      (await api.req('POST', '/internal/custom-rounds/ZZZZZZZZ/takedown', { body: { reason: 'nope' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('game server resolve', () => {
  it('returns published definitions and only with a valid signature', async () => {
    const u = await api.account();
    const code = await published(u);
    const ok = await api.internal('/internal/custom-rounds/resolve', { codes: [code, 'ZZZZZZZZ'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rounds.map((r: { code: string }) => r.code)).toEqual([code]);
    expect(ok.json().missing).toEqual(['ZZZZZZZZ']);
    const forged = await api.internal(
      '/internal/custom-rounds/resolve',
      { codes: [code] },
      { secret: 'wrong-secret' },
    );
    expect(forged.statusCode).toBe(401);
    const tooMany = await api.internal('/internal/custom-rounds/resolve', {
      codes: Array.from({ length: 11 }, () => code),
    });
    expect(tooMany.statusCode).toBe(400);
  });
});
