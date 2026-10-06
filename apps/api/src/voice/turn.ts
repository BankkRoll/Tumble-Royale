/**
 * Short-lived TURN credentials (the "TURN REST API" scheme coturn implements
 * as `use-auth-secret` / `static-auth-secret`).
 *
 * username   = `<expiry unix seconds>:<user id>.<room tag>`
 * credential = base64(HMAC-SHA1(secret, username))
 *
 * The TURN server recomputes the HMAC from the username it is given and
 * refuses expired ones, so it never needs to call the API. The secret stays
 * on the API and the TURN server; a credential is only good for one user,
 * one room tag and a few hours.
 */
import { createHash, createHmac } from 'node:crypto';
import { VOICE_CREDENTIAL_TTL_SEC, type VoiceIceServer } from '@tumble/shared';
import type { VoiceServerConfig } from '../config.ts';

/** A minted TURN credential. */
export interface TurnCredential {
  username: string;
  credential: string;
  /** Epoch ms after which the TURN server refuses it. */
  expiresAt: number;
}

/**
 * A short tag for a room, so credentials say which room they were minted
 * for without spelling out a party id in TURN server logs.
 *
 * @param roomId - Voice room id.
 * @returns Eight hex characters.
 */
export function roomTag(roomId: string): string {
  return createHash('sha256').update(roomId).digest('hex').slice(0, 8);
}

/**
 * Mints a TURN credential.
 *
 * @param secret - `VOICE_TURN_SECRET`.
 * @param userId - Who it is for.
 * @param roomId - The room it is for.
 * @param nowMs - Clock reading.
 * @param ttlSec - Lifetime (default {@link VOICE_CREDENTIAL_TTL_SEC}).
 * @returns The username/credential pair and its expiry.
 * @example
 * const c = turnCredential(secret, userId, 'party:abc', Date.now());
 * // c.username === '1767225600:<userId>.1a2b3c4d'
 */
export function turnCredential(
  secret: string,
  userId: string,
  roomId: string,
  nowMs: number,
  ttlSec: number = VOICE_CREDENTIAL_TTL_SEC,
): TurnCredential {
  const expiry = Math.floor(nowMs / 1000) + ttlSec;
  const username = `${expiry}:${userId}.${roomTag(roomId)}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

/**
 * Checks a credential the way the TURN server does (tests and diagnostics).
 *
 * @param secret - `VOICE_TURN_SECRET`.
 * @param username - As handed out.
 * @param credential - As handed out.
 * @param nowMs - Clock reading.
 * @returns Whether the TURN server would accept it now.
 */
export function verifyTurnCredential(
  secret: string,
  username: string,
  credential: string,
  nowMs: number,
): boolean {
  const expiry = Number(username.split(':', 1)[0]);
  if (!Number.isInteger(expiry) || expiry * 1000 <= nowMs) return false;
  return createHmac('sha1', secret).update(username).digest('base64') === credential;
}

/**
 * The ICE servers for one user in one room: STUN as configured, TURN with a
 * fresh credential.
 *
 * @param voice - Voice configuration.
 * @param userId - Recipient.
 * @param roomId - Their room (null while alone: no TURN credential is minted).
 * @param nowMs - Clock reading.
 * @returns Servers and when their credentials expire (0 without TURN).
 */
export function iceServersFor(
  voice: VoiceServerConfig,
  userId: string,
  roomId: string | null,
  nowMs: number,
): { servers: VoiceIceServer[]; expiresAt: number } {
  const servers: VoiceIceServer[] = [];
  if (voice.stunUrls.length) servers.push({ urls: [...voice.stunUrls] });
  if (!roomId || !voice.turnSecret || voice.turnUrls.length === 0) return { servers, expiresAt: 0 };
  const c = turnCredential(voice.turnSecret, userId, roomId, nowMs);
  servers.push({ urls: [...voice.turnUrls], username: c.username, credential: c.credential });
  return { servers, expiresAt: c.expiresAt };
}
