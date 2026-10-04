/**
 * Live ops on the API: maintenance windows, scheduled playlists, feature-flag
 * kill switches, the services' signed snapshot, analytics ingest validation
 * and crash aggregation.
 */
import { encodeLobbyFrame, type LobbyGameWire } from '@tumble/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { events } from '../src/db/schema.ts';
import { recordServerError } from '../src/liveops/routes.ts';
import { sendGlobalChat } from '../src/social/globalChat.ts';
import { userChannel } from '../src/realtime/notifier.ts';
import { PartyLobbyRelay } from '../src/realtime/partyLobby.ts';
import { PartyService } from '../src/social/party.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

const START = '2026-10-04T12:00:00.000Z';
const T = Date.parse(START);
const iso = (ms: number) => new Date(ms).toISOString();

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(START);
});
afterAll(async () => {
  await api.close();
});

const admin = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
  api.req(method, url, { token: ADMIN_TOKEN, ...(body !== undefined ? { body } : {}) });
const flag = (key: string, enabled: boolean, payload?: unknown) =>
  admin('PUT', `/internal/flags/${key}`, { enabled, ...(payload !== undefined ? { payload } : {}) });

describe('maintenance', () => {
  beforeEach(async () => {
    api.clock.set(START);
    await admin('DELETE', '/internal/maintenance');
  });

  it('is off by default and public', async () => {
    const res = await api.req('GET', '/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ maintenance: { enabled: false, phase: 'off' }, serverTime: T });
  });

  it('only lets the admin change it, and validates the window', async () => {
    expect((await api.req('PUT', '/internal/maintenance', { body: { enabled: true } })).statusCode).toBe(401);
    const backwards = await admin('PUT', '/internal/maintenance', {
      enabled: true,
      startsAt: iso(T + 60_000),
      endsAt: iso(T),
    });
    expect(backwards.statusCode).toBe(400);
    const past = await admin('PUT', '/internal/maintenance', { enabled: true, endsAt: iso(T - 1) });
    expect(past.json().error).toBe('invalid_window');
    const generic = await flag('maintenance', true);
    expect(generic.json().error).toBe('reserved_flag');
  });

  it('blocks queue tickets while active and lifts exactly at endsAt', async () => {
    const u = await api.guest();
    const set = await admin('PUT', '/internal/maintenance', {
      enabled: true,
      message: 'Swapping the slime',
      endsAt: iso(T + 60_000),
    });
    expect(set.json().maintenance).toMatchObject({ phase: 'active', message: 'Swapping the slime' });
    const refused = await api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: {} });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'maintenance', message: 'Swapping the slime' });
    expect((await api.req('GET', '/flags')).json().flags.maintenance).toBeUndefined();

    api.clock.set(iso(T + 60_000));
    expect((await api.req('GET', '/status')).json().maintenance.phase).toBe('off');
    const ok = await api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: {} });
    expect(ok.statusCode).toBe(200);
  });

  it('can be scheduled ahead and starts exactly at startsAt', async () => {
    const u = await api.guest();
    await admin('PUT', '/internal/maintenance', { enabled: true, startsAt: iso(T + 600_000) });
    expect((await api.req('GET', '/status')).json().maintenance).toMatchObject({
      phase: 'scheduled',
      startsAt: iso(T + 600_000),
    });
    expect(
      (await api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: {} })).statusCode,
    ).toBe(200);
    api.clock.set(iso(T + 600_000));
    expect((await api.req('GET', '/status')).json().maintenance.phase).toBe('active');
    expect(
      (await api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: {} })).statusCode,
    ).toBe(503);
  });

  it('records every change in the audit log', async () => {
    await admin('PUT', '/internal/maintenance', { enabled: true });
    await admin('DELETE', '/internal/maintenance');
    const rows = await api.ctx.db.select().from(events).where(eq(events.name, 'audit.admin.maintenance_set'));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('scheduled playlists', () => {
  beforeEach(async () => {
    api.clock.set(START);
    for (const id of ['chaos-mode', 'duos', 'squads']) await admin('DELETE', `/internal/playlists/${id}`);
  });

  it('serves every bundled playlist, live by default', async () => {
    const res = await api.req('GET', '/playlists');
    expect(res.statusCode).toBe(200);
    const list = res.json().playlists as { id: string; phase: string }[];
    expect(list.map((p) => p.id)).toContain('main-show');
    expect(list.every((p) => p.phase === 'live')).toBe(true);
    expect(res.json().serverTime).toBe(T);
  });

  it('validates overrides', async () => {
    expect((await api.req('PUT', '/internal/playlists/duos', { body: {} })).statusCode).toBe(401);
    expect((await admin('PUT', '/internal/playlists/nope', { hidden: true })).statusCode).toBe(404);
    const backwards = await admin('PUT', '/internal/playlists/duos', { startsAt: iso(T), endsAt: iso(T) });
    expect(backwards.json().error).toBe('invalid_window');
    expect((await admin('PUT', '/internal/playlists/duos', { bogus: 1 })).statusCode).toBe(400);
  });

  it('refuses queueing before the start and from exactly the end', async () => {
    const u = await api.guest();
    const ticket = () =>
      api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: { playlistId: 'chaos-mode' } });
    const set = await admin('PUT', '/internal/playlists/chaos-mode', {
      startsAt: iso(T + 1000),
      endsAt: iso(T + 2000),
      featured: true,
    });
    expect(set.json().playlist).toMatchObject({ phase: 'upcoming', featured: true, overridden: true });
    const early = await ticket();
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'playlist_unavailable', details: { phase: 'upcoming' } });

    api.clock.set(iso(T + 1000));
    expect((await ticket()).statusCode).toBe(200);
    api.clock.set(iso(T + 1999));
    expect((await ticket()).statusCode).toBe(200);
    api.clock.set(iso(T + 2000));
    expect((await ticket()).json()).toMatchObject({ details: { phase: 'ended' } });
  });

  it('merges partial edits, hides, and resets to the bundled schedule', async () => {
    await admin('PUT', '/internal/playlists/squads', { endsAt: iso(T + 86_400_000) });
    const hidden = await admin('PUT', '/internal/playlists/squads', { hidden: true });
    expect(hidden.json().playlist).toMatchObject({
      hidden: true,
      endsAt: iso(T + 86_400_000),
      phase: 'hidden',
    });
    const leader = await api.guest();
    await api.req('POST', '/party', { token: leader.accessToken });
    const pick = await api.req('POST', '/party/playlist', {
      token: leader.accessToken,
      body: { playlistId: 'squads' },
    });
    expect(pick.json().error).toBe('playlist_unavailable');

    const reset = await admin('DELETE', '/internal/playlists/squads');
    expect(reset.json().playlist).toMatchObject({
      hidden: false,
      endsAt: null,
      phase: 'live',
      overridden: false,
    });
    const list = (await admin('GET', '/internal/playlists')).json().playlists as { id: string }[];
    expect(list.length).toBeGreaterThan(3);
  });
});

