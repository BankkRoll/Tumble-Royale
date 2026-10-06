/**
 * Shared custom rounds: players publish rounds built in the editor and share
 * them by an 8-character code.
 *
 * - `POST /custom-rounds` publish, `PUT /custom-rounds/:code` replace,
 *   `POST …/:code/unpublish|publish`, `DELETE …/:code`: the owner's round.
 *   Publishing needs a full (non-guest) account.
 * - `GET /custom-rounds/mine`: the caller's rounds, every status.
 * - `GET /custom-rounds/:code`: anyone, signed in or not (load into the
 *   editor, preview in a private lobby).
 * - `POST /custom-rounds/:code/report`: any signed-in player.
 * - `POST /internal/custom-rounds/resolve`: game servers (HMAC) fetch the
 *   definitions a private show picked.
 *
 * Every definition is validated here with the same rules as the editor
 * (`@tumble/content/custom`) before it is stored; the stored copy is what
 * game servers play, after validating it again.
 */
import { randomInt } from 'node:crypto';
import {
  CUSTOM_ROUND_LIMITS,
  checkCustomText,
  customRoundId,
  normalizeShareCode,
  randomShareCode,
  SHARE_CODE_LENGTH,
  validateCustomRound,
} from '@tumble/content/custom';
import { maskProfanity } from '@tumble/shared';
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { customRoundReports, customRounds, profiles } from '../db/schema.ts';
import { requireInternalSignature, requireUser, optionalUser, type AuthContext } from '../http/auth.ts';
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  parse,
} from '../http/errors.ts';

/** Round lifecycle states. */
export const CUSTOM_ROUND_STATUSES = ['published', 'unpublished', 'taken_down'] as const;

/** Why a player reports a shared round. */
export const ROUND_REPORT_REASONS = ['offensive', 'broken', 'spam', 'copied', 'other'] as const;

const CodeParams = z.object({ code: z.string().min(1).max(32) });
const PublishBody = z
  .object({
    round: z.record(z.string(), z.unknown()),
    description: z
      .string()
      .max(CUSTOM_ROUND_LIMITS.descriptionMax * 2)
      .default(''),
  })
  .strict();
const ReportBody = z
  .object({
    reason: z.enum(ROUND_REPORT_REASONS),
    details: z.string().max(500).optional(),
  })
  .strict();
const ResolveBody = z.object({ codes: z.array(z.string().min(1).max(32)).min(1).max(10) }).strict();

/** Rows the summaries are built from. */
type RoundRow = typeof customRounds.$inferSelect;

/** What lists show about a round (no definition). */
export interface CustomRoundSummary {
  code: string;
  name: string;
  description: string;
  type: string;
  status: (typeof CUSTOM_ROUND_STATUSES)[number];
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  /** Present for the owner and staff when the round was taken down. */
  takedownReason?: string | null;
}

/**
 * The public summary of a row.
 *
 * @param row - A `custom_rounds` row.
 * @param withReason - Include the takedown reason (owner, staff).
 */
export function roundSummary(row: RoundRow, withReason = false): CustomRoundSummary {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.roundType,
    status: row.status as CustomRoundSummary['status'],
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(withReason ? { takedownReason: row.takedownReason } : {}),
  };
}

/**
 * Parses a share code from a route param.
 *
 * @throws {ApiError} 404 when it cannot be a code (indistinguishable from an unknown one).
 */
function codeParam(params: unknown): string {
  const code = normalizeShareCode(parse(CodeParams, params).code);
  if (!code) throw notFound('Round');
  return code;
}

async function rowByCode(ctx: AppContext, code: string): Promise<RoundRow | undefined> {
  const [row] = await ctx.db.select().from(customRounds).where(eq(customRounds.code, code));
  return row;
}

/** The caller's own round, or 404 (also for someone else's, so codes cannot be probed for ownership). */
async function ownRound(ctx: AppContext, auth: AuthContext, code: string): Promise<RoundRow> {
  const row = await rowByCode(ctx, code);
  if (!row || row.ownerId !== auth.userId) throw notFound('Round');
  return row;
}

/**
 * Validates a submitted round and description for storage.
 *
 * @returns The definition to store (id set to the share code's) and cleaned texts.
 * @throws {ApiError} 422 `invalid_round` with the validator's errors; 400 for the description.
 */
