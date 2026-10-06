/**
 * The admin audit log: one append-only `admin_audit_log` row per admin
 * action, whoever performed it (CLI token or console session).
 */
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { adminAuditLog } from '../db/schema.ts';
import type { StaffActor } from './auth.ts';

/** What happened, to what, and why. */
export interface AuditEntry {
  /** Dotted action name, e.g. `player.ban`. */
  action: string;
  targetType?: string;
  targetId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Writes one audit row (and an info log line).
 *
 * @param ctx - Shared services.
 * @param req - The admin request (for the client IP and logger).
 * @param actor - Who acted, from `requireStaff`.
 * @param entry - The action.
 * @param db - Transaction to join, so the row commits with the action it records.
 * @example
 * await recordAudit(ctx, req, actor, { action: 'flag.set', targetType: 'flag', targetId: key });
 */
export async function recordAudit(
  ctx: AppContext,
  req: FastifyRequest,
  actor: StaffActor,
  entry: AuditEntry,
  db: DbOrTx = ctx.db,
): Promise<void> {
  req.log.info({ audit: entry.action, actor: actor.label, target: entry.targetId ?? null }, 'admin action');
  await writeAuditRow(db, actor, entry, req.ip, ctx.now());
}

/**
 * Writes one audit row without a request (boot-time jobs such as the
 * development admin seed).
 *
 * @param db - Database or transaction.
 * @param actor - Who acted.
 * @param entry - The action.
 * @param ip - Client address, or null when there is no client.
 * @param at - When it happened.
 */
export async function writeAuditRow(
  db: DbOrTx,
  actor: StaffActor,
  entry: AuditEntry,
  ip: string | null,
  at: Date,
): Promise<void> {
  await db.insert(adminAuditLog).values({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    actorRole: actor.role,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    reason: entry.reason ?? null,
    details: entry.details ?? null,
    ip,
    createdAt: at,
  });
}
