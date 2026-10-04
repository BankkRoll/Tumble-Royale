/**
 * Limited-time events on the client: turns the API's events (or, offline,
 * the bundled ones) and the player's progress into the UI's event screen.
 *
 * Responsibilities:
 * - {@link bundledEvents}: the events shipped with content, in the API's
 *   shape, so an offline or signed-out player still sees what is on.
 * - {@link eventsView}: definitions + progress → `EventsData`, with times on
 *   the device clock and phases re-evaluated on the server's clock (a
 *   measured offset), so "Ends in" reaches zero when the API says it does.
 * - {@link rewardEventLines} / {@link withEventNote}: the event part of the
 *   rewards screen, from the API's summary, or a note when a show could not
 *   count (offline, Vs Bots, private shows).
 *
 * Nothing here decides what was earned: points, tiers and claims are the
 * API's. Offline the screen is read only.
 */
import { getCosmetic } from '@tumble/content/cosmetics';
import { eventPhase, LIVE_EVENTS, eventChallengeTitle, type Grant } from '@tumble/content/progression';
import { getPlaylist } from '@tumble/content/shows';
import type { PlayerRewardMsg } from '@tumble/netcode';
import type { EventsData, GrantView, LiveEventView, RewardsSummary } from '@tumble/ui';
import type { ApiEventProgress, ApiGrant, ApiLiveEvent } from './api.ts';
import { uiItem } from './cosmetics.ts';

/** How long after its end an event stays on screen (matches the API). */
export const ENDED_EVENT_VISIBLE_MS = 14 * 86_400_000;

function toApiGrant(g: Grant): ApiGrant {
  if (g.kind === 'cosmetic') return { type: 'cosmetic', id: g.itemId };
  return { type: g.kind === 'crownShards' ? 'crown_shards' : g.kind, amount: g.amount };
}

/**
 * The bundled events a player would see at `nowMs`: upcoming, live, or ended
 * within {@link ENDED_EVENT_VISIBLE_MS}.
 *
 * @param nowMs - Device clock.
 */
export function bundledEvents(nowMs: number): ApiLiveEvent[] {
  return LIVE_EVENTS.filter((e) => nowMs - Date.parse(e.endsAt) < ENDED_EVENT_VISIBLE_MS).map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    art: [e.art[0], e.art[1]],
    icon: e.icon,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    phase: eventPhase(e, nowMs),
    playlistIds: [...e.playlistIds],
    points: { ...e.points },
    challenges: e.challenges.map((c) => ({
      id: c.id,
      title: eventChallengeTitle(c),
      metric: c.metric,
      target: c.target,
      eventPlaylistsOnly: c.eventPlaylistsOnly,
      points: c.points,
      rewardXp: c.rewardXp,
    })),
    tiers: e.tiers.map((t) => ({ tier: t.tier, points: t.points, rewards: t.rewards.map(toApiGrant) })),
  }));
}

/** Inputs for {@link eventsView}. */
export interface EventsViewInput {
  events: readonly ApiLiveEvent[];
  /** The player's progress; null offline or signed out. */
  progress: readonly ApiEventProgress[] | null;
  /** `events.enabled` as the API reported it. */
  enabled: boolean;
  /** Server clock minus device clock (ms). */
  offsetMs: number;
  /** Device clock (ms). */
  now: number;
  /** API reward → UI chip (unknown cosmetics come back null and are dropped). */
  grant: (g: ApiGrant) => GrantView | null;
}

/**
 * Builds the event screen's data.
 *
 * @param input - Definitions, progress and clocks.
 * @example
 * ui.getState().setEvents(eventsView({ events: bundledEvents(Date.now()), progress: null, enabled: true,
 *   offsetMs: 0, now: Date.now(), grant }));
 */
export function eventsView(input: EventsViewInput): EventsData {
  const online = input.progress !== null;
  const serverNow = input.now + input.offsetMs;
  const list = input.events.map((e): LiveEventView => {
    const p = input.progress?.find((x) => x.eventId === e.id);
    const points = p?.points ?? 0;
    const claimed = new Set(p?.claimedTiers ?? []);
    const phase = eventPhase(e, serverNow);
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      art: e.art,
      icon: e.icon,
      startsAt: Date.parse(e.startsAt) - input.offsetMs,
      endsAt: Date.parse(e.endsAt) - input.offsetMs,
      phase,
      playlists: e.playlistIds.map((id) => getPlaylist(id)?.name ?? id),
      multiplier: e.points.eventPlaylistMultiplier,
      perShow: e.points.perShow,
      points,
      tiers: e.tiers.map((t) => ({
        tier: t.tier,
        points: t.points,
        rewards: t.rewards.flatMap((g) => {
          const v = input.grant(g);
          return v ? [v] : [];
        }),
        state: claimed.has(t.tier)
          ? 'claimed'
          : online && phase !== 'upcoming' && points >= t.points
            ? 'claimable'
            : 'locked',
      })),
      challenges: e.challenges.map((c) => {
        const r = p?.challenges.find((x) => x.id === c.id);
        return {
          id: c.id,
          title: c.title,
          metric: c.metric,
          progress: Math.min(r?.progress ?? 0, c.target),
          goal: c.target,
          points: c.points,
          xp: c.rewardXp,
          eventPlaylistsOnly: c.eventPlaylistsOnly,
          claimed: r?.claimed ?? false,
        };
      }),
    };
  });
  return { list, enabled: input.enabled, online };
}

/**
 * The event screen offline or signed out: the bundled events, no progress,
 * nothing claimable.
 *
 * @param owns - Whether the local profile owns a cosmetic (for the reward chips).
 * @param now - Device clock.
 */
export function offlineEvents(owns: (id: string) => boolean, now: number): EventsData {
  return eventsView({
    events: bundledEvents(now),
    progress: null,
    enabled: true,
    offsetMs: 0,
    now,
    grant: (g) => {
      if (g.type !== 'cosmetic')
        return { kind: g.type === 'crown_shards' ? 'crownShards' : g.type, amount: g.amount };
      const item = getCosmetic(g.id);
      return item ? { kind: 'item', item: uiItem(item, owns(g.id)) } : null;
    },
  });
}

/**
 * The rewards screen's event lines from the API's reward summary.
 *
 * @param events - `PlayerRewardMsg.events`.
 */
export function rewardEventLines(events: PlayerRewardMsg['events']): RewardsSummary['events'] {
  return (events ?? []).map((e) => ({
    id: e.eventId,
    name: e.name,
    gained: e.gained,
    from: e.pointsBefore,
    to: e.pointsAfter,
    tierFrom: e.tierBefore,
    tierTo: e.tierAfter,
  }));
}

/**
 * Adds a note to a show's rewards when an event is live but the show earned
 * no event points, so nobody wonders where their points went.
 *
 * @param rewards - The show's rewards (null passes through).
 * @param events - The event screen's data.
 */
export function withEventNote(
  rewards: RewardsSummary | null,
  events: EventsData | null,
): RewardsSummary | null {
  if (!rewards || rewards.events?.length || !events?.enabled) return rewards;
  const live = events.list.find((e) => e.phase === 'live');
  if (!live) return rewards;
  return {
    ...rewards,
    eventNote: `This show did not earn ${live.name} points. Event points come from online shows, not Vs Bots or private shows.`,
  };
}
