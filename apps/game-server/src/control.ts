/**
 * Internal control endpoint the matchmaker calls on this server:
 * `POST /internal/kick { matchId, userId }` removes a private show member
 * the host kicked after the show moved here, and bars their ticket.
 *
 * SECURITY: requests carry an HMAC-SHA256 of `<ts>.<body>` keyed with
 * `GAME_SERVER_SECRET` (`x-tumble-ts`, `x-tumble-sig`); timestamps outside
 * ±30 s are refused so captured requests cannot be replayed later. Without a
 * configured secret the endpoint answers 404, as if it did not exist.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomManager } from './room/RoomManager.ts';

/** Path of the kick endpoint. */
export const CONTROL_KICK_PATH = '/internal/kick';
const MAX_SKEW_MS = 30_000;
const MAX_BODY = 1024;

/** Options for {@link handleControl}. */
export interface ControlOptions {
  /** `GAME_SERVER_SECRET`, shared with the matchmaker. */
  secret: string;
  /** Wall clock (tests). */
  now?: () => number;
}

/**
 * Signs a control body the way the matchmaker does.
 *
 * @param secret - Shared secret.
 * @param ts - Signing time (ms).
 * @param body - Exact request body.
 */
export function signControl(secret: string, ts: number, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

/** Checks the signature headers against the body. */
export function verifyControl(
  secret: string,
  tsHeader: string | undefined,
  sigHeader: string | undefined,
  body: string,
  now: number,
): boolean {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS || !sigHeader) return false;
  const want = Buffer.from(signControl(secret, ts, body));
  const got = Buffer.from(sigHeader);
  return want.length === got.length && timingSafeEqual(want, got);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Handles a request when it targets a control path.
 *
 * @returns False when the path is not a control path (the caller routes it).
 */
export function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  rooms: RoomManager,
  opts: ControlOptions | null,
): boolean {
  if (pathname !== CONTROL_KICK_PATH) return false;
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!opts || req.method !== 'POST') {
    reply(404, { error: 'not_found' });
    return true;
  }
  void readBody(req).then((raw) => {
    if (raw === null) return reply(413, { error: 'too_large' });
    const now = (opts.now ?? Date.now)();
    if (!verifyControl(opts.secret, header(req, 'x-tumble-ts'), header(req, 'x-tumble-sig'), raw, now))
      return reply(401, { error: 'unauthorized' });
    let body: { matchId?: unknown; userId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return reply(400, { error: 'invalid_json' });
    }
    if (typeof body.matchId !== 'string' || typeof body.userId !== 'string')
      return reply(400, { error: 'invalid_request' });
    const hosted = rooms.kickUser(body.matchId, body.userId);
    return reply(hosted ? 200 : 404, { ok: hosted });
  });
  return true;
}
