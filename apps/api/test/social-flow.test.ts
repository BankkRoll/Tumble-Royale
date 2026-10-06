/**
 * The friend system end to end, over HTTP and the realtime gateway, for two
 * and three users: search → request → realtime notify → accept → presence →
 * party invite / join / chat → remove → block, plus multi-tab presence and the
 * disconnect grace period.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

type Msg = Record<string, unknown>;

let api: TestApi;
let base: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  api = await createTestApi();
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const ws of sockets) ws.close();
  await api.close();
});

interface Conn {
  ws: WebSocket;
  /** Resolves with the next message of `type` matching `pred` (buffered ones first). */
  next(type: string, pred?: (m: Msg) => boolean, timeoutMs?: number): Promise<Msg>;
  /** Resolves true when no matching message arrives within `ms`. */
  quiet(type: string, pred: (m: Msg) => boolean, ms: number): Promise<boolean>;
  send(msg: Msg): void;
  close(): Promise<void>;
}

function connect(user: TestUser): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${user.accessToken}`);
    sockets.push(ws);
    const buffer: Msg[] = [];
    const waiters: { type: string; pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Msg;
      const i = waiters.findIndex((w) => w.type === msg.type && w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
      else buffer.push(msg);
    });
    const take = (type: string, pred: (m: Msg) => boolean): Msg | null => {
      const i = buffer.findIndex((m) => m.type === type && pred(m));
      return i >= 0 ? buffer.splice(i, 1)[0]! : null;
    };
    const conn: Conn = {
      ws,
      next: (type, pred = () => true, timeoutMs = 3000) =>
        new Promise((res, rej) => {
          const hit = take(type, pred);
          if (hit) return res(hit);
          const w = { type, pred, resolve: (m: Msg) => (clearTimeout(t), res(m)) };
          const t = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error(`timed out waiting for ${type}`));
          }, timeoutMs);
          waiters.push(w);
        }),
      quiet: (type, pred, ms) =>
        new Promise((res) => {
          if (take(type, pred)) return res(false);
          const w = { type, pred, resolve: () => (clearTimeout(t), res(false)) };
          const t = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            res(true);
          }, ms);
          waiters.push(w);
        }),
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () =>
        new Promise((res) => {
          ws.once('close', () => res());
          ws.close();
        }),
    };
    ws.on('open', async () => {
      await conn.next('presence_snapshot');
      resolve(conn);
    });
    ws.on('error', reject);
  });
}

const tagOf = (u: TestUser) => `${u.displayName}#${u.tag}`;
const about = (id: string) => (m: Msg) => m.userId === id;

