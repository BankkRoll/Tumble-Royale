/**
 * Admin console sign-in, staff management and the audit log.
 *
 * Console sessions:
 * - `POST /admin/session` — trade a signed-in staff account's access token for
 *   a 30-minute console token (`tra_…`). Guests, suspended accounts and
 *   accounts without a staff role are refused.
 * - `DELETE /admin/session` — sign out (the console token in the header).
 * - `GET /internal/admin/me` — who the presented credential acts as.
 *
 * Staff (admin only):
 * - `GET /internal/staff`, `PUT /internal/staff/:userId` `{ role }`,
 *   `DELETE /internal/staff/:userId`.
 *
 * First admin and sign-in links (`ADMIN_TOKEN` only, never a console session;
 * see `staff/bootstrap.ts`):
 * - `POST /internal/staff/bootstrap` `{ email, displayName? }` — find or create
 *   the account, make it admin, return a one-time sign-in link;
 * - `POST /internal/staff/:userId/link` — a fresh link for a staff account;
 * - `POST /auth/staff-link` `{ token }` — redeem a link for a game session.
 *
 * Audit (moderators and admins):
 * - `GET /internal/audit` — newest first, filtered by action, actor or
 *   target, paged with `before=<id>`.
 */
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthResult } from '../auth/routes.ts';
import { sessionFamily, startSession } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { adminAuditLog, profiles, staffMembers, users } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { badRequest, forbidden, notFound, parse, unauthorized } from '../http/errors.ts';
import { AUTH_RATE, ipRateKey } from '../http/rate-limit.ts';
import { recordAudit } from './audit.ts';
import { bootstrapAdmin, issueStaffLink, redeemStaffLink, requireLinkableStaff } from './bootstrap.ts';
import {
  CONSOLE_REAUTH_MS,
  createStaffSession,
  endStaffSession,
  requireStaff,
  STAFF_ROLES,
  staffRoleOf,
  type StaffActor,
} from './auth.ts';

const UUID = z.string().uuid();
const RoleBody = z.object({ role: z.enum(STAFF_ROLES) }).strict();
const AuditQuery = z.object({
  /** Exact action, or a prefix ending in `.` (`player.`). */
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]*)?$/)
    .max(64)
    .optional(),
  actorUserId: UUID.optional(),
  targetType: z
    .string()
    .regex(/^[a-z_]+$/)
    .max(32)
    .optional(),
  targetId: z.string().min(1).max(128).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const BootstrapBody = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((e) => e.toLowerCase()),
    displayName: z.string().trim().min(1).max(32).optional(),
  })
  .strict();
const LinkBody = z.object({ token: z.string().min(20).max(200) });

/** Minting links is rarer than signing in; a tight per-IP budget blunts a leaked token. */
const LINK_RATE = { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: ipRateKey } };

/**
 * Only the static operator token may create admins or mint sign-in links: a
 * console session that could do either would let one stolen session mint
 * more access for itself.
 */
async function requireOperatorToken(ctx: AppContext, req: FastifyRequest): Promise<StaffActor> {
  const actor = await requireStaff(ctx, req);
  if (actor.kind !== 'token')
    throw forbidden(
      'operator_token_required',
      'This action needs ADMIN_TOKEN (pnpm admin), not a console session',
    );
  return actor;
}

