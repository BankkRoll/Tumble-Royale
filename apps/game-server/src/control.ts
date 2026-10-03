/**
 * Internal control endpoint the matchmaker calls on this server:
 * `POST /internal/kick { matchId, userId }` removes a private show member
 * the host kicked after the show moved here, and bars their ticket.
 *
 * SECURITY: requests carry an HMAC-SHA256 of `<ts>.<nonce>.<body>` keyed with
 * `GAME_SERVER_SECRET` (`x-tumble-ts`, `x-tumble-nonce`, `x-tumble-sig`).
 * Timestamps outside ±30 s are refused, and every nonce is remembered for
 * that window and refused a second time, so a captured request can be
 * replayed neither later nor straight away. Without a configured secret the
 * endpoint answers 404, as if it did not exist.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomManager } from './room/RoomManager.ts';

/** Path of the kick endpoint. */
export const CONTROL_KICK_PATH = '/internal/kick';
/**
 * Paths the kick is served on: also behind a reverse proxy that forwards the
 * `/gs` prefix unchanged (the matchmaker derives `https://host/gs` from
 * `wss://host/gs/ws`), like the WebSocket's `/gs/ws`.
 */
const KICK_PATHS: ReadonlySet<string> = new Set([CONTROL_KICK_PATH, `/gs${CONTROL_KICK_PATH}`]);
const MAX_SKEW_MS = 30_000;
const MAX_BODY = 1024;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Upper bound on remembered nonces; far above any honest kick rate within the window. */
const MAX_NONCES = 10_000;

/** Options for {@link handleControl}. */
export interface ControlOptions {
  /** `GAME_SERVER_SECRET`, shared with the matchmaker. */
  secret: string;
  /** Wall clock (tests). */
  now?: () => number;
  /** Replay cache; one per server (created by {@link startGameServer} when absent). */
  nonces?: NonceCache;
}

/**
 * Nonces seen inside the freshness window. A nonce only has to be remembered
 * until its timestamp would be refused as stale anyway.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  /**
   * Records a nonce.
   *
   * @param nonce - The request's nonce.
   * @param ts - The request's signed timestamp.
   * @param now - Wall clock.
   * @returns False when the nonce was already used (a replay), or the cache is
   *   full of live nonces (refuse rather than forget one that could be replayed).
   */
  use(nonce: string, ts: number, now: number): boolean {
    for (const [n, t] of this.seen) {
      if (Math.abs(now - t) <= MAX_SKEW_MS) break;
      this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= MAX_NONCES) return false;
    this.seen.set(nonce, ts);
    return true;
  }
}

/**
 * Signs a control body the way the matchmaker does.
 *
 * @param secret - Shared secret.
 * @param ts - Signing time (ms).
 * @param nonce - Single-use request id.
 * @param body - Exact request body.
 */
export function signControl(secret: string, ts: number, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');
}

/**
 * Checks the signature headers against the body (freshness and signature;
 * nonce reuse is checked separately by {@link NonceCache}).
 *
 * @returns The signed timestamp, or null when the request is not authentic.
 */
export function verifyControl(
  secret: string,
  tsHeader: string | undefined,
  nonce: string | undefined,
  sigHeader: string | undefined,
  body: string,
  now: number,
): number | null {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS || !sigHeader) return null;
  if (!nonce || !NONCE_RE.test(nonce)) return null;
  const want = Buffer.from(signControl(secret, ts, nonce, body));
  const got = Buffer.from(sigHeader);
  return want.length === got.length && timingSafeEqual(want, got) ? ts : null;
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
  if (!KICK_PATHS.has(pathname)) return false;
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!opts || req.method !== 'POST') {
    reply(404, { error: 'not_found' });
    return true;
  }
  const nonces = opts.nonces ?? (opts.nonces = new NonceCache());
  void readBody(req).then((raw) => {
    if (raw === null) return reply(413, { error: 'too_large' });
    const now = (opts.now ?? Date.now)();
    const nonce = header(req, 'x-tumble-nonce');
    const ts = verifyControl(
      opts.secret,
      header(req, 'x-tumble-ts'),
      nonce,
      header(req, 'x-tumble-sig'),
      raw,
      now,
    );
    if (ts === null) return reply(401, { error: 'unauthorized' });
    // Only an authentic request may consume a nonce, so forged traffic cannot fill the cache.
    if (!nonces.use(nonce!, ts, now)) return reply(409, { error: 'replayed' });
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
