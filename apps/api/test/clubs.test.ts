/**
 * Clubs: eligibility, founding, join modes, the role permission matrix, the
 * member cap under concurrent joins, kick cooldowns, ownership hand-over on
 * leave and on account deletion, discovery and the kill switch.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUB_MAX_MEMBERS } from '@tumble/shared';
import { removeMember } from '../src/clubs/service.ts';
import { clubKicks, clubReports, clubs, clubMembers, featureFlags } from '../src/db/schema.ts';
import { invalidateLiveOps } from '../src/liveops/state.ts';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import {
  ageAccount,
  befriend,
  createClub,
  fillClub,
  freshIdentity,
  joinClub,
  myClub,
  player,
  type Account,
} from './clubHelpers.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // Asserts realtime events right after each call: in-process pub/sub delivers synchronously.
  api = await createTestApi(undefined, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (u: TestUser, method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token: u.accessToken, ...(body !== undefined ? { body } : {}) });

async function events(u: TestUser): Promise<RealtimeEvent[]> {
  const seen: RealtimeEvent[] = [];
  await api.ctx.kv.subscribe(userChannel(u.id), (m) => seen.push(JSON.parse(m) as RealtimeEvent));
  return seen;
}

/** An owner, an officer and a member in one open club. */
async function trio(): Promise<{
  club: { id: string; name: string };
  owner: Account;
  officer: Account;
  member: Account;
}> {
  const owner = await player(api);
  const club = await createClub(api, owner);
  const officer = await player(api);
  const member = await player(api);
  await joinClub(api, officer, club.id);
  await joinClub(api, member, club.id);
  expect(
    (await call(owner, 'POST', `/clubs/me/members/${officer.id}/role`, { role: 'officer' })).statusCode,
  ).toBe(200);
  return { club, owner, officer, member };
}