describe('service snapshot and server errors', () => {
  it('requires a signature', async () => {
    expect((await api.req('POST', '/internal/liveops', { body: {} })).statusCode).toBe(401);
    expect(
      (await api.internal('/internal/liveops', {}, { secret: 'wrong-secret-0123456789' })).statusCode,
    ).toBe(401);
  });

  it('hands services raw flags, maintenance and overrides', async () => {
    api.clock.set(START);
    await flag('mutators.chaos', false);
    await admin('PUT', '/internal/maintenance', {
      enabled: true,
      startsAt: iso(T + 60_000),
      message: 'Soon',
    });
    await admin('PUT', '/internal/playlists/duos', { hidden: true });
    const res = await api.internal('/internal/liveops', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      flags: { 'mutators.chaos': { enabled: false } },
      maintenance: { enabled: true, message: 'Soon', startsAt: iso(T + 60_000) },
      playlists: expect.arrayContaining([expect.objectContaining({ id: 'duos', hidden: true })]),
      serverTime: T,
    });
    expect(res.json().flags.maintenance).toBeUndefined();
    await flag('mutators.chaos', true);
    await admin('DELETE', '/internal/maintenance');
    await admin('DELETE', '/internal/playlists/duos');
  });

  it('stores signed crash reports and validates them', async () => {
    const bad = await api.internal('/internal/errors', { service: 'matchmaker', type: 'X' });
    expect(bad.statusCode).toBe(400);
    const ok = await api.internal('/internal/errors', {
      service: 'game-server',
      kind: 'uncaughtException',
      type: 'TypeError',
      message: 'room exploded',
      stack: 'TypeError: room exploded\n    at tick',
    });
    expect(ok.statusCode).toBe(202);
    await recordServerError(api.ctx, new RangeError('api fell over'), { kind: 'unhandledRejection' });
    const top = await admin('GET', '/internal/errors/top?source=server');
    const errors = top.json().errors as { message: string; services: string }[];
    expect(errors.find((e) => e.message === 'room exploded')?.services).toBe('game-server');
    expect(errors.find((e) => e.message === 'api fell over')?.services).toBe('api');
  });
});

