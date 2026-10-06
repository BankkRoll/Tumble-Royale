/**
 * The realtime gateway's voice handler: `voice_join`, `voice_leave` and
 * `voice_signal` frames from a socket.
 *
 * Responsibilities:
 * - drop oversized frames, malformed frames and frames over the per-user
 *   signalling rate (token bucket) before any lookup;
 * - hand joins and leaves to the voice service and signals to the relay,
 *   which re-checks room membership, blocks and sanctions on every signal;
 * - remember which tab (socket) owns a session so closing it ends voice.
 *
 * NOTE: rate buckets live in this API instance's memory, like the party
 * lobby's. A user's tabs on different instances each get a bucket; joins are
 * also counted in the KV, so the cluster-wide join limit holds.
 */
import { sanitizeVoiceMessage, VOICE_CLIENT_TYPES, VOICE_LIMITS } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { joinVoice, leaveVoice, relayVoiceSignal, type VoiceSignalOutcome } from './service.ts';

/** What happened to a frame (tests and metrics). */
export type VoiceFrameOutcome =
  VoiceSignalOutcome | 'joined' | 'left' | 'too_large' | 'invalid' | 'rate_limited' | 'refused';

/** Result of {@link VoiceRelay.handle}. */
export interface VoiceFrameResult {
  outcome: VoiceFrameOutcome;
  /** For a refused join, the error to send back to the socket. */
  error?: ApiError;
  /** Tab id of a successful join or leave, for the gateway's socket bookkeeping. */
  cid?: string;
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Validates and dispatches voice frames.
 *
 * @example
 * const voice = new VoiceRelay(ctx);
 * const { outcome, error } = await voice.handle(userId, parsedJson, rawText.length);
 */
export class VoiceRelay {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly ctx: AppContext) {}

  /** True for a message the gateway should hand to {@link handle}. */
  static matches(msg: unknown): boolean {
    const type = !!msg && typeof msg === 'object' ? (msg as { type?: unknown }).type : undefined;
    return typeof type === 'string' && (VOICE_CLIENT_TYPES as readonly string[]).includes(type);
  }

  /**
   * Handles one frame from `userId`.
   *
   * @param userId - Authenticated sender.
   * @param raw - Parsed JSON.
   * @param size - Raw message length, for the size cap.
   * @returns What happened, and the error for a refused join.
   */
  async handle(userId: string, raw: unknown, size: number): Promise<VoiceFrameResult> {
    if (size > VOICE_LIMITS.maxMessageBytes) return { outcome: 'too_large' };
    if (!this.take(userId, this.ctx.now().getTime())) return { outcome: 'rate_limited' };
    const msg = sanitizeVoiceMessage(raw);
    if (!msg) return { outcome: 'invalid' };
    if (msg.type === 'voice_signal') return { outcome: await relayVoiceSignal(this.ctx, userId, msg) };
    if (msg.type === 'voice_leave') {
      await leaveVoice(this.ctx, userId, msg.cid);
      return { outcome: 'left', cid: msg.cid };
    }
    try {
      await joinVoice(this.ctx, userId, msg.cid, msg.team);
      return { outcome: 'joined', cid: msg.cid };
    } catch (err) {
      if (err instanceof ApiError) return { outcome: 'refused', error: err };
      throw err;
    }
  }

  /** Drops a user's rate state (their last socket closed). */
  forget(userId: string): void {
    this.buckets.delete(userId);
  }

  private take(userId: string, now: number): boolean {
    const { signalBurst, signalPerSecond } = VOICE_LIMITS;
    let b = this.buckets.get(userId);
    if (!b) {
      b = { tokens: signalBurst, at: now };
      this.buckets.set(userId, b);
    }
    b.tokens = Math.min(signalBurst, b.tokens + (Math.max(0, now - b.at) / 1000) * signalPerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