describe('founding a club', () => {
  it('needs a full account old enough', async () => {
    const guest = await api.guest();
    const g = await call(guest, 'POST', '/clubs', freshIdentity());
    expect(g.statusCode).toBe(403);
    expect(g.json().error).toBe('guest_account');

    const fresh = await api.account();
    const f = await call(fresh, 'POST', '/clubs', freshIdentity());
    expect(f.statusCode).toBe(403);
    expect(f.json().error).toBe('account_too_new');

    await ageAccount(api, fresh.id);
    const ok = await call(fresh, 'POST', '/clubs', { ...freshIdentity(), description: '  we   tumble  ' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().club).toMatchObject({ memberCount: 1, joinMode: 'open', description: 'we tumble' });
    const me = await myClub(api, fresh);
    expect(me.role).toBe('owner');
    expect(me.club.members).toEqual([expect.objectContaining({ userId: fresh.id, role: 'owner' })]);
  });

  it('runs names, tags and descriptions through the filter', async () => {
    const u = await player(api);
    const bad = async (body: Record<string, unknown>, error: string) => {
      const res = await call(u, 'POST', '/clubs', { ...freshIdentity(), ...body });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe(error);
    };
    await bad({ name: 'Fuck Squad' }, 'invalid_club_name');
    await bad({ name: 'Official Club' }, 'invalid_club_name');
    await bad({ tag: 'A' }, 'invalid_club_tag');
    await bad({ tag: 'SH1T' }, 'invalid_club_tag');
    await bad({ tag: 'A-B' }, 'invalid_club_tag');
    // Five attempts an hour: the sixth is refused before any validation.
    expect((await call(u, 'POST', '/clubs', freshIdentity())).statusCode).toBe(429);
    const v = await player(api);
    await createClub(api, v);
    const edit = async (body: Record<string, unknown>, error: string) => {
      const res = await call(v, 'PATCH', '/clubs/me', body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe(error);
    };
    await edit({ description: 'what the fuck' }, 'invalid_club_description');
    await edit({ emblem: { motif: 'stars', primary: '#123456', secondary: '#ffffff' } }, 'invalid_request');
    const ok = await call(v, 'PATCH', '/clubs/me', {
      emblem: { motif: 'waves', primary: '#FF4F9A', secondary: '#ffffff' },
    });
    expect(ok.json().club.emblem).toEqual({ motif: 'waves', primary: '#ff4f9a', secondary: '#ffffff' });
  });

  it('keeps names and tags unique case-insensitively among live clubs', async () => {
    const a = await player(api);
    const b = await player(api);
    const id = freshIdentity();
    await createClub(api, a, id);
    const sameName = await call(b, 'POST', '/clubs', { name: id.name.toUpperCase(), tag: 'ZZQ' });
    expect(sameName.statusCode).toBe(409);
    expect(sameName.json().error).toBe('name_taken');
    const sameTag = await call(b, 'POST', '/clubs', { name: 'Totally Different', tag: id.tag.toLowerCase() });
    expect(sameTag.json().error).toBe('tag_taken');
  });

  it('allows one club at a time', async () => {
    const u = await player(api);
    await createClub(api, u);
    const again = await call(u, 'POST', '/clubs', freshIdentity());
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_in_club');
  });
});

describe('joining', () => {
  it('lets anyone signed in join an open club, but not guests until they link a sign-in', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    const guest = await api.guest();
    const refused = await call(guest, 'POST', `/clubs/${club.id}/join`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('guest_account');
    // Guest conversion: same account, now with an email sign-in.
    const linked = await api.emailSignIn(`convert-${guest.id}@example.com`, guest.accessToken);
    expect(linked.statusCode).toBe(200);
    const converted = { ...guest, accessToken: linked.json().accessToken as string };
    await joinClub(api, converted, club.id);
    expect((await myClub(api, converted)).role).toBe('member');
  });

  it('turns a join into a request for request-only clubs, which officers accept or decline', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner, { joinMode: 'request' });
    const seen = await events(owner);
    const a = await player(api);
    const b = await player(api);
    expect((await call(a, 'POST', `/clubs/${club.id}/join`)).json().status).toBe('requested');
    expect((await call(b, 'POST', `/clubs/${club.id}/join`)).json().status).toBe('requested');
    expect(seen.filter((e) => e.type === 'club_request')).toHaveLength(2);
    expect((await myClub(api, a)).requests).toEqual([
      expect.objectContaining({ club: expect.objectContaining({ id: club.id }) }),
    ]);
    expect((await myClub(api, owner)).joinRequests.map((r: { userId: string }) => r.userId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await call(owner, 'POST', `/clubs/me/requests/${a.id}/accept`)).statusCode).toBe(200);
    expect((await call(owner, 'POST', `/clubs/me/requests/${b.id}/decline`)).statusCode).toBe(204);
    expect((await myClub(api, a)).role).toBe('member');
    expect((await myClub(api, b)).club).toBeNull();
    // A member cannot see or answer requests.
    const c = await player(api);
    await call(c, 'POST', `/clubs/${club.id}/join`);
    expect((await myClub(api, a)).joinRequests).toEqual([]);
    expect((await call(a, 'POST', `/clubs/me/requests/${c.id}/accept`)).json().error).toBe('club_role');
  });

  it('needs an invite for invite-only clubs, and invites go to friends only', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner, { joinMode: 'invite' });
    const friend = await player(api);
    const stranger = await player(api);
    const closed = await call(friend, 'POST', `/clubs/${club.id}/join`);
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error).toBe('invite_only');
    expect((await call(owner, 'POST', '/clubs/me/invites', { userId: stranger.id })).json().error).toBe(
      'not_friends',
    );
    await befriend(api, owner, friend);
    const seen = await events(friend);
    expect((await call(owner, 'POST', '/clubs/me/invites', { userId: friend.id })).statusCode).toBe(201);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'club_invite', clubId: club.id }));
    expect((await myClub(api, friend)).invites).toEqual([
      expect.objectContaining({
        club: expect.objectContaining({ id: club.id }),
        from: expect.objectContaining({ userId: owner.id }),
      }),
    ]);
    expect((await call(friend, 'POST', `/clubs/invites/${club.id}/accept`)).statusCode).toBe(200);
    expect((await myClub(api, friend)).role).toBe('member');
  });

  it('refuses a second club while in one', async () => {
    const a = await player(api);
    const b = await player(api);
    const c1 = await createClub(api, a);
    await createClub(api, b);
    const res = await call(b, 'POST', `/clubs/${c1.id}/join`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_in_club');
  });
});

