/**
 * Player-facing club routes. Every route needs a signed-in player and the
 * `clubs.enabled` flag; role checks follow `CLUB_PERMISSIONS` in
 * `@tumble/shared`.
 *
 * - `GET /clubs/me` — the caller's club (roster with presence, their role,
 *   join requests for officers), invites to them and their pending requests.
 * - `POST /clubs` — found a club; `PATCH /clubs/me` — edit it.
 * - `GET /clubs/search?q=`, `GET /clubs/recommended`, `GET /clubs/:id` — discovery.
 * - `POST /clubs/:id/join` (open: join, request: ask, invite-only: needs an
 *   invite), `DELETE /clubs/:id/request`, `POST /clubs/invites/:clubId/accept|decline`.
 * - `POST /clubs/me/leave`, `/disband`, `/transfer`, `/invites`,
 *   `/requests/:userId/accept|decline`, `/members/:userId/kick`, `/members/:userId/role`.
 * - `GET|POST /clubs/me/chat`, `POST /clubs/me/party-up`.
 * - `GET /clubs/me/goals`, `POST /clubs/me/goals/claim`.
 * - `POST /clubs/:id/report`.
 *
 * Membership changes run in one transaction under the club row lock and
 * notify members only after commit.
 */
import { and, desc, eq, gt, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CLUB_JOIN_MODES,
  CLUB_MAX_MEMBERS,
  CLUB_REPORT_REASONS,
  CLUB_TEXT_MESSAGES,
  checkClubDescription,
  checkClubName,
  checkClubTag,
  clubCan,
  clubOutranks,
  DEFAULT_CLUB_EMBLEM,
  parseClubEmblem,
  type ClubAction,
  type ClubJoinMode,
} from '@tumble/shared';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { clubInvites, clubMembers, clubReports, clubs, profiles } from '../db/schema.ts';
import { readWallet } from '../economy/wallet.ts';
import { requireUser } from '../http/auth.ts';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse } from '../http/errors.ts';
import { requireFlag } from '../liveops/state.ts';
import { maskProfanity } from '../names/profanity.ts';
import { isBlockedEitherWay, friendIds, socialRef } from '../social/friends.ts';
import { MAX_PARTY_SIZE, PartyService } from '../social/party.ts';
import { getPresence } from '../social/presence.ts';
import { CLUBS_OFF_MESSAGE, clubChatHistory, recentClubMessages, sendClubChat } from './chat.ts';
import { claimClubGoal, clubGoalsView } from './goals.ts';
import {
  addMember,
  clubCard,
  clubMembersAtLeast,
  liveClub,
  lockClub,
  lockOwnClub,
  membershipOf,
  notifyClub,
  recordKick,
  removeMember,
  requireClubEligible,
  requireMembership,
  requireNotKicked,
  roster,
  disbandClub,
  type ClubRow,
  type Membership,
} from './service.ts';

/** Join requests one player may have waiting at once. */
export const MAX_PENDING_CLUB_REQUESTS = 5;
/** Join requests one club may have waiting at once. */
export const MAX_CLUB_REQUEST_QUEUE = 100;
/** Results per search. */
export const CLUB_SEARCH_LIMIT = 20;
/** Clubs offered as recommended. */
export const CLUB_RECOMMENDED_LIMIT = 8;
/** A club counts as active for recommendations if something happened this recently. */
export const CLUB_ACTIVE_DAYS = 7;
/** Chat lines attached to a club report filed by a member. */
export const CLUB_REPORT_EVIDENCE_LINES = 30;

const UUID = z.string().uuid();
const IdParams = z.object({ id: UUID });
const ClubIdParams = z.object({ clubId: UUID });
const UserParams = z.object({ userId: UUID });
const UserBody = z.object({ userId: UUID }).strict();
const Emblem = z.unknown().transform((v, c) => {
  const e = parseClubEmblem(v);
  if (!e) c.addIssue({ code: 'custom', message: 'emblem must use the club motifs and palette' });
  return e ?? DEFAULT_CLUB_EMBLEM;
});
const CreateBody = z
  .object({
    name: z.string().max(64),
    tag: z.string().max(16),
    description: z.string().max(400).default(''),
    emblem: Emblem.optional(),
    joinMode: z.enum(CLUB_JOIN_MODES).default('open'),
  })
  .strict();
