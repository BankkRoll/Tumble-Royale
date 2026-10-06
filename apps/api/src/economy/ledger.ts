/**
 * Currency ledger: the only code path that changes a balance.
 *
 * Every change appends a `currencies_ledger` row and updates the cached
 * balance on `profiles` in the same transaction, under a row lock on the
 * profile so concurrent spends serialise. Grants keyed by `(reason, ref)` are
 * idempotent: a second call with the same key is a no-op.
 *
 * Gem debt is a ledger account of its own (`gem_debt`, cached on
 * `profiles.gem_debt`). {@link revokeGems} takes Gems back after a refund or
 * chargeback and books whatever the balance cannot cover as debt; every later
 * Gem credit repays that debt first, so `gem_debt > 0` implies `gems = 0`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { LedgerCurrency } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { currenciesLedger, profiles } from '../db/schema.ts';
import { ApiError } from '../http/errors.ts';

/** A ledger account: a spendable currency, or the Gem debt left by a reversed payment. */
export type LedgerAccount = LedgerCurrency | 'gem_debt';

/** Why a balance changed. Stored on each ledger row. */
export type LedgerReason =
  | 'match_reward'
  | 'level_reward'
  | 'purchase'
  | 'gem_pack'
  | 'pass_reward'
  | 'pass_premium'
  | 'challenge_reward'
  /** An achievement unlocked (ref `achievement:<id>`). */
  | 'achievement_reward'
  /** A limited-time event tier or challenge (ref `event:<eventId>:<tier>` or `event:<eventId>:challenge:<id>`). */
  | 'event_reward'
  /** A weekly club goal (ref `club:<clubId>:<YYYY-Www>:<goalId>`). */
  | 'club_reward'
  /** A daily login claim (ref `login:<YYYY-MM-DD>`). */
  | 'login_reward'
  | 'shard_conversion'
  /** Free Gems for the first Crown of a UTC day (ref `day:<YYYY-MM-DD>`). */
  | 'daily_crown'
  /** Crown Shards spent in the shard shop (ref = purchase id). */
  | 'shard_shop'
  /** Currency given back by a self-service store refund (ref `refund:<purchaseId>`). */
  | 'store_refund'
  /** A store item bought for a friend (ref `gift:<giftId>`). */
  | 'gift'
  /** A gift's price given back to its sender: declined, cancelled, returned or reversed (ref `gift:<giftId>`). */
  | 'gift_refund'
  /** Gems (and debt) taken back after a refund or dispute (ref `<purchaseId>:<n>`). */
  | 'gem_reversal'
  /** Gems given back when a dispute is won (ref `<purchaseId>:<n>`). */
  | 'gem_restore'
  /** Gem debt paid off by a Gem credit (ref `<credit reason>:<credit ref>`). */
  | 'debt_repayment'
  /** Gem debt written off by an admin. */
  | 'debt_forgiven'
  | 'admin_adjust';

/** One balance change. */
export interface LedgerEntry {
  userId: string;
  currency: LedgerAccount;
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

/** Wallet plus the Gem debt, which is not spendable and not part of {@link Wallet}. */
interface Balances extends Wallet {
  gemDebt: number;
}

const FIELD: Record<LedgerAccount, keyof Balances> = {
  gumballs: 'gumballs',
  gems: 'gems',
  crown_shards: 'crownShards',
  gem_debt: 'gemDebt',
};

const BALANCE_COLUMNS = {
  gumballs: profiles.gumballs,
  gems: profiles.gems,
  crownShards: profiles.crownShards,
  gemDebt: profiles.gemDebt,
};

async function lockBalances(tx: DbOrTx, userId: string): Promise<Balances> {
  const [row] = await tx
    .select(BALANCE_COLUMNS)
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  if (!row) throw new ApiError(404, 'not_found', 'Profile not found');
  return row;
}

/**
 * Locks the profile row for the rest of the transaction and returns balances.
 *
 * @param tx - Open transaction.
 * @param userId - Whose wallet.
 * @throws {ApiError} 404 when the profile is missing.
 */
export async function lockWallet(tx: DbOrTx, userId: string): Promise<Wallet> {
  const { gumballs, gems, crownShards } = await lockBalances(tx, userId);
  return { gumballs, gems, crownShards };
}

async function isDuplicate(tx: DbOrTx, entry: LedgerEntry): Promise<boolean> {
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
  return Boolean(dup);
}

async function writeRows(
  tx: DbOrTx,
  userId: string,
  rows: { currency: LedgerAccount; delta: number; reason: LedgerReason; ref: string; balanceAfter: number }[],
  balances: Balances,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(currenciesLedger).values(rows.map((r) => ({ userId, ...r })));
  const patch: Partial<Balances> = {};
  for (const r of rows) patch[FIELD[r.currency]] = r.balanceAfter;
  await tx
    .update(profiles)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(profiles.userId, userId));
  Object.assign(balances, patch);
}