describe('role permissions', () => {
  it('lets members chat and leave but nothing else', async () => {
    const { member, officer } = await trio();
    const denied = async (method: Method, url: string, body?: unknown) => {
      const res = await call(member, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe('club_role');
    };
    await denied('PATCH', '/clubs/me', { description: 'hi' });
    await denied('PATCH', '/clubs/me', { name: 'Renamed Club' });
    await denied('POST', `/clubs/me/members/${officer.id}/kick`);
    await denied('POST', `/clubs/me/members/${officer.id}/role`, { role: 'member' });
    await denied('POST', '/clubs/me/transfer', { userId: officer.id });
    await denied('POST', '/clubs/me/disband');
  });

  it('lets officers edit and kick members, but not rename, promote, kick officers or disband', async () => {
    const { owner, officer, member } = await trio();
    expect(
      (await call(officer, 'PATCH', '/clubs/me', { description: 'Daily shows at 8', joinMode: 'request' }))
        .statusCode,
    ).toBe(200);
    expect((await call(officer, 'PATCH', '/clubs/me', { tag: 'NEWT' })).json().error).toBe('club_role');
    expect(
      (await call(officer, 'POST', `/clubs/me/members/${member.id}/role`, { role: 'officer' })).json().error,
    ).toBe('club_role');
    expect((await call(officer, 'POST', '/clubs/me/disband')).json().error).toBe('club_role');
    const other = await player(api);
    await call(owner, 'PATCH', '/clubs/me', { joinMode: 'open' });
    await joinClub(api, other, (await myClub(api, owner)).club.id);
    await call(owner, 'POST', `/clubs/me/members/${other.id}/role`, { role: 'officer' });
    const peer = await call(officer, 'POST', `/clubs/me/members/${other.id}/kick`);
    expect(peer.statusCode).toBe(403);
    expect((await call(officer, 'POST', `/clubs/me/members/${member.id}/kick`)).statusCode).toBe(204);
    expect((await myClub(api, member)).club).toBeNull();
  });

  it('lets the owner rename, promote, demote, transfer and disband', async () => {
    const { club, owner, officer, member } = await trio();
    const fresh = freshIdentity();
    expect(
      (await call(owner, 'PATCH', '/clubs/me', { name: fresh.name, tag: fresh.tag })).json().club,
    ).toMatchObject({
      name: fresh.name,
      tag: fresh.tag.toUpperCase(),
    });
    expect(
      (await call(owner, 'POST', `/clubs/me/members/${officer.id}/role`, { role: 'member' })).statusCode,
    ).toBe(200);
    expect((await call(owner, 'POST', '/clubs/me/transfer', { userId: member.id })).statusCode).toBe(200);
    const roles = Object.fromEntries(
      (await myClub(api, member)).club.members.map((m: { userId: string; role: string }) => [
        m.userId,
        m.role,
      ]),
    );
    expect(roles).toEqual({ [member.id]: 'owner', [owner.id]: 'officer', [officer.id]: 'member' });
    const seen = await events(officer);
    expect((await call(member, 'POST', '/clubs/me/disband')).statusCode).toBe(204);
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'club_removed', clubId: club.id, reason: 'disbanded' }),
    );
    expect((await myClub(api, owner)).club).toBeNull();
    // The name is free again once the club is gone.
    await createClub(api, owner, { name: fresh.name, tag: fresh.tag });
  });
});

