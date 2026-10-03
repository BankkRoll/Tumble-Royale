import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEWS_POSTS, NewsPostSchema, newsPost } from '../src/news/index.ts';
import { roundCatalog } from '../src/rounds/index.ts';

const BANNED = /fall\s*guys|\bbeans?\b|mediatonic|\bepic games\b/i;
const PUBLIC_DIR = fileURLToPath(new URL('../../../apps/client/public', import.meta.url));

/** Every image URL a post references: the hero plus inline image blocks. */
function imagesOf(post: (typeof NEWS_POSTS)[number]): string[] {
  const inline = post.body.flatMap((b) => (b.type === 'image' ? [b.src] : []));
  return post.image ? [post.image, ...inline] : inline;
}

/** All player-visible text of a post. */
function textOf(post: (typeof NEWS_POSTS)[number]): string[] {
  return [
    post.title,
    post.summary,
    ...post.body.flatMap((b) => {
      if (b.type === 'list') return b.items;
      if (b.type === 'image') return b.caption ? [b.caption] : [];
      return [b.text];
    }),
  ];
}

describe('news feed', () => {
  it('has posts that pass the schema', () => {
    expect(NEWS_POSTS.length).toBeGreaterThan(0);
    for (const p of NEWS_POSTS) expect(() => NewsPostSchema.parse(p)).not.toThrow();
  });

  it('ids are unique and resolvable', () => {
    const ids = NEWS_POSTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(newsPost(id)?.id).toBe(id);
    expect(newsPost('no-such-post')).toBeUndefined();
  });

  it('dates are valid ISO days, sorted newest first', () => {
    for (const p of NEWS_POSTS) {
      const d = new Date(`${p.date}T00:00:00Z`);
      expect(Number.isNaN(d.getTime()), p.id).toBe(false);
      expect(d.toISOString().slice(0, 10), p.id).toBe(p.date);
    }
    const dates = NEWS_POSTS.map((p) => p.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('every roundId is a registered round', () => {
    const catalog = roundCatalog();
    for (const p of NEWS_POSTS) if (p.roundId) expect(catalog.has(p.roundId), `${p.id} → ${p.roundId}`).toBe(true);
  });

  it('every referenced image exists under apps/client/public', () => {
    for (const p of NEWS_POSTS) {
      for (const src of imagesOf(p)) expect(existsSync(`${PUBLIC_DIR}${src}`), `${p.id}: ${src}`).toBe(true);
    }
  });

  it('the round guide shows every round still that is on disk for a real round', () => {
    const guide = newsPost('meet-the-rounds')!;
    const catalog = roundCatalog();
    for (const src of imagesOf(guide).filter((s) => s.startsWith('/news/rounds/'))) {
      expect(catalog.has(src.replace('/news/rounds/', '').replace('.jpg', '')), src).toBe(true);
    }
  });

  it('uses only original names', () => {
    for (const p of NEWS_POSTS) for (const t of textOf(p)) expect(t, p.id).not.toMatch(BANNED);
  });
});
