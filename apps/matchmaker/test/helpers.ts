/**
 * Shared test environment: tests never read `.env` files, so every config is
 * built from these explicit secrets.
 */
import type { Env } from '@tumble/shared/env';

/** Explicit secrets for tests. */
export const TEST_SECRETS = {
  JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijkl',
  GAME_TICKET_SECRET: 'test-game-ticket-secret-0123456789',
  GAME_SERVER_SECRET: 'test-game-server-secret-0123456789',
  INTERNAL_HMAC_SECRET: 'test-internal-hmac-secret-0123456789',
} as const;

/**
 * A complete, quiet test environment: `NODE_ENV=test`, `LOG_LEVEL=silent`
 * and {@link TEST_SECRETS}.
 *
 * @param overrides - Variables to add or replace; `undefined` removes one.
 */
export function testEnv(overrides: Env = {}): Env {
  return { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...TEST_SECRETS, ...overrides };
}
