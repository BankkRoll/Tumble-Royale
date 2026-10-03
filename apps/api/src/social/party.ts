/**
 * Parties (up to 4) stored in KV, with invite codes, ready checks and the
 * signed queue ticket the leader hands to the matchmaker.
 *
 * Keys: `party:<id>` (JSON, 6 h TTL refreshed on change), `party-code:<code>`
 * → id, `user-party:<userId>` → id. Every mutation runs under a KV lock on the
 * party so concurrent joins cannot overfill it, then pushes `party_update` to
 * all members through the realtime gateway. Membership changes also re-push
 * each member's presence to their friends, since "joinable" depends on size.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountRegion, RegionSchema } from '../accounts/accounts.ts';
import { signServiceToken } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import { profiles, ratings } from '../db/schema.ts';
import { activeBans, requireUser, type AuthContext } from '../http/auth.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../http/errors.ts';
import { withLock } from '../kv/index.ts';
import { RANKED_QUEUE } from '../leaderboards/service.ts';
import { DEFAULT_RATING, skillOrdinal } from '../ranked/rating.ts';
import { broadcastPresence, friendIds, socialRef } from './friends.ts';
import { sendPartyChat } from './partyChat.ts';
import { getPresence } from './presence.ts';

/** Maximum party size. */
export const MAX_PARTY_SIZE = 4;
/** Queue tickets are short-lived: the leader uses one immediately. */
export const QUEUE_TICKET_TTL_SEC = 120;
const PARTY_TTL_MS = 6 * 3_600_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A party member. */
export interface PartyMember {
  userId: string;
  displayName: string;
  tag: string;
  ready: boolean;
  joinedAt: number;
}

/** Party state. */
export interface Party {
  id: string;
  /** Six-character invite code used in `/join/<code>`. */
  code: string;
  leaderId: string;
  members: PartyMember[];
  playlistId: string;
  /** Users kicked from this party; they cannot rejoin with the code. */
  kicked: string[];
  createdAt: number;
  updatedAt: number;
}

/** Claims carried by a queue ticket (verified by the matchmaker with `JWT_SECRET`). */
export interface QueueTicketClaims {
  typ: 'queue';
  /** Party id, or `solo:<userId>`. */
  pid: string;
  leaderId: string;
  playlistId: string;
  queue: 'casual' | 'ranked';
  teamSize: number;
  /** Lobby size to fill. */
  maxPlayers: number;
  /** Minimum humans when bots are not allowed. */
  minPlayers: number;
  botsAllowed: boolean;
  region: string;
  members: { userId: string; name: string; mu: number; sigma: number; ordinal: number }[];
}

const CodeBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{6}$/),
});
const UserBody = z.object({ userId: z.string().uuid() });
const ChatBody = z.object({ text: z.string().max(500) });
const ReadyBody = z.object({ ready: z.boolean() });
const PlaylistBody = z.object({ playlistId: z.string().min(1).max(64) });
const TicketBody = z
  .object({ playlistId: z.string().min(1).max(64).optional(), region: RegionSchema.optional() })
  .optional();

function newCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Party persistence + notifications. */
export class PartyService {
  constructor(private readonly ctx: AppContext) {}

  private async load(id: string): Promise<Party | null> {
    const raw = await this.ctx.kv.get(`party:${id}`);
    return raw ? (JSON.parse(raw) as Party) : null;
  }

  private async save(p: Party): Promise<void> {
    p.updatedAt = this.ctx.now().getTime();
    await this.ctx.kv.set(`party:${p.id}`, JSON.stringify(p), PARTY_TTL_MS);
    await this.ctx.kv.set(`party-code:${p.code}`, p.id, PARTY_TTL_MS);
    for (const m of p.members) await this.ctx.kv.set(`user-party:${m.userId}`, p.id, PARTY_TTL_MS);
  }

  private async broadcast(p: Party): Promise<void> {
    await this.ctx.notifier.notifyMany(
      p.members.map((m) => m.userId),
      { type: 'party_update', party: this.view(p) },
    );
  }