describe('caps and concurrency', () => {
  it('never lets concurrent joins push a club past the cap', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    await fillClub(api, club.id, CLUB_MAX_MEMBERS - 3);
    const racers: Account[] = [];
    for (let i = 0; i < 4; i++) racers.push(await player(api));
    const results = await Promise.all(racers.map((r) => call(r, 'POST', `/clubs/${club.id}/join`)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 409, 409]);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error === 'club_full')).toBe(
      true,
    );
    const [row] = await api.ctx.db.select().from(clubs).where(eq(clubs.id, club.id));
    expect(row!.memberCount).toBe(CLUB_MAX_MEMBERS);
    const count = await api.ctx.db.select().from(clubMembers).where(eq(clubMembers.clubId, club.id));
    expect(count).toHaveLength(CLUB_MAX_MEMBERS);
  });

  it('lets a player land in only one of two clubs joined at once', async () => {
    const a = await player(api);
    const b = await player(api);
    const joiner = await player(api);
    const c1 = await createClub(api, a);
    const c2 = await createClub(api, b);
    const results = await Promise.all([
      call(joiner, 'POST', `/clubs/${c1.id}/join`),
      call(joiner, 'POST', `/clubs/${c2.id}/join`),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const rows = await api.ctx.db.select().from(clubMembers).where(eq(clubMembers.userId, joiner.id));
    expect(rows).toHaveLength(1);
  });

  /** Owners on the roster, and the stored count against the real rows. */
  async function integrity(clubId: string) {
    const rows = await api.ctx.db.select().from(clubMembers).where(eq(clubMembers.clubId, clubId));
    const [row] = await api.ctx.db.select().from(clubs).where(eq(clubs.id, clubId));
    return {
      owners: rows.filter((r) => r.role === 'owner').length,
      rows: rows.length,
      memberCount: row!.memberCount,
    };
  }

  it('keeps exactly one owner when the owner transfers and leaves at once', async () => {
    for (let round = 0; round < 3; round++) {
      const { club, owner, member } = await trio();
      await Promise.all([
        call(owner, 'POST', '/clubs/me/transfer', { userId: member.id }),
        call(owner, 'POST', '/clubs/me/leave'),
      ]);
      const after = await integrity(club.id);
      expect(after.owners).toBe(1);
      expect(after.memberCount).toBe(after.rows);
    }
  });

  it('counts a member out once when a kick and a leave race', async () => {
    const { club, owner, member } = await trio();
    await Promise.all([
      call(owner, 'POST', `/clubs/me/members/${member.id}/kick`),
      call(member, 'POST', '/clubs/me/leave'),
    ]);
    expect(await integrity(club.id)).toEqual({ owners: 1, rows: 2, memberCount: 2 });
  });

  it('removes a member once when two removals run concurrently', async () => {
    const { club, member } = await trio();
    const now = api.clock.now();
    const results = await Promise.all([
      api.ctx.db.transaction((tx) => removeMember(tx, member.id, now)),
      api.ctx.db.transaction((tx) => removeMember(tx, member.id, now)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await integrity(club.id)).toEqual({ owners: 1, rows: 2, memberCount: 2 });
  });

  it('keeps a kicked player out until the cooldown ends', async () => {
    const { club, owner, member } = await trio();
    const seen = await events(member);
    expect((await call(owner, 'POST', `/clubs/me/members/${member.id}/kick`)).statusCode).toBe(204);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'club_removed', reason: 'kicked' }));
    const back = await call(member, 'POST', `/clubs/${club.id}/join`);
    expect(back.statusCode).toBe(403);
    expect(back.json().error).toBe('kick_cooldown');
    await befriend(api, owner, member);
    expect((await call(owner, 'POST', '/clubs/me/invites', { userId: member.id })).json().error).toBe(
      'kick_cooldown',
    );
    // Ends the cooldown in the database: advancing the clock a day would expire the access tokens.
    await api.ctx.db
      .update(clubKicks)
      .set({ until: new Date(api.clock.now().getTime() - 1000) })
      .where(eq(clubKicks.userId, member.id));
    await joinClub(api, member, club.id);
  });
});

describe('ownership hand-over', () => {
  it('passes the club to the longest-serving officer, then member, then disbands it', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    const early = await player(api);
    const later = await player(api);
    await joinClub(api, early, club.id);
    await joinClub(api, later, club.id);
    await call(owner, 'POST', `/clubs/me/members/${later.id}/role`, { role: 'officer' });
    const seen = await events(later);
    expect((await call(owner, 'POST', '/clubs/me/leave')).statusCode).toBe(204);
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'notification', title: `You now own ${club.name}` }),
    );
    expect((await myClub(api, later)).role).toBe('owner');

    expect((await call(later, 'POST', '/clubs/me/leave')).statusCode).toBe(204);
    expect((await myClub(api, early)).role).toBe('owner');

    expect((await call(early, 'POST', '/clubs/me/leave')).statusCode).toBe(204);
    const [row] = await api.ctx.db.select().from(clubs).where(eq(clubs.id, club.id));
    expect(row).toMatchObject({ memberCount: 0, disbandReason: 'empty' });
    expect(row!.disbandedAt).not.toBeNull();
  });

  it('hands the club on when the owner deletes their account, and disbands an empty one', async () => {
    const { club, owner, officer } = await trio();
    const del = await call(owner, 'DELETE', '/me', { confirm: 'DELETE' });
    expect(del.statusCode).toBe(204);
    expect((await myClub(api, officer)).role).toBe('owner');
    const roster = (await myClub(api, officer)).club.members as { userId: string }[];
    expect(roster.map((m) => m.userId)).not.toContain(owner.id);
    expect((await myClub(api, officer)).club.memberCount).toBe(2);

    const solo = await player(api);
    const lonely = await createClub(api, solo);
    expect((await call(solo, 'DELETE', '/me', { confirm: 'DELETE' })).statusCode).toBe(204);
    const [row] = await api.ctx.db.select().from(clubs).where(eq(clubs.id, lonely.id));
    expect(row!.disbandedAt).not.toBeNull();
    expect(club.id).not.toBe(lonely.id);
  });
});

