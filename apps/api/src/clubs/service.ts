/**
 * Club membership: the transactional core every club route, the account
 * erasure and the admin console go through.
 *
 * Responsibilities:
 * - eligibility (signed-in accounts only; founding also needs account age);
 * - joining under the club row lock, so the member cap holds under concurrent
 *   joins, while the `club_members` primary key holds "one club per player";
 * - leaving, kicking (with a rejoin cooldown) and disbanding (a soft delete);
 * - ownership hand-over when the owner leaves or deletes their account: the
 *   longest-serving officer, else the longest-serving member, else the empty
 *   club is disbanded;
 * - the views the routes return (club card, roster with presence).
 *
 * Every mutation takes a transaction; callers notify members after commit
 * with {@link notifyClub}, so nobody hears about a change that rolled back.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  CLUB_KICK_COOLDOWN_HOURS,
  CLUB_MAX_MEMBERS,
  CLUB_MIN_ACCOUNT_AGE_DAYS,
  clubRoleRank,
  DEFAULT_CLUB_EMBLEM,
  parseClubEmblem,
  type ClubEmblem,
  type ClubRole,
} from '@tumble/shared';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { clubInvites, clubKicks, clubMembers, clubs, profiles, users } from '../db/schema.ts';
import { conflict, forbidden, notFound } from '../http/errors.ts';
import type { RealtimeEvent } from '../realtime/notifier.ts';
import { presenceViews } from '../social/presence.ts';

/** A stored club. */
export type ClubRow = typeof clubs.$inferSelect;

/** A player's place in a club. */
export interface Membership {
  clubId: string;
  role: ClubRole;
  joinedAt: Date;
}

/** What other players see of a club (search, discovery, invites). */
export interface ClubCard {
  id: string;
  name: string;
  tag: string;
  description: string;
  emblem: ClubEmblem;
  joinMode: string;
  memberCount: number;
  maxMembers: number;
  createdAt: string;
  lastActivityAt: string;
}

/** What {@link removeMember} did to the club. */
export interface Removal {
  clubId: string;
  clubName: string;
  /** The member's role before leaving. */
  role: ClubRole;
  /** Set when ownership passed to someone else. */
  newOwnerId: string | null;
  /** True when the club was left empty and disbanded. */
  disbanded: boolean;
}

/**
 * The club card for a row.
 *
 * @param c - Stored club.
 */
export function clubCard(c: ClubRow): ClubCard {
  return {
    id: c.id,
    name: c.name,
    tag: c.tag,
    description: c.description,
    emblem: parseClubEmblem(c.emblem) ?? DEFAULT_CLUB_EMBLEM,
    joinMode: c.joinMode,
    memberCount: c.memberCount,
    maxMembers: CLUB_MAX_MEMBERS,
    createdAt: c.createdAt.toISOString(),
    lastActivityAt: c.lastActivityAt.toISOString(),
  };
}

/**
 * The player's club membership, if any.
 *
 * @param db - Database or open transaction.
 * @param userId - Player.
 */
export async function membershipOf(db: DbOrTx, userId: string): Promise<Membership | null> {
  const [row] = await db
    .select({ clubId: clubMembers.clubId, role: clubMembers.role, joinedAt: clubMembers.joinedAt })
    .from(clubMembers)
    .where(eq(clubMembers.userId, userId));
  return row ? { clubId: row.clubId, role: row.role as ClubRole, joinedAt: row.joinedAt } : null;
}

/**
 * Like {@link membershipOf}, but refuses players outside a club.
 *
 * @throws {ApiError} 404 `not_found` (Club).
 */
export async function requireMembership(db: DbOrTx, userId: string): Promise<Membership> {
  const m = await membershipOf(db, userId);
  if (!m) throw notFound('Club');
  return m;
}

/**
 * Account ids of a club's members.
 *
 * @param db - Database or open transaction.
 * @param clubId - Club.
 */
export async function clubMemberIds(db: DbOrTx, clubId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: clubMembers.userId })
    .from(clubMembers)
    .where(eq(clubMembers.clubId, clubId));
  return rows.map((r) => r.userId);
}

/**
 * A live (not disbanded) club, without locking.
 *
 * @throws {ApiError} 404 when missing or disbanded.
 */
export async function liveClub(db: DbOrTx, clubId: string): Promise<ClubRow> {
  const [c] = await db
    .select()
    .from(clubs)
    .where(and(eq(clubs.id, clubId), isNull(clubs.disbandedAt)));
  if (!c) throw notFound('Club');
  return c;
}

/**
 * Locks a live club's row for the rest of the transaction. Every change to
 * membership takes this lock first, which serialises joins at the cap and
 * ownership changes.
 *
 * @throws {ApiError} 404 when missing or disbanded.
 */
export async function lockClub(tx: DbOrTx, clubId: string): Promise<ClubRow> {
  const [c] = await tx
    .select()
    .from(clubs)
    .where(and(eq(clubs.id, clubId), isNull(clubs.disbandedAt)))
    .for('update');
  if (!c) throw notFound('Club');
  return c;
}