  /** Friends of these users learn the new party size (joinable flag). */
  private async presenceChanged(userIds: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(userIds)].map((id) => broadcastPresence(this.ctx, id)));
  }

  /** Client-facing view including the invite link. */
  view(p: Party) {
    return { ...p, inviteUrl: `${this.ctx.config.publicWebUrl}/join/${p.code}`, maxSize: MAX_PARTY_SIZE };
  }

  /** The caller's current party, if any. */
  async current(userId: string): Promise<Party | null> {
    const id = await this.ctx.kv.get(`user-party:${userId}`);
    if (!id) return null;
    const p = await this.load(id);
    if (!p || !p.members.some((m) => m.userId === userId)) {
      await this.ctx.kv.del(`user-party:${userId}`);
      return null;
    }
    return p;
  }

  private async member(userId: string): Promise<PartyMember> {
    const [p] = await this.ctx.db
      .select({ displayName: profiles.displayName, tag: profiles.tag })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    if (!p) throw notFound('Profile');
    return {
      userId,
      displayName: p.displayName,
      tag: p.tag,
      ready: false,
      joinedAt: this.ctx.now().getTime(),
    };
  }

  /** Creates a party led by the caller (returns the existing one if already in a party). */
  async create(userId: string): Promise<Party> {
    const existing = await this.current(userId);
    if (existing) return existing;
    let code = newCode();
    for (let i = 0; i < 10 && (await this.ctx.kv.get(`party-code:${code}`)); i++) code = newCode();
    const now = this.ctx.now().getTime();
    const p: Party = {
      id: randomUUID(),
      code,
      leaderId: userId,
      members: [{ ...(await this.member(userId)), ready: true }],
      playlistId: this.ctx.catalog.playlists[0]?.id ?? 'main_show',
      kicked: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(p);
    return p;
  }

  /** Joins by invite code, leaving any previous party first. */
  async join(userId: string, code: string): Promise<Party> {
    const id = await this.ctx.kv.get(`party-code:${code}`);
    if (!id) throw notFound('Party');
    const prev = await this.current(userId);
    if (prev?.id === id) return prev;
    if (prev) await this.leave(userId);
    const joined = await withLock(this.ctx.kv, `party:${id}`, async () => {
      const p = await this.load(id);
      if (!p) throw notFound('Party');
      if (p.kicked.includes(userId)) throw forbidden('kicked', 'You were removed from this party');
      if (p.members.length >= MAX_PARTY_SIZE) throw conflict('party_full', 'Party is full');
      p.members.push(await this.member(userId));
      await this.save(p);
      return p;
    });
    await this.broadcast(joined);
    await this.presenceChanged(joined.members.map((m) => m.userId));
    return joined;
  }

  /** Leaves the current party; promotes the longest-standing member if the leader leaves. */
  async leave(userId: string): Promise<void> {
    const cur = await this.current(userId);
    if (!cur) return;
    const after = await withLock(
      this.ctx.kv,
      `party:${cur.id}`,
      async (): Promise<Party | 'empty' | null> => {
        const p = await this.load(cur.id);
        if (!p) return null;
        p.members = p.members.filter((m) => m.userId !== userId);
        await this.ctx.kv.del(`user-party:${userId}`);
        if (p.members.length === 0) {
          await this.ctx.kv.del(`party:${p.id}`, `party-code:${p.code}`);
          return 'empty';
        }
        if (p.leaderId === userId) {
          const next = [...p.members].sort((a, b) => a.joinedAt - b.joinedAt)[0]!;
          p.leaderId = next.userId;
          next.ready = true;
        }
        await this.save(p);
        return p;
      },
    );
    // The last member's other tabs and devices still show the party until told otherwise.
    if (after === 'empty')
      await this.ctx.notifier.notifyUser(userId, { type: 'party_disbanded', partyId: cur.id });
    else if (after) await this.broadcast(after);
    await this.presenceChanged([
      userId,
      ...(after && after !== 'empty' ? after.members.map((m) => m.userId) : []),
    ]);
  }

  /**
   * Breaks the party up (leader only): every member is removed and told.
   *
   * @throws {ApiError} 404 without a party, 403 `not_leader`.
   */
  async disband(leaderId: string): Promise<void> {
    const cur = await this.current(leaderId);
    if (!cur) throw notFound('Party');
    const members = await withLock(this.ctx.kv, `party:${cur.id}`, async () => {
      const p = await this.load(cur.id);
      if (!p) throw notFound('Party');
      if (p.leaderId !== leaderId) throw forbidden('not_leader', 'Only the party leader can disband');
      await this.ctx.kv.del(
        `party:${p.id}`,
        `party-code:${p.code}`,
        ...p.members.map((m) => `user-party:${m.userId}`),
      );
      return p.members.map((m) => m.userId);
    });
    await this.ctx.notifier.notifyMany(members, { type: 'party_disbanded', partyId: cur.id });
    await this.presenceChanged(members);
  }

  /** Mutates the caller's party under the lock and broadcasts the result. */
  async mutate(userId: string, fn: (p: Party) => void | Promise<void>): Promise<Party> {
    const cur = await this.current(userId);
    if (!cur) throw notFound('Party');
    const p = await withLock(this.ctx.kv, `party:${cur.id}`, async () => {
      const fresh = await this.load(cur.id);
      if (!fresh) throw notFound('Party');
      await fn(fresh);
      await this.save(fresh);
      return fresh;
    });
    await this.broadcast(p);
    return p;
  }

  /** Removes a member (leader only). */
  async kick(leaderId: string, targetId: string): Promise<Party> {
    if (leaderId === targetId) throw badRequest('self_kick', 'Use leave instead');
    const p = await this.mutate(leaderId, (party) => {
      if (party.leaderId !== leaderId) throw forbidden('not_leader', 'Only the party leader can kick');
      if (!party.members.some((m) => m.userId === targetId)) throw notFound('Member');
      party.members = party.members.filter((m) => m.userId !== targetId);
      party.kicked.push(targetId);
    });
    await this.ctx.kv.del(`user-party:${targetId}`);
    await this.ctx.notifier.notifyUser(targetId, { type: 'party_kicked', partyId: p.id });
    await this.presenceChanged([targetId, ...p.members.map((m) => m.userId)]);
    return p;
  }

  /**
   * Hands leadership to another member (leader only). Every member receives
   * the new party through `party_update`.
   *
   * @throws {ApiError} 400 self, 403 not leader, 404 not a member.
   */
  async promote(leaderId: string, targetId: string): Promise<Party> {
    if (leaderId === targetId) throw badRequest('already_leader', 'You already lead this party');
    return this.mutate(leaderId, (party) => {
      if (party.leaderId !== leaderId) throw forbidden('not_leader', 'Only the party leader can promote');
      const m = party.members.find((x) => x.userId === targetId);
      if (!m) throw notFound('Member');
      party.leaderId = targetId;
      m.ready = true;
    });
  }
}