/**
 * Registers the console session, staff and audit routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerStaffRoutes(app: FastifyInstance, ctx: AppContext): void {
  // SECURITY: the only door from a player session into the console. The
  // access token proves the account, its session must still be signed in and
  // recent, and the staff row, checked here and again on every console
  // request, proves the role. Limited per IP like sign-in.
  app.post('/admin/session', { config: AUTH_RATE }, async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const family = await sessionFamily(ctx.db, auth.sessionId, ctx.now());
    if (!family?.alive) throw unauthorized('This game session was signed out; sign in again');
    const [user] = await ctx.db
      .select({ isGuest: users.isGuest })
      .from(users)
      .where(eq(users.id, auth.userId));
    const staff = user && !user.isGuest ? await staffRoleOf(ctx, auth.userId) : null;
    if (!staff) throw forbidden('not_staff', 'This account has no admin console access');
    if (ctx.now().getTime() - family.signedInAt.getTime() > CONSOLE_REAUTH_MS) {
      throw forbidden(
        'reauth_required',
        'For the console, sign out of the game and sign in again (or open a new staff link), then retry within 10 minutes',
      );
    }
    const session = await createStaffSession(ctx, auth.userId, family.familyId);
    const actor: StaffActor = { kind: 'staff', userId: auth.userId, label: staff.label, role: staff.role };
    await recordAudit(ctx, req, actor, {
      action: 'session.start',
      targetType: 'user',
      targetId: auth.userId,
    });
    return reply.code(201).send({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      actor: { userId: auth.userId, label: staff.label, role: staff.role },
    });
  });

  app.delete('/admin/session', async (req, reply) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    if (actor.sessionHash) {
      await endStaffSession(ctx, actor.sessionHash);
      await recordAudit(ctx, req, actor, {
        action: 'session.end',
        targetType: 'user',
        targetId: actor.userId,
      });
    }
    return reply.code(204).send();
  });

  app.get('/internal/admin/me', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    return { actor: { kind: actor.kind, userId: actor.userId, label: actor.label, role: actor.role } };
  });

  app.get('/internal/staff', async (req) => {
    await requireStaff(ctx, req);
    const rows = await ctx.db
      .select({
        userId: staffMembers.userId,
        role: staffMembers.role,
        grantedBy: staffMembers.grantedBy,
        createdAt: staffMembers.createdAt,
        updatedAt: staffMembers.updatedAt,
        displayName: profiles.displayName,
        tag: profiles.tag,
      })
      .from(staffMembers)
      .leftJoin(profiles, eq(profiles.userId, staffMembers.userId))
      .orderBy(staffMembers.createdAt);
    return { staff: rows };
  });

  app.put('/internal/staff/:userId', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { userId } = parse(z.object({ userId: UUID }), req.params);
    const { role } = parse(RoleBody, req.body);
    const [user] = await ctx.db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound('User');
    // SECURITY: a guest is only a device secret; staff must be able to sign in again and be recovered.
    if (user.isGuest) {
      throw badRequest(
        'guest_account',
        'Link a sign-in method (email, Discord, Google, GitHub, Twitch or Apple) to this account first, ' +
          'or create the account with `pnpm admin staff bootstrap --email <address>`',
      );
    }
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(staffMembers)
        .values({ userId, role, grantedBy: actor.label, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: staffMembers.userId,
          set: { role, grantedBy: actor.label, updatedAt: now },
        });
      await recordAudit(
        ctx,
        req,
        actor,
        { action: 'staff.grant', targetType: 'user', targetId: userId, details: { role } },
        tx,
      );
    });
    return { userId, role };
  });

  app.delete('/internal/staff/:userId', async (req, reply) => {
    const actor = await requireStaff(ctx, req);
    const { userId } = parse(z.object({ userId: UUID }), req.params);
    await ctx.db.transaction(async (tx) => {
      const removed = await tx
        .delete(staffMembers)
        .where(eq(staffMembers.userId, userId))
        .returning({ role: staffMembers.role });
      if (removed.length === 0) throw notFound('Staff member');
      await recordAudit(
        ctx,
        req,
        actor,
        { action: 'staff.revoke', targetType: 'user', targetId: userId, details: { role: removed[0]!.role } },
        tx,
      );
    });
    return reply.code(204).send();
  });

  app.post('/internal/staff/bootstrap', { config: LINK_RATE }, async (req, reply) => {
    const actor = await requireOperatorToken(ctx, req);
    const body = parse(BootstrapBody, req.body);
    const result = await bootstrapAdmin(ctx, body, actor, (entry, tx) =>
      recordAudit(ctx, req, actor, entry, tx),
    );
    const link = await issueStaffLink(ctx, result.userId);
    await recordAudit(ctx, req, actor, {
      action: 'staff.link_issue',
      targetType: 'user',
      targetId: result.userId,
      details: { expiresAt: link.expiresAt.toISOString() },
    });
    const [p] = await ctx.db
      .select({ name: profiles.displayName, tag: profiles.tag })
      .from(profiles)
      .where(eq(profiles.userId, result.userId));
    return reply.code(result.created ? 201 : 200).send({
      userId: result.userId,
      label: p ? `${p.name}#${p.tag}` : null,
      email: body.email,
      created: result.created,
      role: 'admin',
      previousRole: result.previousRole,
      link: link.url,
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  app.post('/internal/staff/:userId/link', { config: LINK_RATE }, async (req) => {
    const actor = await requireOperatorToken(ctx, req);
    const { userId } = parse(z.object({ userId: UUID }), req.params);
    const role = await requireLinkableStaff(ctx, userId);
    const link = await issueStaffLink(ctx, userId);
    await recordAudit(ctx, req, actor, {
      action: 'staff.link_issue',
      targetType: 'user',
      targetId: userId,
      details: { expiresAt: link.expiresAt.toISOString() },
    });
    return { userId, role, link: link.url, expiresAt: link.expiresAt.toISOString() };
  });

  // SECURITY: the public half of a staff link. The token is single use and
  // found only by its hash; the account must still be staff when it is used.
  app.post('/auth/staff-link', { config: AUTH_RATE }, async (req) => {
    const { token } = parse(LinkBody, req.body);
    const { userId, role } = await redeemStaffLink(ctx, token);
    const pair = await ctx.db.transaction((tx) =>
      startSession(tx, ctx.config.jwtSecret, userId, ctx.now(), req.headers['user-agent']),
    );
    const label = `${pair.user.displayName}#${pair.user.tag}`;
    await recordAudit(
      ctx,
      req,
      { kind: 'staff', userId, label, role: role as StaffActor['role'] },
      { action: 'staff.link_use', targetType: 'user', targetId: userId },
    );
    return { ...pair, outcome: 'signedIn', provider: 'link' } satisfies AuthResult;
  });

  app.get('/internal/audit', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(AuditQuery, req.query);
    const conds: (SQL | undefined)[] = [
      q.action
        ? q.action.endsWith('.')
          ? like(adminAuditLog.action, `${q.action}%`)
          : eq(adminAuditLog.action, q.action)
        : undefined,
      q.actorUserId ? eq(adminAuditLog.actorUserId, q.actorUserId) : undefined,
      q.targetType ? eq(adminAuditLog.targetType, q.targetType) : undefined,
      q.targetId ? eq(adminAuditLog.targetId, q.targetId) : undefined,
      q.before ? lt(adminAuditLog.id, q.before) : undefined,
    ];
    const rows = await ctx.db
      .select()
      .from(adminAuditLog)
      .where(and(...conds))
      .orderBy(desc(adminAuditLog.id))
      .limit(q.limit);
    return { entries: rows, nextBefore: rows.length === q.limit ? rows.at(-1)!.id : null };
  });
}