const EditBody = z
  .object({
    name: z.string().max(64).optional(),
    tag: z.string().max(16).optional(),
    description: z.string().max(400).optional(),
    emblem: Emblem.optional(),
    joinMode: z.enum(CLUB_JOIN_MODES).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const RoleBody = z.object({ role: z.enum(['officer', 'member']) }).strict();
const SearchQuery = z.object({ q: z.string().trim().min(2).max(24) });
const ChatBody = z.object({ text: z.string().max(500) }).strict();
const ClaimBody = z
  .object({ week: z.string().regex(/^\d{4}-W\d{2}$/), goalId: z.string().min(1).max(32) })
  .strict();
const ReportBody = z
  .object({ reason: z.enum(CLUB_REPORT_REASONS), details: z.string().max(1000).optional() })
  .strict();

const MUTATE = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const READ = { rateLimit: { max: 120, timeWindow: '1 minute' } };

/**
 * Validated name, tag and description, or a 400 naming the field.
 *
 * @throws {ApiError} 400 `invalid_club_name` / `invalid_club_tag` / `invalid_club_description`.
 */
function cleanText(field: 'name' | 'tag' | 'description', raw: string): string {
  const check =
    field === 'name' ? checkClubName(raw) : field === 'tag' ? checkClubTag(raw) : checkClubDescription(raw);
  if (!check.ok)
    throw badRequest(`invalid_club_${field}`, CLUB_TEXT_MESSAGES[field][check.reason], {
      reason: check.reason,
    });
  return check.value;
}

/**
 * Refuses a name or tag another live club holds (case-insensitive).
 *
 * @throws {ApiError} 409 `name_taken` / `tag_taken`.
 */
async function requireFreeIdentity(
  db: DbOrTx,
  name: string | undefined,
  tag: string | undefined,
  except?: string,
): Promise<void> {
  const live = (cond: ReturnType<typeof eq>) =>
    db
      .select({ id: clubs.id })
      .from(clubs)
      .where(and(isNull(clubs.disbandedAt), cond, ...(except ? [ne(clubs.id, except)] : [])))
      .limit(1);
  if (name && (await live(sql`lower(${clubs.name}) = lower(${name})`)).length)
    throw conflict('name_taken', 'Another club already has that name');
  if (tag && (await live(sql`lower(${clubs.tag}) = lower(${tag})`)).length)
    throw conflict('tag_taken', 'Another club already has that tag');
}

/**
 * Refuses a member whose role does not allow an action.
 *
 * @throws {ApiError} 403 `club_role`.
 */
function requireRole(m: Membership, action: ClubAction): void {
  if (!clubCan(m.role, action)) throw forbidden('club_role', 'Your club role does not allow that');
}

/** Maps a unique violation from a racing join or rename onto a friendly conflict. */
async function friendly<T>(run: () => Promise<T>, code: string, message: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(code, message);
    throw err;
  }
}

/**
 * Registers the player club routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerClubRoutes(app: FastifyInstance, ctx: AppContext): void {
  const parties = new PartyService(ctx);

  /** Every club route: signed in, and clubs switched on. */
  const player = async (req: Parameters<typeof requireUser>[1]) => {
    const auth = await requireUser(ctx, req);
    await requireFlag(ctx, 'clubs.enabled', CLUBS_OFF_MESSAGE);
    return auth;
  };

  /** Pending invites to a player, with the inviting clubs. */
  const invitesFor = async (userId: string) => {
    const rows = await ctx.db
      .select({ club: clubs, kind: clubInvites.kind, at: clubInvites.createdAt, by: clubInvites.invitedBy })
      .from(clubInvites)
      .innerJoin(clubs, eq(clubs.id, clubInvites.clubId))
      .where(and(eq(clubInvites.userId, userId), isNull(clubs.disbandedAt)))
      .orderBy(desc(clubInvites.createdAt));
    return {
      invites: await Promise.all(
        rows
          .filter((r) => r.kind === 'invite')
          .map(async (r) => ({
            club: clubCard(r.club),
            at: r.at.toISOString(),
            from: r.by ? await socialRef(ctx.db, r.by) : null,
          })),
      ),
      requests: rows
        .filter((r) => r.kind === 'request')
        .map((r) => ({ club: clubCard(r.club), at: r.at.toISOString() })),
    };
  };

  /** Join requests waiting on a club (officers see these). */
  const requestsOf = async (clubId: string) => {
    const rows = await ctx.db
      .select({
        userId: clubInvites.userId,
        at: clubInvites.createdAt,
        displayName: profiles.displayName,
        tag: profiles.tag,
        level: profiles.level,
      })
      .from(clubInvites)
      .innerJoin(profiles, eq(profiles.userId, clubInvites.userId))
      .where(and(eq(clubInvites.clubId, clubId), eq(clubInvites.kind, 'request')))
      .orderBy(clubInvites.createdAt);
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  };

  /** Puts a player into a club and tells everyone who should know. */
  const join = async (
    clubId: string,
    userId: string,
    via: 'open' | 'invite' | 'request',
    approverId?: string,
  ): Promise<ClubRow> => {
    const club = await friendly(
      () =>
        ctx.db.transaction(async (tx) => {
          await requireClubEligible(tx, userId, ctx.now());
          const c = await lockClub(tx, clubId);
          if (approverId) {
            const approver = await membershipOf(tx, approverId);
            if (approver?.clubId !== c.id) throw notFound('Club');
            requireRole(approver, 'acceptRequest');
          }
          if (via === 'invite' || via === 'request') {
            const gone = await tx
              .delete(clubInvites)
              .where(
                and(
                  eq(clubInvites.clubId, clubId),
                  eq(clubInvites.userId, userId),
                  eq(clubInvites.kind, via),
                ),
              )
              .returning({ kind: clubInvites.kind });
            if (gone.length === 0) throw notFound(via === 'invite' ? 'Club invite' : 'Join request');
          }
          await addMember(tx, c, userId, 'member', ctx.now());
          return c;
        }),
      'already_in_club',
      'Leave your current club first',
    );
    await notifyClub(ctx, club.id, { type: 'club_update', clubId: club.id });
    return club;
  };

  app.get('/clubs/me', { config: READ }, async (req) => {
    const auth = await player(req);
    const m = await membershipOf(ctx.db, auth.userId);
    const mine = await invitesFor(auth.userId);
    if (!m) return { club: null, role: null, ...mine };
    const club = await liveClub(ctx.db, m.clubId);
    return {
      club: { ...clubCard(club), members: await roster(ctx, club.id) },
      role: m.role,
      joinRequests: clubCan(m.role, 'acceptRequest') ? await requestsOf(club.id) : [],
      ...mine,
    };
  });

  app.post('/clubs', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const auth = await player(req);
    const body = parse(CreateBody, req.body);
    const name = cleanText('name', body.name);
    const tag = cleanText('tag', body.tag);
    const description = cleanText('description', body.description);
    const now = ctx.now();
    const club = await friendly(
      () =>
        ctx.db.transaction(async (tx) => {
          await requireClubEligible(tx, auth.userId, now, true);
          if (await membershipOf(tx, auth.userId))
            throw conflict('already_in_club', 'Leave your current club first');
          await requireFreeIdentity(tx, name, tag);
          const [c] = await tx
            .insert(clubs)
            .values({
              name,
              tag,
              description,
              emblem: body.emblem ?? DEFAULT_CLUB_EMBLEM,
              joinMode: body.joinMode,
              memberCount: 0,
              createdAt: now,
              updatedAt: now,
              lastActivityAt: now,
            })
            .returning();
          await addMember(tx, c!, auth.userId, 'owner', now);
          return c!;
        }),
      'name_taken',
      'Another club already has that name or tag',
    );
    return reply.code(201).send({ club: clubCard({ ...club, memberCount: 1 }) });
  });

  app.patch('/clubs/me', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const body = parse(EditBody, req.body);
    const name = body.name !== undefined ? cleanText('name', body.name) : undefined;
    const tag = body.tag !== undefined ? cleanText('tag', body.tag) : undefined;
    const description =
      body.description !== undefined ? cleanText('description', body.description) : undefined;
    const club = await friendly(
      () =>
        ctx.db.transaction(async (tx) => {
          const { club: c, m } = await lockOwnClub(tx, auth.userId);
          if (name !== undefined || tag !== undefined) requireRole(m, 'rename');
          if (description !== undefined || body.emblem || body.joinMode) requireRole(m, 'edit');
          await requireFreeIdentity(tx, name, tag, c.id);
          const [after] = await tx
            .update(clubs)
            .set({
              ...(name !== undefined ? { name } : {}),
              ...(tag !== undefined ? { tag } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(body.emblem ? { emblem: body.emblem } : {}),
              ...(body.joinMode ? { joinMode: body.joinMode } : {}),
              updatedAt: ctx.now(),
            })
            .where(eq(clubs.id, c.id))
            .returning();
          return after!;
        }),
      'name_taken',
      'Another club already has that name or tag',
    );
    await notifyClub(ctx, club.id, { type: 'club_update', clubId: club.id });
    return { club: clubCard(club) };
  });

  app.get('/clubs/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await player(req);
    const { q } = parse(SearchQuery, req.query);
    const term = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await ctx.db
      .select()
      .from(clubs)
      .where(and(isNull(clubs.disbandedAt), or(ilike(clubs.name, `%${term}%`), ilike(clubs.tag, `${term}%`))))
      .orderBy(
        sql`lower(${clubs.tag}) = lower(${q}) desc`,
        sql`lower(${clubs.name}) = lower(${q}) desc`,
        desc(clubs.memberCount),
        desc(clubs.lastActivityAt),
      )
      .limit(CLUB_SEARCH_LIMIT);
    return { clubs: rows.map(clubCard) };
  });

  app.get('/clubs/recommended', { config: READ }, async (req) => {
    const auth = await player(req);
    const since = new Date(ctx.now().getTime() - CLUB_ACTIVE_DAYS * 86_400_000);
    const m = await membershipOf(ctx.db, auth.userId);
    const rows = await ctx.db
      .select()
      .from(clubs)
      .where(
        and(
          isNull(clubs.disbandedAt),
          eq(clubs.joinMode, 'open'),
          sql`${clubs.memberCount} < ${CLUB_MAX_MEMBERS}`,
          gt(clubs.lastActivityAt, since),
          ...(m ? [ne(clubs.id, m.clubId)] : []),
        ),
      )
      .orderBy(desc(clubs.lastActivityAt), desc(clubs.memberCount))
      .limit(CLUB_RECOMMENDED_LIMIT);
    return { clubs: rows.map(clubCard) };
  });

  app.get('/clubs/:id', { config: READ }, async (req) => {
    await player(req);
    const { id } = parse(IdParams, req.params);
    return { club: clubCard(await liveClub(ctx.db, id)) };
  });

  app.post('/clubs/:id/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await player(req);
    const { id } = parse(IdParams, req.params);
    const club = await liveClub(ctx.db, id);
    const [invited] = await ctx.db
      .select({ k: clubInvites.kind })
      .from(clubInvites)
      .where(
        and(eq(clubInvites.clubId, id), eq(clubInvites.userId, auth.userId), eq(clubInvites.kind, 'invite')),
      );
    if (invited) return { status: 'joined', club: clubCard(await join(id, auth.userId, 'invite')) };
    const mode = club.joinMode as ClubJoinMode;
    if (mode === 'open') return { status: 'joined', club: clubCard(await join(id, auth.userId, 'open')) };
    if (mode === 'invite') throw forbidden('invite_only', 'This club is invite only');
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await requireClubEligible(tx, auth.userId, now);
      if (await membershipOf(tx, auth.userId))
        throw conflict('already_in_club', 'Leave your current club first');
      await requireNotKicked(tx, id, auth.userId, now);
      const [mine] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(clubInvites)
        .where(and(eq(clubInvites.userId, auth.userId), eq(clubInvites.kind, 'request')));
      if ((mine?.n ?? 0) >= MAX_PENDING_CLUB_REQUESTS)
        throw conflict('request_limit', 'Too many requests waiting; cancel some first');
      const [queue] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(clubInvites)
        .where(and(eq(clubInvites.clubId, id), eq(clubInvites.kind, 'request')));
      if ((queue?.n ?? 0) >= MAX_CLUB_REQUEST_QUEUE)
        throw conflict('club_request_queue_full', 'That club has too many requests waiting');
      await tx
        .insert(clubInvites)
        .values({ clubId: id, userId: auth.userId, kind: 'request', createdAt: now })
        .onConflictDoNothing();
    });
    const officers = await clubMembersAtLeast(ctx.db, id, 'officer');
    const hidden = new Set<string>();
    for (const o of officers) if (await isBlockedEitherWay(ctx.db, o, auth.userId)) hidden.add(o);
    await ctx.notifier.notifyMany(
      officers.filter((o) => !hidden.has(o)),
      { type: 'club_request', clubId: id, from: await socialRef(ctx.db, auth.userId) },
    );
    return { status: 'requested', club: clubCard(club) };
  });

  app.delete('/clubs/:id/request', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const { id } = parse(IdParams, req.params);
    await ctx.db
      .delete(clubInvites)
      .where(
        and(eq(clubInvites.clubId, id), eq(clubInvites.userId, auth.userId), eq(clubInvites.kind, 'request')),
      );
    await notifyClub(ctx, id, { type: 'club_update', clubId: id });
    return reply.code(204).send();
  });

  app.post('/clubs/invites/:clubId/accept', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const { clubId } = parse(ClubIdParams, req.params);
    return { status: 'joined', club: clubCard(await join(clubId, auth.userId, 'invite')) };
  });

  app.post('/clubs/invites/:clubId/decline', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const { clubId } = parse(ClubIdParams, req.params);
    await ctx.db
      .delete(clubInvites)
      .where(
        and(
          eq(clubInvites.clubId, clubId),
          eq(clubInvites.userId, auth.userId),
          eq(clubInvites.kind, 'invite'),
        ),
      );
    return reply.code(204).send();
  });

  app.post('/clubs/me/leave', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const removal = await ctx.db.transaction((tx) => removeMember(tx, auth.userId, ctx.now()));
    if (!removal) throw notFound('Club');
    await notifyClub(ctx, removal.clubId, { type: 'club_update', clubId: removal.clubId }, [auth.userId]);
    if (removal.newOwnerId)
      await ctx.notifier.notifyUser(removal.newOwnerId, {
        type: 'notification',
        kind: 'info',
        title: `You now own ${removal.clubName}`,
        body: 'The previous owner left the club.',
      });
    return reply.code(204).send();
  });

  app.post('/clubs/me/disband', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const result = await ctx.db.transaction(async (tx) => {
      const { club: c, m } = await lockOwnClub(tx, auth.userId);
      requireRole(m, 'disband');
      return { club: c, members: await disbandClub(tx, c.id, 'owner', ctx.now()) };
    });
    await ctx.notifier.notifyMany(result.members, {
      type: 'club_removed',
      clubId: result.club.id,
      name: result.club.name,
      reason: 'disbanded',
    });
    return reply.code(204).send();
  });

  app.post('/clubs/me/transfer', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const { userId } = parse(UserBody, req.body);
    if (userId === auth.userId) throw badRequest('self_transfer', 'You already own this club');
    const club = await ctx.db.transaction(async (tx) => {
      const { club: c, m } = await lockOwnClub(tx, auth.userId);
      requireRole(m, 'transfer');
      const target = await membershipOf(tx, userId);
      if (target?.clubId !== c.id) throw notFound('Member');
      await tx
        .update(clubMembers)
        .set({ role: 'owner' })
        .where(and(eq(clubMembers.userId, userId), eq(clubMembers.clubId, c.id)));
      await tx
        .update(clubMembers)
        .set({ role: 'officer' })
        .where(and(eq(clubMembers.userId, auth.userId), eq(clubMembers.clubId, c.id)));
      return c;
    });
    await notifyClub(ctx, club.id, { type: 'club_update', clubId: club.id });
    await ctx.notifier.notifyUser(userId, {
      type: 'notification',
      kind: 'info',
      title: `You now own ${club.name}`,
    });
    return { ok: true };
  });

  app.post('/clubs/me/invites', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const { userId } = parse(UserBody, req.body);
    if (userId === auth.userId) throw badRequest('self_invite', 'You are already here');
    // SECURITY: invites go to friends only, which also rules out blocked pairs (blocking ends a friendship).
    if (
      !(await friendIds(ctx.db, auth.userId)).includes(userId) ||
      (await isBlockedEitherWay(ctx.db, auth.userId, userId))
    )
      throw forbidden('not_friends', 'You can only invite friends');
    const now = ctx.now();
    const club = await ctx.db.transaction(async (tx) => {
      const { club: c, m } = await lockOwnClub(tx, auth.userId);
      requireRole(m, 'invite');
      const theirs = await membershipOf(tx, userId);
      if (theirs?.clubId === c.id) throw conflict('already_member', 'They are already in your club');
      await requireNotKicked(tx, c.id, userId, now);
      await tx
        .insert(clubInvites)
        .values({ clubId: c.id, userId, kind: 'invite', invitedBy: auth.userId, createdAt: now })
        .onConflictDoUpdate({
          target: [clubInvites.clubId, clubInvites.userId, clubInvites.kind],
          set: { invitedBy: auth.userId, createdAt: now },
        });
      return c;
    });
    await ctx.notifier.notifyUser(userId, {
      type: 'club_invite',
      clubId: club.id,
      name: club.name,
      tag: club.tag,
      from: await socialRef(ctx.db, auth.userId),
    });
    return reply.code(201).send({ invited: userId });
  });

  app.post('/clubs/me/requests/:userId/accept', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const { userId } = parse(UserParams, req.params);
    const m = await requireMembership(ctx.db, auth.userId);
    requireRole(m, 'acceptRequest');
    const club = await join(m.clubId, userId, 'request', auth.userId);
    await ctx.notifier.notifyUser(userId, {
      type: 'notification',
      kind: 'success',
      title: `Welcome to ${club.name}!`,
      body: 'Your request to join was accepted.',
    });
    return { status: 'joined' };
  });

  app.post('/clubs/me/requests/:userId/decline', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const { userId } = parse(UserParams, req.params);
    const m = await requireMembership(ctx.db, auth.userId);
    requireRole(m, 'acceptRequest');
    await ctx.db
      .delete(clubInvites)
      .where(
        and(
          eq(clubInvites.clubId, m.clubId),
          eq(clubInvites.userId, userId),
          eq(clubInvites.kind, 'request'),
        ),
      );
    await notifyClub(ctx, m.clubId, { type: 'club_update', clubId: m.clubId });
    return reply.code(204).send();
  });

  app.post('/clubs/me/members/:userId/kick', { config: MUTATE }, async (req, reply) => {
    const auth = await player(req);
    const { userId } = parse(UserParams, req.params);
    if (userId === auth.userId) throw badRequest('self_kick', 'Use leave instead');
    const now = ctx.now();
    const club = await ctx.db.transaction(async (tx) => {
      const { club: c, m } = await lockOwnClub(tx, auth.userId);
      requireRole(m, 'kick');
      const target = await membershipOf(tx, userId);
      if (target?.clubId !== c.id) throw notFound('Member');
      if (!clubOutranks(m.role, target.role))
        throw forbidden('club_role', 'You can only remove members below your role');
      if (!(await removeMember(tx, userId, now))) throw notFound('Member');
      await recordKick(tx, c.id, userId, now);
      return c;
    });
    await ctx.notifier.notifyUser(userId, {
      type: 'club_removed',
      clubId: club.id,
      name: club.name,
      reason: 'kicked',
    });
    await notifyClub(ctx, club.id, { type: 'club_update', clubId: club.id });
    return reply.code(204).send();
  });

  app.post('/clubs/me/members/:userId/role', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const { userId } = parse(UserParams, req.params);
    const { role } = parse(RoleBody, req.body);
    if (userId === auth.userId) throw badRequest('self_role', 'Transfer ownership instead');
    const club = await ctx.db.transaction(async (tx) => {
      const { club: c, m } = await lockOwnClub(tx, auth.userId);
      requireRole(m, 'setRole');
      const target = await membershipOf(tx, userId);
      if (target?.clubId !== c.id) throw notFound('Member');
      // Without this an owner target would be demoted, leaving the club with no owner.
      if (target.role === 'owner') throw forbidden('club_role', 'Transfer ownership instead');
      await tx
        .update(clubMembers)
        .set({ role })
        .where(and(eq(clubMembers.userId, userId), eq(clubMembers.clubId, c.id)));
      return c;
    });
    await notifyClub(ctx, club.id, { type: 'club_update', clubId: club.id });
    return { userId, role };
  });

  app.get('/clubs/me/chat', { config: READ }, async (req) => {
    const auth = await player(req);
    const m = await requireMembership(ctx.db, auth.userId);
    return { clubId: m.clubId, lines: await clubChatHistory(ctx, m.clubId, auth.userId) };
  });

  app.post('/clubs/me/chat', async (req) => {
    const auth = await player(req);
    const { text } = parse(ChatBody, req.body);
    return { message: await sendClubChat(ctx, auth.userId, text) };
  });

  // Invites a club mate into the caller's party, through the ordinary party invite.
  app.post('/clubs/me/party-up', { config: MUTATE }, async (req) => {
    const auth = await player(req);
    const { userId } = parse(UserBody, req.body);
    if (userId === auth.userId) throw badRequest('self_invite', 'That is you');
    const m = await requireMembership(ctx.db, auth.userId);
    requireRole(m, 'partyUp');
    const theirs = await membershipOf(ctx.db, userId);
    // SECURITY: club mates only, and a block either way hides the invite like it hides everything else.
    if (theirs?.clubId !== m.clubId || (await isBlockedEitherWay(ctx.db, auth.userId, userId)))
      throw notFound('Member');
    const presence = await getPresence(ctx.kv, userId);
    if (presence.status === 'offline') throw conflict('member_offline', 'They are offline');
    if (presence.status === 'in_queue' || presence.status === 'in_match')
      throw conflict('member_busy', 'They are in a show right now');
    const p = (await parties.current(auth.userId)) ?? (await parties.create(auth.userId));
    if (p.members.some((x) => x.userId === userId))
      throw conflict('already_in_party', 'They are already in your party');
    if (p.members.length >= MAX_PARTY_SIZE) throw conflict('party_full', 'Party is full');
    const me = p.members.find((x) => x.userId === auth.userId)!;
    await ctx.notifier.notifyUser(userId, {
      type: 'party_invite',
      from: { userId: auth.userId, name: me.displayName, tag: me.tag },
      code: p.code,
      partyId: p.id,
    });
    return { party: parties.view(p), invited: userId };
  });

  app.get('/clubs/me/goals', { config: READ }, async (req) => {
    const auth = await player(req);
    const view = await ctx.db.transaction((tx) => clubGoalsView(tx, ctx, auth.userId));
    if (view.settled.length)
      await ctx.notifier.notifyUser(auth.userId, {
        type: 'wallet',
        ...(await readWallet(ctx.db, auth.userId)),
      });
    return view;
  });

  app.post(
    '/clubs/me/goals/claim',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await player(req);
      const { week, goalId } = parse(ClaimBody, req.body);
      const result = await ctx.db.transaction((tx) => claimClubGoal(tx, ctx, auth.userId, week, goalId));
      await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...result.wallet });
      return result;
    },
  );

  app.post(
    '/clubs/:id/report',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const auth = await player(req);
      const { id } = parse(IdParams, req.params);
      const body = parse(ReportBody, req.body);
      const club = await liveClub(ctx.db, id);
      const m = await membershipOf(ctx.db, auth.userId);
      // SECURITY: chat is attached only for a member, who could read it; outsiders report what is public.
      const evidence =
        m?.clubId === id ? await recentClubMessages(ctx, id, CLUB_REPORT_EVIDENCE_LINES) : null;
      const [row] = await ctx.db
        .insert(clubReports)
        .values({
          reporterId: auth.userId,
          clubId: id,
          reason: body.reason,
          details: body.details ? maskProfanity(body.details) : null,
          snapshot: { name: club.name, tag: club.tag, description: club.description, emblem: club.emblem },
          evidence: evidence?.length ? evidence : null,
          createdAt: ctx.now(),
        })
        .returning({ id: clubReports.id });
      return reply.code(201).send({ id: row!.id, status: 'open' });
    },
  );
}
