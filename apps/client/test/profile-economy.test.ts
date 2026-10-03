/**
 * Offline economy in the local profile: season rollover, the Crown Shard
 * shop and free Gem earn paths, driven by an injected clock.
 */
import {
  GEM_EARN,
  PASS_DUPLICATE_GUMBALLS,
  SEASON_PASS,
  SHARDS_PER_CROWN,
  shardShopAt,
  xpForLevel,
} from '@tumble/content/progression';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProfileStore, type ShowResultForProfile } from '../src/game/profile.ts';

class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const storage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

const colors = { primary: '#ff6fb5', secondary: '#ffd23f', tertiary: '#7c5cff', pattern: 'plain' as const };
const KEY = 'tumble.v1.profile';

function clock(iso: string): { now: () => number; set: (iso: string) => void } {
  let t = Date.parse(iso);
  return { now: () => t, set: (x) => (t = Date.parse(x)) };
}

function saved(): Record<string, unknown> {
  return JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>;
}

function patch(p: Record<string, unknown>): void {
  storage.setItem(KEY, JSON.stringify({ ...saved(), ...p }));
}

function show(won: boolean): ShowResultForProfile {
  return {
    playlistName: 'Main Show',
    rounds: [
      { name: 'Gumdrop Gauntlet', type: 'race', qualified: true },
      { name: 'Final', type: 'final', qualified: won },
    ],
    reachedFinal: true,
    wonCrown: won,
    place: won ? 1 : 2,
    participants: 40,
    quit: false,
    counters: {},
  };
}

const xpForTiers = (n: number): number => SEASON_PASS.tiers.slice(0, n).reduce((s, t) => s + t.xp, 0);

beforeEach(() => storage.clear());