/**
 * Refuses accounts that may not take part in clubs.
 *
 * SECURITY: guests are a device secret with no recovery and no friction to
 * mint, so clubs (and their chat) need a linked sign-in; founding also needs
 * {@link CLUB_MIN_ACCOUNT_AGE_DAYS}, so a fresh throwaway cannot squat names.
 *
 * @param db - Database or open transaction.
 * @param userId - Player.
 * @param now - Server clock.
 * @param founding - Also check the account age.
 * @throws {ApiError} 403 `guest_account` / `account_too_new`.
 */
export async function requireClubEligible(
  db: DbOrTx,
  userId: string,
  now: Date,
  founding = false,
): Promise<void> {
  const [u] = await db
    .select({ isGuest: users.isGuest, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw notFound('Player');
  if (u.isGuest)
    throw forbidden('guest_account', 'Link an email, Discord or Google sign-in to take part in clubs');
  if (founding && now.getTime() - u.createdAt.getTime() < CLUB_MIN_ACCOUNT_AGE_DAYS * 86_400_000)
    throw forbidden(
      'account_too_new',
      `Accounts can found a club once they are ${CLUB_MIN_ACCOUNT_AGE_DAYS} days old`,
    );
}

/**
 * Refuses a player kicked from this club within the cooldown.
 *
 * @throws {ApiError} 403 `kick_cooldown`.
 */
export async function requireNotKicked(db: DbOrTx, clubId: string, userId: string, now: Date): Promise<void> {
  const [k] = await db
    .select({ until: clubKicks.until })
    .from(clubKicks)
    .where(and(eq(clubKicks.clubId, clubId), eq(clubKicks.userId, userId), gt(clubKicks.until, now)));
  if (k)
    throw forbidden(
      'kick_cooldown',
      `You were removed from this club; you can rejoin after ${k.until.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    );
}

/**
 * Adds a player to a locked club. The caller has already decided they may
 * join (open club, invite or approved request).
 *
 * @param tx - Open transaction holding {@link lockClub} on `club`.
 * @param club - The locked row.
 * @param userId - New member.
 * @param role - `member` normally, `owner` for the founder.
 * @param now - Server clock.
 * @throws {ApiError} 409 `already_in_club` / `club_full`, 403 `kick_cooldown`.
 */
export async function addMember(
  tx: DbOrTx,
  club: ClubRow,
  userId: string,
  role: ClubRole,
  now: Date,
): Promise<void> {
  const existing = await membershipOf(tx, userId);
  if (existing)
    throw conflict(
      'already_in_club',
      existing.clubId === club.id ? 'You are already in this club' : 'Leave your current club first',
    );
  if (club.memberCount >= CLUB_MAX_MEMBERS) throw conflict('club_full', 'That club is full');
  await requireNotKicked(tx, club.id, userId, now);
  await tx.insert(clubMembers).values({ userId, clubId: club.id, role, joinedAt: now });
  await tx
    .update(clubs)
    .set({ memberCount: sql`${clubs.memberCount} + 1`, lastActivityAt: now, updatedAt: now })
    .where(eq(clubs.id, club.id));
  // Joining one club answers every other pending invite and request.
  await tx.delete(clubInvites).where(eq(clubInvites.userId, userId));
  club.memberCount += 1;
}

/**
 * Soft-deletes a club: members, invites and requests go, the row (name freed
 * for reuse), its chat and its reports stay for moderators.
 *
 * @param tx - Open transaction (the club row should be locked).
 * @param clubId - Club.
 * @param reason - `owner`, `empty`, or a moderator's reason.
 * @param now - Server clock.
 * @returns The ids of everyone who was a member.
 */
export async function disbandClub(tx: DbOrTx, clubId: string, reason: string, now: Date): Promise<string[]> {
  const gone = await tx
    .delete(clubMembers)
    .where(eq(clubMembers.clubId, clubId))
    .returning({ userId: clubMembers.userId });
  await tx.delete(clubInvites).where(eq(clubInvites.clubId, clubId));
  await tx
    .update(clubs)
    .set({ disbandedAt: now, disbandReason: reason, memberCount: 0, updatedAt: now })
    .where(eq(clubs.id, clubId));
  return gone.map((g) => g.userId);
}

/**
 * The member who inherits a club: the longest-serving officer, else the
 * longest-serving member.
 *
 * @param tx - Open transaction.
 * @param clubId - Club.
 * @param excluding - The departing owner.
 */
async function successorOf(tx: DbOrTx, clubId: string, excluding: string): Promise<string | null> {
  const rows = await tx
    .select({ userId: clubMembers.userId, role: clubMembers.role })
    .from(clubMembers)
    .where(eq(clubMembers.clubId, clubId))
    .orderBy(asc(clubMembers.joinedAt), asc(clubMembers.userId));
  const others = rows.filter((r) => r.userId !== excluding);
  return (others.find((r) => r.role === 'officer') ?? others[0])?.userId ?? null;
}

/**
 * Takes a player out of their club (leave, kick or account deletion). An
 * owner's departure hands the club on; the last member's disbands it.
 *
 * @param tx - Open transaction.
 * @param userId - Departing member.
 * @param now - Server clock.
 * @returns What happened, or null when they were in no club.
 */
export async function removeMember(tx: DbOrTx, userId: string, now: Date): Promise<Removal | null> {
  const m = await membershipOf(tx, userId);
  if (!m) return null;
  const club = await lockClub(tx, m.clubId);
  let newOwnerId: string | null = null;
  if (m.role === 'owner') {
    newOwnerId = await successorOf(tx, club.id, userId);
    if (!newOwnerId) {
      await disbandClub(tx, club.id, 'empty', now);
      return { clubId: club.id, clubName: club.name, role: m.role, newOwnerId: null, disbanded: true };
    }
    await tx
      .update(clubMembers)
      .set({ role: 'owner' })
      .where(and(eq(clubMembers.userId, newOwnerId), eq(clubMembers.clubId, club.id)));
  }
  await tx.delete(clubMembers).where(eq(clubMembers.userId, userId));
  await tx
    .update(clubs)
    .set({ memberCount: sql`greatest(${clubs.memberCount} - 1, 0)`, updatedAt: now })
    .where(eq(clubs.id, club.id));
  return { clubId: club.id, clubName: club.name, role: m.role, newOwnerId, disbanded: false };
}

/**
 * Records a kick: the player cannot come back for {@link CLUB_KICK_COOLDOWN_HOURS}.
 *
 * @param tx - Open transaction.
 * @param clubId - Club.
 * @param userId - Kicked player.
 * @param now - Server clock.
 */
export async function recordKick(tx: DbOrTx, clubId: string, userId: string, now: Date): Promise<void> {
  const until = new Date(now.getTime() + CLUB_KICK_COOLDOWN_HOURS * 3_600_000);
  await tx
    .insert(clubKicks)
    .values({ clubId, userId, until })
    .onConflictDoUpdate({ target: [clubKicks.clubId, clubKicks.userId], set: { until } });
  await tx.delete(clubInvites).where(and(eq(clubInvites.clubId, clubId), eq(clubInvites.userId, userId)));
}

/**
 * Club tags of several players, for names shown in chat and lists.
 *
 * @param db - Database or open transaction.
 * @param userIds - Players.
 * @returns Tag per player in a club.
 */
export async function clubTagsOf(db: DbOrTx, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: clubMembers.userId, tag: clubs.tag })
    .from(clubMembers)
    .innerJoin(clubs, eq(clubs.id, clubMembers.clubId))
    .where(inArray(clubMembers.userId, [...userIds]));
  return new Map(rows.map((r) => [r.userId, r.tag]));
}

/** One roster row. */
export interface RosterMember {
  userId: string;
  displayName: string;
  tag: string;
  level: number;
  role: ClubRole;
  joinedAt: string;
  /** Coarse presence only: club mates see whether you are around, not what you play. */
  presence: string;
}

/**
 * A club's roster, owner first, then officers, then members, each by tenure.
 *
 * @param ctx - Shared services (presence lives in the KV).
 * @param clubId - Club.
 */
export async function roster(ctx: AppContext, clubId: string): Promise<RosterMember[]> {
  const rows = await ctx.db
    .select({
      userId: clubMembers.userId,
      role: clubMembers.role,
      joinedAt: clubMembers.joinedAt,
      displayName: profiles.displayName,
      tag: profiles.tag,
      level: profiles.level,
    })
    .from(clubMembers)
    .innerJoin(profiles, eq(profiles.userId, clubMembers.userId))
    .where(eq(clubMembers.clubId, clubId))
    .orderBy(asc(clubMembers.joinedAt));
  const presence = await presenceViews(
    ctx.kv,
    rows.map((r) => r.userId),
  );
  return rows
    .map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      tag: r.tag,
      level: r.level,
      role: r.role as ClubRole,
      joinedAt: r.joinedAt.toISOString(),
      presence: presence.get(r.userId)?.status ?? 'offline',
    }))
    .sort((a, b) => clubRoleRank(b.role) - clubRoleRank(a.role));
}

/**
 * Pushes an event to every member of a club (plus anyone else listed).
 *
 * @param ctx - Shared services.
 * @param clubId - Club whose members hear it.
 * @param event - Event.
 * @param also - Extra recipients (a player who just left).
 */
export async function notifyClub(
  ctx: AppContext,
  clubId: string,
  event: RealtimeEvent,
  also: readonly string[] = [],
): Promise<void> {
  const ids = await clubMemberIds(ctx.db, clubId);
  await ctx.notifier.notifyMany([...ids, ...also], event);
}

/**
 * Members of a club at or above a role (who hear about join requests).
 *
 * @param db - Database or open transaction.
 * @param clubId - Club.
 * @param min - Least role.
 */
export async function clubMembersAtLeast(db: DbOrTx, clubId: string, min: ClubRole): Promise<string[]> {
  const rows = await db
    .select({ userId: clubMembers.userId, role: clubMembers.role })
    .from(clubMembers)
    .where(eq(clubMembers.clubId, clubId));
  return rows.filter((r) => clubRoleRank(r.role) >= clubRoleRank(min)).map((r) => r.userId);
}
