/**
 * Party lobby hangout rules: the shared ball belongs to the leader and a
 * grab may only name another current member. Separate from the gateway
 * suite so its guest sign-ups stay under the auth rate limit.
 */
import { randomUUID } from 'node:crypto';
import { encodeLobbyFrame, type LobbyPose } from '@tumble/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel } from '../src/realtime/notifier.ts';
import { PartyLobbyRelay } from '../src/realtime/partyLobby.ts';
import { PartyService } from '../src/social/party.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

const pose = (): LobbyPose => ({
  x: 1,
  y: 0,
  z: 1,
  yaw: 0,
  state: 0,
  speed: 0,
  vy: 0,
  grounded: true,
  emote: null,
});

async function party(n: number): Promise<TestUser[]> {
  const leader = await api.guest();
  const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code as string;
  const out = [leader];
  for (let i = 1; i < n; i++) {
    const m = await api.guest();
    await api.req('POST', '/party/join', { token: m.accessToken, body: { code } });
    out.push(m);
  }
  return out;
}

async function inbox(userId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  await api.ctx.kv.subscribe(userChannel(userId), (m) => {
    const e = JSON.parse(m) as Record<string, unknown>;
    if (e.type === 'party_lobby') out.push(e);
  });
  return out;
}

describe('party lobby toys', () => {
  it('keeps the ball from the leader only and grabs aimed at fellow members only', async () => {
    const [lead, b, c] = (await party(3)) as [TestUser, TestUser, TestUser];
    const r = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    const atC = await inbox(c.id);
    const ball: [number, number, number, number, number, number] = [1, 0.5, 1, 2, 0, 0];

    await r.handle(lead.id, encodeLobbyFrame(pose(), 1, null, { ball, grab: b.id }), 200);
    await r.handle(
      b.id,
      encodeLobbyFrame(pose(), 1, null, { ball, bump: [3, 1, 0], grab: randomUUID() }),
      200,
    );
    await r.handle(b.id, encodeLobbyFrame(pose(), 2, null, { grab: b.id, status: 'store' }), 200);

    const [fromLead, fromB, fromB2] = atC;
    expect(fromLead).toMatchObject({ userId: lead.id, ball, grab: b.id });
    expect(fromB).toMatchObject({ userId: b.id, bump: [3, 1, 0] });
    expect(fromB!.ball).toBeUndefined();
    expect(fromB!.grab).toBeUndefined();
    expect(fromB2).toMatchObject({ status: 'store' });
    expect(fromB2!.grab).toBeUndefined();
  });
});
