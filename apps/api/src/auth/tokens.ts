/**
 * Token primitives: HS256 access JWTs, opaque refresh tokens and hashing.
 *
 * Access tokens are verified statelessly by the API, the matchmaker and the
 * realtime gateway; refresh tokens are opaque random strings whose SHA-256 is
 * stored in `sessions`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

/** Access token lifetime: 15 minutes. */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
/** Refresh token lifetime: 30 days. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** JWT issuer for every token this API signs. */
export const JWT_ISSUER = 'tumble-api';

/** Claims carried by an access token. */
export interface AccessClaims {
  /** User id. */
  sub: string;
  /** Session id (refresh family member) the token was minted from. */
  sid: string;
  /** Display name `name#tag`, for services that only need a label. */
  name: string;
  /** Account region. */
  region: string;
  guest: boolean;
}

/**
 * Signs a 15-minute access token.
 *
 * @param secret - HS256 secret.
 * @param claims - Token claims.
 * @param nowSec - Issued-at in seconds (injectable clock).
 */
export async function signAccessToken(secret: string, claims: AccessClaims, nowSec: number): Promise<string> {
  return new SignJWT({
    sid: claims.sid,
    name: claims.name,
    region: claims.region,
    guest: claims.guest,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ACCESS_TOKEN_TTL_SEC)
    .sign(new TextEncoder().encode(secret));
}

/**
 * Verifies an access token.
 *
 * @param secret - HS256 secret.
 * @param token - Compact JWT.
 * @param nowSec - Current time in seconds.
 * @returns Claims, or null when invalid or expired.
 */
export async function verifyAccessToken(
  secret: string,
  token: string,
  nowSec: number,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: JWT_ISSUER,
      algorithms: ['HS256'],
      currentDate: new Date(nowSec * 1000),
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
      return null;
    return {
      sub: payload.sub,
      sid: payload.sid,
      name: typeof payload.name === 'string' ? payload.name : '',
      region: typeof payload.region === 'string' ? payload.region : 'na',
      guest: payload.guest === true,
    };
  } catch {
    return null;
  }
}

/**
 * Signs an arbitrary short-lived token for other services (e.g. party queue tickets).
 *
 * @param secret - HS256 secret.
 * @param typ - Token type claim, checked by the verifier.
 * @param payload - Extra claims.
 * @param ttlSec - Lifetime in seconds.
 * @param nowSec - Issued-at in seconds.
 */
export async function signServiceToken(
  secret: string,
  typ: string,
  payload: Record<string, unknown>,
  ttlSec: number,
  nowSec: number,
): Promise<string> {
  return new SignJWT({ ...payload, typ })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSec)
    .sign(new TextEncoder().encode(secret));
}

/** Generates a 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256 of a string. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