/**
 * Builds and signs a matchmaker queue ticket for the caller's party (or solo).
 *
 * @throws {ApiError} 403 not leader / ranked ban, 409 not ready / party too big for the playlist.
 */
export async function issueQueueTicket(
  ctx: AppContext,
  parties: PartyService,
  auth: AuthContext,
  opts: { playlistId?: string; region?: string },
): Promise<{ ticket: string; expiresIn: number; claims: QueueTicketClaims }> {
  const party = await parties.current(auth.userId);
  if (party && party.leaderId !== auth.userId)
    throw forbidden('not_leader', 'Only the party leader can start matchmaking');
  if (party && party.members.some((m) => !m.ready))
    throw conflict('not_ready', 'Not every party member is ready');
  const playlistId = opts.playlistId ?? party?.playlistId ?? ctx.catalog.playlists[0]?.id ?? 'main_show';
  const playlist = ctx.catalog.playlists.find((p) => p.id === playlistId);
  if (!playlist) throw badRequest('unknown_playlist', `Unknown playlist ${playlistId}`);
  const memberIds = party ? party.members.map((m) => m.userId) : [auth.userId];
  if (memberIds.length > playlist.teamSize && playlist.teamSize > 1) {
    throw conflict('party_too_large', `${playlist.name} allows parties of up to ${playlist.teamSize}`);
  }
  if (playlist.queue === 'ranked' && memberIds.length > playlist.teamSize) {
    throw conflict('party_too_large', `${playlist.name} is solo-only`);
  }
  for (const id of memberIds) {
    // Members joined before a ban landed stay in the party, so check everyone, not just the caller.
    const memberBans = await activeBans(ctx, id);
    if (memberBans.some((b) => b.scope === 'all')) {
      throw forbidden('member_banned', 'A party member is suspended');
    }
    if (playlist.queue === 'ranked' && memberBans.some((b) => b.scope === 'ranked')) {
      throw forbidden('ranked_banned', 'A party member is suspended from ranked play');
    }
  }
  const names = await ctx.db
    .select({ id: profiles.userId, displayName: profiles.displayName, tag: profiles.tag })
    .from(profiles)
    .where(inArray(profiles.userId, memberIds));
  const rated = await ctx.db
    .select({ id: ratings.userId, mu: ratings.mu, sigma: ratings.sigma })
    .from(ratings)
    .where(
      and(
        eq(ratings.seasonId, ctx.catalog.season.id),
        eq(ratings.queue, RANKED_QUEUE),
        inArray(ratings.userId, memberIds),
      ),
    );
  const claims: QueueTicketClaims = {
    typ: 'queue',
    pid: party?.id ?? `solo:${auth.userId}`,
    leaderId: auth.userId,
    playlistId: playlist.id,
    queue: playlist.queue,
    teamSize: playlist.teamSize,
    maxPlayers: playlist.maxPlayers,
    minPlayers: playlist.minPlayers,
    botsAllowed: playlist.botsAllowed,
    region: opts.region ?? (await accountRegion(ctx.db, auth.userId)),
    members: memberIds.map((id) => {
      const n = names.find((x) => x.id === id);
      const r = rated.find((x) => x.id === id) ?? DEFAULT_RATING;
      return {
        userId: id,
        name: n ? `${n.displayName}#${n.tag}` : 'Tumbler',
        mu: r.mu,
        sigma: r.sigma,
        ordinal: skillOrdinal(r.mu, r.sigma),
      };
    }),
  };
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  const ticket = await signServiceToken(
    ctx.config.jwtSecret,
    'queue',
    { ...claims, sub: auth.userId },
    QUEUE_TICKET_TTL_SEC,
    nowSec,
  );
  return { ticket, expiresIn: QUEUE_TICKET_TTL_SEC, claims };
}

