/**
 * Data-retention job, run inside the API on a timer.
 *
 * Responsibilities:
 * - Delete refresh-token sessions that expired more than a grace period ago.
 *   Unexpired sessions are never touched, revoked or not: revoked rows are
 *   what refresh-token reuse detection compares against.
 * - Delete analytics events older than `RETENTION_EVENTS_DAYS`, except
 *   `audit.*` events (account-deletion records), which are kept.
 * - Delete club chat older than {@link CLUB_CHAT_RETENTION_DAYS}; a club report
 *   already holds its own copy of the lines it was filed over. Resolved and
 *   dismissed club reports go after {@link CLUB_REPORT_RETENTION_DAYS}, and
 *   expired club kicks as soon as they lapse.
 * - Delete shows older than `MATCH_HISTORY_RETENTION_DAYS` (outside the live
 *   season), with their rounds, results, rank history and event credits,
 *   and leaderboard boards of past seasons and weeks from KV.
 * - Optionally (`RETENTION_GUEST_DAYS` > 0) delete guest accounts nobody has
 *   used for that long, through the same path as `DELETE /me`. A guest is
 *   only stale when it has no live session, never paid for anything and has
 *   no ban on record (deleting it would erase the ban).
 * - Auto-accept gifts left unopened for 30 days (`economy/gifts.ts`), so they
 *   settle even when neither player signs in again.
 * - Run on one instance at a time (a KV lock), in bounded batches so a large
 *   backlog never holds long locks or one huge transaction.
 */
