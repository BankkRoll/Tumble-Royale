import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
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
});
