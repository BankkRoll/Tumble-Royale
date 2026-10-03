/**
 * The profanity filter lives in `@tumble/shared` so the game server, the API
 * and the client mask chat identically; this module keeps the API's import path.
 */
export { containsProfanity, maskProfanity, normalizeForFilter } from '@tumble/shared';
