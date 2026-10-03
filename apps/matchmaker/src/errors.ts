/**
 * The matchmaker's error type, shared by the service, the lobby rules and the
 * HTTP layer (which maps it to `{ error, message }` with its status).
 */

/** Error with an HTTP status and stable code. */
export class MMError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
