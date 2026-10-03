/**
 * Refresh-token sessions with rotation and reuse detection.
 *
 * Every refresh revokes the presented token and issues a new one in the same
 * family. If a token that was already rotated is presented again, someone else
 * holds a copy, so the whole family is revoked and the caller must sign in again.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AccountRef } from '../accounts/accounts.ts';
import { getAccountRef } from '../accounts/accounts.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { bans, sessions, users } from '../db/schema.ts';
import { ApiError } from '../http/errors.ts';
import {
  ACCESS_TOKEN_TTL_SEC,
  randomToken,
  REFRESH_TOKEN_TTL_MS,
  sha256,
  signAccessToken,
} from './tokens.ts';

/** Token pair returned by every sign-in path. */
export interface TokenPair {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: { id: string; displayName: string; tag: string; region: string; isGuest: boolean };
}

/**
 * Refuses to mint tokens for an account under an active `all` ban, so a
 * suspended player cannot keep a session alive by refreshing.
 *
 * @throws {ApiError} 403 `banned` with the reason and expiry.
 */
async function assertNotSuspended(tx: DbOrTx, userId: string, now: Date): Promise<void> {
  const [ban] = await tx
    .select({ reason: bans.reason, expiresAt: bans.expiresAt })
    .from(bans)
    .where(
      and(
        eq(bans.userId, userId),
        eq(bans.scope, 'all'),
        isNull(bans.revokedAt),
        or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
      ),
    )
    .limit(1);
  if (ban) {
    throw new ApiError(403, 'banned', 'This account is suspended', {
      reason: ban.reason,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
    });
  }
}

async function mint(
  tx: DbOrTx,
  secret: string,
  account: AccountRef,
  familyId: string,
  now: Date,
  userAgent: string | undefined,
): Promise<{ pair: TokenPair; sessionId: string }> {
  const refreshToken = randomToken();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  const sessionId = randomUUID();
  await tx.insert(sessions).values({
    id: sessionId,
    userId: account.userId,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt,
    userAgent: userAgent?.slice(0, 256) ?? null,
    createdAt: now,
  });
  const accessToken = await signAccessToken(
    secret,
    {
      sub: account.userId,
      sid: sessionId,
      name: `${account.displayName}#${account.tag}`,
      region: account.region,
      guest: account.isGuest,
    },
    Math.floor(now.getTime() / 1000),
  );
  return {
    sessionId,
    pair: {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
      user: {
        id: account.userId,
        displayName: account.displayName,
        tag: account.tag,
        region: account.region,
        isGuest: account.isGuest,
      },
    },
  };
}

/**
 * Starts a new session family for a user.
 *
 * @param tx - Database or transaction.
 * @param secret - JWT secret.
 * @param userId - Who signed in.
 * @param now - Current time.
 * @param userAgent - Stored for the session list.
 * @throws {ApiError} 403 `banned` while the account is suspended.
 */
export async function startSession(
  tx: DbOrTx,
  secret: string,
  userId: string,
  now: Date,
  userAgent?: string,
): Promise<TokenPair> {
  await assertNotSuspended(tx, userId, now);
  const account = await getAccountRef(tx, userId);
  await tx.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId));
  return (await mint(tx, secret, account, randomUUID(), now, userAgent)).pair;
}

/**
 * Exchanges a refresh token for a new pair (rotation).
 *
 * @throws {ApiError} 401 `invalid_refresh` (unknown/expired) or `refresh_reused`
 *   (family revoked because a rotated token was replayed); 403 `banned` while suspended.
 */
export async function rotateSession(
  db: Db,
  secret: string,
  refreshToken: string,
  now: Date,
  userAgent?: string,
): Promise<TokenPair> {
  const reused = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(refreshToken)))
      .for('update');
    if (!row) throw new ApiError(401, 'invalid_refresh', 'Unknown refresh token');
    if (row.revokedAt) {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
      return true;
    }
    if (row.expiresAt <= now) throw new ApiError(401, 'invalid_refresh', 'Refresh token expired');
    await assertNotSuspended(tx, row.userId, now);
    const account = await getAccountRef(tx, row.userId);
    const next = await mint(tx, secret, account, row.familyId, now, userAgent);
    await tx
      .update(sessions)
      .set({ revokedAt: now, replacedBy: next.sessionId })
      .where(eq(sessions.id, row.id));
    await tx.update(users).set({ lastSeenAt: now }).where(eq(users.id, row.userId));
    return next.pair;
  });
  // Thrown outside the transaction so the family revocation commits.
  if (reused === true)
    throw new ApiError(
      401,
      'refresh_reused',
      'Refresh token reuse detected; all sessions in this family were revoked',
    );
  return reused;
}

/**
 * Revokes the session family a refresh token belongs to (logout). Unknown tokens are ignored.
 */
export async function revokeByRefreshToken(db: DbOrTx, refreshToken: string, now: Date): Promise<void> {
  const [row] = await db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(refreshToken)));
  if (!row) return;
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
}

/** Revokes the family of a session id (logout with only an access token). */
export async function revokeBySessionId(db: DbOrTx, sessionId: string, now: Date): Promise<void> {
  const [row] = await db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!row) return;
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
}
