/**
 * Limited-time events: catalogue invariants (ids, windows, tiers, reward
 * references, the per-event currency budget), the schema refusing broken
 * events, window phases at exact instants, override merging and scoring.
 */
import { describe, expect, it } from 'vitest';
import { COSMETICS, getCosmetic } from '../src/cosmetics/index.ts';
import {
  ALL_CHALLENGES,
  ACHIEVEMENTS,
  cosmeticSources,
  EVENT_CURRENCY_BUDGET,
  eventChallengeIncrement,
  eventChallengeTitle,
  eventPhase,
  eventRewardTotals,
  eventShowMetrics,
  eventShowPoints,
  eventTiersReached,
  getLiveEvent,
  LIVE_EVENTS,
  LiveEventSchema,
  MAX_EVENT_DAYS,
  mergeEventWindow,
  PASS_TRACKS,
  type EventShowFacts,
  type LiveEvent,
} from '../src/progression/index.ts';
import { PLAYLISTS } from '../src/shows/index.ts';

const facts = (over: Partial<EventShowFacts> = {}): EventShowFacts => ({
  playlistId: 'main-show',
  roundsQualified: 0,
  qualifiedByType: {},
  reachedFinal: false,
  crowned: false,
  placement: 50,
  ...over,
});

/** A minimal valid event to break one field at a time. */
function sample(): Record<string, unknown> {
  const e = LIVE_EVENTS[0]!;
  return JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
}