import { and, eq, inArray, lt, ne, notLike, sql } from 'drizzle-orm';
import { deleteAccount } from '../accounts/erase.ts';
import type { RetentionConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import {
  bans,
  clubKicks,
  clubMessages,
  clubReports,
  eventMatchCredits,
  events,
  matches,
  purchases,
  rankHistory,
  sessions,
  users,
} from '../db/schema.ts';
import { settleExpiredGifts } from '../economy/gifts.ts';
import { pruneOldBoards } from '../leaderboards/service.ts';
import { MATCH_HISTORY_RETENTION_DAYS } from '../matches/ingest.ts';

const DAY_MS = 86_400_000;
/** Club chat kept for history and report evidence. */
export const CLUB_CHAT_RETENTION_DAYS = 30;
const LOCK_KEY = 'ops:retention:lock';
/** Rows per delete statement. */
const BATCH = 5000;
/** Statements per kind per run; the rest waits for the next run. */
const MAX_BATCHES = 40;
/** Guest accounts deleted per run (each is a multi-table transaction). */
const MAX_GUESTS = 200;

/** Closed club reports kept for reference after they were handled. */
export const CLUB_REPORT_RETENTION_DAYS = 180;

/** Rows deleted by one run. */
export interface RetentionResult {
  sessions: number;
  events: number;
  guests: number;
  clubMessages: number;
  /** Overdue gifts auto-accepted (or returned). */
  gifts: number;
  /** Club kicks whose ban from the club has run out. */
  clubKicks: number;
  /** Resolved or dismissed club reports past {@link CLUB_REPORT_RETENTION_DAYS}. */
  clubReports: number;
  /** Shows past {@link MATCH_HISTORY_RETENTION_DAYS}, with their rounds, results and rank history. */
  matches: number;
  /** Old season and weekly leaderboard keys deleted from KV. */
  boards: number;
  /** False when another instance held the lock and nothing ran. */
  ran: boolean;
}

/** The kinds a run counts, in metric label order. */
export const RETENTION_KINDS = [
  'sessions',
  'events',
  'guests',
  'clubMessages',
  'gifts',
  'clubKicks',
  'clubReports',
  'matches',
  'boards',
] as const satisfies readonly (keyof RetentionResult)[];

const NOTHING_RAN: RetentionResult = {
  sessions: 0,
  events: 0,
  guests: 0,
  clubMessages: 0,
  gifts: 0,
  clubKicks: 0,
  clubReports: 0,
  matches: 0,
  boards: 0,
  ran: false,
};

async function batched(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Guest accounts eligible for deletion.
 *
 * @param ctx - API context.
 * @param cutoff - Last activity before this instant.
 * @param limit - Maximum ids.
 * @param onlyId - Re-check a single account.
 */
export async function staleGuestIds(
  ctx: AppContext,
  cutoff: Date,
  limit: number,
  onlyId?: string,
): Promise<string[]> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isGuest, true),
        onlyId ? eq(users.id, onlyId) : undefined,
        lt(users.lastSeenAt, cutoff),
        sql`not exists (select 1 from ${sessions} where ${sessions.userId} = ${users.id}
              and ${sessions.expiresAt} > ${now} and ${sessions.revokedAt} is null)`,
        sql`not exists (select 1 from ${purchases} where ${purchases.userId} = ${users.id}
              and ${purchases.provider} is not null)`,
        sql`not exists (select 1 from ${bans} where ${bans.userId} = ${users.id})`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Runs one retention pass.
 *
 * @param ctx - API context.
 * @param policy - What to delete.
 * @returns Rows deleted per kind.
 */
export async function runRetention(ctx: AppContext, policy: RetentionConfig): Promise<RetentionResult> {
  const owner = globalThis.crypto.randomUUID();
  // Longer than any sane run; a crashed holder's lock simply expires.
  if (!(await ctx.kv.setNX(LOCK_KEY, owner, 30 * 60_000))) return { ...NOTHING_RAN };
  try {
    const now = ctx.now().getTime();
    const sessionCutoff = new Date(now - policy.sessionGraceDays * DAY_MS);
    const deletedSessions = await batched(async () => {
      const ids = ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(lt(sessions.expiresAt, sessionCutoff))
        .limit(BATCH);
      const rows = await ctx.db
        .delete(sessions)
        .where(and(inArray(sessions.id, ids), lt(sessions.expiresAt, sessionCutoff)))
        .returning({ id: sessions.id });
      return rows.length;
    });

    let deletedEvents = 0;
    if (policy.eventsDays > 0) {
      const cutoff = new Date(now - policy.eventsDays * DAY_MS);
      const old = and(lt(events.createdAt, cutoff), notLike(events.name, 'audit.%'));
      deletedEvents = await batched(async () => {
        const ids = ctx.db.select({ id: events.id }).from(events).where(old).limit(BATCH);
        const rows = await ctx.db
          .delete(events)
          .where(and(inArray(events.id, ids), old))
          .returning({ id: events.id });
        return rows.length;
      });
    }

    const chatCutoff = new Date(now - CLUB_CHAT_RETENTION_DAYS * DAY_MS);
    const deletedClubMessages = await batched(async () => {
      const ids = ctx.db
        .select({ id: clubMessages.id })
        .from(clubMessages)
        .where(lt(clubMessages.createdAt, chatCutoff))
        .limit(BATCH);
      const rows = await ctx.db
        .delete(clubMessages)
        .where(and(inArray(clubMessages.id, ids), lt(clubMessages.createdAt, chatCutoff)))
        .returning({ id: clubMessages.id });
      return rows.length;
    });

    let deletedGuests = 0;
    if (policy.guestDays > 0) {
      const cutoff = new Date(now - policy.guestDays * DAY_MS);
      for (const id of await staleGuestIds(ctx, cutoff, MAX_GUESTS)) {
        try {
          // The guest may have signed in since the scan; deletion is irreversible, so ask again.
          if ((await staleGuestIds(ctx, cutoff, 1, id)).length === 0) continue;
          await deleteAccount(ctx, id, { ip: 'retention-job' });
          deletedGuests++;
        } catch {
          // Signed in or deleted meanwhile; the next run reconsiders it.
        }
      }
    }
    const settledGifts = await settleExpiredGifts(ctx);

    const nowDate = new Date(now);
    // One row per kicked member and club, gone by itself once it expires: small enough for one statement.
    const deletedKicks = (
      await ctx.db
        .delete(clubKicks)
        .where(lt(clubKicks.until, nowDate))
        .returning({ clubId: clubKicks.clubId })
    ).length;

    const reportCutoff = new Date(now - CLUB_REPORT_RETENTION_DAYS * DAY_MS);
    const closedReport = and(ne(clubReports.status, 'open'), lt(clubReports.createdAt, reportCutoff));
    const deletedReports = await batched(async () => {
      const ids = ctx.db.select({ id: clubReports.id }).from(clubReports).where(closedReport).limit(BATCH);
      const rows = await ctx.db
        .delete(clubReports)
        .where(and(inArray(clubReports.id, ids), closedReport))
        .returning({ id: clubReports.id });
      return rows.length;
    });

    // The live season's shows stay whatever their age: its leaderboards are
    // rebuilt from them.
    const matchCutoff = new Date(now - MATCH_HISTORY_RETENTION_DAYS * DAY_MS);
    const liveSeason = ctx.catalog.seasonAt(nowDate).id;
    const deletedMatches = await batched(async () => {
      const ids = (
        await ctx.db
          .select({ id: matches.id })
          .from(matches)
          .where(and(lt(matches.endedAt, matchCutoff), ne(matches.seasonId, liveSeason)))
          .limit(BATCH)
      ).map((r) => r.id);
      if (ids.length === 0) return 0;
      await ctx.db.transaction(async (tx) => {
        await tx.delete(rankHistory).where(inArray(rankHistory.matchId, ids));
        await tx.delete(eventMatchCredits).where(inArray(eventMatchCredits.matchId, ids));
        // Participants, rounds and round results cascade.
        await tx.delete(matches).where(inArray(matches.id, ids));
      });
      return ids.length;
    });

    const prunedBoards = await pruneOldBoards(ctx);
    return {
      sessions: deletedSessions,
      events: deletedEvents,
      guests: deletedGuests,
      clubMessages: deletedClubMessages,
      gifts: settledGifts,
      clubKicks: deletedKicks,
      clubReports: deletedReports,
      matches: deletedMatches,
      boards: prunedBoards,
      ran: true,
    };
  } finally {
    // Compare-and-delete in one step: a run that overran the TTL must not remove the next holder's lock.
    await ctx.kv.delIfEquals(LOCK_KEY, owner).catch(() => false);
  }
}
