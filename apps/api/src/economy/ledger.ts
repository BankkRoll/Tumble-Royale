/**
 * Currency ledger: the only code path that changes a balance.
 *
 * Every change appends a `currencies_ledger` row and updates the cached
 * balance on `profiles` in the same transaction, under a row lock on the
 * profile so concurrent spends serialise. Grants keyed by `(reason, ref)` are
 * idempotent: a second call with the same key is a no-op.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { LedgerCurrency } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { currenciesLedger, profiles } from '../db/schema.ts';
import { ApiError } from '../http/errors.ts';

/** Why a balance changed. Stored on each ledger row. */
export type LedgerReason =
  | 'match_reward'
  | 'level_reward'
  | 'purchase'
  | 'gem_pack'
  | 'pass_reward'
  | 'pass_premium'
  | 'challenge_reward'
  | 'shard_conversion'
  | 'admin_adjust';

/** One balance change. */
export interface LedgerEntry {
  userId: string;
  currency: LedgerCurrency;
  /** Positive grants, negative spends. Zero is ignored. */
  delta: number;
  reason: LedgerReason;
  /** External id making the entry idempotent (match id, purchase id, `s1:tier:12:free`…). */
  ref: string;
}

/** Balances as cached on the profile. */
export interface Wallet {
  gumballs: number;
  gems: number;
  crownShards: number;
}

const FIELD: Record<LedgerCurrency, keyof Wallet> = {
  gumballs: 'gumballs',
  gems: 'gems',
  crown_shards: 'crownShards',
};

/**
 * Locks the profile row for the rest of the transaction and returns balances.
 *
 * @param tx - Open transaction.
 * @param userId - Whose wallet.
 * @throws {ApiError} 404 when the profile is missing.
 */
export async function lockWallet(tx: DbOrTx, userId: string): Promise<Wallet> {
  const [row] = await tx
    .select({ gumballs: profiles.gumballs, gems: profiles.gems, crownShards: profiles.crownShards })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  if (!row) throw new ApiError(404, 'not_found', 'Profile not found');
  return row;
}

/**
 * Applies a ledger entry. Must run inside a transaction.
 *
 * @param tx - Open transaction.
 * @param entry - The change.
 * @returns New balance and whether the entry was applied (false = duplicate key).
 * @throws {ApiError} 402 `insufficient_funds` when a spend exceeds the balance.
 */
export async function applyLedger(tx: DbOrTx, entry: LedgerEntry): Promise<{ balance: number; applied: boolean }> {
  const wallet = await lockWallet(tx, entry.userId);
  const field = FIELD[entry.currency];
  if (entry.delta === 0) return { balance: wallet[field], applied: false };
  const [dup] = await tx
    .select({ id: currenciesLedger.id })
    .from(currenciesLedger)
    .where(
      and(
        eq(currenciesLedger.userId, entry.userId),
        eq(currenciesLedger.currency, entry.currency),
        eq(currenciesLedger.reason, entry.reason),
        eq(currenciesLedger.ref, entry.ref),
      ),
    );
  if (dup) return { balance: wallet[field], applied: false };
  const balance = wallet[field] + entry.delta;
  if (balance < 0) {
    throw new ApiError(402, 'insufficient_funds', `Not enough ${entry.currency}`, {
      currency: entry.currency,
      balance: wallet[field],
      required: -entry.delta,
      missing: -balance,
    });
  }
  await tx.insert(currenciesLedger).values({ ...entry, balanceAfter: balance });
  const patch: Partial<Wallet> = { [field]: balance };
  await tx
    .update(profiles)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(profiles.userId, entry.userId));
  return { balance, applied: true };
}

/** Result of {@link verifyLedger}. */
export interface LedgerAudit {
  ok: boolean;
  /** Per currency: cached balance vs. ledger sum, only where they differ. */
  mismatches: { currency: LedgerCurrency; cached: number; ledger: number }[];
}

/**
 * Integrity check: every cached balance must equal the sum of its ledger rows.
 *
 * @param db - Database.
 * @param userId - Player to audit.
 */
export async function verifyLedger(db: DbOrTx, userId: string): Promise<LedgerAudit> {
  const [p] = await db
    .select({ gumballs: profiles.gumballs, gems: profiles.gems, crownShards: profiles.crownShards })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  if (!p) return { ok: false, mismatches: [] };
  const sums = await db
    .select({ currency: currenciesLedger.currency, total: sql<string>`coalesce(sum(${currenciesLedger.delta}), 0)` })
    .from(currenciesLedger)
    .where(eq(currenciesLedger.userId, userId))
    .groupBy(currenciesLedger.currency);
  const ledger = new Map(sums.map((s) => [s.currency, Number(s.total)]));
  const mismatches: LedgerAudit['mismatches'] = [];
  for (const currency of Object.keys(FIELD) as LedgerCurrency[]) {
    const cached = p[FIELD[currency]];
    const sum = ledger.get(currency) ?? 0;
    if (cached !== sum) mismatches.push({ currency, cached, ledger: sum });
  }
  return { ok: mismatches.length === 0, mismatches };
}