describe('event catalogue', () => {
  it('ships a current and an upcoming event with unique ids', () => {
    expect(LIVE_EVENTS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(LIVE_EVENTS.map((e) => e.id)).size).toBe(LIVE_EVENTS.length);
    // Relative to the launch date the samples were written for (2026-10-04).
    const launch = Date.parse('2026-10-04T12:00:00Z');
    expect(LIVE_EVENTS.map((e) => eventPhase(e, launch))).toEqual(['live', 'upcoming']);
  });

  it('has valid, bounded, non-overlapping windows', () => {
    const sorted = [...LIVE_EVENTS].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    for (const [i, e] of sorted.entries()) {
      const start = Date.parse(e.startsAt);
      const end = Date.parse(e.endsAt);
      expect(end, e.id).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(MAX_EVENT_DAYS * 86_400_000);
      if (i > 0) expect(start).toBeGreaterThanOrEqual(Date.parse(sorted[i - 1]!.endsAt));
    }
  });

  it('features playlists that exist', () => {
    const ids = new Set(PLAYLISTS.map((p) => p.id));
    for (const e of LIVE_EVENTS)
      for (const p of e.playlistIds) expect(ids.has(p), `${e.id}: ${p}`).toBe(true);
  });

  it('numbers tiers 1..n with strictly rising thresholds and one reward per kind', () => {
    for (const e of LIVE_EVENTS) {
      expect(e.tiers.map((t) => t.tier)).toEqual(e.tiers.map((_, i) => i + 1));
      for (let i = 1; i < e.tiers.length; i++)
        expect(e.tiers[i]!.points).toBeGreaterThan(e.tiers[i - 1]!.points);
      for (const t of e.tiers) {
        const kinds = t.rewards.filter((r) => r.kind !== 'cosmetic').map((r) => r.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
      }
    }
  });

  it('rewards only event cosmetics that exist, each on exactly one track', () => {
    const seen = new Map<string, string>();
    for (const e of LIVE_EVENTS)
      for (const t of e.tiers)
        for (const r of t.rewards) {
          if (r.kind !== 'cosmetic') continue;
          expect(getCosmetic(r.itemId)?.source, r.itemId).toBe('event');
          expect(seen.has(r.itemId), r.itemId).toBe(false);
          seen.set(r.itemId, e.id);
        }
    // Event items never leak into a pass, an achievement or a challenge.
    for (const track of Object.values(PASS_TRACKS))
      for (const t of track.tiers)
        for (const r of [...t.free, ...t.premium])
          if (r.kind === 'cosmetic') expect(seen.has(r.itemId)).toBe(false);
    for (const a of ACHIEVEMENTS)
      for (const r of a.rewards) if (r.kind === 'cosmetic') expect(seen.has(r.itemId)).toBe(false);
    for (const c of ALL_CHALLENGES.values())
      if (c.rewardCosmetic) expect(seen.has(c.rewardCosmetic)).toBe(false);
    for (const id of seen.keys()) expect(COSMETICS.find((c) => c.id === id)?.price).toBeNull();
  });

  it('labels event cosmetics with their event and tier in the collection log', () => {
    const e = LIVE_EVENTS[0]!;
    const t = e.tiers.find((x) => x.rewards.some((r) => r.kind === 'cosmetic'))!;
    const id = (t.rewards.find((r) => r.kind === 'cosmetic') as { itemId: string }).itemId;
    expect(cosmeticSources(id)).toEqual([{ kind: 'event', label: `${e.name} event tier ${t.tier}` }]);
  });

  it('keeps every event inside the currency budget and its top tier reachable', () => {
    for (const e of LIVE_EVENTS) {
      const totals = eventRewardTotals(e);
      for (const k of Object.keys(EVENT_CURRENCY_BUDGET) as (keyof typeof EVENT_CURRENCY_BUDGET)[])
        expect(totals[k], `${e.id} ${k}`).toBeLessThanOrEqual(EVENT_CURRENCY_BUDGET[k]);
      // A steady player: two featured shows a day qualifying twice, plus every challenge.
      const days = (Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 86_400_000;
      const perShow = eventShowPoints(e, facts({ playlistId: e.playlistIds[0]!, roundsQualified: 2 }));
      const challengePoints = e.challenges.reduce((s, c) => s + c.points, 0);
      expect(perShow * 2 * days + challengePoints).toBeGreaterThanOrEqual(e.tiers.at(-1)!.points);
    }
  });

  it('gives every challenge a positive target and a readable title', () => {
    for (const e of LIVE_EVENTS)
      for (const c of e.challenges) {
        expect(c.target).toBeGreaterThan(0);
        expect(eventChallengeTitle(c)).not.toContain('{n}');
      }
    expect(eventChallengeTitle({ description: 'Play {n} shows', target: 1500 })).toBe('Play 1,500 shows');
  });
});

describe('event schema', () => {
  const bad = (patch: (e: Record<string, unknown>) => void): boolean => {
    const e = sample();
    patch(e);
    return LiveEventSchema.safeParse(e).success;
  };

  it('accepts a bundled event as is', () => {
    expect(bad(() => undefined)).toBe(true);
  });

  it('refuses inverted, empty and overlong windows', () => {
    expect(bad((e) => (e.endsAt = e.startsAt))).toBe(false);
    expect(bad((e) => (e.endsAt = '2026-09-01T00:00:00Z'))).toBe(false);
    expect(bad((e) => (e.endsAt = '2027-06-01T00:00:00Z'))).toBe(false);
    expect(bad((e) => (e.startsAt = 'next tuesday'))).toBe(false);
  });

  it('refuses overlapping or out-of-order tiers', () => {
    expect(
      bad((e) => {
        const tiers = e.tiers as { points: number }[];
        tiers[1]!.points = tiers[0]!.points;
      }),
    ).toBe(false);
    expect(
      bad((e) => {
        const tiers = e.tiers as { tier: number }[];
        tiers[0]!.tier = 2;
      }),
    ).toBe(false);
  });

  it('refuses unknown, non-event or repeated rewards', () => {
    const setReward = (r: unknown) => (e: Record<string, unknown>) => {
      (e.tiers as { rewards: unknown[] }[])[0]!.rewards = [r];
    };
    expect(bad(setReward({ kind: 'cosmetic', itemId: 'headwear.nope' }))).toBe(false);
    expect(bad(setReward({ kind: 'cosmetic', itemId: 'color.bubblegum' }))).toBe(false);
    expect(
      bad((e) => {
        (e.tiers as { rewards: unknown[] }[])[0]!.rewards = [
          { kind: 'gumballs', amount: 10 },
          { kind: 'gumballs', amount: 10 },
        ];
      }),
    ).toBe(false);
    expect(bad(setReward({ kind: 'gumballs', amount: 0 }))).toBe(false);
  });

  it('refuses a currency total over the budget', () => {
    expect(
      bad((e) => {
        (e.tiers as { rewards: unknown[] }[])[0]!.rewards = [
          { kind: 'gems', amount: EVENT_CURRENCY_BUDGET.gems + 1 },
        ];
      }),
    ).toBe(false);
  });

  it('refuses unknown playlists, themes and duplicate challenge ids', () => {
    expect(bad((e) => (e.playlistIds = ['no-such-show']))).toBe(false);
    expect(bad((e) => (e.themeId = 'lava-land'))).toBe(false);
    expect(
      bad((e) => {
        const list = e.challenges as unknown[];
        list.push(list[0]);
      }),
    ).toBe(false);
  });
});

describe('event windows', () => {
  const w = { startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' };

  it('is half-open: live from the first instant, over at the end instant', () => {
    expect(eventPhase(w, Date.parse(w.startsAt) - 1)).toBe('upcoming');
    expect(eventPhase(w, Date.parse(w.startsAt))).toBe('live');
    expect(eventPhase(w, Date.parse(w.endsAt) - 1)).toBe('live');
    expect(eventPhase(w, Date.parse(w.endsAt))).toBe('ended');
  });

  it('lets an override replace the bundled window wholesale', () => {
    const e = getLiveEvent('moonlit-mischief')!;
    expect(mergeEventWindow(e, null)).toEqual({ startsAt: e.startsAt, endsAt: e.endsAt, enabled: true });
    const o = { id: e.id, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-06T00:00:00Z', enabled: false };
    expect(mergeEventWindow(e, o)).toEqual({ startsAt: o.startsAt, endsAt: o.endsAt, enabled: false });
    expect(getLiveEvent('nope')).toBeUndefined();
  });
});

describe('event scoring', () => {
  const e: LiveEvent = getLiveEvent('moonlit-mischief')!;
  const r = e.points;

  it('pays per show, per qualified round, for a final and a Crown', () => {
    expect(eventShowPoints(e, facts())).toBe(r.perShow);
    expect(eventShowPoints(e, facts({ roundsQualified: 3 }))).toBe(r.perShow + 3 * r.perQualifiedRound);
    expect(eventShowPoints(e, facts({ roundsQualified: 4, reachedFinal: true, crowned: true }))).toBe(
      r.perShow + 4 * r.perQualifiedRound + r.finalReached + r.crown,
    );
  });

  it('multiplies shows in the featured playlists', () => {
    const plain = eventShowPoints(e, facts({ roundsQualified: 2 }));
    expect(eventShowPoints(e, facts({ roundsQualified: 2, playlistId: e.playlistIds[0]! }))).toBe(
      Math.round(plain * r.eventPlaylistMultiplier),
    );
  });

  it('counts challenge metrics, scoped to featured playlists where asked', () => {
    const show = facts({
      roundsQualified: 3,
      qualifiedByType: { race: 1, survival: 1, final: 1 },
      reachedFinal: true,
      crowned: true,
      placement: 1,
    });
    expect(eventShowMetrics(show)).toMatchObject({
      showsPlayed: 1,
      roundsQualified: 3,
      racesQualified: 1,
      survivalsQualified: 1,
      teamRoundsWon: 0,
      finalsReached: 1,
      crowns: 1,
      topTenFinishes: 1,
    });
    const scoped = e.challenges.find((c) => c.eventPlaylistsOnly && c.metric === 'crowns')!;
    expect(eventChallengeIncrement(e, scoped, show)).toBe(0);
    expect(eventChallengeIncrement(e, scoped, { ...show, playlistId: e.playlistIds[0]! })).toBe(1);
    const open = e.challenges.find((c) => !c.eventPlaylistsOnly && c.metric === 'racesQualified')!;
    expect(eventChallengeIncrement(e, open, show)).toBe(1);
  });

  it('reaches tiers exactly at their thresholds', () => {
    expect(eventTiersReached(e, 0)).toBe(0);
    expect(eventTiersReached(e, e.tiers[0]!.points - 1)).toBe(0);
    expect(eventTiersReached(e, e.tiers[0]!.points)).toBe(1);
    expect(eventTiersReached(e, e.tiers.at(-1)!.points * 10)).toBe(e.tiers.length);
  });
});
