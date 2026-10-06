/**
 * The admin console's player page:
 *
 * - `GET /internal/users/:id` — everything a moderator needs about one
 *   account: sign-in methods, balances, stats, recent matches and purchases,
 *   owned cosmetics, reports against and by the player, bans, warnings, name
 *   history and the audit trail.
 * - `POST /internal/users/:id/warn` — record a warning and notify the player.
 * - `POST /internal/users/:id/reset-name` — replace the display name with a
 *   generated one.
 * - `POST /internal/users/:id/currency` (admin) — credit or debit a currency
 *   through the ledger.
 * - `DELETE /internal/users/:id/inventory/:cosmeticId` (admin) — revoke a
 *   cosmetic and take it out of every loadout that wears it.
 *
 * Each mutation requires a reason and writes an audit row in the same
 * transaction.
 */
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { changeDisplayName } from '../accounts/accounts.ts';
import { starterItems } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import {
  adminAuditLog,
  authIdentities,
  bans,
  inventoryItems,
  matches,
  matchParticipants,
  nameHistory,
  playerStats,
  playerWarnings,
  profiles,
  purchases,
  reports,
  staffMembers,
  users,
} from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { revokeCosmetic } from '../inventory/revoke.ts';
import { readWallet } from '../economy/wallet.ts';
import { badRequest, notFound, parse } from '../http/errors.ts';
import { generateGuestName } from '../names/display-name.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { assertCanModerate } from './guard.ts';
import { announceSanction, applySanction } from './sanctions.ts';

const UUID = z.string().uuid();
const IdParams = z.object({ id: UUID });
const Reason = z.string().trim().min(3).max(500);
const ReasonBody = z.object({ reason: Reason }).strict();
/** Largest single adjustment, so a typo cannot mint a fortune. */
export const MAX_CURRENCY_ADJUSTMENT = 1_000_000;
const CurrencyBody = z
  .object({
    currency: z.enum(['gumballs', 'gems', 'crown_shards']),
    delta: z
      .number()
      .int()
      .min(-MAX_CURRENCY_ADJUSTMENT)
      .max(MAX_CURRENCY_ADJUSTMENT)
      .refine((d) => d !== 0, 'delta must not be 0'),
    reason: Reason,
  })
  .strict();

