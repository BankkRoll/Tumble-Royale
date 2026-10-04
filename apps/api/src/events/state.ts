/**
 * Which limited-time events exist right now and whether they count: the
 * bundled windows with operator overrides merged in, evaluated on the API's
 * clock.
 *
 * Overrides ride on the cached live-ops snapshot, so an admin change reaches
 * every API instance through the same invalidation as playlists and flags.
 * Two switches stop an event: the global `events.enabled` kill switch and an
 * override's own `enabled`. Either one off means no progress, no claims and
 * no settlement until it is back on.
 */
import { eventPhase, mergeEventWindow, type EventPhase, type EventWindow } from '@tumble/content/progression';
import type { CatalogEvent } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import { ApiError, notFound } from '../http/errors.ts';
import { liveOpsSnapshot, requireFlag, serverFlag } from '../liveops/state.ts';

/** How long after its end an event stays listed (results, settled rewards). */
export const ENDED_EVENT_VISIBLE_MS = 14 * 86_400_000;

/** An event with its effective window. */
export interface ScheduledEvent extends EventWindow {
  id: string;
  name: string;
  /** Phase at the time of the read. */
  phase: EventPhase;
  /** True when an operator override is in effect. */
  overridden: boolean;
  /** The definition (challenges, tiers, point rules). */
  def: CatalogEvent;
}

/**
 * Every bundled event with overrides merged in, earliest start first.
 *
 * @param ctx - Shared services.
 * @param nowMs - Instant the phase is evaluated at (defaults to the API clock).
 */
export async function scheduledEvents(
  ctx: AppContext,
  nowMs = ctx.now().getTime(),
): Promise<ScheduledEvent[]> {
  const overrides = new Map((await liveOpsSnapshot(ctx)).events.map((o) => [o.id, o]));
  return ctx.catalog.events
    .map((def) => {
      const o = overrides.get(def.id);
      const w = mergeEventWindow(def, o);
      return { id: def.id, name: def.name, ...w, phase: eventPhase(w, nowMs), overridden: !!o, def };
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * Whether the `events.enabled` kill switch is on.
 *
 * @param ctx - Shared services.
 */
export function eventsEnabled(ctx: AppContext): Promise<boolean> {
  return serverFlag(ctx, 'events.enabled');
}

/**
 * Events a show counts toward: switched on, and live at the instant the show
 * is counted by. Empty when the kill switch is off.
 *
 * @param ctx - Shared services.
 * @param countAtMs - The show's counting instant (its start, see the ingest).
 */
export async function countingEvents(ctx: AppContext, countAtMs: number): Promise<ScheduledEvent[]> {
  if (!(await eventsEnabled(ctx))) return [];
  return (await scheduledEvents(ctx, countAtMs)).filter((e) => e.enabled && e.phase === 'live');
}

/**
 * Events a player sees: switched on, upcoming, live, or ended within
 * {@link ENDED_EVENT_VISIBLE_MS}.
 *
 * @param ctx - Shared services.
 */
export async function visibleEvents(ctx: AppContext): Promise<ScheduledEvent[]> {
  const now = ctx.now().getTime();
  return (await scheduledEvents(ctx, now)).filter(
    (e) => e.enabled && (e.phase !== 'ended' || now - Date.parse(e.endsAt) < ENDED_EVENT_VISIBLE_MS),
  );
}

/**
 * The event a claim targets, refusing when claims are not possible.
 *
 * @param ctx - Shared services.
 * @param eventId - Event id from the URL.
 * @throws {ApiError} 503 `feature_disabled` (kill switch), 404, 409 `event_disabled` / `event_not_started`.
 */
export async function claimableEvent(ctx: AppContext, eventId: string): Promise<ScheduledEvent> {
  await requireFlag(ctx, 'events.enabled', 'Events are paused for a moment. Try again soon!');
  const e = (await scheduledEvents(ctx)).find((x) => x.id === eventId);
  if (!e) throw notFound('Event');
  if (!e.enabled) throw new ApiError(409, 'event_disabled', `${e.name} is not running`);
  if (e.phase === 'upcoming')
    throw new ApiError(409, 'event_not_started', `${e.name} has not started yet`, { startsAt: e.startsAt });
  return e;
}
