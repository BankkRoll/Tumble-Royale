import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('party invite codes', () => {
  it('creates a party and joins it by code', async () => {
    const leader = await api.guest();
    const friend = await api.guest();
    const created = (await api.req('POST', '/party', { token: leader.accessToken })).json().party;
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.inviteUrl).toBe(`http://localhost:5173/join/${created.code}`);

    const preview = (
      await api.req('GET', `/party/code/${created.code}`, { token: friend.accessToken })
    ).json();
    expect(preview).toMatchObject({ size: 1, maxSize: 4 });

    const joined = await api.req('POST', '/party/join', {
      token: friend.accessToken,
      body: { code: created.code.toLowerCase() },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().party.members.map((m: { userId: string }) => m.userId)).toEqual([
      leader.id,
      friend.id,
    ]);
    expect((await api.req('GET', '/party', { token: friend.accessToken })).json().party.id).toBe(created.id);
  });

  it('enforces size, leadership, ready checks and kicks', async () => {
    const leader = await api.guest();
    const party = (await api.req('POST', '/party', { token: leader.accessToken })).json().party;
    const members = [await api.guest(), await api.guest(), await api.guest()];
    for (const m of members)
      expect(
        (await api.req('POST', '/party/join', { token: m.accessToken, body: { code: party.code } }))
          .statusCode,
      ).toBe(200);
    const fifth = await api.guest();
    expect(
      (await api.req('POST', '/party/join', { token: fifth.accessToken, body: { code: party.code } })).json()
        .error,
    ).toBe('party_full');

    const notReady = await api.req('POST', '/party/queue-ticket', { token: leader.accessToken });
    expect(notReady.json().error).toBe('not_ready');
    expect(
      (
        await api.req('POST', '/party/kick', {
          token: members[0]!.accessToken,
          body: { userId: members[1]!.id },
        })
      ).statusCode,
    ).toBe(403);

    for (const m of members)
      await api.req('POST', '/party/ready', { token: m.accessToken, body: { ready: true } });
    const duos = await api.req('POST', '/party/queue-ticket', {
      token: leader.accessToken,
      body: { playlistId: 'duos' },
    });
    expect(duos.json().error).toBe('party_too_large');
    const ticket = await api.req('POST', '/party/queue-ticket', {
      token: leader.accessToken,
      body: { playlistId: 'squads' },
    });
    expect(ticket.statusCode).toBe(200);
    const { payload } = await jwtVerify(
      ticket.json().ticket,
      new TextEncoder().encode(api.ctx.config.jwtSecret),
      {
        currentDate: api.clock.now(),
      },
    );
    expect(payload).toMatchObject({ typ: 'queue', pid: party.id, playlistId: 'squads', teamSize: 4 });
    expect((payload.members as unknown[]).length).toBe(4);

    const kicked = await api.req('POST', '/party/kick', {
      token: leader.accessToken,
      body: { userId: members[2]!.id },
    });
    expect(kicked.json().party.members).toHaveLength(3);
    expect(
      (
        await api.req('POST', '/party/join', { token: members[2]!.accessToken, body: { code: party.code } })
      ).json().error,
    ).toBe('kicked');

    await api.req('POST', '/party/leave', { token: leader.accessToken });
    const after = (await api.req('GET', '/party', { token: members[0]!.accessToken })).json().party;
    expect(after.leaderId).toBe(members[0]!.id);
  });

  it('issues a solo queue ticket without a party', async () => {
    const solo = await api.guest();
    const res = await api.req('POST', '/party/queue-ticket', {
      token: solo.accessToken,
      body: { playlistId: 'ranked' },
    });
    expect(res.json().claims).toMatchObject({
      pid: `solo:${solo.id}`,
      queue: 'ranked',
      members: [{ userId: solo.id }],
    });
  });
});

describe('friends', () => {
  it('requests by name#tag, accepts, lists and removes', async () => {
    const a = await api.guest('Friendly_A');
    const b = await api.guest('Friendly_B');
    const req = await api.req('POST', '/friends/request', {
      token: a.accessToken,
      body: { nameTag: `${b.displayName}#${b.tag}` },
    });
    expect(req.json().status).toBe('pending');
    expect((await api.req('GET', '/friends', { token: b.accessToken })).json().incoming).toEqual([
      expect.objectContaining({ userId: a.id }),
    ]);
    expect(
      (await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } })).statusCode,
    ).toBe(200);
    const list = (await api.req('GET', '/friends', { token: a.accessToken })).json();
    expect(list.friends).toEqual([expect.objectContaining({ userId: b.id, presence: 'offline' })]);
    expect((await api.req('DELETE', `/friends/${b.id}`, { token: a.accessToken })).statusCode).toBe(204);
    expect((await api.req('GET', '/friends', { token: b.accessToken })).json().friends).toEqual([]);
  });

  it('hides blocked players from requests', async () => {
    const a = await api.guest('Blocker_A');
    const b = await api.guest('Blocked_B');
    await api.req('POST', '/friends/block', { token: b.accessToken, body: { userId: a.id } });
    const req = await api.req('POST', '/friends/request', {
      token: a.accessToken,
      body: { nameTag: `${b.displayName}#${b.tag}` },
    });
    expect(req.statusCode).toBe(404);
  });

  it('accepts reports into the moderation queue', async () => {
    const a = await api.guest();
    const b = await api.guest();
    const res = await api.req('POST', '/report', {
      token: a.accessToken,
      body: { targetUserId: b.id, reason: 'griefing', details: 'kept grabbing me' },
    });
    expect(res.statusCode).toBe(201);
    const queue = await api.req('GET', '/internal/reports', {
      headers: { authorization: 'Bearer test-admin-token-0123456789-abcdefghij' },
    });
    expect(queue.json().reports.some((r: { targetUserId: string }) => r.targetUserId === b.id)).toBe(true);
  });
});
