/**
 * Event progress and rewards on the server. Never trusts the client: points
 * and challenge progress come only from verified match results, rewards only
 * from rows those results produced.
 *
 * Responsibilities:
 * - {@link recordEventShow}: inside the match-ingest transaction, credit one
 *   player's show to every event live at the show's counting instant. The
 *   `event_match_credits` primary key (and the ingest's own `matches` row)
 *   make a replayed or concurrent duplicate report count once.
 * - {@link claimEventTier}: pay one points-track tier. The `event_tier_claims`
 *   primary key is the guard, so concurrent claims pay once; currency goes on
 *   the ledger under `event:<eventId>:<tier>`.
 * - {@link claimEventChallenge}: pay a completed challenge's points and XP;
 *   the conditional `claimed_at` update is the guard.
 * - {@link settleEndedEvents}: once an event has ended, pay every completed
 *   challenge and every reached tier the player never claimed, the same way a
 *   claim would (same guards, same ledger refs). Repeatable: a show that
 *   straddled the end and was ingested late is settled on the next read.
 * - {@link eventProgressView}: the player's standing in each visible event.
 */
import {
  eventChallengeIncrement,
  eventShowPoints,
  eventTiersReached,
  type EventShowFacts,
} from '@tumble/content/progression';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Catalog, CatalogEvent, CatalogGrant } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { eventChallengeProgress, eventMatchCredits, eventProgress, eventTierClaims } from '../db/schema.ts';
import { applyLedger, type Wallet } from '../economy/ledger.ts';
import { grantCosmetic, readWallet } from '../economy/wallet.ts';
import { conflict, notFound } from '../http/errors.ts';
import { addXp } from '../progression/xp.ts';
import type { ScheduledEvent } from './state.ts';

// -----------------------------------------------------------------------------
// Recording shows
// -----------------------------------------------------------------------------

/** One event challenge's change from one show. */
export interface EventChallengeUpdate {
  challengeId: string;
  title: string;
  before: number;
  progress: number;
  target: number;
  completed: boolean;
}

/** What one show did for one event (part of the show's reward summary). */
export interface EventShowUpdate {
  eventId: string;
  name: string;
  /** Points this show earned. */
  gained: number;
  pointsBefore: number;
  pointsAfter: number;
  tierBefore: number;
  tierAfter: number;
  tiers: number;
  challenges: EventChallengeUpdate[];
}

async function ensureChallengeRows(tx: DbOrTx, userId: string, def: CatalogEvent): Promise<void> {
  await tx
    .insert(eventChallengeProgress)
    .values(def.challenges.map((c) => ({ userId, eventId: def.id, challengeId: c.id, target: c.target })))
    .onConflictDoNothing();
}

/**
 * Credits one player's show to each event it counts toward.
 *
 * @param tx - The match-ingest transaction.
 * @param events - Events live at the show's counting instant (`countingEvents`).
 * @param userId - Player.
 * @param matchId - Game-server match id.
 * @param facts - The player's show.
 * @param now - Server clock.
 * @returns One update per event credited (none for a duplicate).
 */