describe('banned members', () => {
  it('stay on the roster but cannot act until the ban ends, and officers can remove them', async () => {
    const { owner, member } = await trio();
    await api.ban(member.id);
    expect((await call(member, 'GET', '/clubs/me')).statusCode).toBe(403);
    const roster = (await myClub(api, owner)).club.members as { userId: string }[];
    expect(roster.map((m) => m.userId)).toContain(member.id);
    expect((await call(owner, 'POST', `/clubs/me/members/${member.id}/kick`)).statusCode).toBe(204);
  });
});

describe('discovery', () => {
  it('finds clubs by name or tag and recommends active open ones', async () => {
    const a = await player(api);
    const b = await player(api);
    const c = await player(api);
    // Newer than every club the earlier tests made, so it ranks first among the recommended.
    api.clock.advance(60_000);
    const open = await createClub(api, a, { name: 'Jelly Jumpers', tag: 'JLLY' });
    await createClub(api, b, { name: 'Jelly Closed', tag: 'JLC', joinMode: 'invite' });
    const byName = (await call(c, 'GET', '/clubs/search?q=jelly')).json().clubs as { id: string }[];
    expect(byName).toHaveLength(2);
    const byTag = (await call(c, 'GET', '/clubs/search?q=jlly')).json().clubs as { id: string }[];
    expect(byTag[0]!.id).toBe(open.id);
    expect((await call(c, 'GET', '/clubs/search?q=%25%25')).json().clubs).toEqual([]);
    const rec = (await call(c, 'GET', '/clubs/recommended')).json().clubs as {
      id: string;
      joinMode: string;
    }[];
    expect(rec.some((r) => r.id === open.id)).toBe(true);
    expect(rec.every((r) => r.joinMode === 'open')).toBe(true);
    await api.ctx.db
      .update(clubs)
      .set({ lastActivityAt: new Date(api.clock.now().getTime() - 8 * 86_400_000) })
      .where(eq(clubs.id, open.id));
    const stale = (await call(c, 'GET', '/clubs/recommended')).json().clubs as { id: string }[];
    expect(stale.some((r) => r.id === open.id)).toBe(false);
  });
});

describe('party up', () => {
  it('invites an online club mate into the party', async () => {
    const { owner, member } = await trio();
    const offline = await call(owner, 'POST', '/clubs/me/party-up', { userId: member.id });
    expect(offline.json().error).toBe('member_offline');
    await call(member, 'POST', '/presence', { status: 'in_menu' });
    const seen = await events(member);
    const res = await call(owner, 'POST', '/clubs/me/party-up', { userId: member.id });
    expect(res.statusCode).toBe(200);
    const invite = seen.find((e) => e.type === 'party_invite') as { code: string } | undefined;
    expect(invite).toBeDefined();
    expect((await call(member, 'POST', '/party/join', { code: invite!.code })).statusCode).toBe(200);
    const outsider = await player(api);
    expect((await call(owner, 'POST', '/clubs/me/party-up', { userId: outsider.id })).statusCode).toBe(404);
  });

  it('hides a club mate who blocked, or was blocked by, anyone in the party', async () => {
    const { owner, officer, member } = await trio();
    const stranger = await api.guest();
    const { code } = (await call(owner, 'POST', '/party')).json().party;
    expect((await call(stranger, 'POST', '/party/join', { code })).statusCode).toBe(200);
    expect((await call(member, 'POST', '/friends/block', { userId: stranger.id })).statusCode).toBe(200);
    await call(member, 'POST', '/presence', { status: 'in_menu' });
    const seen = await events(member);
    expect((await call(owner, 'POST', '/clubs/me/party-up', { userId: member.id })).statusCode).toBe(404);
    expect(seen.some((e) => e.type === 'party_invite')).toBe(false);
    expect((await call(member, 'POST', '/party/join', { code })).statusCode).toBe(404);

    await call(officer, 'POST', '/presence', { status: 'in_menu' });
    expect((await call(stranger, 'POST', '/friends/block', { userId: officer.id })).statusCode).toBe(200);
    expect((await call(owner, 'POST', '/clubs/me/party-up', { userId: officer.id })).statusCode).toBe(404);
  });
});

