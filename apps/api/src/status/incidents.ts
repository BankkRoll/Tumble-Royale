/**
 * Status page incidents: reads in their public shape, and the writes behind
 * the admin routes. Every write runs inside the caller's transaction so the
 * audit row commits with it.
 */
import {
  INCIDENT_LIMITS,
  type IncidentImpact,
  type IncidentStatus,
  type PublicIncident,
} from '@tumble/shared/status';
import { and, count, desc, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { statusIncidents, statusIncidentUpdates } from '../db/schema.ts';
import { ApiError, conflict, notFound } from '../http/errors.ts';

type IncidentRow = typeof statusIncidents.$inferSelect;

/** Which incidents to read. */
export interface IncidentQuery {
  /** Only unresolved ones. */
  activeOnly?: boolean;
  /** Only those that started at or after this instant. */
  since?: Date;
  /** Most incidents returned (newest first). */
  limit: number;
}

/**
 * Incidents in their public shape, newest first, each with its updates
 * (newest first).
 *
 * @param db - Database or transaction.
 * @param q - Filters.
 */
export async function listIncidents(db: DbOrTx, q: IncidentQuery): Promise<PublicIncident[]> {
  const where: SQL[] = [];
  if (q.activeOnly) where.push(isNull(statusIncidents.resolvedAt));
  // An incident belongs to a window when it overlapped it: one opened long
  // before and still open (or resolved inside the window) counts too.
  if (q.since)
    where.push(
      or(
        gte(statusIncidents.startedAt, q.since),
        isNull(statusIncidents.resolvedAt),
        gte(statusIncidents.resolvedAt, q.since),
      )!,
    );
  const rows = await db
    .select()
    .from(statusIncidents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(statusIncidents.startedAt))
    .limit(q.limit);
  return withUpdates(db, rows);
}

/**
 * One incident in its public shape.
 *
 * @param db - Database or transaction.
 * @param id - Incident id.
 * @throws {ApiError} 404 when there is no such incident.
 */
export async function getIncident(db: DbOrTx, id: string): Promise<PublicIncident> {
  const rows = await db.select().from(statusIncidents).where(eq(statusIncidents.id, id));
  if (rows.length === 0) throw notFound('Incident');
  return (await withUpdates(db, rows))[0]!;
}

async function withUpdates(db: DbOrTx, rows: IncidentRow[]): Promise<PublicIncident[]> {
  if (rows.length === 0) return [];
  const updates = await db
    .select()
    .from(statusIncidentUpdates)
    .where(
      inArray(
        statusIncidentUpdates.incidentId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(statusIncidentUpdates.createdAt), desc(statusIncidentUpdates.id));
  const by = new Map<string, PublicIncident['updates']>();
  for (const u of updates) {
    const list = by.get(u.incidentId) ?? [];
    list.push({ status: u.status as IncidentStatus, message: u.message, at: u.createdAt.toISOString() });
    by.set(u.incidentId, list);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    impact: r.impact as IncidentImpact,
    status: r.status as IncidentStatus,
    components: r.components,
    startedAt: r.startedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    updates: by.get(r.id) ?? [],
  }));
}

/** A new incident. */
export interface NewIncident {
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  components: string[];
  /** The first public update. */
  message: string;
}

/**
 * Opens an incident with its first update.
 *
 * @param tx - Transaction.
 * @param input - Validated, cleaned input.
 * @param now - Clock.
 * @returns The new incident's id.
 */
export async function openIncident(tx: DbOrTx, input: NewIncident, now: Date): Promise<string> {
  const resolved = input.status === 'resolved';
  const [row] = await tx
    .insert(statusIncidents)
    .values({
      title: input.title,
      impact: input.impact,
      status: input.status,
      components: input.components,
      startedAt: now,
      updatedAt: now,
      resolvedAt: resolved ? now : null,
    })
    .returning({ id: statusIncidents.id });
  await tx
    .insert(statusIncidentUpdates)
    .values({ incidentId: row!.id, status: input.status, message: input.message, createdAt: now });
  return row!.id;
}

/** A public update, optionally changing the incident's impact or components. */
export interface IncidentUpdate {
  status: IncidentStatus;
  message: string;
  impact?: IncidentImpact;
  components?: string[];
}

/**
 * Posts an update. A `resolved` update closes the incident; any other status
 * on a resolved incident reopens it.
 *
 * @param tx - Transaction.
 * @param id - Incident id.
 * @param input - Validated, cleaned input.
 * @param now - Clock.
 * @returns The incident before the update.
 * @throws {ApiError} 404 unknown incident, 409 `too_many_updates`, 409
 *   `incident_resolved` when resolving one that is already resolved.
 */
export async function updateIncident(
  tx: DbOrTx,
  id: string,
  input: IncidentUpdate,
  now: Date,
): Promise<IncidentRow> {
  // Row lock: two staff updating at once get a consistent resolved_at and count.
  const [current] = await tx.select().from(statusIncidents).where(eq(statusIncidents.id, id)).for('update');
  if (!current) throw notFound('Incident');
  if (input.status === 'resolved' && current.resolvedAt)
    throw conflict('incident_resolved', 'This incident is already resolved');
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(statusIncidentUpdates)
    .where(eq(statusIncidentUpdates.incidentId, id));
  if (n >= INCIDENT_LIMITS.updatesMax)
    throw new ApiError(409, 'too_many_updates', 'This incident has too many updates; open a new one');
  await tx
    .update(statusIncidents)
    .set({
      status: input.status,
      updatedAt: now,
      resolvedAt: input.status === 'resolved' ? (current.resolvedAt ?? now) : null,
      ...(input.impact ? { impact: input.impact } : {}),
      ...(input.components ? { components: input.components } : {}),
    })
    .where(eq(statusIncidents.id, id));
  await tx
    .insert(statusIncidentUpdates)
    .values({ incidentId: id, status: input.status, message: input.message, createdAt: now });
  return current;
}
