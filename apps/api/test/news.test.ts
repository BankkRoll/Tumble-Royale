import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newsPosts } from '../src/db/schema.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // After every post date used here, so none of them is still scheduled.
  api = await createTestApi('2099-01-02T12:00:00.000Z');
});
afterAll(async () => {
  await api.close();
});

const post = {
  id: 'live-hotfix-notes',
  title: 'Hotfix: bouncier bounce pads',
  summary: 'A quick tune-up, live now.',
  body: [{ type: 'paragraph', text: 'Bounce pads now bounce a little more.' }],
  tag: 'PATCH NOTES',
  date: '2099-01-01',
  image: 'https://cdn.example.com/hotfix.jpg',
  art: ['#ff6fb5', '#ffd23f'],
  icon: '🛠️',
};

describe('live news', () => {
  it('serves the bundled feed to anyone', async () => {
    const res = await api.req('GET', '/news');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.json().posts.length).toBeGreaterThan(0);
  });

  it('only lets the admin publish, and validates posts', async () => {
    expect((await api.req('POST', '/internal/news', { body: post })).statusCode).toBe(401);
    expect((await api.req('POST', '/internal/news', { body: post, token: 'nope' })).statusCode).toBe(401);
    const bad = await api.req('POST', '/internal/news', {
      body: { ...post, id: 'Bad Id' },
      token: ADMIN_TOKEN,
    });
    expect(bad.statusCode).toBe(400);
    const js = await api.req('POST', '/internal/news', {
      body: { ...post, image: 'javascript:alert(1)' },
      token: ADMIN_TOKEN,
    });
    expect(js.statusCode).toBe(400);
  });

  it('merges published posts over the bundled feed, newest first', async () => {
    const bundled = (await api.req('GET', '/news')).json().posts as { id: string }[];
    expect((await api.req('POST', '/internal/news', { body: post, token: ADMIN_TOKEN })).statusCode).toBe(
      201,
    );
    const feed = (await api.req('GET', '/news')).json().posts as { id: string; title: string }[];
    expect(feed[0]).toMatchObject({ id: post.id, title: post.title });
    expect(feed).toHaveLength(bundled.length + 1);

    const edited = { ...post, title: 'Hotfix: even bouncier' };
    await api.req('POST', '/internal/news', { body: edited, token: ADMIN_TOKEN });
    const after = (await api.req('GET', '/news')).json().posts as { id: string; title: string }[];
    expect(after[0]!.title).toBe(edited.title);
    expect(after).toHaveLength(bundled.length + 1);
  });

  it('withdraws posts, bundled ones included', async () => {
    const before = (await api.req('GET', '/news')).json().posts as { id: string }[];
    const target = before.find((p) => p.id !== post.id)!;
    const res = await api.req('POST', '/internal/news', {
      body: { ...post, id: target.id, hidden: true },
      token: ADMIN_TOKEN,
    });
    expect(res.statusCode).toBe(201);
    const after = (await api.req('GET', '/news')).json().posts as { id: string }[];
    expect(after.some((p) => p.id === target.id)).toBe(false);
    expect((await api.req('GET', '/news')).json().withdrawn).toEqual([target.id]);
    expect(after).toHaveLength(before.length - 1);
  });

  it('answers 201 for a new post and 200 for a correction', async () => {
    const fresh = { ...post, id: 'live-status-codes' };
    const created = await api.req('POST', '/internal/news', { body: fresh, token: ADMIN_TOKEN });
    expect(created.statusCode).toBe(201);
    const edited = await api.req('POST', '/internal/news', {
      body: { ...fresh, title: 'Corrected' },
      token: ADMIN_TOKEN,
    });
    expect(edited.statusCode).toBe(200);
  });

  it('holds a post back until its date', async () => {
    const scheduled = { ...post, id: 'live-scheduled', date: '2099-02-01' };
    await api.req('POST', '/internal/news', { body: scheduled, token: ADMIN_TOKEN });
    const ids = () =>
      api.req('GET', '/news').then((r) => (r.json().posts as { id: string }[]).map((p) => p.id));
    expect(await ids()).not.toContain(scheduled.id);
    api.clock.set('2099-02-01T00:00:00.000Z');
    expect(await ids()).toContain(scheduled.id);
  });

  it('lists every withdrawal however many posts came after it', async () => {
    const old = { ...post, id: 'live-withdrawn-long-ago', hidden: true };
    await api.req('POST', '/internal/news', { body: old, token: ADMIN_TOKEN });
    await api.ctx.db.insert(newsPosts).values(
      Array.from({ length: 205 }, (_, i) => ({
        id: `live-filler-${i}`,
        data: { ...post, id: `live-filler-${i}` },
        hidden: false,
        publishedAt: new Date(api.clock.now().getTime() + i + 1),
        updatedAt: api.clock.now(),
      })),
    );
    const feed = (await api.req('GET', '/news')).json();
    expect(feed.withdrawn).toContain(old.id);
  });
});