describe('offline season rollover', () => {
  it('reports the live season and the next one', () => {
    const c = clock('2026-11-20T00:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    const pass = p.uiPass();
    expect(pass.seasonNumber).toBe(1);
    expect(pass.endsAt).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(pass.nextSeason).toMatchObject({ number: 2, startsAt: Date.parse('2026-12-01T00:00:00Z') });
  });

  it('auto-grants unclaimed rewards once, resets the pass and keeps history', () => {
    const c = clock('2026-11-20T00:00:00Z');
    new ProfileStore(false, c.now).create('Sprinkles', colors);
    patch({ seasonXp: xpForTiers(3), premiumPass: true, passClaimed: ['1:free'], gems: 0, gumballs: 0 });

    let p = new ProfileStore(false, c.now);
    expect(p.uiPass().currentTier).toBe(3);
    c.set('2026-12-01T00:00:01Z');
    p = new ProfileStore(false, c.now);
    const pass = p.uiPass();
    expect(pass).toMatchObject({ seasonNumber: 2, currentTier: 0, premium: false });
    expect(p.seasonHistory()).toHaveLength(1);
    expect(p.seasonHistory()[0]).toMatchObject({ seasonId: 's1', tier: 3, premium: true, autoGranted: 5 });
    for (const t of SEASON_PASS.tiers.slice(0, 3))
      for (const r of [...t.free.slice(t.tier === 1 ? 1 : 0), ...t.premium])
        if (r.kind === 'cosmetic') expect(p.owns(r.itemId)).toBe(true);

    const wallet = { gems: saved().gems, gumballs: saved().gumballs };
    // Idempotent: reloading or re-reading never grants again.
    p = new ProfileStore(false, c.now);
    p.uiPass();
    p.uiProfile();
    expect({ gems: saved().gems, gumballs: saved().gumballs }).toEqual(wallet);
    expect(p.seasonHistory()).toHaveLength(1);
    // Season 2 progress starts fresh and claims work against the new track.
    expect(p.claimPassTier(1, 'free')).toBe(false);
  });

  it('treats saves from before rollover as Season 1 and ignores a clock running backwards', () => {
    const c = clock('2026-11-20T00:00:00Z');
    new ProfileStore(false, c.now).create('Sprinkles', colors);
    patch({ seasonId: undefined, seasonXp: xpForTiers(1) });
    c.set('2027-01-10T00:00:00Z');
    const p = new ProfileStore(false, c.now);
    expect(p.seasonHistory()[0]).toMatchObject({ seasonId: 's1', autoGranted: 1 });
    c.set('2026-10-01T00:00:00Z');
    expect(p.rollSeason()).toBeNull();
    expect(saved().seasonId).toBe('s2');
  });

  it('pays Gumballs for a pass cosmetic the player already owns', () => {
    const c = clock('2026-10-02T00:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    const tier = SEASON_PASS.tiers.find((t) => t.free[0]?.kind === 'cosmetic')!;
    const r = tier.free[0] as { itemId: string };
    patch({ seasonXp: xpForTiers(tier.tier), owned: [r.itemId], gumballs: 0 });
    const q = new ProfileStore(false, c.now);
    expect(q.claimPassTier(tier.tier, 'free')).toBe(true);
    expect(saved().gumballs).toBe(PASS_DUPLICATE_GUMBALLS);
  });
});

describe('offline Crown Shard shop', () => {
  it("sells this week's shelf for shards", () => {
    const c = clock('2026-10-02T00:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    const shop = p.uiStore().shardShop!;
    const offer = shardShopAt(new Date(c.now())).offers[0]!;
    expect(shop.offers.map((o) => o.id)).toContain(`shards:${offer.itemId}`);
    expect(shop.rotationEndsAt).toBe(Date.parse('2026-10-05T00:00:00Z'));

    expect(p.purchase(`shards:${offer.itemId}`)).toEqual({ error: 'funds' });
    patch({ crownShards: offer.price + 2 });
    const q = new ProfileStore(false, c.now);
    expect('item' in q.purchase(`shards:${offer.itemId}`)).toBe(true);
    expect(saved().crownShards).toBe(2);
    expect(q.owns(offer.itemId)).toBe(true);
    expect(q.purchase(`shards:${offer.itemId}`)).toEqual({ error: 'owned' });
    expect(q.purchase('shards:headwear.tiara')).toEqual({ error: 'unknown' });
  });

  it('converts every full set of shards into a Crown like the API', () => {
    const c = clock('2026-10-02T00:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    patch({ crownShards: SHARDS_PER_CROWN - 1, crowns: 0 });
    const q = new ProfileStore(false, c.now);
    const summary = q.applyShow(show(false));
    expect(saved().crownShards).toBe(0);
    expect(saved().crowns).toBe(1);
    expect(summary.crowns).toBe(1);
  });
});

describe('offline free Gems', () => {
  it('pays the first Crown of each day once', () => {
    const c = clock('2026-10-02T10:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    patch({ gems: 0, totalXp: xpForLevel(2) });
    const q = new ProfileStore(false, c.now);
    const gemsAfter = (): number => Number(saved().gems);
    q.applyShow(show(true));
    const first = gemsAfter();
    expect(first).toBeGreaterThanOrEqual(GEM_EARN.firstCrownOfDay);
    q.applyShow(show(true));
    const second = gemsAfter() - first;
    c.set('2026-10-03T10:00:00Z');
    q.applyShow(show(true));
    const third = gemsAfter() - first - second;
    // Second Crown of the same day pays no daily bonus (level milestones aside).
    expect(second % GEM_EARN.levelMilestone).toBe(0);
    expect(third % GEM_EARN.levelMilestone).toBe(GEM_EARN.firstCrownOfDay % GEM_EARN.levelMilestone);
    expect(q.lastCrownDay).toBe('2026-10-03');
  });

  it('shows and pays Gems on weekly challenges', () => {
    const c = clock('2026-10-02T10:00:00Z');
    const p = new ProfileStore(false, c.now);
    p.create('Sprinkles', colors);
    const weekly = p.uiChallenges().list.find((x) => x.cadence === 'weekly')!;
    expect(weekly.gems).toBe(GEM_EARN.weeklyChallenge);
    expect(p.uiChallenges().list.find((x) => x.cadence === 'daily')!.gems).toBeUndefined();
    const s = saved() as { weekly: { counts: Record<string, number> } };
    patch({ gems: 0, weekly: { ...s.weekly, counts: { [weekly.metric!]: weekly.goal } } });
    const q = new ProfileStore(false, c.now);
    expect(q.claimChallenge(weekly.id)).toBe(true);
    expect(Number(saved().gems) % GEM_EARN.levelMilestone).toBe(GEM_EARN.weeklyChallenge);
  });
});
