import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpVoiceTeams } from '../src/voiceTeams.ts';

const SECRET = 'internal-secret-0123456789';

describe('HttpVoiceTeams', () => {
  it('posts the round signed with the internal HMAC', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sink = new HttpVoiceTeams({
      apiUrl: 'http://api.test/',
      secret: SECRET,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const players = [{ userId: 'u1', team: 1, partyId: 'p1' }];
    expect(await sink.send('room_1', 3, players)).toBe(true);
    expect(calls[0]!.url).toBe('http://api.test/internal/voice/teams');
    const body = calls[0]!.init.body as string;
    expect(JSON.parse(body)).toEqual({ matchId: 'room_1', round: 3, players });
    const h = calls[0]!.init.headers as Record<string, string>;
    const expected = createHmac('sha256', SECRET)
      .update(`POST\n/internal/voice/teams\n${h['x-tumble-timestamp']}\n${h['x-tumble-nonce']}\n${body}`)
      .digest('hex');
    expect(h['x-tumble-signature']).toBe(expected);
  });

  it('never throws when the API is down', async () => {
    const logs: string[] = [];
    const sink = new HttpVoiceTeams({
      apiUrl: 'http://api.test',
      secret: SECRET,
      log: (m) => logs.push(m),
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await sink.send('room_1', 0, [])).toBe(false);
    expect(logs[0]).toContain('ECONNREFUSED');
  });
});
