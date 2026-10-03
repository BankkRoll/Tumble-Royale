/**
 * Whispers: direct chat between friends, relayed over the realtime gateway
 * (`whisper` events to both sides, so the sender's other tabs see it too).
 *
 * Friends only, so a block (which ends the friendship) also stops whispers;
 * the block check is repeated anyway in case a stale friendship row survives.
 * Lines use the shared chat filter and a per-account KV rate limit, and are
 * refused for chat- or fully-banned accounts.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { filterChat } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import { activeBans, requireUser } from '../http/auth.ts';
import { ApiError, badRequest, forbidden, parse } from '../http/errors.ts';
import type { SocialRef } from '../realtime/notifier.ts';
import { friendIds, isBlockedEitherWay, socialRef } from './friends.ts';

/** Whispers allowed per {@link WHISPER_WINDOW_MS}. */
export const WHISPER_MAX = 8;
/** Whisper rate-limit window. */
export const WHISPER_WINDOW_MS = 10_000;

/** A relayed whisper. */
export interface WhisperLine {
  id: string;
  from: SocialRef;
  to: SocialRef;
  /** Slurs masked; shown with the chat filter off. */
  text: string;
  /** Fully masked copy, when it differs. */
  masked?: string;
  /** Epoch ms. */
  at: number;
}

const WhisperBody = z.object({ userId: z.string().uuid(), text: z.string().max(500) });

/**
 * Sends a whisper to a friend.
 *
 * @param ctx - Shared services.
 * @param fromId - Sender.
 * @param toId - Recipient (must be a friend).
 * @param raw - Untrusted text.
 * @throws {ApiError} 400 `self_whisper` / `empty_message`, 403 `not_friends` / `chat_banned`, 429 `chat_rate`.
 */
export async function sendWhisper(
  ctx: AppContext,
  fromId: string,
  toId: string,
  raw: unknown,
): Promise<WhisperLine> {
  if (fromId === toId) throw badRequest('self_whisper', 'Whispering to yourself?');
  if (!(await friendIds(ctx.db, fromId)).includes(toId) || (await isBlockedEitherWay(ctx.db, fromId, toId)))
    throw forbidden('not_friends', 'You can only whisper to friends');
  const bans = await activeBans(ctx, fromId);
  if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
    throw forbidden('chat_banned', 'Chat is disabled on this account');
  const filtered = filterChat(raw);
  if (!filtered) throw badRequest('empty_message', 'Say something first');
  const now = ctx.now().getTime();
  const window = Math.floor(now / WHISPER_WINDOW_MS);
  const count = await ctx.kv.incr(`whisper-rate:${fromId}:${window}`, WHISPER_WINDOW_MS * 2);
  if (count > WHISPER_MAX) throw new ApiError(429, 'chat_rate', 'Slow down a little');
  const line: WhisperLine = {
    id: randomUUID(),
    from: await socialRef(ctx.db, fromId),
    to: await socialRef(ctx.db, toId),
    ...filtered,
    at: now,
  };
  await ctx.notifier.notifyMany([toId, fromId], { type: 'whisper', ...line });
  return line;
}

/**
 * Registers `POST /whisper`.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerWhisperRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/whisper', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId, text } = parse(WhisperBody, req.body);
    return { message: await sendWhisper(ctx, auth.userId, userId, text) };
  });
}