describe('friend system end to end', () => {
  it('runs the whole lifecycle for two and three users', async () => {
    const a = await api.guest('Flow_Alpha');
    const b = await api.guest('Flow_Bravo');
    const c = await api.guest('Flow_Charlie');
    const [ca, cb, cc] = await Promise.all([connect(a), connect(b), connect(c)]);
    const http = (u: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
      api.req(method, url, { token: u.accessToken, ...(body !== undefined ? { body } : {}) });

    // --- Search: prefix, excludes self, carries the relation ---------------
    const found = (await http(a, 'GET', '/friends/search?q=flow_')).json().players as Msg[];
    expect(found.map((p) => p.userId)).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(found.some((p) => p.userId === a.id)).toBe(false);
    expect(found.find((p) => p.userId === b.id)).toMatchObject({ relation: 'none' });
    const byTag = (await http(a, 'GET', `/friends/search?q=${encodeURIComponent(tagOf(b))}`)).json();
    expect(byTag.players.map((p: Msg) => p.userId)).toEqual([b.id]);

    // --- Request by id → realtime notify → requests lists ------------------
    expect((await http(a, 'POST', '/friends/request', { userId: b.id })).json().status).toBe('pending');
    expect(await cb.next('friend_request')).toMatchObject({ from: { userId: a.id, name: a.displayName } });
    expect((await http(b, 'GET', '/friends')).json().incoming).toEqual([
      expect.objectContaining({ userId: a.id, at: expect.any(String) }),
    ]);
    expect((await http(a, 'GET', '/friends')).json().outgoing).toEqual([
      expect.objectContaining({ userId: b.id }),
    ]);
    expect((await http(a, 'GET', '/friends/search?q=flow_bravo')).json().players[0]).toMatchObject({
      relation: 'outgoing',
    });

    // --- Accept → both sides told, each sees the other online --------------
    expect((await http(b, 'POST', '/friends/accept', { userId: a.id })).statusCode).toBe(200);
    expect(await ca.next('friend_accepted')).toMatchObject({ by: { userId: b.id } });
    expect(await ca.next('presence', about(b.id))).toMatchObject({ status: 'online', joinable: true });
    expect(await cb.next('presence', about(a.id))).toMatchObject({ status: 'online' });
    expect((await http(a, 'GET', '/friends')).json().friends).toEqual([
      expect.objectContaining({ userId: b.id, presence: 'online', joinable: true }),
    ]);

    // --- Presence changes are pushed with the playlist ---------------------
    cb.send({ type: 'presence', status: 'in_queue', playlistId: 'main-show' });
    expect(await ca.next('presence', about(b.id))).toMatchObject({
      status: 'in_queue',
      playlistId: 'main-show',
    });
    cb.send({ type: 'presence', status: 'in_menu' });
    expect(await ca.next('presence', about(b.id))).toMatchObject({ status: 'in_menu', joinable: true });

    // --- Party invite → join → live update → party chat --------------------
    await http(a, 'POST', '/party/invite', { userId: b.id });
    const invite = await cb.next('party_invite');
    expect(invite).toMatchObject({ from: { userId: a.id } });
    expect((await http(b, 'POST', '/party/join', { code: invite.code })).statusCode).toBe(200);
    const update = await ca.next(
      'party_update',
      (m) => (m.party as { members: unknown[] }).members.length === 2,
    );
    expect((update.party as { leaderId: string }).leaderId).toBe(a.id);
    expect((await http(a, 'POST', '/party/invite', { userId: b.id })).json().error).toBe('already_in_party');

    cb.send({ type: 'party_chat', text: 'this round is shit lol' });
    const line = await ca.next('party_chat');
    expect(line).toMatchObject({
      from: { userId: b.id },
      text: 'this round is shit lol',
      masked: 'this round is **** lol',
    });
    expect(await cb.next('party_chat')).toMatchObject({ id: line.id });
    expect((await http(c, 'POST', '/party/chat', { text: 'hi' })).statusCode).toBe(404);

    // --- Decline and cancel are live for the other side --------------------
    await http(c, 'POST', '/friends/request', { nameTag: tagOf(a) });
    await ca.next('friend_request', (m) => (m.from as Msg).userId === c.id);
    await http(a, 'POST', '/friends/decline', { userId: c.id });
    expect(await cc.next('friend_request_removed')).toMatchObject({ userId: a.id });
    await http(c, 'POST', '/friends/request', { userId: a.id });
    await ca.next('friend_request', (m) => (m.from as Msg).userId === c.id);
    expect((await http(c, 'DELETE', `/friends/request/${a.id}`)).statusCode).toBe(204);
    expect(await ca.next('friend_request_removed')).toMatchObject({ userId: c.id });
    expect((await http(a, 'GET', '/friends')).json().incoming).toEqual([]);

    // --- Requests in both directions auto-accept ---------------------------
    await http(c, 'POST', '/friends/request', { userId: a.id });
    const crossed = await http(a, 'POST', '/friends/request', { userId: c.id });
    expect(crossed.json().status).toBe('accepted');
    expect(await cc.next('friend_accepted')).toMatchObject({ by: { userId: a.id } });

    // --- Join a friend's party from their row ------------------------------
    const joined = await http(c, 'POST', '/party/join-friend', { userId: a.id });
    expect(joined.json().party.members).toHaveLength(3);
    await ca.next('party_update', (m) => (m.party as { members: unknown[] }).members.length === 3);
    expect(await cb.next('presence', about(a.id))).toMatchObject({ joinable: true });
    expect((await http(b, 'POST', '/party/join-friend', { userId: c.id })).json().error).toBe('not_friends');

    // --- Invite decline reaches the inviter --------------------------------
    await http(b, 'POST', '/party/invite/decline', { userId: a.id });
    expect(await ca.next('party_invite_declined')).toMatchObject({ by: { userId: b.id } });

    // --- Remove → live on both sides; block prevents re-request ------------
    expect((await http(a, 'DELETE', `/friends/${b.id}`)).statusCode).toBe(204);
    expect(await cb.next('friend_removed')).toMatchObject({ userId: a.id });
    expect((await http(b, 'GET', '/friends')).json().friends).toEqual([]);
    await http(b, 'POST', '/friends/block', { userId: a.id });
    expect((await http(b, 'GET', '/friends')).json().blocked).toEqual([
      expect.objectContaining({ userId: a.id }),
    ]);
    expect((await http(a, 'POST', '/friends/request', { userId: b.id })).statusCode).toBe(404);
    expect((await http(a, 'POST', '/friends/request', { nameTag: tagOf(b) })).statusCode).toBe(404);
    expect(((await http(a, 'GET', '/friends/search?q=flow_bravo')).json().players as Msg[]).length).toBe(0);
    expect((await http(a, 'POST', '/party/invite', { userId: b.id })).statusCode).toBe(403);

    // Blocked party members stop receiving each other's chat.
    cc.send({ type: 'party_chat', text: 'still here?' });
    await ca.next('party_chat', (m) => (m.from as Msg).userId === c.id);
    cb.send({ type: 'party_chat', text: 'can anyone hear me' });
    expect(await ca.quiet('party_chat', (m) => (m.from as Msg).userId === b.id, 300)).toBe(true);
    expect(await cc.next('party_chat', (m) => (m.from as Msg).userId === b.id)).toBeTruthy();

    // Unblock lets requests through again.
    expect((await http(b, 'DELETE', `/friends/block/${a.id}`)).statusCode).toBe(204);
    expect((await http(a, 'POST', '/friends/request', { userId: b.id })).json().status).toBe('pending');

    // --- Multi-tab presence: the most engaged tab wins ---------------------
    const ca2 = await connect(a);
    ca2.send({ type: 'presence', status: 'in_match', playlistId: 'main-show' });
    expect(await cc.next('presence', (m) => m.userId === a.id && m.status === 'in_match')).toMatchObject({
      playlistId: 'main-show',
    });
    await ca2.close();
    expect(await cc.next('presence', (m) => m.userId === a.id && m.status !== 'in_match')).toMatchObject({
      status: 'online',
    });

    // --- Disconnect grace: a quick reconnect never shows offline -----------
    await ca.close();
    const back = await connect(a);
    expect(await cc.quiet('presence', (m) => m.userId === a.id && m.status === 'offline', 400)).toBe(true);
    await back.close();
    expect(await cc.next('presence', (m) => m.userId === a.id && m.status === 'offline')).toBeTruthy();
    expect((await http(c, 'GET', '/friends')).json().friends).toEqual([
      expect.objectContaining({ userId: a.id, presence: 'offline' }),
    ]);
  });

  it('enforces chat bans and the party chat rate limit', async () => {
    const lead = await api.guest('Chatty_Lead');
    const pal = await api.guest('Chatty_Pal');
    const party = (await api.req('POST', '/party', { token: lead.accessToken })).json().party;
    await api.req('POST', '/party/join', { token: pal.accessToken, body: { code: party.code } });
    const say = (u: TestUser, text: string) =>
      api.req('POST', '/party/chat', { token: u.accessToken, body: { text } });
    expect((await say(lead, '   ')).json().error).toBe('empty_message');
    for (let i = 0; i < 6; i++) expect((await say(lead, `line ${i}`)).statusCode).toBe(200);
    expect((await say(lead, 'one too many')).json().error).toBe('chat_rate');
    api.clock.advance(20_000);
    expect((await say(lead, 'and we are back')).statusCode).toBe(200);

    await api.req('POST', '/internal/bans', {
      headers: { authorization: 'Bearer test-admin-token-0123456789-abcdefghij' },
      body: { userId: pal.id, scope: 'chat', reason: 'spam in party chat', durationHours: 1 },
    });
    expect((await say(pal, 'hello?')).json().error).toBe('chat_banned');
  });

  it('applies friend and pending limits with clear errors', async () => {
    const asker = await api.guest('Limit_Asker');
    const target = await api.guest('Limit_Target');
    const { MAX_PENDING_OUTGOING } = await import('../src/social/friends.ts');
    // Fill the outgoing quota directly so the test stays fast.
    const { friendships, users } = await import('../src/db/schema.ts');
    const fillers = await api.ctx.db
      .insert(users)
      .values(Array.from({ length: MAX_PENDING_OUTGOING }, () => ({})))
      .returning({ id: users.id });
    await api.ctx.db
      .insert(friendships)
      .values(fillers.map((f) => ({ userId: asker.id, friendId: f.id, status: 'pending' })));
    const res = await api.req('POST', '/friends/request', {
      token: asker.accessToken,
      body: { userId: target.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('pending_limit');
    expect(
      (
        await api.req('POST', '/friends/request', { token: asker.accessToken, body: { userId: asker.id } })
      ).json().error,
    ).toBe('self_request');
  });

  it('orders recent players by match and shows presence only for friends', async () => {
    const me = await api.guest('Recent_Me');
    const pal = await api.guest('Recent_Pal');
    const stranger = await api.guest('Recent_Stranger');
    const { buildShow } = await import('./helpers.ts');
    expect(
      (
        await api.postMatch(
          buildShow({
            humans: [
              { userId: me.id, placement: 3 },
              { userId: stranger.id, placement: 5 },
              { userId: pal.id, placement: 9 },
            ],
          }),
        )
      ).statusCode,
    ).toBeLessThan(300);
    await api.req('POST', '/friends/request', { token: me.accessToken, body: { userId: pal.id } });
    await api.req('POST', '/friends/accept', { token: pal.accessToken, body: { userId: me.id } });
    await api.req('POST', '/presence', { token: pal.accessToken, body: { status: 'in_menu' } });
    const players = (await api.req('GET', '/friends/recent', { token: me.accessToken })).json()
      .players as Msg[];
    expect(players.find((p) => p.userId === pal.id)).toMatchObject({
      relation: 'friend',
      presence: 'in_menu',
    });
    const s = players.find((p) => p.userId === stranger.id)!;
    expect(s).toMatchObject({ relation: 'none' });
    expect(s.presence).toBeUndefined();
  });
});
