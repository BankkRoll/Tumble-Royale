/**
 * Live news from the account API merged over the news bundled with the
 * client. The bundled posts are the offline fallback; the last live feed is
 * cached per device so it survives going offline. Unread tracking is
 * unchanged (`newsRead` in `meta.ts`).
 */
import { NEWS_POSTS, type NewsPost } from '@tumble/content/news';
import { loadJson, saveJson } from './storage.ts';

/** The cached live feed. */
export interface LiveNewsCache {
  posts: NewsPost[];
  withdrawn: string[];
  /** Epoch ms of the fetch. */
  fetchedAt: number;
}

const TAGS = new Set(['SEASON', 'ROUNDS', 'HOW TO PLAY', 'PATCH NOTES', 'TIPS', 'EVENT']);
const BLOCKS = new Set(['paragraph', 'heading', 'list', 'image', 'tip']);
const HEX = /^#[0-9a-f]{6}$/i;

// SECURITY: images come from the network, so only site paths and https URLs are rendered.
function safeImage(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('/') || v.startsWith('https://'));
}

/**
 * Validates one post from the API; anything malformed is dropped rather than
 * risking a broken News tab.
 *
 * @param x - Untrusted JSON.
 * @returns The post, or null.
 */
export function parseLivePost(x: unknown): NewsPost | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Record<string, unknown>;
  const str = (k: string): boolean => typeof p[k] === 'string' && (p[k] as string).length > 0;
  if (!str('id') || !/^[a-z0-9-]+$/.test(p.id as string)) return null;
  if (!str('title') || !str('summary') || !str('icon') || !TAGS.has(p.tag as string)) return null;
  if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return null;
  if (
    !Array.isArray(p.art) ||
    p.art.length !== 2 ||
    !p.art.every((c) => typeof c === 'string' && HEX.test(c))
  )
    return null;
  if (p.image !== undefined && !safeImage(p.image)) return null;
  if (!Array.isArray(p.body) || p.body.length === 0) return null;
  for (const b of p.body as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object' || !BLOCKS.has(b.type as string)) return null;
    if (b.type === 'image' && !safeImage(b.src)) return null;
    if (b.type === 'list' && !(Array.isArray(b.items) && b.items.every((i) => typeof i === 'string')))
      return null;
    if (b.type !== 'image' && b.type !== 'list' && typeof b.text !== 'string') return null;
  }
  return p as unknown as NewsPost;
}

/**
 * Bundled posts minus withdrawn ones, overlaid with live posts by id, newest first.
 *
 * @param bundled - Posts shipped with the client.
 * @param live - Cached live feed, or null when never fetched.
 */
export function mergeNews(bundled: readonly NewsPost[], live: LiveNewsCache | null): NewsPost[] {
  if (!live) return [...bundled];
  const withdrawn = new Set(live.withdrawn);
  const byId = new Map<string, NewsPost>();
  for (const p of bundled) if (!withdrawn.has(p.id)) byId.set(p.id, p);
  for (const p of live.posts) if (!withdrawn.has(p.id)) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** The cached live feed, if any. */
export function cachedLiveNews(): LiveNewsCache | null {
  const c = loadJson<LiveNewsCache>('newsLive');
  return c && Array.isArray(c.posts) && Array.isArray(c.withdrawn) ? c : null;
}

/** Every post to show: bundled news with the cached live feed merged over it. */
export function currentNews(): NewsPost[] {
  return mergeNews(NEWS_POSTS, cachedLiveNews());
}

/**
 * Fetches the live feed and caches it. Failures keep the previous cache
 * (or the bundled posts) so the News tab never empties.
 *
 * @param fetchNews - `ApiClient.news`.
 * @returns True when a fresh feed was stored.
 */
export async function refreshLiveNews(
  fetchNews: () => Promise<{ posts: unknown[]; withdrawn?: unknown[] }>,
): Promise<boolean> {
  try {
    const r = await fetchNews();
    const posts = (Array.isArray(r.posts) ? r.posts : []).flatMap((x) => parseLivePost(x) ?? []);
    const withdrawn = (Array.isArray(r.withdrawn) ? r.withdrawn : []).filter(
      (x): x is string => typeof x === 'string',
    );
    saveJson('newsLive', { posts, withdrawn, fetchedAt: Date.now() } satisfies LiveNewsCache);
    return true;
  } catch {
    return false;
  }
}