describe('analytics ingest', () => {
  beforeEach(() => api.clock.set(START));

  it('accepts allow-listed events with flat props and stores the account id only', async () => {
    const u = await api.guest();
    const res = await api.req('POST', '/events', {
      token: u.accessToken,
      body: {
        events: [
          { name: 'show_end', props: { placement: 3, playlist: 'main-show', crowned: false } },
          { name: 'fps_bucket', props: { bucket: '50-60', tier: 'high' } },
          { name: 'quit_point' },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const rows = await api.ctx.db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.name, 'show_end')));
    expect(rows[0]!.props).toEqual({ placement: 3, playlist: 'main-show', crowned: false });
  });

  it('refuses unknown names, nested or oversized props and forged crash fields', async () => {
    const post = (body: unknown) => api.req('POST', '/events', { body });
    expect((await post({ events: [{ name: 'audit.admin.rename' }] })).statusCode).toBe(400);
    expect((await post({ events: [{ name: 'show_end', props: { a: { b: 1 } } }] })).statusCode).toBe(400);
    expect((await post({ events: [{ name: 'show_end', props: { s: 'x'.repeat(200) } }] })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ events: Array.from({ length: 51 }, () => ({ name: 'quit_point' })) })).statusCode,
    ).toBe(400);
    const crash = { kind: 'error', type: 'Error', message: 'm', path: '/', count: 1 };
    expect(
      (await post({ events: [{ name: 'client.error', props: { ...crash, email: 'a@b.c' } }] })).statusCode,
    ).toBe(400);
    expect((await post({ events: [{ name: 'client.error', props: crash }] })).statusCode).toBe(202);
  });

  it('accepts the crash reporter batch exactly as the client builds it, at its size limits', async () => {
    // Mirrors apps/client/src/crashReporter.ts: every field present, each at the client's cap.
    const props = {
      kind: 'unhandledrejection',
      type: 'T'.repeat(100),
      message: 'm'.repeat(500),
      stack: 's'.repeat(4000),
      source: `https://play.example.com/${'a'.repeat(270)}`.slice(0, 300),
      line: 12,
      col: 7,
      path: `/${'p'.repeat(199)}`,
      count: 40,
      ua: 'u'.repeat(300),
      release: 'r'.repeat(100),
    };
    const batch = {
      events: Array.from({ length: 20 }, (_, i) => ({
        name: 'client.error',
        props: { ...props, line: i + 1 },
      })),
    };
    const res = await api.req('POST', '/events', { body: batch });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 20 });
  });

  it('accepts sendBeacon batches as text/plain with the token in the body', async () => {
    const u = await api.guest();
    const beacon = (payload: string) =>
      api.app.inject({
        method: 'POST',
        url: '/events',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        payload,
      });
    const ok = await beacon(
      JSON.stringify({ events: [{ name: 'quit_point', props: { round: 'beacon-1' } }], auth: u.accessToken }),
    );
    expect(ok.statusCode).toBe(202);
    const forged = await beacon(
      JSON.stringify({ events: [{ name: 'quit_point', props: { round: 'beacon-2' } }], auth: 'not-a-token' }),
    );
    expect(forged.statusCode).toBe(202);
    const rows = await api.ctx.db.select().from(events).where(eq(events.name, 'quit_point'));
    const byRound = (r: string) => rows.find((x) => (x.props as { round?: string }).round === r);
    expect(byRound('beacon-1')?.userId).toBe(u.id);
    expect(byRound('beacon-2')?.userId).toBeNull();
    expect(byRound('beacon-1')?.props).not.toHaveProperty('auth');
    expect((await beacon('{not json')).statusCode).toBe(400);
  });

  it('drops analytics but keeps crash reports when analytics.sample is off', async () => {
    const u = await api.guest();
    await flag('analytics.sample', false);
    const res = await api.req('POST', '/events', {
      token: u.accessToken,
      body: {
        events: [
          { name: 'store_view' },
          { name: 'client.error', props: { kind: 'error', type: 'E', message: 'kept', path: '/', count: 1 } },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const rows = await api.ctx.db.select({ name: events.name }).from(events).where(eq(events.userId, u.id));
    expect(rows.map((r) => r.name)).toEqual(['client.error']);
    await flag('analytics.sample', true);
  });

  it('aggregates client errors by type and message, summing repeat counts', async () => {
    const a = await api.guest();
    const b = await api.guest();
    const crash = (message: string, count: number) => ({
      name: 'client.error',
      props: { kind: 'error', type: 'TypeError', message, path: '/', count, release: 'v1' },
    });
    await api.req('POST', '/events', { token: a.accessToken, body: { events: [crash('boom-top', 5)] } });
    await api.req('POST', '/events', { token: b.accessToken, body: { events: [crash('boom-top', 2)] } });
    await api.req('POST', '/events', { token: b.accessToken, body: { events: [crash('rare', 1)] } });
    const top = await admin('GET', '/internal/errors/top?hours=1&limit=50');
    expect(top.statusCode).toBe(200);
    const rows = top.json().errors as {
      message: string;
      occurrences: number;
      players: number;
      reports: number;
    }[];
    const boom = rows.find((r) => r.message === 'boom-top')!;
    expect(boom).toMatchObject({ type: 'TypeError', occurrences: 7, reports: 2, players: 2, releases: 'v1' });
    expect(rows.indexOf(boom)).toBeLessThan(rows.findIndex((r) => r.message === 'rare'));
    expect((await admin('GET', '/internal/errors/top?hours=0')).statusCode).toBe(400);

    // Outside the window: gone from the view.
    api.clock.set(iso(T + 2 * 3_600_000));
    const later = (await admin('GET', '/internal/errors/top?hours=1')).json().errors as { message: string }[];
    expect(later.some((r) => r.message === 'boom-top')).toBe(false);
  });
});

describe('kill switches', () => {
  beforeEach(() => api.clock.set(START));

  it('closes every spend route while store.enabled is off, and reopens at once', async () => {
    const u = await api.guest();
    await flag('store.enabled', false);
    for (const url of ['/purchase', '/gems/checkout', '/shop/shards/buy', '/pass/premium']) {
      const res = await api.req('POST', url, { token: u.accessToken, body: {} });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: 'feature_disabled', details: { flag: 'store.enabled' } });
    }
    expect((await api.req('GET', '/store')).statusCode).toBe(200);
    await flag('store.enabled', true);
    expect((await api.req('POST', '/purchase', { token: u.accessToken, body: {} })).statusCode).not.toBe(503);
  });

  it('turns global chat off', async () => {
    const u = await api.guest();
    await flag('chat.global', false);
    await expect(sendGlobalChat(api.ctx, u.id, 'hello')).rejects.toMatchObject({ code: 'feature_disabled' });
    await flag('chat.global', true);
    await expect(sendGlobalChat(api.ctx, u.id, 'hello')).resolves.toMatchObject({ text: 'hello' });
  });

  it('strips lobby games from party frames while party.lobbyGames is off', async () => {
    const lead = await api.guest();
    const code = (await api.req('POST', '/party', { token: lead.accessToken })).json().party.code as string;
    const b = await api.guest();
    await api.req('POST', '/party/join', { token: b.accessToken, body: { code } });
    const seen: Record<string, unknown>[] = [];
    await api.ctx.kv.subscribe(userChannel(b.id), (m) => void seen.push(JSON.parse(m)));
    const game: LobbyGameWire = {
      op: 'start',
      id: 1,
      kind: 'potato',
      phase: 'intro',
      left: 3,
      players: [lead.id, b.id],
      teams: [0, 0],
      score: [0, 0],
      out: 0,
      it: 0,
      aux: 0,
      targets: [],
      win: 0,
    };
    const pose = { x: 1, y: 0, z: 1, yaw: 0, state: 0, speed: 0, vy: 0, grounded: true, emote: null };
    const relay = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    await flag('party.lobbyGames', false);
    expect(await relay.handle(lead.id, encodeLobbyFrame(pose, 1, null, { game }), 300)).toBe('relayed');
    await flag('party.lobbyGames', true);
    await relay.handle(lead.id, encodeLobbyFrame(pose, 2, null, { game }), 300);
    const frames = seen.filter((e) => e.type === 'party_lobby');
    expect(frames[0]!.game).toBeUndefined();
    expect(frames[0]).toMatchObject({ x: 1 });
    expect(frames[1]!.game).toBeDefined();
  });

  it('serves flags with mixed-case keys', async () => {
    expect((await flag('party.lobbyGames', true)).statusCode).toBe(200);
    expect((await api.req('GET', '/flags')).json().flags['party.lobbyGames']).toEqual({
      enabled: true,
      payload: null,
    });
  });
});
