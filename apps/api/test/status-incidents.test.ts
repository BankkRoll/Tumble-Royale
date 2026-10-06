/**
 * Status page incidents: who may read and write them, the audit row each
 * write commits with, input validation and plain-text handling (markup is
 * stored as text and escaped in every feed), how open and resolved
 * incidents reach the summary and history, and the JSON and Atom feeds.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog } from '../src/db/schema.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

const START = '2026-10-05T12:00:00.000Z';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi(START, {}, { status: { cacheMs: 60_000, historyCacheMs: 0 } });
});
afterAll(async () => {
  await api.close();
});

type Method = 'GET' | 'POST';
const as = (token: string) => (method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token, ...(body !== undefined ? { body } : {}) });
const admin = as(ADMIN_TOKEN);

let ipNo = 0;
async function staff(role: 'admin' | 'moderator'): Promise<TestUser & { session: string }> {
  const u = await api.account();
  expect(
    (await api.req('PUT', `/internal/staff/${u.id}`, { token: ADMIN_TOKEN, body: { role } })).statusCode,
  ).toBe(200);
  const res = await api.req('POST', '/admin/session', { token: u.accessToken, ip: `10.77.0.${++ipNo}` });
  expect(res.statusCode).toBe(201);
  return { ...u, session: res.json().token as string };
}

const audit = (incidentId: string) =>
  api.ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.targetId, incidentId));

const open = async (body: Record<string, unknown> = {}) => {
  const res = await admin('POST', '/internal/status/incidents', {
    title: 'Queues are slow',
    impact: 'major',
    components: ['matchmaking'],
    message: 'We are looking into slow queues.',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().incident as { id: string; [k: string]: unknown };
};

describe('incident authorisation and audit', () => {
  it('lets admins write and moderators only read', async () => {
    const mod = await staff('moderator');
    const boss = await staff('admin');
    const body = { title: 'Login trouble', impact: 'minor', components: ['api'], message: 'Looking.' };
    const refused = await as(mod.session)('POST', '/internal/status/incidents', body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('insufficient_role');

    const created = await as(boss.session)('POST', '/internal/status/incidents', body);
    expect(created.statusCode).toBe(201);
    const id = created.json().incident.id as string;
    expect((await as(mod.session)('POST', `/internal/status/incidents/${id}/resolve`, {})).statusCode).toBe(
      403,
    );

    const list = await as(mod.session)('GET', '/internal/status/incidents?state=active');
    expect(list.statusCode).toBe(200);
    expect(list.json().incidents.map((i: { id: string }) => i.id)).toContain(id);

    const rows = await audit(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'status.incident.open',
      targetType: 'incident',
      actorUserId: boss.id,
      actorRole: 'admin',
    });
    expect(rows[0]!.details).toMatchObject({ impact: 'minor', components: ['api'] });
  });

  it('refuses anonymous callers and players', async () => {
    const player = await api.account();
    for (const token of [undefined, player.accessToken]) {
      const res = await api.req('POST', '/internal/status/incidents', {
        ...(token ? { token } : {}),
        body: { title: 'x', impact: 'minor', message: 'x' },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await api.req('GET', '/internal/status/incidents')).statusCode).toBe(401);
  });

  it('audits every update and resolution, and nothing for a refused one', async () => {
    const inc = await open();
    const upd = await admin('POST', `/internal/status/incidents/${inc.id}/updates`, {
      status: 'identified',
      message: 'A queue worker is stuck.',
      impact: 'critical',
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().incident).toMatchObject({ status: 'identified', impact: 'critical' });
    const res = await admin('POST', `/internal/status/incidents/${inc.id}/resolve`, {});
    expect(res.statusCode).toBe(200);
    const done = res.json().incident;
    expect(done.status).toBe('resolved');
    expect(done.resolvedAt).toBe(START);
    expect(done.updates.map((u: { status: string }) => u.status)).toEqual([
      'resolved',
      'identified',
      'investigating',
    ]);
    expect(done.updates[0].message).toBe('This incident has been resolved.');
    expect((await audit(inc.id)).map((r) => r.action)).toEqual([
      'status.incident.open',
      'status.incident.update',
      'status.incident.resolve',
    ]);

    const missing = '00000000-0000-4000-8000-00000000abcd';
    const nope = await admin('POST', `/internal/status/incidents/${missing}/updates`, {
      status: 'monitoring',
      message: 'x',
    });
    expect(nope.statusCode).toBe(404);
    expect(await audit(missing)).toEqual([]);
  });

  it('reopens a resolved incident on a non-resolved update', async () => {
    const inc = await open();
    await admin('POST', `/internal/status/incidents/${inc.id}/resolve`, { message: 'Fixed.' });
    const back = await admin('POST', `/internal/status/incidents/${inc.id}/updates`, {
      status: 'investigating',
      message: 'It is back.',
    });
    expect(back.json().incident).toMatchObject({ status: 'investigating', resolvedAt: null });
    await admin('POST', `/internal/status/incidents/${inc.id}/resolve`, {});
  });
});

describe('incident input', () => {
  it('validates impact, status, components, lengths and ids', async () => {
    const post = (body: Record<string, unknown>) =>
      admin('POST', '/internal/status/incidents', {
        title: 'Fine title',
        impact: 'minor',
        message: 'ok',
        ...body,
      });
    for (const bad of [
      { impact: 'apocalyptic' },
      { status: 'panicking' },
      { components: ['database'] },
      { components: ['gameservers:<b>'] },
      { title: 'x'.repeat(121) },
      { title: '  ' },
      { message: 'x'.repeat(2001) },
      { message: '\u0000\u0001' },
      { extra: true },
    ])
      expect((await post(bad)).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    expect((await admin('POST', '/internal/status/incidents/not-a-uuid/resolve', {})).statusCode).toBe(400);
    expect((await post({ components: ['gameservers:eu', 'api', 'api'] })).json().incident.components).toEqual(
      ['gameservers:eu', 'api'],
    );
  });

  it('stores markup as plain text, strips control characters, and escapes it in the Atom feed', async () => {
    const title = '<img src=x onerror=alert(1)> & "quotes"';
    const inc = await open({
      title,
      message: 'Line one\r\nLine two\u0007 <script>alert(1)</script>\u202e',
      components: [],
    });
    const fetched = (await admin('GET', '/internal/status/incidents'))
      .json()
      .incidents.find((i: { id: string }) => i.id === inc.id);
    expect(fetched.title).toBe(title);
    expect(fetched.updates[0].message).toBe('Line one\nLine two <script>alert(1)</script>');

    const atom = await api.req('GET', '/status/feed.atom');
    expect(atom.body).not.toContain('<img');
    expect(atom.body).not.toContain('<script>');
    expect(atom.body).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
    expect(atom.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    await admin('POST', `/internal/status/incidents/${inc.id}/resolve`, {});
  });
});

describe('incidents on the public page', () => {
  it('shows open incidents in the summary at once and resolved ones only in the history', async () => {
    // Warm the summary cache (60 s in this suite); a write must still show at once.
    await api.req('GET', '/status/summary');
    const inc = await open({ title: 'Chat is down', impact: 'critical', components: ['chat'] });
    let summary = (await api.req('GET', '/status/summary')).json();
    expect(summary.incidents.map((i: { id: string }) => i.id)).toContain(inc.id);
    expect(summary.components.find((c: { id: string }) => c.id === 'chat').state).toBe('major_outage');
    expect(summary.overall).toBe('partial_outage');
    const pub = summary.incidents.find((i: { id: string }) => i.id === inc.id);
    expect(Object.keys(pub).sort()).toEqual([
      'components',
      'id',
      'impact',
      'resolvedAt',
      'startedAt',
      'status',
      'title',
      'updatedAt',
      'updates',
    ]);
    for (const u of pub.updates) expect(Object.keys(u).sort()).toEqual(['at', 'message', 'status']);
    const body = JSON.stringify(summary);
    expect(body).not.toMatch(/operator token|actor|10\.77\./);

    api.clock.advance(3_600_000);
    await admin('POST', `/internal/status/incidents/${inc.id}/resolve`, { message: 'Chat is back.' });
    summary = (await api.req('GET', '/status/summary')).json();
    expect(summary.incidents.map((i: { id: string }) => i.id)).not.toContain(inc.id);
    const history = (await api.req('GET', '/status/history')).json();
    const past = history.incidents.find((i: { id: string }) => i.id === inc.id);
    expect(past).toMatchObject({ status: 'resolved', resolvedAt: '2026-10-05T13:00:00.000Z' });
  });
});

describe('feeds', () => {
  it('serves a valid JSON Feed 1.1 with plain-text items', async () => {
    const inc = await open({ title: 'Store purchases failing', components: ['store'] });
    const res = await api.req('GET', '/status/feed.json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/feed+json');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const feed = res.json();
    expect(feed).toMatchObject({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Tumble Royale status',
      home_page_url: 'http://localhost:5173/status',
      feed_url: 'http://localhost:7360/status/feed.json',
    });
    const item = feed.items.find((i: { id: string }) => i.id === `urn:uuid:${inc.id}`);
    expect(item).toMatchObject({
      url: `http://localhost:5173/status#incident-${inc.id}`,
      title: 'Investigating: Store purchases failing',
      tags: ['major', 'investigating'],
    });
    expect(item.content_text).toContain('Affected: Store & payments.');
    expect(item).not.toHaveProperty('content_html');
    for (const i of feed.items) {
      expect(typeof i.id).toBe('string');
      expect(Number.isFinite(Date.parse(i.date_published))).toBe(true);
    }
  });

  it('serves well-formed Atom with one entry per incident', async () => {
    const res = await api.req('GET', '/status/feed.atom');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/atom+xml');
    const xml = res.body;
    expect(
      xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'),
    ).toBe(true);
    expect(xml.trimEnd().endsWith('</feed>')).toBe(true);
    const entries = xml.match(/<entry>/g)?.length ?? 0;
    expect(entries).toBeGreaterThan(0);
    expect(xml.match(/<\/entry>/g)?.length).toBe(entries);
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost:7360/status/feed.atom"/>',
    );
    // Every tag is one the feed writes: no markup leaked out of the text.
    const tags = new Set([...xml.matchAll(/<\/?([a-zA-Z?]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(
      [
        '?xml',
        'author',
        'category',
        'content',
        'entry',
        'feed',
        'id',
        'link',
        'name',
        'published',
        'title',
        'updated',
      ].sort(),
    );
    for (const m of xml.matchAll(/<(published|updated)>([^<]*)</g))
      expect(Number.isFinite(Date.parse(m[2]!)), m[0]).toBe(true);
  });

  it('serves an empty but valid feed on a fresh install', async () => {
    const fresh = await createTestApi(START);
    try {
      expect((await fresh.req('GET', '/status/feed.json')).json().items).toEqual([]);
      const atom = (await fresh.req('GET', '/status/feed.atom')).body;
      expect(atom).toContain(`<updated>${START}</updated>`);
      expect(atom).not.toContain('<entry>');
    } finally {
      await fresh.close();
    }
  });
});
