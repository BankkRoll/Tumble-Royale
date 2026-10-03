/**
 * HTTP error model and request-parsing helpers shared by every route.
 */
import type { z } from 'zod';

/** An error that maps directly onto an HTTP response `{ error, message }`. */
export class ApiError extends Error {
  /**
   * @param status - HTTP status code.
   * @param code - Stable machine-readable error code the client switches on.
   * @param message - Human-readable explanation.
   * @param details - Optional structured context (validation issues, missing amount…).
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 — malformed input. */
export const badRequest = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(400, code, message, details);
/** 401 — missing or invalid credentials. */
export const unauthorized = (message = 'Authentication required'): ApiError =>
  new ApiError(401, 'unauthorized', message);
/** 403 — authenticated but not allowed. */
export const forbidden = (code: string, message: string): ApiError => new ApiError(403, code, message);
/** 404 — resource does not exist (or is hidden from the caller). */
export const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `${what} not found`);
/** 409 — state conflict. */
export const conflict = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(409, code, message, details);

/**
 * Validates untrusted input against a zod schema.
 *
 * @param schema - The schema to apply.
 * @param data - Raw request body, query or params.
 * @returns The parsed value.
 * @throws {ApiError} 400 `invalid_request` listing each issue.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'invalid_request',
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/**
 * True when a database error is a Postgres unique-constraint violation (SQLSTATE 23505).
 * Drizzle wraps driver errors, so the code may sit on `cause`.
 *
 * @param err - Anything thrown from a query.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === '23505') return true;
    e = typeof e === 'object' && 'cause' in e ? (e as { cause: unknown }).cause : undefined;
  }
  return false;
}
