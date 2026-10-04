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
 * Staff (admin only; the CLI grants the first admin):
 * - `GET /internal/staff`, `PUT /internal/staff/:userId` `{ role }`,
 *   `DELETE /internal/staff/:userId`.
 *
 * Audit (moderators and admins):
 * - `GET /internal/audit` — newest first, filtered by action, actor or
 *   target, paged with `before=<id>`.
 */
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { adminAuditLog, profiles, staffMembers, users } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { badRequest, forbidden, notFound, parse } from '../http/errors.ts';
import { AUTH_RATE } from '../http/rate-limit.ts';
import { recordAudit } from './audit.ts';
import {
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

/**
 * Registers the console session, staff and audit routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerStaffRoutes(app: FastifyInstance, ctx: AppContext): void {
  // SECURITY: the only door from a player session into the console. The
  // access token proves the account; the staff row, checked here and again on
  // every console request, proves the role. Limited per IP like sign-in.
  app.post('/admin/session', { config: AUTH_RATE }, async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const [user] = await ctx.db
      .select({ isGuest: users.isGuest })
      .from(users)
      .where(eq(users.id, auth.userId));
    const staff = user && !user.isGuest ? await staffRoleOf(ctx, auth.userId) : null;
    if (!staff) throw forbidden('not_staff', 'This account has no admin console access');
    const session = await createStaffSession(ctx, auth.userId);
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
    if (user.isGuest)
      throw badRequest('guest_account', 'Link an email, Discord or Google sign-in to this account first');
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