describe('requests and reports', () => {
  it('tells the club about a cancelled request only when there was one', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner, { joinMode: 'request' });
    const asker = await player(api);
    const seen = await events(owner);
    expect((await call(asker, 'DELETE', `/clubs/${club.id}/request`)).statusCode).toBe(204);
    expect(seen.filter((e) => e.type === 'club_update')).toHaveLength(0);
    expect((await call(asker, 'POST', `/clubs/${club.id}/join`)).json().status).toBe('requested');
    expect((await call(asker, 'DELETE', `/clubs/${club.id}/request`)).statusCode).toBe(204);
    expect(seen.filter((e) => e.type === 'club_update')).toHaveLength(1);
  });

  it('hides join requests from players in a blocked pair with the officer', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner, { joinMode: 'request' });
    const blocked = await player(api);
    const blocker = await player(api);
    const fine = await player(api);
    for (const u of [blocked, blocker, fine])
      expect((await call(u, 'POST', `/clubs/${club.id}/join`)).json().status).toBe('requested');
    expect((await call(owner, 'POST', '/friends/block', { userId: blocked.id })).statusCode).toBe(200);
    expect((await call(blocker, 'POST', '/friends/block', { userId: owner.id })).statusCode).toBe(200);
    const ids = (await myClub(api, owner)).joinRequests.map((r: { userId: string }) => r.userId);
    expect(ids).toEqual([fine.id]);
  });

  it('hands back the open club report instead of filing a duplicate', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    const reporter = await player(api);
    const first = await call(reporter, 'POST', `/clubs/${club.id}/report`, { reason: 'name' });
    expect(first.statusCode).toBe(201);
    const racing = await Promise.all(
      Array.from({ length: 3 }, () => call(reporter, 'POST', `/clubs/${club.id}/report`, { reason: 'name' })),
    );
    expect(racing.map((r) => [r.statusCode, r.json().id])).toEqual(
      Array.from({ length: 3 }, () => [200, first.json().id]),
    );
    const other = await call(reporter, 'POST', `/clubs/${club.id}/report`, { reason: 'description' });
    expect(other.statusCode).toBe(201);
    const rows = await api.ctx.db.select().from(clubReports).where(eq(clubReports.clubId, club.id));
    expect(rows).toHaveLength(2);
  });

  it('files one report when the first copies race', async () => {
    const owner = await player(api);
    const club = await createClub(api, owner);
    const reporter = await player(api);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call(reporter, 'POST', `/clubs/${club.id}/report`, { reason: 'name' })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const rows = await api.ctx.db.select().from(clubReports).where(eq(clubReports.clubId, club.id));
    expect(rows).toHaveLength(1);
  });
});

describe('clubs.enabled', () => {
  it('turns every club route off and back on', async () => {
    const u = await player(api);
    await api.ctx.db.insert(featureFlags).values({ key: 'clubs.enabled', enabled: false });
    await invalidateLiveOps(api.ctx);
    const off = await call(u, 'GET', '/clubs/me');
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ error: 'feature_disabled', details: { flag: 'clubs.enabled' } });
    await api.ctx.db
      .update(featureFlags)
      .set({ enabled: true })
      .where(and(eq(featureFlags.key, 'clubs.enabled')));
    await invalidateLiveOps(api.ctx);
    expect((await call(u, 'GET', '/clubs/me')).statusCode).toBe(200);
  });
});