/**
 * Applies a ledger entry. Must run inside a transaction.
 *
 * A positive Gem entry repays outstanding Gem debt first: the debt share is
 * booked as a `debt_repayment` row and only the rest reaches the balance (the
 * Gem row is still written, possibly with delta 0, so the entry stays idempotent).
 *
 * @param tx - Open transaction.
 * @param entry - The change.
 * @returns New balance and whether the entry was applied (false = duplicate key).
 * @throws {ApiError} 402 `insufficient_funds` when a spend exceeds the balance.
 */
export async function applyLedger(
  tx: DbOrTx,
  entry: LedgerEntry,
): Promise<{ balance: number; applied: boolean }> {
  const balances = await lockBalances(tx, entry.userId);
  const field = FIELD[entry.currency];
  if (entry.delta === 0) return { balance: balances[field], applied: false };
  if (await isDuplicate(tx, entry)) return { balance: balances[field], applied: false };

  let delta = entry.delta;
  const rows: Parameters<typeof writeRows>[2] = [];
  if (entry.currency === 'gems' && delta > 0 && balances.gemDebt > 0) {
    const repay = Math.min(balances.gemDebt, delta);
    delta -= repay;
    rows.push({
      currency: 'gem_debt',
      delta: -repay,
      reason: 'debt_repayment',
      ref: `${entry.reason}:${entry.ref}`,
      balanceAfter: balances.gemDebt - repay,
    });
  }
  const balance = balances[field] + delta;
  if (balance < 0) {
    throw new ApiError(402, 'insufficient_funds', `Not enough ${entry.currency}`, {
      currency: entry.currency,
      balance: balances[field],
      required: -delta,
      missing: -balance,
    });
  }
  rows.push({ currency: entry.currency, delta, reason: entry.reason, ref: entry.ref, balanceAfter: balance });
  await writeRows(tx, entry.userId, rows, balances);
  return { balance, applied: true };
}

/** Outcome of {@link revokeGems}. */
export interface Revocation {
  /** Gems taken from the balance. */
  taken: number;
  /** Gems the balance could not cover, added to the Gem debt. */
  owed: number;
  applied: boolean;
}

/**
 * Takes Gems back (refund or chargeback). Whatever the balance cannot cover
 * because the Gems were already spent becomes Gem debt. Idempotent per
 * `(reason, ref)` like {@link applyLedger}. Must run inside a transaction.
 *
 * @param tx - Open transaction.
 * @param userId - Whose Gems.
 * @param amount - Gems to take back (positive).
 * @param ref - Idempotency ref, e.g. `<purchaseId>:<n>`.
 */
export async function revokeGems(
  tx: DbOrTx,
  userId: string,
  amount: number,
  ref: string,
): Promise<Revocation> {
  const balances = await lockBalances(tx, userId);
  if (amount <= 0) return { taken: 0, owed: 0, applied: false };
  if (await isDuplicate(tx, { userId, currency: 'gems', delta: -amount, reason: 'gem_reversal', ref })) {
    return { taken: 0, owed: 0, applied: false };
  }
  const taken = Math.min(balances.gems, amount);
  const owed = amount - taken;
  const rows: Parameters<typeof writeRows>[2] = [
    // Written even when nothing could be taken, as the idempotency marker.
    { currency: 'gems', delta: -taken, reason: 'gem_reversal', ref, balanceAfter: balances.gems - taken },
  ];
  if (owed > 0) {
    rows.push({
      currency: 'gem_debt',
      delta: owed,
      reason: 'gem_reversal',
      ref,
      balanceAfter: balances.gemDebt + owed,
    });
  }
  await writeRows(tx, userId, rows, balances);
  return { taken, owed, applied: true };
}

/**
 * Current Gem debt.
 *
 * @param db - Database or transaction.
 * @param userId - Whose debt.
 */
export async function readGemDebt(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db
    .select({ gemDebt: profiles.gemDebt })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return row?.gemDebt ?? 0;
}

/** Result of {@link verifyLedger}. */
export interface LedgerAudit {
  ok: boolean;
  /** Per account: cached balance vs. ledger sum, only where they differ. */
  mismatches: { currency: LedgerAccount; cached: number; ledger: number }[];
}

/**
 * Integrity check: every cached balance must equal the sum of its ledger rows.
 *
 * @param db - Database.
 * @param userId - Player to audit.
 */
export async function verifyLedger(db: DbOrTx, userId: string): Promise<LedgerAudit> {
  const [p] = await db.select(BALANCE_COLUMNS).from(profiles).where(eq(profiles.userId, userId));
  if (!p) return { ok: false, mismatches: [] };
  const sums = await db
    .select({
      currency: currenciesLedger.currency,
      total: sql<string>`coalesce(sum(${currenciesLedger.delta}), 0)`,
    })
    .from(currenciesLedger)
    .where(eq(currenciesLedger.userId, userId))
    .groupBy(currenciesLedger.currency);
  const ledger = new Map(sums.map((s) => [s.currency, Number(s.total)]));
  const mismatches: LedgerAudit['mismatches'] = [];
  for (const currency of Object.keys(FIELD) as LedgerAccount[]) {
    const cached = p[FIELD[currency]];
    const sum = ledger.get(currency) ?? 0;
    if (cached !== sum) mismatches.push({ currency, cached, ledger: sum });
  }
  return { ok: mismatches.length === 0, mismatches };
}
