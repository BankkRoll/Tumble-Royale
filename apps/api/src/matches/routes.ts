/**
 * Match routes: signed results ingest from game servers, match detail, the
 * player's recent show history and their reward for one show (the rewards
 * screen's fallback when the game server's forward never arrived).
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { matches, matchParticipants, matchRounds, roundResults } from '../db/schema.ts';
import { requireInternalSignature, requireUser } from '../http/auth.ts';
import { notFound, parse } from '../http/errors.ts';
import { ingestMatch, type PlayerRewardSummary } from './ingest.ts';
import { verifyPlacement } from './placement.ts';
import { MatchResultSchema } from './schema.ts';

const MatchIdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) });

/**
 * Registers match routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerMatchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/internal/match-results',
    { config: { rateLimit: false }, bodyLimit: 1024 * 1024 },
    async (req) => {
      await requireInternalSignature(ctx, req, { callers: ['game-server'] });
      const payload = parse(MatchResultSchema, req.body);
      return ingestMatch(ctx, payload, (m) => verifyPlacement(ctx, m));
    },
  );

  app.get('/matches/:id', async (req) => {
    await requireUser(ctx, req);
    const { id } = parse(MatchIdParam, req.params);
    const [m] = await ctx.db.select().from(matches).where(eq(matches.id, id));
    if (!m) throw notFound('Match');
    const participants = await ctx.db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, id))
      .orderBy(asc(matchParticipants.placement));
    const rounds = await ctx.db
      .select()
      .from(matchRounds)
      .where(eq(matchRounds.matchId, id))
      .orderBy(asc(matchRounds.roundIndex));
    const results = await ctx.db.select().from(roundResults).where(eq(roundResults.matchId, id));
    return {
      id: m.id,
      queue: m.queue,
      playlistId: m.playlistId,
      seasonId: m.seasonId,
      region: m.region,
      startedAt: m.startedAt.toISOString(),
      endedAt: m.endedAt.toISOString(),
      playerCount: m.playerCount,
      botCount: m.botCount,
      participants: participants.map((p) => ({
        key: p.participantKey,
        userId: p.userId,
        isBot: p.isBot,
        name: p.name,
        team: p.team,
        placement: p.placement,
        crowned: p.crowned,
        roundsSurvived: p.roundsSurvived,
      })),
      rounds: rounds.map((r) => ({
        index: r.roundIndex,
        roundId: r.roundId,
        roundType: r.roundType,
        durationMs: r.durationMs,
        results: results
          .filter((x) => x.roundIndex === r.roundIndex)
          .map((x) => ({
            key: x.participantKey,
            qualified: x.qualified,
            position: x.position,
            score: x.score,
            timeMs: x.timeMs,
          })),
      })),
    };
  });

  app.get('/me/matches', async (req) => {
    const auth = await requireUser(ctx, req);
    const { limit } = parse(HistoryQuery, req.query);
    const mine = await ctx.db
      .select({ m: matches, p: matchParticipants })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(eq(matchParticipants.userId, auth.userId))
      .orderBy(desc(matches.endedAt))
      .limit(limit);
    if (!mine.length) return { matches: [] };
    const ids = mine.map((x) => x.m.id);
    const rounds = await ctx.db.select().from(matchRounds).where(inArray(matchRounds.matchId, ids));
    const results = await ctx.db
      .select()
      .from(roundResults)
      .where(
        and(
          inArray(roundResults.matchId, ids),
          inArray(roundResults.participantKey, [...new Set(mine.map((x) => x.p.participantKey))]),
        ),
      );
    return {
      matches: mine.map(({ m, p }) => ({
        id: m.id,
        queue: m.queue,
        playlistId: m.playlistId,
        endedAt: m.endedAt.toISOString(),
        playerCount: m.playerCount,
        placement: p.placement,
        crowned: p.crowned,
        xp: p.xp,
        gumballs: p.gumballs,
        rpDelta: p.rpDelta,
        rounds: rounds
          .filter((r) => r.matchId === m.id)
          .sort((a, b) => a.roundIndex - b.roundIndex)
          .map((r) => {
            const res = results.find(
              (x) =>
                x.matchId === m.id && x.roundIndex === r.roundIndex && x.participantKey === p.participantKey,
            );
            return {
              index: r.roundIndex,
              roundId: r.roundId,
              roundType: r.roundType,
              played: Boolean(res),
              qualified: res?.qualified ?? false,
              position: res?.position ?? null,
              timeMs: res?.timeMs ?? null,
            };
          }),
      })),
    };
  });

  // 404 until the game server's results land (the client polls); then the
  // caller's stored grant, or null when the show had no reward for them.
  app.get('/me/matches/:id/reward', async (req) => {
    const auth = await requireUser(ctx, req);
    const { id } = parse(MatchIdParam, req.params);
    const [m] = await ctx.db.select({ rewards: matches.rewards }).from(matches).where(eq(matches.id, id));
    if (!m) throw notFound('Match');
    const reward = (m.rewards as PlayerRewardSummary[]).find((r) => r.userId === auth.userId) ?? null;
    return { matchId: id, reward };
  });
}
