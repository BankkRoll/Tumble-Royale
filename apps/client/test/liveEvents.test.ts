/**
 * Limited-time events on the client: the bundled events offline, the API's
 * events and progress mapped onto the event screen (device-clock times,
 * phases on the server clock, tier and challenge states), the rewards-screen
 * lines and the note for shows that could not count.
 */
import { LIVE_EVENTS } from '@tumble/content/progression';
import type { RewardsSummary } from '@tumble/ui';
import { describe, expect, it } from 'vitest';
import type { ApiEventProgress, ApiGrant } from '../src/game/api.ts';
import {
  bundledEvents,
  ENDED_EVENT_VISIBLE_MS,
  eventsView,
  offlineEvents,
  rewardEventLines,
  withEventNote,
} from '../src/game/liveEvents.ts';

const moon = LIVE_EVENTS[0]!;
const frost = LIVE_EVENTS[1]!;
const LIVE_AT = Date.parse(moon.startsAt) + 86_400_000;
const grant = (g: ApiGrant) =>
  g.type === 'cosmetic'
    ? null
    : { kind: g.type === 'crown_shards' ? ('crownShards' as const) : g.type, amount: g.amount };

const rewards = (): RewardsSummary => ({
  xpLines: [],
  levelFrom: { level: 1, xp: 0, xpToNext: 100 },
  levelTo: { level: 1, xp: 0, xpToNext: 100 },
  gumballs: 0,
  crowns: 0,
  unlocks: [],
});

describe('bundled events', () => {
  it('lists what is upcoming, live or recently ended, in the API shape', () => {
    const list = bundledEvents(LIVE_AT);
    expect(list.map((e) => [e.id, e.phase])).toEqual([
      [moon.id, 'live'],
      [frost.id, 'upcoming'],
    ]);
    expect(list[0]!.tiers[0]!.rewards[0]).toEqual({ type: 'gumballs', amount: 150 });
    expect(list[0]!.challenges[0]!.title).not.toContain('{n}');
    const tier6 = list[0]!.tiers.find((t) => t.tier === 6)!;
    expect(tier6.rewards).toContainEqual({ type: 'crown_shards', amount: 3 });
    const gone = bundledEvents(Date.parse(moon.endsAt) + ENDED_EVENT_VISIBLE_MS);
    expect(gone.map((e) => e.id)).not.toContain(moon.id);
  });

  it('shows offline with every tier locked and cosmetic previews', () => {
    const data = offlineEvents(() => false, LIVE_AT);
    expect(data.online).toBe(false);
    expect(data.enabled).toBe(true);
    const e = data.list[0]!;
    expect(e.tiers.every((t) => t.state === 'locked')).toBe(true);
    const item = e.tiers.flatMap((t) => t.rewards).find((r) => r.kind === 'item');
    expect(item).toMatchObject({ kind: 'item', item: { owned: false } });
    expect(e.playlists).toEqual(['Chaos Mode']);
  });
});

describe('event screen data', () => {
  const progress: ApiEventProgress = {
    eventId: moon.id,
    points: 260,
    shows: 3,
    tierReached: 2,
    claimedTiers: [1],
    challenges: [{ id: moon.challenges[0]!.id, progress: 99, target: 10, completed: true, claimed: false }],
  };

  it('marks tiers claimed, claimable or locked from the progress', () => {
    const data = eventsView({
      events: bundledEvents(LIVE_AT),
      progress: [progress],
      enabled: true,
      offsetMs: 0,
      now: LIVE_AT,
      grant,
    });
    expect(data.online).toBe(true);
    const e = data.list[0]!;
    expect(e.points).toBe(260);
    expect(e.tiers.slice(0, 3).map((t) => t.state)).toEqual(['claimed', 'claimable', 'locked']);
    expect(e.challenges[0]).toMatchObject({ progress: 10, goal: 10, claimed: false });
    expect(e.multiplier).toBe(moon.points.eventPlaylistMultiplier);
    // Nothing earned in the upcoming event yet.
    expect(data.list[1]!.tiers.every((t) => t.state === 'locked')).toBe(true);
  });

  it('puts times on the device clock and phases on the server clock', () => {
    const end = Date.parse(moon.endsAt);
    const offset = 5 * 60_000;
    // The device is five minutes behind: on its clock the event still has time,
    // but the server says it is over.
    const data = eventsView({
      events: bundledEvents(end - 60_000),
      progress: [progress],
      enabled: true,
      offsetMs: offset,
      now: end - 60_000,
      grant,
    });
    const e = data.list[0]!;
    expect(e.phase).toBe('ended');
    expect(e.endsAt).toBe(end - offset);
  });

  it('passes the kill switch through', () => {
    const data = eventsView({ events: [], progress: [], enabled: false, offsetMs: 0, now: LIVE_AT, grant });
    expect(data.enabled).toBe(false);
  });
});

describe('rewards screen', () => {
  it('maps the API summary to event lines', () => {
    expect(
      rewardEventLines([
        {
          eventId: moon.id,
          name: moon.name,
          gained: 80,
          pointsBefore: 60,
          pointsAfter: 140,
          tierBefore: 0,
          tierAfter: 1,
          tiers: 12,
          challenges: [],
        },
      ]),
    ).toEqual([{ id: moon.id, name: moon.name, gained: 80, from: 60, to: 140, tierFrom: 0, tierTo: 1 }]);
    expect(rewardEventLines(undefined)).toEqual([]);
  });

  it('explains a show that earned no event points while an event is live', () => {
    const data = offlineEvents(() => false, LIVE_AT);
    expect(withEventNote(rewards(), data)?.eventNote).toContain(`did not earn ${moon.name} points`);
    const counted = {
      ...rewards(),
      events: [{ id: moon.id, name: moon.name, gained: 1, from: 0, to: 1, tierFrom: 0, tierTo: 0 }],
    };
    expect(withEventNote(counted, data)?.eventNote).toBeUndefined();
    expect(withEventNote(rewards(), { ...data, enabled: false })?.eventNote).toBeUndefined();
    expect(
      withEventNote(
        rewards(),
        offlineEvents(() => false, Date.parse(moon.endsAt) + 1),
      )?.eventNote,
    ).toBeUndefined();
    expect(withEventNote(null, data)).toBeNull();
  });
});
