/**
 * Party lobby relay: `party_lobby` frames (a member's main-menu Tumbler pose,
 * emote and, on change, equipped look) fanned out to the sender's fellow
 * party members through the realtime gateway.
 *
 * Responsibilities:
 * - drop frames from users not in a party, oversized frames and frames over
 *   the per-user rate (token bucket);
 * - validate/clamp with the shared {@link sanitizeLobbyFrame} (finite numbers,
 *   platform bounds, catalog emotes);
 * - accept a look only if it passes the same catalog + ownership checks as a
 *   saved loadout, and at most once per `lookMinIntervalMs`;
 * - keep the shared ball state from the leader only, and a grab only when it
 *   names another current member;
 * - keep a lobby mini-game snapshot from the leader only and only when every
 *   player in it is a current member; keep a game claim from members only,
 *   and a tag claim only when it names another current member;
 * - deliver to the other current members only, never the sender.
 *
 * Nothing is persisted. Membership is read from the party store on every
 * frame, so leave/kick/disband take effect on the very next frame.
 *
 * NOTE: rate buckets live in this API instance's memory. A user's tabs on
 * different instances each get a bucket; the client cadence is well inside one.
 */
import {
  PARTY_LOBBY_LIMITS,
  PARTY_LOBBY_TYPE,
  sanitizeLobbyFrame,
  type LobbyLook,
  type PartyLobbyEvent,
} from '@tumble/shared';
import { ownedSet } from '../accounts/routes.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { LoadoutItemsSchema, validateLoadout } from '../inventory/loadout.ts';
import type { PartyService } from '../social/party.ts';

/** Why a frame was not relayed (tests and metrics). */
export type PartyLobbyOutcome = 'relayed' | 'no_party' | 'rate_limited' | 'invalid' | 'too_large';

interface Bucket {
  tokens: number;
  at: number;
  lookAt: number;
}

/**
 * Validates and relays `party_lobby` frames.
 *
 * @example
 * const relay = new PartyLobbyRelay(ctx, parties);
 * await relay.handle(userId, parsedJson, rawText.length);
 */
export class PartyLobbyRelay {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly ctx: AppContext,
    private readonly parties: PartyService,
  ) {}

  /** True for a message the gateway should hand to {@link handle}. */
  static matches(msg: unknown): boolean {
    return !!msg && typeof msg === 'object' && (msg as { type?: unknown }).type === PARTY_LOBBY_TYPE;
  }

  /**
   * Handles one frame from `userId`.
   *
   * @param userId - Authenticated sender.
   * @param raw - Parsed JSON.
   * @param size - Raw message length, for the size cap.
   * @returns What happened to the frame.
   */
  async handle(userId: string, raw: unknown, size: number): Promise<PartyLobbyOutcome> {
    if (size > PARTY_LOBBY_LIMITS.maxBytes) return 'too_large';
    const now = this.ctx.now().getTime();
    const bucket = this.take(userId, now);
    if (!bucket) return 'rate_limited';
    const frame = sanitizeLobbyFrame(raw, (id) => this.ctx.cosmetics.get(id)?.slot === 'emote');
    if (!frame) return 'invalid';
    const party = await this.parties.current(userId);
    if (!party) return 'no_party';
    const others = party.members.map((m) => m.userId).filter((id) => id !== userId);
    if (others.length === 0) return 'relayed';
    // The leader's client simulates the shared ball; anyone else claiming it would fight them.
    if (frame.ball && party.leaderId !== userId) delete frame.ball;
    if (frame.grab && !others.includes(frame.grab)) delete frame.grab;
    const memberIds = party.members.map((m) => m.userId);
    // The leader runs every lobby game; a stale player list (someone just left) would show ghosts.
    if (
      frame.game &&
      (party.leaderId !== userId || !frame.game.players.every((id) => memberIds.includes(id)))
    )
      delete frame.game;
    // Claims are for the leader to judge; the leader judges its own locally and never sends one.
    if (frame.claim) {
      const c = frame.claim;
      if (party.leaderId === userId || (c.k === 'tag' && (!c.target || !others.includes(c.target))))
        delete frame.claim;
    }
    if (frame.look) {
      const ok =
        now - bucket.lookAt >= PARTY_LOBBY_LIMITS.lookMinIntervalMs &&
        (await this.lookAllowed(userId, frame.look));
      if (ok) bucket.lookAt = now;
      else delete frame.look;
    }
    const event: PartyLobbyEvent = { type: PARTY_LOBBY_TYPE, userId, partyId: party.id, ...frame };
    await this.ctx.notifier.notifyMany(others, event);
    return 'relayed';
  }

  /** Drops a user's rate state (their last socket closed). */
  forget(userId: string): void {
    this.buckets.delete(userId);
  }

  private take(userId: string, now: number): Bucket | null {
    const { rateBurst, ratePerSecond } = PARTY_LOBBY_LIMITS;
    let b = this.buckets.get(userId);
    if (!b) {
      b = { tokens: rateBurst, at: now, lookAt: -Infinity };
      this.buckets.set(userId, b);
    }
    b.tokens = Math.min(rateBurst, b.tokens + (Math.max(0, now - b.at) / 1000) * ratePerSecond);
    b.at = now;
    if (b.tokens < 1) return null;
    b.tokens -= 1;
    return b;
  }

  /** Same rules as saving a loadout: real items, right slots, owned. */
  private async lookAllowed(userId: string, look: LobbyLook): Promise<boolean> {
    const parsed = LoadoutItemsSchema.safeParse(look);
    if (!parsed.success) return false;
    try {
      validateLoadout(parsed.data, this.ctx.cosmetics, await ownedSet(this.ctx, userId));
      return true;
    } catch (err) {
      if (err instanceof ApiError) return false;
      throw err;
    }
  }
}
