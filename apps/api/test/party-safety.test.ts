/**
 * Party joins respect blocks between the joiner and every member, and one
 * player's concurrent creates and joins never leave them in two parties.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartyService, type Party } from '../src/social/party.ts';
import { befriend } from './clubHelpers.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(undefined, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

const post = (u: TestUser, url: string, body?: unknown) =>
  api.req('POST', url, { token: u.accessToken, ...(body !== undefined ? { body } : {}) });

async function newParty(leader: TestUser): Promise<{ id: string; code: string }> {
  return (await post(leader, '/party')).json().party;
}

async function partyOf(u: TestUser): Promise<{ id: string; members: { userId: string }[] } | null> {
  return (await api.req('GET', '/party', { token: u.accessToken })).json().party;
}

/** Every stored party the player is listed in, whatever `user-party` says. */
async function partiesListing(userId: string, ids: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const id of new Set(ids)) {
    const raw = await api.ctx.kv.get(`party:${id}`);
    if (raw && (JSON.parse(raw) as Party).members.some((m) => m.userId === userId)) found.push(id);
  }
  return found;
}

describe('party joins and blocks', () => {
  it('refuses a code join when a member and the joiner blocked each other, either way', async () => {
    const leader = await api.guest();
    const blocker = await api.guest();
    const joiner = await api.guest();
    const { code } = await newParty(leader);
    expect((await post(blocker, '/party/join', { code })).statusCode).toBe(200);
    expect((await post(blocker, '/friends/block', { userId: joiner.id })).statusCode).toBe(200);

    const own = await newParty(joiner);
    const refused = await post(joiner, '/party/join', { code });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error).toBe('not_found');
    // A refused join leaves the joiner where they were.
    expect((await partyOf(joiner))?.id).toBe(own.id);

    const other = await api.guest();
    const second = await newParty(other);
    expect((await post(joiner, '/friends/block', { userId: other.id })).statusCode).toBe(200);
    expect((await post(joiner, '/party/join', { code: second.code })).statusCode).toBe(404);

    expect((await post(blocker, '/party/leave')).statusCode).toBe(204);
    expect((await post(joiner, '/party/join', { code })).statusCode).toBe(200);
  });

  it('refuses joining a friend whose party holds someone the joiner blocked', async () => {
    const friend = await api.guest();
    const blocked = await api.guest();
    const joiner = await api.guest();
    await befriend(api, joiner, friend);
    const { code } = await newParty(friend);
    expect((await post(blocked, '/party/join', { code })).statusCode).toBe(200);
    expect((await post(joiner, '/friends/block', { userId: blocked.id })).statusCode).toBe(200);
    await post(friend, '/presence', { status: 'in_menu' });
    expect((await post(joiner, '/party/join-friend', { userId: friend.id })).statusCode).toBe(404);
    expect(await partyOf(joiner)).toBeNull();
  });
});

describe('party races', () => {
  it('leaves a player in exactly one party after concurrent joins', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newParty(await api.guest());
      const b = await newParty(await api.guest());
      const racer = await api.guest();
      await Promise.all([
        post(racer, '/party/join', { code: a.code }),
        post(racer, '/party/join', { code: b.code }),
      ]);
      const current = await partyOf(racer);
      expect(current).not.toBeNull();
      expect(await partiesListing(racer.id, [a.id, b.id])).toEqual([current!.id]);
    }
  });

  it('serialises concurrent joins by one player inside the service', async () => {
    const parties = new PartyService(api.ctx);
    for (let round = 0; round < 3; round++) {
      const a = await newParty(await api.guest());
      const b = await newParty(await api.guest());
      const racer = await api.guest();
      await Promise.all([parties.join(racer.id, a.code), parties.join(racer.id, b.code)]);
      const current = await parties.current(racer.id);
      expect(current).not.toBeNull();
      expect(await partiesListing(racer.id, [a.id, b.id])).toEqual([current!.id]);
    }
  });

  it('creates one party when a player creates and joins at once', async () => {
    const other = await newParty(await api.guest());
    const racer = await api.guest();
    const parties = new PartyService(api.ctx);
    const results = await Promise.all([
      parties.create(racer.id),
      parties.join(racer.id, other.code),
      parties.create(racer.id),
    ]);
    const current = await parties.current(racer.id);
    expect(current).not.toBeNull();
    const ids = [other.id, ...results.map((p) => p.id)];
    expect(await partiesListing(racer.id, ids)).toEqual([current!.id]);
  });
});
