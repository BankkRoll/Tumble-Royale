/**
 * Voice HTTP routes:
 *
 * - `GET /voice/config` — whether voice can be switched on for the caller
 *   (operator flag, TURN configured, not voice-muted) and whether team voice
 *   is allowed for the account. The client hides voice entirely otherwise.
 * - `POST /internal/voice/teams` — game server → API (HMAC): the humans of a
 *   team round with their team and queue party, or none when the round ended.
 *   The API splits them into squads and moves opted-in players into them.
 *
 * Signalling itself rides the realtime WebSocket (`voice/relay.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { requireInternalSignature, requireUser } from '../http/auth.ts';
import { parse } from '../http/errors.ts';
import { setTeamRooms, voiceAvailability } from './service.ts';

const TeamsBody = z
  .object({
    matchId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    round: z.number().int().min(0).max(99),
    players: z
      .array(
        z
          .object({
            userId: z.string().uuid(),
            team: z.number().int().min(-1).max(7),
            partyId: z.string().min(1).max(80).nullable().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

/**
 * Registers the voice routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/voice/config', async (req) => {
    const auth = await requireUser(ctx, req);
    return voiceAvailability(ctx, auth.userId);
  });

  app.post('/internal/voice/teams', { config: { rateLimit: false } }, async (req, reply) => {
    // SECURITY: only a game server holding INTERNAL_HMAC_SECRET may say who is on whose team.
    await requireInternalSignature(ctx, req);
    const body = parse(TeamsBody, req.body);
    await setTeamRooms(ctx, body.matchId, body.round, body.players);
    return reply.code(204).send();
  });
}