export async function recordEventShow(
  tx: DbOrTx,
  events: readonly ScheduledEvent[],
  userId: string,
  matchId: string,
  facts: EventShowFacts,
  now: Date,
): Promise<EventShowUpdate[]> {
  const out: EventShowUpdate[] = [];
  for (const e of events) {
    const def = e.def;
    const gained = eventShowPoints(def, facts);
    const credited = await tx
      .insert(eventMatchCredits)
      .values({ userId, eventId: def.id, matchId, points: gained })
      .onConflictDoNothing()
      .returning({ matchId: eventMatchCredits.matchId });
    if (!credited.length) continue;
    const [row] = await tx
      .insert(eventProgress)
      .values({ userId, eventId: def.id, points: gained, shows: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: [eventProgress.userId, eventProgress.eventId],
        set: {
          points: sql`${eventProgress.points} + ${gained}`,
          shows: sql`${eventProgress.shows} + 1`,
          updatedAt: now,
        },
      })
      .returning({ points: eventProgress.points });
    const pointsAfter = row?.points ?? gained;
    const pointsBefore = pointsAfter - gained;

    await ensureChallengeRows(tx, userId, def);
    const rows = await tx
      .select()
      .from(eventChallengeProgress)
      .where(and(eq(eventChallengeProgress.userId, userId), eq(eventChallengeProgress.eventId, def.id)));
    const byId = new Map(rows.map((r) => [r.challengeId, r]));
    const challenges: EventChallengeUpdate[] = [];
    for (const c of def.challenges) {
      const r = byId.get(c.id);
      if (!r || r.completedAt) continue;
      const inc = eventChallengeIncrement(def, c, facts);
      if (inc <= 0) continue;
      const progress = Math.min(r.target, r.progress + inc);
      const completed = progress >= r.target;
      await tx
        .update(eventChallengeProgress)
        .set({ progress, ...(completed ? { completedAt: now } : {}) })
        .where(
          and(
            eq(eventChallengeProgress.userId, userId),
            eq(eventChallengeProgress.eventId, def.id),
            eq(eventChallengeProgress.challengeId, c.id),
          ),
        );
      challenges.push({
        challengeId: c.id,
        title: c.title,
        before: r.progress,
        progress,
        target: r.target,
        completed,
      });
    }
    out.push({
      eventId: def.id,
      name: def.name,
      gained,
      pointsBefore,
      pointsAfter,
      tierBefore: eventTiersReached(def, pointsBefore),
      tierAfter: eventTiersReached(def, pointsAfter),
      tiers: def.tiers.length,
      challenges,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Paying out
// -----------------------------------------------------------------------------

/** A reward as paid. `granted` is false for a cosmetic already owned. */
export type PaidEventReward = CatalogGrant & { granted: boolean };

/** What one tier paid. */
export interface TierPayout {
  eventId: string;
  tier: number;
  rewards: PaidEventReward[];
}

/** What one challenge claim paid. */
export interface ChallengePayout {
  eventId: string;
  challengeId: string;
  title: string;
  points: number;
  xp: number;
}

async function lockProgress(tx: DbOrTx, userId: string, eventId: string): Promise<{ points: number }> {
  // Created first so the lock below always has a row to hold, even before any show counted.
  await tx.insert(eventProgress).values({ userId, eventId }).onConflictDoNothing();
  const [row] = await tx
    .select({ points: eventProgress.points })
    .from(eventProgress)
    .where(and(eq(eventProgress.userId, userId), eq(eventProgress.eventId, eventId)))
    .for('update');
  return { points: row?.points ?? 0 };
}

/**
 * Pays a tier after its claim row was inserted.
 *
 * @returns The rewards and the XP they were worth.
 */
async function payTier(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  def: CatalogEvent,
  tier: number,
): Promise<TierPayout> {
  const t = def.tiers.find((x) => x.tier === tier)!;
  const ref = `event:${def.id}:${tier}`;
  const rewards: PaidEventReward[] = [];
  let xp = 0;
  for (const r of t.rewards) {
    if (r.type === 'xp') {
      xp += r.amount;
      rewards.push({ ...r, granted: true });
    } else if (r.type === 'cosmetic') {
      rewards.push({ ...r, granted: await grantCosmetic(tx, userId, r.id, 'event') });
    } else {
      const res = await applyLedger(tx, {
        userId,
        currency: r.type,
        delta: r.amount,
        reason: 'event_reward',
        ref,
      });
      rewards.push({ ...r, granted: res.applied });
    }
  }
  if (xp > 0) await addXp(tx, catalog, userId, xp);
  return { eventId: def.id, tier, rewards };
}

/**
 * Claims one reached tier.
 *
 * @param tx - Open transaction.
 * @param catalog - Level curve (XP rewards).
 * @param e - The event (from `claimableEvent`).
 * @param userId - Player.
 * @param tier - Tier number.
 * @param now - Server clock.
 * @throws {ApiError} 404 unknown tier, 409 `tier_locked` / `already_claimed`.
 */
export async function claimEventTier(
  tx: DbOrTx,
  catalog: Catalog,
  e: ScheduledEvent,
  userId: string,
  tier: number,
  now: Date,
): Promise<TierPayout & { wallet: Wallet }> {
  const def = e.def;
  const t = def.tiers.find((x) => x.tier === tier);
  if (!t) throw notFound('Tier');
  const { points } = await lockProgress(tx, userId, def.id);
  if (points < t.points)
    throw conflict('tier_locked', `Tier ${tier} needs ${t.points} points`, { points, needed: t.points });
  const inserted = await tx
    .insert(eventTierClaims)
    .values({ userId, eventId: def.id, tier, claimedAt: now })
    .onConflictDoNothing()
    .returning({ tier: eventTierClaims.tier });
  if (!inserted.length) throw conflict('already_claimed', 'Tier already claimed');
  const paid = await payTier(tx, catalog, userId, def, tier);
  return { ...paid, wallet: await readWallet(tx, userId) };
}

/**
 * Claims a completed event challenge: its points join the track, its XP the
 * account and the pass.
 *
 * @param tx - Open transaction.
 * @param catalog - Level curve.
 * @param e - The event.
 * @param userId - Player.
 * @param challengeId - Challenge id within the event.
 * @param now - Server clock.
 * @throws {ApiError} 404 unknown challenge, 409 `not_completed` / `already_claimed`.
 */
export async function claimEventChallenge(
  tx: DbOrTx,
  catalog: Catalog,
  e: ScheduledEvent,
  userId: string,
  challengeId: string,
  now: Date,
): Promise<ChallengePayout> {
  const def = e.def;
  const c = def.challenges.find((x) => x.id === challengeId);
  if (!c) throw notFound('Challenge');
  await lockProgress(tx, userId, def.id);
  const [row] = await tx
    .select()
    .from(eventChallengeProgress)
    .where(
      and(
        eq(eventChallengeProgress.userId, userId),
        eq(eventChallengeProgress.eventId, def.id),
        eq(eventChallengeProgress.challengeId, c.id),
      ),
    );
  if (!row?.completedAt) throw conflict('not_completed', 'Challenge not completed yet');
  return payChallenge(tx, catalog, userId, def, c.id, now);
}

/** Marks a completed challenge claimed and pays it; the conditional update is the guard. */
async function payChallenge(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  def: CatalogEvent,
  challengeId: string,
  now: Date,
): Promise<ChallengePayout> {
  const c = def.challenges.find((x) => x.id === challengeId)!;
  const claimed = await tx
    .update(eventChallengeProgress)
    .set({ claimedAt: now })
    .where(
      and(
        eq(eventChallengeProgress.userId, userId),
        eq(eventChallengeProgress.eventId, def.id),
        eq(eventChallengeProgress.challengeId, c.id),
        isNotNull(eventChallengeProgress.completedAt),
        isNull(eventChallengeProgress.claimedAt),
      ),
    )
    .returning({ id: eventChallengeProgress.challengeId });
  if (!claimed.length) throw conflict('already_claimed', 'Challenge already claimed');
  await tx
    .update(eventProgress)
    .set({ points: sql`${eventProgress.points} + ${c.points}`, updatedAt: now })
    .where(and(eq(eventProgress.userId, userId), eq(eventProgress.eventId, def.id)));
  if (c.rewardXp > 0) await addXp(tx, catalog, userId, c.rewardXp);
  return { eventId: def.id, challengeId: c.id, title: c.title, points: c.points, xp: c.rewardXp };
}

/** What a settlement paid for one event. */
export interface EventSettlement {
  eventId: string;
  name: string;
  challenges: ChallengePayout[];
  tiers: TierPayout[];
}

/**
 * Pays everything earned but unclaimed in events that have ended: completed
 * challenges first (their points can reach more tiers), then reached tiers.
 * Idempotent and safe to repeat.
 *
 * @param tx - Open transaction.
 * @param catalog - Level curve.
 * @param events - Scheduled events; only switched-on, ended ones settle.
 * @param userId - Player.
 * @param now - Server clock.
 * @returns One entry per event that paid something.
 */
export async function settleEndedEvents(
  tx: DbOrTx,
  catalog: Catalog,
  events: readonly ScheduledEvent[],
  userId: string,
  now: Date,
): Promise<EventSettlement[]> {
  const ended = events.filter((e) => e.enabled && e.phase === 'ended');
  if (!ended.length) return [];
  const have = await tx
    .select({ eventId: eventProgress.eventId })
    .from(eventProgress)
    .where(
      and(
        eq(eventProgress.userId, userId),
        inArray(
          eventProgress.eventId,
          ended.map((e) => e.id),
        ),
      ),
    );
  const out: EventSettlement[] = [];
  for (const e of ended.filter((x) => have.some((h) => h.eventId === x.id))) {
    const def = e.def;
    const { points: before } = await lockProgress(tx, userId, def.id);
    const open = await tx
      .select({ challengeId: eventChallengeProgress.challengeId })
      .from(eventChallengeProgress)
      .where(
        and(
          eq(eventChallengeProgress.userId, userId),
          eq(eventChallengeProgress.eventId, def.id),
          isNotNull(eventChallengeProgress.completedAt),
          isNull(eventChallengeProgress.claimedAt),
        ),
      );
    const challenges: ChallengePayout[] = [];
    for (const o of open)
      if (def.challenges.some((c) => c.id === o.challengeId))
        challenges.push(await payChallenge(tx, catalog, userId, def, o.challengeId, now));
    const points = before + challenges.reduce((s, c) => s + c.points, 0);
    const reached = eventTiersReached(def, points);
    const claimedTiers = new Set(
      (
        await tx
          .select({ tier: eventTierClaims.tier })
          .from(eventTierClaims)
          .where(and(eq(eventTierClaims.userId, userId), eq(eventTierClaims.eventId, def.id)))
      ).map((r) => r.tier),
    );
    const tiers: TierPayout[] = [];
    for (const t of def.tiers) {
      if (t.tier > reached || claimedTiers.has(t.tier)) continue;
      const inserted = await tx
        .insert(eventTierClaims)
        .values({ userId, eventId: def.id, tier: t.tier, claimedAt: now, auto: true })
        .onConflictDoNothing()
        .returning({ tier: eventTierClaims.tier });
      if (inserted.length) tiers.push(await payTier(tx, catalog, userId, def, t.tier));
    }
    if (!challenges.length && !tiers.length) continue;
    await tx
      .update(eventProgress)
      .set({ settledAt: now })
      .where(and(eq(eventProgress.userId, userId), eq(eventProgress.eventId, def.id)));
    out.push({ eventId: def.id, name: def.name, challenges, tiers });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

/** A player's standing in one event. */
export interface EventProgressView {
  eventId: string;
  points: number;
  shows: number;
  /** Tiers the points reach. */
  tierReached: number;
  /** Tiers already paid (claimed or settled). */
  claimedTiers: number[];
  challenges: {
    id: string;
    progress: number;
    target: number;
    completed: boolean;
    claimed: boolean;
  }[];
}

/**
 * The player's progress in each of `events` (zeros where nothing counted yet).
 *
 * @param db - Database or transaction.
 * @param events - Events to report.
 * @param userId - Player.
 */
export async function eventProgressView(
  db: DbOrTx,
  events: readonly ScheduledEvent[],
  userId: string,
): Promise<EventProgressView[]> {
  if (!events.length) return [];
  const ids = events.map((e) => e.id);
  // Sequential: a transaction's single connection cannot run queries side by side.
  const progress = await db
    .select()
    .from(eventProgress)
    .where(and(eq(eventProgress.userId, userId), inArray(eventProgress.eventId, ids)));
  const challenges = await db
    .select()
    .from(eventChallengeProgress)
    .where(and(eq(eventChallengeProgress.userId, userId), inArray(eventChallengeProgress.eventId, ids)));
  const claims = await db
    .select({ eventId: eventTierClaims.eventId, tier: eventTierClaims.tier })
    .from(eventTierClaims)
    .where(and(eq(eventTierClaims.userId, userId), inArray(eventTierClaims.eventId, ids)));
  return events.map(({ def }) => {
    const p = progress.find((r) => r.eventId === def.id);
    const points = p?.points ?? 0;
    return {
      eventId: def.id,
      points,
      shows: p?.shows ?? 0,
      tierReached: eventTiersReached(def, points),
      claimedTiers: claims
        .filter((c) => c.eventId === def.id)
        .map((c) => c.tier)
        .sort((a, b) => a - b),
      challenges: def.challenges.map((c) => {
        const r = challenges.find((x) => x.eventId === def.id && x.challengeId === c.id);
        return {
          id: c.id,
          progress: Math.min(r?.progress ?? 0, c.target),
          target: c.target,
          completed: !!r?.completedAt,
          claimed: !!r?.claimedAt,
        };
      }),
    };
  });
}