function checkSubmission(
  body: z.output<typeof PublishBody>,
  code: string,
): { definition: Record<string, unknown>; name: string; description: string; type: string; bytes: number } {
  // SECURITY: never trust the editor's verdict; the same rules run again here.
  const v = validateCustomRound(body.round);
  if (!v.ok || !v.round) {
    throw new ApiError(
      422,
      'invalid_round',
      'The round did not pass validation',
      v.issues.filter((i) => i.severity === 'error').slice(0, 30),
    );
  }
  let description = '';
  if (body.description.trim()) {
    const d = checkCustomText(body.description, CUSTOM_ROUND_LIMITS.descriptionMax);
    if (!d.ok) {
      if (d.reason === 'profanity')
        throw badRequest('description_filtered', 'That description is not allowed');
      throw badRequest(
        'description_length',
        `Descriptions are up to ${CUSTOM_ROUND_LIMITS.descriptionMax} characters`,
      );
    }
    description = d.text;
  }
  const name = checkCustomText(v.round.name, CUSTOM_ROUND_LIMITS.nameMax);
  const definition = {
    ...v.round,
    id: customRoundId(code),
    name: name.ok ? name.text : v.round.name,
    designNotes: v.round.designNotes ? maskProfanity(v.round.designNotes) : '',
  };
  const bytes = new TextEncoder().encode(JSON.stringify(definition)).length;
  if (bytes > CUSTOM_ROUND_LIMITS.maxBytes)
    throw new ApiError(422, 'invalid_round', 'The round is too large');
  return { definition, name: definition.name, description, type: v.round.type, bytes };
}

