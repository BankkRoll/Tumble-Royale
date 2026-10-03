/**
 * Request correlation ids shared by the services.
 *
 * Every HTTP hop carries `x-request-id`: a service reuses the caller's id
 * when it is well formed and mints one otherwise, logs it on every line of
 * the request, echoes it in the response, and forwards it on the calls it
 * makes. Game-server calls about a show use `match-<matchId>`, so a show's
 * results can be followed from the game server's log into the API's.
 */

/** Header that carries the id. */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accepts a caller-supplied id only when it is short and plain, so a client
 * cannot inject newlines or megabytes into every log line.
 *
 * @param raw - Header value.
 * @returns The id, or undefined when absent or unsafe.
 */
export function sanitizeRequestId(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && SAFE.test(v) ? v : undefined;
}

/**
 * Picks the id for an incoming request.
 *
 * @param raw - Incoming `x-request-id` header.
 * @returns The caller's id when safe, else a fresh UUID.
 * @example
 * const id = requestIdFor(req.headers['x-request-id']);
 */
export function requestIdFor(raw: string | string[] | undefined): string {
  return sanitizeRequestId(raw) ?? globalThis.crypto.randomUUID();
}

/**
 * The id used for every call about one show.
 *
 * @param matchId - Match id.
 */
export function matchRequestId(matchId: string): string {
  return sanitizeRequestId(`match-${matchId}`) ?? globalThis.crypto.randomUUID();
}
