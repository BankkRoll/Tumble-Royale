/**
 * Live news merged over bundled news, and the offline notification bell.
 */
import { NEWS_POSTS } from '@tumble/content/news';
import { SEASON_PASS } from '@tumble/content/progression';
import { ui } from '@tumble/ui';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedLiveNews,
  currentNews,
  mergeNews,
  parseLivePost,
  refreshLiveNews,
} from '../src/game/liveNews.ts';
import { deriveNotices, syncLocalNotifications } from '../src/game/localNotifications.ts';
import { ProfileStore } from '../src/game/profile.ts';

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const live = {
  id: 'live-hotfix',
  title: 'Hotfix',
  summary: 'Live now.',
  body: [{ type: 'paragraph', text: 'Bouncier.' }],
  tag: 'PATCH NOTES',
  date: '2099-01-01',
  art: ['#ff6fb5', '#ffd23f'],
  icon: 'x',
};

beforeEach(() => {
  store.clear();
  ui.getState().setNotifications([]);
});

describe('live news', () => {
  it('validates untrusted posts and rejects unsafe images', () => {
    expect(parseLivePost(live)).not.toBeNull();
    expect(parseLivePost({ ...live, image: 'https://cdn.example.com/a.jpg' })).not.toBeNull();
    expect(parseLivePost({ ...live, image: 'javascript:alert(1)' })).toBeNull();
    expect(parseLivePost({ ...live, body: [{ type: 'image', src: 'http://x/a.png' }] })).toBeNull();
    expect(parseLivePost({ ...live, tag: 'NOPE' })).toBeNull();
    expect(parseLivePost(null)).toBeNull();
  });

  it('falls back to bundled news, then merges the live feed over it', async () => {
    expect(currentNews().map((p) => p.id)).toEqual(NEWS_POSTS.map((p) => p.id));
    const withdrawn = NEWS_POSTS[0]!.id;
    const edited = { ...NEWS_POSTS[1]!, title: 'Corrected title' };
    expect(
      await refreshLiveNews(async () => ({ posts: [live, edited, { junk: true }], withdrawn: [withdrawn] })),
    ).toBe(true);
    const merged = currentNews();
    expect(merged[0]!.id).toBe(live.id);
    expect(merged.some((p) => p.id === withdrawn)).toBe(false);
    expect(merged.find((p) => p.id === edited.id)?.title).toBe('Corrected title');
    expect(merged).toHaveLength(NEWS_POSTS.length);
  });

  it('keeps the last feed when a refresh fails', async () => {
    await refreshLiveNews(async () => ({ posts: [live] }));
    expect(
      await refreshLiveNews(async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
    expect(cachedLiveNews()?.posts.map((p) => p.id)).toEqual([live.id]);
    expect(mergeNews([], null)).toEqual([]);
  });
});

describe('offline notifications', () => {
  const colors = { primary: '#ff6fb5', secondary: '#ffd23f', tertiary: '#7c5cff', pattern: 'plain' as const };

  function profileAt(iso: string, patch: Record<string, unknown> = {}): ProfileStore {
    const t = Date.parse(iso);
    const p = new ProfileStore(false, () => t);
    if (!p.exists) p.create('Sprinkles', colors);
    const raw = JSON.parse(store.get('tumble.v1.profile')!) as Record<string, unknown>;
    store.set('tumble.v1.profile', JSON.stringify({ ...raw, ...patch }));
    return new ProfileStore(false, () => t);
  }

  it('is empty for a brand-new Tumbler', () => {
    expect(deriveNotices(profileAt('2026-10-02T10:00:00Z'))).toEqual([]);
  });

  it('announces pass tiers, level ups and the first Crown bonus, deduped across syncs', () => {
    const p = profileAt('2026-10-02T10:00:00Z', {
      seasonXp: SEASON_PASS.tiers[0]!.xp + SEASON_PASS.tiers[1]!.xp,
      totalXp: 5000,
      lastCrownDay: '2026-10-02',
    });
    const first = syncLocalNotifications(p);
    const ids = first.map((n) => n.id);
    expect(ids).toContain('local:pass:s1:tier:2');
    expect(ids).toContain('local:crown-gems:2026-10-02');
    expect(ids.some((id) => id.startsWith('local:level:'))).toBe(true);
    expect(first.every((n) => !n.read)).toBe(true);
    expect(syncLocalNotifications(p)).toHaveLength(first.length);
  });

  it('persists read flags per device and keeps online items untouched', () => {
    const p = profileAt('2026-10-02T10:00:00Z', { totalXp: 5000 });
    syncLocalNotifications(p);
    const s = ui.getState();
    s.setNotifications([
      { id: 'n-online', kind: 'invite', title: 'Invite', time: 1 },
      ...s.notifications.map((n) => ({ ...n, read: true })),
    ]);
    const again = syncLocalNotifications(new ProfileStore(false, () => Date.parse('2026-10-02T10:00:00Z')));
    expect(again.find((n) => n.id === 'n-online')).toBeDefined();
    expect(again.filter((n) => n.id.startsWith('local:')).every((n) => n.read)).toBe(true);
    const saved = JSON.parse(store.get('tumble.v1.notifications')!) as { items: { id: string }[] };
    expect(saved.items.every((n) => n.id.startsWith('local:'))).toBe(true);
  });

  it('announces a new season with the auto-granted rewards', () => {
    profileAt('2026-11-20T00:00:00Z', { seasonXp: SEASON_PASS.tiers[0]!.xp });
    const p = new ProfileStore(false, () => Date.parse('2026-12-02T00:00:00Z'));
    const n = deriveNotices(p).find((x) => x.id === 'local:season:s1:ended');
    expect(n?.title).toContain('Season 2');
    expect(n?.body).toContain('1 unclaimed');
  });

  it('announces a completed challenge and the weekly shard shelf after playing', () => {
    const p = profileAt('2026-10-02T10:00:00Z');
    const weekly = p.uiChallenges().list.find((c) => c.cadence === 'weekly')!;
    const raw = JSON.parse(store.get('tumble.v1.profile')!) as {
      weekly: { counts: Record<string, number> };
      stats: { shows: number };
    };
    raw.weekly.counts[weekly.metric!] = weekly.goal;
    raw.stats.shows = 1;
    store.set('tumble.v1.profile', JSON.stringify(raw));
    const ids = deriveNotices(new ProfileStore(false, () => Date.parse('2026-10-02T10:00:00Z'))).map(
      (n) => n.id,
    );
    expect(ids.some((id) => id.startsWith('local:challenge:weekly:') && id.endsWith(weekly.id))).toBe(true);
    expect(ids).toContain('local:shards:2026-W40');
  });
});