/**
 * Registers the player page routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerPlayerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/users/:id', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const [account] = await ctx.db
      .select({
        id: users.id,
        isGuest: users.isGuest,
        email: users.email,
        region: users.region,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        displayName: profiles.displayName,
        tag: profiles.tag,
        nameChangedAt: profiles.nameChangedAt,
        level: profiles.level,
        xp: profiles.xp,
        crowns: profiles.crowns,
        gumballs: profiles.gumballs,
        gems: profiles.gems,
        crownShards: profiles.crownShards,
        gemDebt: profiles.gemDebt,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, id));
    if (!account) throw notFound('User');

    const reporter = sql<
      string | null
    >`(select ${profiles.displayName} || '#' || ${profiles.tag} from ${profiles} where ${profiles.userId} = ${reports.reporterId})`;
    const target = sql<
      string | null
    >`(select ${profiles.displayName} || '#' || ${profiles.tag} from ${profiles} where ${profiles.userId} = ${reports.targetUserId})`;
    const [
      providers,
      staff,
      [stats],
      [{ n: matchCount } = { n: 0 }],
      recentMatches,
      [{ n: purchaseCount } = { n: 0 }],
      recentPurchases,
      inventory,
      reportsAgainstByStatus,
      reportsAgainst,
      [{ n: reportsByCount } = { n: 0 }],
      reportsBy,
      banRows,
      warnings,
      names,
      audit,
    ] = await Promise.all([
      ctx.db
        .select({ provider: authIdentities.provider, createdAt: authIdentities.createdAt })
        .from(authIdentities)
        .where(eq(authIdentities.userId, id)),
      ctx.db
        .select({ role: staffMembers.role, grantedBy: staffMembers.grantedBy })
        .from(staffMembers)
        .where(eq(staffMembers.userId, id)),
      ctx.db.select().from(playerStats).where(eq(playerStats.userId, id)),
      ctx.db.select({ n: count() }).from(matchParticipants).where(eq(matchParticipants.userId, id)),
      ctx.db
        .select({
          matchId: matches.id,
          queue: matches.queue,
          playlistId: matches.playlistId,
          endedAt: matches.endedAt,
          placement: matchParticipants.placement,
          crowned: matchParticipants.crowned,
        })
        .from(matchParticipants)
        .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
        .where(eq(matchParticipants.userId, id))
        .orderBy(desc(matches.endedAt))
        .limit(10),
      ctx.db.select({ n: count() }).from(purchases).where(eq(purchases.userId, id)),
      ctx.db
        .select({
          id: purchases.id,
          kind: purchases.kind,
          itemId: purchases.itemId,
          currency: purchases.currency,
          price: purchases.price,
          status: purchases.status,
          provider: purchases.provider,
          createdAt: purchases.createdAt,
        })
        .from(purchases)
        .where(eq(purchases.userId, id))
        .orderBy(desc(purchases.createdAt))
        .limit(20),
      ctx.db
        .select({
          cosmeticId: inventoryItems.cosmeticId,
          source: inventoryItems.source,
          acquiredAt: inventoryItems.acquiredAt,
        })
        .from(inventoryItems)
        .where(eq(inventoryItems.userId, id))
        .orderBy(desc(inventoryItems.acquiredAt))
        .limit(1000),
      ctx.db
        .select({ status: reports.status, n: count() })
        .from(reports)
        .where(eq(reports.targetUserId, id))
        .groupBy(reports.status),
      ctx.db
        .select({
          id: reports.id,
          reason: reports.reason,
          status: reports.status,
          details: reports.details,
          matchId: reports.matchId,
          createdAt: reports.createdAt,
          reporterId: reports.reporterId,
          reporter,
        })
        .from(reports)
        .where(eq(reports.targetUserId, id))
        .orderBy(desc(reports.createdAt))
        .limit(20),
      ctx.db.select({ n: count() }).from(reports).where(eq(reports.reporterId, id)),
      ctx.db
        .select({
          id: reports.id,
          reason: reports.reason,
          status: reports.status,
          createdAt: reports.createdAt,
          targetUserId: reports.targetUserId,
          target,
        })
        .from(reports)
        .where(eq(reports.reporterId, id))
        .orderBy(desc(reports.createdAt))
        .limit(10),
      ctx.db.select().from(bans).where(eq(bans.userId, id)).orderBy(desc(bans.createdAt)).limit(50),
      ctx.db
        .select()
        .from(playerWarnings)
        .where(eq(playerWarnings.userId, id))
        .orderBy(desc(playerWarnings.createdAt))
        .limit(50),
      ctx.db
        .select({
          displayName: nameHistory.displayName,
          tag: nameHistory.tag,
          changedBy: nameHistory.changedBy,
          changedAt: nameHistory.changedAt,
        })
        .from(nameHistory)
        .where(eq(nameHistory.userId, id))
        .orderBy(desc(nameHistory.changedAt))
        .limit(50),
      ctx.db
        .select()
        .from(adminAuditLog)
        .where(and(eq(adminAuditLog.targetType, 'user'), eq(adminAuditLog.targetId, id)))
        .orderBy(desc(adminAuditLog.id))
        .limit(20),
    ]);
    const now = ctx.now().getTime();
    const starters = new Set(starterItems(ctx.catalog));
    return {
      account: {
        ...account,
        providers: providers.map((p) => p.provider),
        staffRole: staff[0]?.role ?? null,
      },
      stats: stats ?? null,
      matches: { total: matchCount, recent: recentMatches },
      purchases: { total: purchaseCount, recent: recentPurchases },
      inventory: inventory.map((i) => ({
        ...i,
        name: ctx.cosmetics.get(i.cosmeticId)?.name ?? i.cosmeticId,
        slot: ctx.cosmetics.get(i.cosmeticId)?.slot ?? null,
        starter: starters.has(i.cosmeticId),
      })),
      reportsAgainst: {
        byStatus: Object.fromEntries(reportsAgainstByStatus.map((r) => [r.status, r.n])),
        recent: reportsAgainst,
      },
      reportsBy: { total: reportsByCount, recent: reportsBy },
      bans: banRows.map((b) => ({
        ...b,
        active: b.revokedAt === null && (b.expiresAt === null || b.expiresAt.getTime() > now),
      })),
      warnings,
      nameHistory: names,
      audit,
    };
  });

  app.post('/internal/users/:id/warn', async (req, reply) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const { reason } = parse(ReasonBody, req.body);
    await assertCanModerate(ctx, actor, id);
    const applied = await ctx.db.transaction(async (tx) => {
      const s = await applySanction(tx, ctx.now(), {
        userId: id,
        kind: 'warn',
        reason,
        issuedBy: actor.label,
      });
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'player.warn',
          targetType: 'user',
          targetId: id,
          reason,
          details: { warningId: s.warningId },
        },
        tx,
      );
      return s;
    });
    await announceSanction(ctx, applied, reason);
    return reply.code(201).send({ warningId: applied.warningId });
  });

  app.post('/internal/users/:id/reset-name', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const { reason } = parse(ReasonBody, req.body);
    await assertCanModerate(ctx, actor, id);
    const result = await ctx.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ name: profiles.displayName, tag: profiles.tag })
        .from(profiles)
        .where(eq(profiles.userId, id));
      if (!before) throw notFound('User');
      // Generated names come from a fixed word list, so they always pass the name rules.
      let next = generateGuestName();
      while (next === before.name) next = generateGuestName();
      const after = await changeDisplayName(tx, id, next, ctx.now(), 0, 'staff');
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'player.reset_name',
          targetType: 'user',
          targetId: id,
          reason,
          details: { from: `${before.name}#${before.tag}`, to: `${after.displayName}#${after.tag}` },
        },
        tx,
      );
      return after;
    });
    return { userId: id, ...result };
  });

  app.post('/internal/users/:id/currency', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { id } = parse(IdParams, req.params);
    const body = parse(CurrencyBody, req.body);
    const ref = `staff:${randomUUID()}`;
    const balance = await ctx.db.transaction(async (tx) => {
      const r = await applyLedger(tx, {
        userId: id,
        currency: body.currency,
        delta: body.delta,
        reason: 'admin_adjust',
        ref,
      });
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'player.currency_adjust',
          targetType: 'user',
          targetId: id,
          reason: body.reason,
          details: { currency: body.currency, delta: body.delta, balance: r.balance, ref },
        },
        tx,
      );
      return r.balance;
    });
    const wallet = await readWallet(ctx.db, id);
    await ctx.notifier.notifyUser(id, { type: 'wallet', ...wallet });
    return { userId: id, currency: body.currency, balance, wallet };
  });

  app.delete('/internal/users/:id/inventory/:cosmeticId', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { id, cosmeticId } = parse(
      z.object({ id: UUID, cosmeticId: z.string().min(1).max(64) }),
      req.params,
    );
    const { reason } = parse(ReasonBody, req.body);
    // Starter items back the default loadout every slot falls back to.
    if (starterItems(ctx.catalog).includes(cosmeticId))
      throw badRequest('starter_item', 'Starter items cannot be revoked');
    const changedLoadouts = await ctx.db.transaction(async (tx) => {
      const revoked = await revokeCosmetic(tx, ctx, id, cosmeticId);
      if (!revoked) throw notFound('Owned cosmetic');
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'player.cosmetic_revoke',
          targetType: 'user',
          targetId: id,
          reason,
          details: { cosmeticId, source: revoked.source, loadouts: revoked.loadouts },
        },
        tx,
      );
      return revoked.loadouts;
    });
    return { userId: id, cosmeticId, loadoutsChanged: changedLoadouts };
  });
}
