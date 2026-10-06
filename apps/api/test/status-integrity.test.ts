/**
 * The status page keeps its record straight: uptime samples taken while the
 * database is down are kept and written once it is back, incidents opened
 * long ago but still open stay listed, resolving twice is refused, and the
 * feeds announce maintenance too.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusIncidents, statusUptime } from '../src/db/schema.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';
import { BACKENDS } from './infra.ts';

describe.each(BACKENDS)('status integrity ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi('2026-10-05T12:00:00.000Z', backend.env, { memoryKv: true });
  });
  afterAll(async () => {
    await api.close();
  });
  const admin = (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    api.req(method, url, { token: ADMIN_TOKEN, ...(body !== undefined ? { body } : {}) });

  it('records samples taken during a database outage once the database is back', async () => {
    const day = '2026-10-05';
    const samples = async () =>
      (
        await api.ctx.db
          .select()
          .from(statusUptime)
          .where(and(eq(statusUptime.component, 'api'), eq(statusUptime.day, day)))
      )[0]?.samples ?? 0;
    const before = await samples();
    const insert = vi.spyOn(api.ctx.db, 'insert').mockImplementation(() => {
      throw new Error('database unreachable');
    });
    try {
      await expect(api.status.sample()).rejects.toThrow('database unreachable');
      api.clock.advance(60_000);
      await expect(api.status.sample()).rejects.toThrow('database unreachable');
    } finally {
      insert.mockRestore();
    }
    expect(await samples()).toBe(before);
    api.clock.advance(60_000);
    expect(await api.status.sample()).toBe(true);
    expect(await samples()).toBe(before + 3);
  });

  it('keeps an incident opened long ago listed while it is still open', async () => {
    const [old] = await api.ctx.db
      .insert(statusIncidents)
      .values({
        title: 'Long-running chat trouble',
        impact: 'minor',
        status: 'monitoring',
        components: ['chat'],
        startedAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
      })
      .returning();
    const history = (await api.req('GET', '/status/history')).json();
    expect(history.incidents.map((i: { id: string }) => i.id)).toContain(old!.id);
    const feed = (await api.req('GET', '/status/feed.json')).json();
    expect(feed.items.map((i: { id: string }) => i.id)).toContain(`urn:uuid:${old!.id}`);
  });

  it('refuses to resolve an incident twice', async () => {
    const opened = await admin('POST', '/internal/status/incidents', {
      title: 'Matchmaking slow',
      impact: 'minor',
      status: 'investigating',
      components: ['matchmaking'],
      message: 'Looking into it.',
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const id = opened.json().incident.id as string;
    expect((await admin('POST', `/internal/status/incidents/${id}/resolve`, {})).statusCode).toBe(200);
    const again = await admin('POST', `/internal/status/incidents/${id}/resolve`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('incident_resolved');
  });

  it('announces maintenance in both feeds', async () => {
    const set = await admin('PUT', '/internal/maintenance', {
      enabled: true,
      message: 'Servers are getting new paint.',
      startsAt: '2026-10-06T00:00:00.000Z',
      endsAt: '2026-10-06T02:00:00.000Z',
    });
    expect(set.statusCode, set.body).toBe(200);
    try {
      const feed = (await api.req('GET', '/status/feed.json')).json();
      expect(feed.items[0]).toMatchObject({
        title: 'Scheduled maintenance',
        tags: ['maintenance'],
        date_published: '2026-10-06T00:00:00.000Z',
      });
      expect(feed.items[0].content_text).toContain('Servers are getting new paint.');
      const atom = (await api.req('GET', '/status/feed.atom')).body;
      expect(atom).toContain('<title type="text">Scheduled maintenance</title>');
    } finally {
      await admin('DELETE', '/internal/maintenance');
    }
  });
});