/**
 * Registers `/party` routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerPartyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const parties = new PartyService(ctx);

  app.get('/party', async (req) => {
    const auth = await requireUser(ctx, req);
    const p = await parties.current(auth.userId);
    return { party: p ? parties.view(p) : null };
  });

  app.post('/party', async (req) => {
    const auth = await requireUser(ctx, req);
    return { party: parties.view(await parties.create(auth.userId)) };
  });

  app.get('/party/code/:code', async (req) => {
    await requireUser(ctx, req);
    const { code } = parse(CodeBody, req.params);
    const id = await ctx.kv.get(`party-code:${code}`);
    const raw = id ? await ctx.kv.get(`party:${id}`) : null;
    if (!raw) throw notFound('Party');
    const p = JSON.parse(raw) as Party;
    const leader = p.members.find((m) => m.userId === p.leaderId);
    return {
      code: p.code,
      leader: leader ? `${leader.displayName}#${leader.tag}` : null,
      size: p.members.length,
      maxSize: MAX_PARTY_SIZE,
      playlistId: p.playlistId,
    };
  });

  app.post('/party/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { code } = parse(CodeBody, req.body);
    return { party: parties.view(await parties.join(auth.userId, code)) };
  });

  app.post('/party/leave', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    await parties.leave(auth.userId);
    return reply.code(204).send();
  });

  app.post('/party/disband', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    await parties.disband(auth.userId);
    return reply.code(204).send();
  });

  app.post('/party/kick', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    return { party: parties.view(await parties.kick(auth.userId, userId)) };
  });

  app.post('/party/promote', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    return { party: parties.view(await parties.promote(auth.userId, userId)) };
  });

  app.post('/party/ready', async (req) => {
    const auth = await requireUser(ctx, req);
    const { ready } = parse(ReadyBody, req.body);
    const p = await parties.mutate(auth.userId, (party) => {
      const m = party.members.find((x) => x.userId === auth.userId)!;
      m.ready = party.leaderId === auth.userId ? true : ready;
    });
    return { party: parties.view(p) };
  });

  app.post('/party/playlist', async (req) => {
    const auth = await requireUser(ctx, req);
    const { playlistId } = parse(PlaylistBody, req.body);
    const playlist = ctx.catalog.playlists.find((x) => x.id === playlistId);
    if (!playlist) throw badRequest('unknown_playlist', `Unknown playlist ${playlistId}`);
    const p = await parties.mutate(auth.userId, (party) => {
      if (party.leaderId !== auth.userId)
        throw forbidden('not_leader', 'Only the party leader picks the playlist');
      if (playlist.teamSize > 1 && party.members.length > playlist.teamSize) {
        throw conflict('party_too_large', `${playlist.name} allows parties of up to ${playlist.teamSize}`);
      }
      party.playlistId = playlistId;
      // Members agreed to a different show; make them confirm again.
      for (const m of party.members) m.ready = m.userId === party.leaderId;
    });
    return { party: parties.view(p) };
  });

  app.post('/party/invite', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    // Blocking removes the friendship, so this also refuses blocked pairs.
    if (!(await friendIds(ctx.db, auth.userId)).includes(userId))
      throw forbidden('not_friends', 'You can only invite friends');
    const p = (await parties.current(auth.userId)) ?? (await parties.create(auth.userId));
    if (p.members.some((m) => m.userId === userId))
      throw conflict('already_in_party', 'They are already in your party');
    if (p.members.length >= MAX_PARTY_SIZE) throw conflict('party_full', 'Party is full');
    const me = p.members.find((m) => m.userId === auth.userId)!;
    await ctx.notifier.notifyUser(userId, {
      type: 'party_invite',
      from: { userId: auth.userId, name: me.displayName, tag: me.tag },
      code: p.code,
      partyId: p.id,
    });
    return { party: parties.view(p), invited: userId };
  });

  /** The invitee says no; the inviter gets a notice instead of waiting. */
  app.post(
    '/party/invite/decline',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const auth = await requireUser(ctx, req);
      const { userId } = parse(UserBody, req.body);
      if ((await friendIds(ctx.db, auth.userId)).includes(userId))
        await ctx.notifier.notifyUser(userId, {
          type: 'party_invite_declined',
          by: await socialRef(ctx.db, auth.userId),
        });
      return reply.code(204).send();
    },
  );

  /** Joins a friend's party from their row (creates it if they are solo in the menu). */
  app.post(
    '/party/join-friend',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const { userId } = parse(UserBody, req.body);
      if (userId === auth.userId) throw badRequest('self_join', 'That is you');
      if (!(await friendIds(ctx.db, auth.userId)).includes(userId))
        throw forbidden('not_friends', 'You can only join friends');
      const presence = await getPresence(ctx.kv, userId);
      if (presence.status === 'offline') throw conflict('friend_offline', 'They are offline');
      if (presence.status === 'in_queue' || presence.status === 'in_match')
        throw conflict('friend_busy', 'They are in a show right now');
      const theirs = (await parties.current(userId)) ?? (await parties.create(userId));
      if (theirs.members.some((m) => m.userId === auth.userId)) return { party: parties.view(theirs) };
      return { party: parties.view(await parties.join(auth.userId, theirs.code)) };
    },
  );

  app.post('/party/chat', async (req) => {
    const auth = await requireUser(ctx, req);
    const { text } = parse(ChatBody, req.body);
    return { message: await sendPartyChat(ctx, parties, auth.userId, text) };
  });

  app.post('/party/queue-ticket', async (req) => {
    const auth = await requireUser(ctx, req);
    const body = parse(TicketBody, req.body) ?? {};
    return issueQueueTicket(ctx, parties, auth, body);
  });
}