/**
 * Registers the player and game-server routes for shared rounds.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerCustomRoundRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/custom-rounds',
    { bodyLimit: 160 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const auth = await requireUser(ctx, req);
      // Shared rounds reach other players: an account that can be held to
      // account (and keeps its rounds) is required; guests can still build,
      // save locally and test play.
      if (auth.guest)
        throw forbidden('guest_account', 'Link an email, Discord or Google sign-in to share rounds');
      const body = parse(PublishBody, req.body);
      const now = ctx.now();
      const checked = checkSubmission(body, 'X'.repeat(SHARE_CODE_LENGTH));
      const row = await ctx.db.transaction(async (tx) => {
        // One owner's shares serialise here, so two at once cannot both slip
        // under the cap.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`custom-rounds:${auth.userId}`}))`);
        // Rounds staff took down stay on record but no longer use a slot.
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(customRounds)
          .where(and(eq(customRounds.ownerId, auth.userId), ne(customRounds.status, 'taken_down')));
        if (n >= CUSTOM_ROUND_LIMITS.maxPerAccount)
          throw conflict(
            'round_limit',
            `You can share up to ${CUSTOM_ROUND_LIMITS.maxPerAccount} rounds; delete one first`,
          );
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = randomShareCode(randomInt);
          const s = { ...checked, definition: { ...checked.definition, id: customRoundId(code) } };
          try {
            // A savepoint per attempt: a clashing code must not abort the whole transaction.
            const [inserted] = await tx.transaction((sp) =>
              sp
                .insert(customRounds)
                .values({
                  code,
                  ownerId: auth.userId,
                  name: s.name,
                  description: s.description,
                  roundType: s.type,
                  definition: s.definition,
                  sizeBytes: s.bytes,
                  status: 'published',
                  createdAt: now,
                  updatedAt: now,
                })
                .returning(),
            );
            return inserted!;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
        }
        throw new ApiError(503, 'code_exhausted', 'Could not pick a share code; try again');
      });
      return reply.code(201).send({ round: roundSummary(row) });
    },
  );

  app.get('/custom-rounds/mine', async (req) => {
    const auth = await requireUser(ctx, req);
    const rows = await ctx.db
      .select()
      .from(customRounds)
      .where(eq(customRounds.ownerId, auth.userId))
      // Taken-down rounds no longer use a slot, so the live ones (which do) come first.
      .orderBy(
        sql`${customRounds.status} = 'taken_down'`,
        desc(customRounds.updatedAt),
        desc(customRounds.id),
      )
      .limit(CUSTOM_ROUND_LIMITS.maxPerAccount * 2);
    return { rounds: rows.map((r) => roundSummary(r, true)), limit: CUSTOM_ROUND_LIMITS.maxPerAccount };
  });

  app.get(
    '/custom-rounds/:code',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const code = codeParam(req.params);
      const row = await rowByCode(ctx, code);
      if (!row) throw notFound('Round');
      if (row.status === 'taken_down')
        throw new ApiError(410, 'taken_down', 'This round was removed by moderators');
      if (row.status !== 'published') {
        const auth = await optionalUser(ctx, req);
        if (auth?.userId !== row.ownerId) throw notFound('Round');
      }
      const [author] = await ctx.db
        .select({ displayName: profiles.displayName, tag: profiles.tag })
        .from(profiles)
        .where(eq(profiles.userId, row.ownerId));
      return {
        ...roundSummary(row),
        author: author ? `${author.displayName}#${author.tag}` : null,
        definition: row.definition,
      };
    },
  );

  app.put(
    '/custom-rounds/:code',
    { bodyLimit: 160 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const code = codeParam(req.params);
      const row = await ownRound(ctx, auth, code);
      if (row.status === 'taken_down') throw conflict('taken_down', 'Moderators removed this round');
      const s = checkSubmission(parse(PublishBody, req.body), code);
      const [updated] = await ctx.db
        .update(customRounds)
        .set({
          name: s.name,
          description: s.description,
          roundType: s.type,
          definition: s.definition,
          sizeBytes: s.bytes,
          updatedAt: ctx.now(),
        })
        // The status check keeps a takedown that lands between the read and this write.
        .where(and(eq(customRounds.id, row.id), inArray(customRounds.status, ['published', 'unpublished'])))
        .returning();
      if (!updated) throw conflict('taken_down', 'Moderators removed this round');
      return { round: roundSummary(updated, true) };
    },
  );

  const setStatus = (to: 'published' | 'unpublished') => async (req: Parameters<typeof requireUser>[1]) => {
    const auth = await requireUser(ctx, req);
    const row = await ownRound(ctx, auth, codeParam(req.params));
    if (row.status === 'taken_down') throw conflict('taken_down', 'Moderators removed this round');
    const [updated] = await ctx.db
      .update(customRounds)
      .set({ status: to, updatedAt: ctx.now() })
      .where(and(eq(customRounds.id, row.id), inArray(customRounds.status, ['published', 'unpublished'])))
      .returning();
    if (!updated) throw conflict('taken_down', 'Moderators removed this round');
    return { round: roundSummary(updated, true) };
  };
  app.post('/custom-rounds/:code/unpublish', setStatus('unpublished'));
  app.post('/custom-rounds/:code/publish', setStatus('published'));

  app.delete('/custom-rounds/:code', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const row = await ownRound(ctx, auth, codeParam(req.params));
    // Kept as the record of the takedown; account erasure still removes it.
    if (row.status === 'taken_down')
      throw conflict('taken_down', 'Rounds removed by moderators are kept on record');
    await ctx.db
      .delete(customRounds)
      .where(and(eq(customRounds.id, row.id), inArray(customRounds.status, ['published', 'unpublished'])));
    return reply.code(204).send();
  });

  app.post(
    '/custom-rounds/:code/report',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const auth = await requireUser(ctx, req);
      const code = codeParam(req.params);
      const body = parse(ReportBody, req.body);
      const row = await rowByCode(ctx, code);
      if (!row || row.status !== 'published') throw notFound('Round');
      if (row.ownerId === auth.userId) throw badRequest('self_report', 'You cannot report your own round');
      try {
        const [report] = await ctx.db
          .insert(customRoundReports)
          .values({
            roundId: row.id,
            reporterId: auth.userId,
            reason: body.reason,
            details: body.details ? maskProfanity(body.details) : null,
            createdAt: ctx.now(),
          })
          .returning({ id: customRoundReports.id });
        return reply.code(201).send({ id: report?.id, status: 'open' });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('already_reported', 'You already reported this round');
        throw err;
      }
    },
  );

  // Game server → API (HMAC): the definitions a private show picked. Only
  // published rounds resolve, so a takedown stops new shows from loading it.
  app.post('/internal/custom-rounds/resolve', { config: { rateLimit: false } }, async (req) => {
    await requireInternalSignature(ctx, req, { callers: ['game-server'] });
    const { codes } = parse(ResolveBody, req.body);
    const wanted = [...new Set(codes.map((c) => normalizeShareCode(c)).filter((c): c is string => !!c))];
    const rows = wanted.length
      ? await ctx.db
          .select({ code: customRounds.code, definition: customRounds.definition })
          .from(customRounds)
          .where(and(inArray(customRounds.code, wanted), eq(customRounds.status, 'published')))
      : [];
    const found = new Set(rows.map((r) => r.code));
    return { rounds: rows, missing: codes.filter((c) => !found.has(normalizeShareCode(c) ?? '')) };
  });
}
