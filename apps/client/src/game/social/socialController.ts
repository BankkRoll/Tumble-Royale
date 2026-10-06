/**
 * Friends, requests, blocking, reports, global / party chat, whispers and
 * party joins for the online account.
 *
 * Responsibilities:
 * - load `GET /friends` + `GET /friends/recent` into a {@link FriendsModel}
 *   and keep it current from realtime events (no refetch per change);
 * - push the projection to the UI (`ui.friends`, the social store's requests
 *   and blocked list);
 * - run the friend actions the UI emits, with clear toasts for API errors;
 * - the menu's global chat room (All tab) while the realtime socket is up,
 *   party chat and whispers in and out, party-invite declines, joining a friend.
 */
import { getPlaylist } from '@tumble/content/shows';
import {
  social,
  ui,
  type ChatLine,
  type PlayerSearchResult,
  type ReportReason,
  type TumblerColors,
} from '@tumble/ui';
import { ApiError, type ApiClient, type ApiParty } from '../api.ts';
import { liveFlags } from '../liveOps/flags.ts';
import type { TypedMessage } from '../online/jsonSocket.ts';
import {
  chatHint,
  setChatRoom,
  setChatRoute,
  setPartyChat,
  setWhisperRoute,
  systemNotice,
} from './chatRouter.ts';
import {
  EMPTY_FRIENDS,
  friendsFromApi,
  friendsToUi,
  reduceFriends,
  type FriendsEvent,
  type FriendsModel,
  type SocialRef,
} from './friendsState.ts';

/** The realtime socket as this controller uses it. */
export interface RealtimeLike {
  on(type: string, fn: (m: TypedMessage) => void): () => void;
  send(m: TypedMessage): void;
  readonly connected: boolean;
}

/** What the controller needs from the account. */
export interface SocialHost {
  userId(): string | null;
  colorsOf(userId: string): TumblerColors;
  /** A party came back from the API (join / join-friend). */
  applyParty(p: ApiParty): void;
  /** Party chat only exists while in a party. */
  partyId(): string | null;
}

/** Human message for an API error. */
export function socialErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'The server could not be reached.';
    if (err.status === 404 && err.code === 'not_found') return "We couldn't find that player.";
    if (err.status === 429 && err.code === 'rate_limited') return 'Slow down a little and try again.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** Chat refusals from the gateway, shown as the inline hint. */
const CHAT_ERRORS = new Set(['chat_rate', 'chat_banned', 'empty_message', 'not_friends', 'self_whisper']);

const REALTIME_EVENTS = [
  'presence',
  'presence_snapshot',
  'friend_request',
  'friend_accepted',
  'friend_removed',
  'friend_request_removed',
] as const;

/**
 * Social features of the signed-in account.
 *
 * @example
 * const social = new SocialController(api, realtime, host);
 * social.bind();
 * await social.refresh();
 */
export class SocialController {
  private model: FriendsModel = EMPTY_FRIENDS;
  private readonly offs: (() => void)[] = [];
  private searchSeq = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly rt: RealtimeLike,
    private readonly host: SocialHost,
  ) {}

  /** The current model (tests, debug). */
  get state(): FriendsModel {
    return this.model;
  }

  /** True when the two players are friends. */
  isFriend(userId: string): boolean {
    return this.model.friends.some((f) => f.userId === userId);
  }

  /** Wires realtime events. */
  bind(): void {
    for (const type of REALTIME_EVENTS)
      this.offs.push(this.rt.on(type, (m) => this.apply(m as unknown as FriendsEvent)));
    this.offs.push(
      this.rt.on('party_chat', (m) => this.onPartyChat(m)),
      this.rt.on('party_invite_declined', (m) => {
        const by = m.by as SocialRef | undefined;
        ui.getState().pushToast({
          kind: 'social',
          title: `${by?.name ?? 'Your friend'} can't join right now`,
          icon: '💌',
        });
      }),
      this.rt.on('whisper', (m) => this.onWhisper(m)),
      this.rt.on('global_chat', (m) => this.onGlobalChat(m)),
      this.rt.on('global_chat_history', (m) => {
        if (Array.isArray(m.lines)) for (const l of m.lines) this.onGlobalChat(l as TypedMessage);
      }),
      this.rt.on('error', (m) => {
        if (typeof m.code === 'string' && CHAT_ERRORS.has(m.code))
          chatHint(String(m.message ?? 'Message not sent'));
      }),
      this.rt.on('socket_open', () => this.setGlobalRoom(true)),
      this.rt.on('socket_closed', () => this.setGlobalRoom(false)),
      liveFlags.subscribe(() => this.setGlobalRoom(this.rt.connected)),
    );
    setWhisperRoute((to, text) => this.whisper(to.userId, text));
    setChatRoute('global', (text) => this.sendGlobalChat(text));
    this.setGlobalRoom(this.rt.connected);
  }

  /**
   * The global room only exists over the realtime socket (no HTTP fallback).
   * A drop keeps the lines: the history on reconnect dedupes against them.
   */
  private setGlobalRoom(up: boolean): void {
    // `chat.global` off closes the room like a dropped socket; the API refuses sends anyway.
    const open = up && liveFlags.flag('chat.global');
    social.getState().dispatchChat({ type: 'room', room: 'global', access: open ? 'write' : 'off' });
  }

  /**
   * Keeps the Party tab and System notices in step with the party. Called by
   * the account for every party change (realtime or HTTP).
   *
   * @param party - Current party, or null.
   */
  onParty(party: ApiParty | null): void {
    const me = this.host.userId();
    const prev = this.lastParty;
    this.lastParty = party;
    const others = party?.members.filter((m) => m.userId !== me) ?? [];
    if (!party || party.id !== prev?.id) setPartyChat(false);
    if (others.length > 0) {
      setPartyChat(true);
      setChatRoute('party', (text) => this.sendPartyChat(text));
    } else {
      setPartyChat(false);
      setChatRoute('party', null);
    }
    if (!party || !prev || party.id !== prev.id) {
      // A switch between two parties is a join; the first load after sign-in is not.
      if (party && prev && others.length > 0) systemNotice('You joined the party');
      return;
    }
    const before = new Map(prev.members.map((m) => [m.userId, m]));
    const after = new Map(party.members.map((m) => [m.userId, m]));
    for (const m of party.members)
      if (!before.has(m.userId) && m.userId !== me) systemNotice(`${m.displayName} joined the party`);
    for (const m of prev.members)
      if (!after.has(m.userId) && m.userId !== me) systemNotice(`${m.displayName} left the party`);
    if (prev.leaderId !== party.leaderId) {
      const leader = after.get(party.leaderId);
      systemNotice(
        leader?.userId === me
          ? 'You lead the party now'
          : `${leader?.displayName ?? 'Someone'} leads the party now`,
      );
    }
  }

  private lastParty: ApiParty | null = null;

  /** Applies one event and republishes. */
  apply(e: FriendsEvent): void {
    const next = reduceFriends(this.model, e);
    if (next === this.model) return;
    this.model = next;
    this.publish();
  }

  /** Reloads everything from the API (sign-in, reconnect). */
  async refresh(): Promise<void> {
    try {
      const [f, recent] = await Promise.all([
        this.api.friends(),
        this.api.recentPlayers().catch(() => ({ players: [] })),
      ]);
      this.model = friendsFromApi(f, recent.players);
      this.publish();
    } catch (err) {
      console.warn('[social] friends failed', err);
    }
  }

  /** Re-projects (colours arrived for someone). */
  publish(): void {
    const v = friendsToUi(
      this.model,
      (id) => this.host.colorsOf(id),
      (id) => getPlaylist(id)?.name ?? id,
    );
    ui.getState().setFriends(v.friends);
    social.getState().setRequests(v.incoming, v.outgoing);
    social.getState().setBlocked(v.blocked);
  }

  private fail(title: string, err: unknown): void {
    ui.getState().pushToast({ kind: 'warning', title, body: socialErrorText(err), icon: '👥' });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Sends a friend request by `name#tag` or account id.
   *
   * @param target - `Name#1234` or `{ userId }`.
   */
  async request(target: string | { userId: string }): Promise<void> {
    try {
      const r = await this.api.friendRequest(target);
      const user = { userId: r.user.userId, name: r.user.displayName, tag: r.user.tag };
      this.apply({ type: 'request_sent', user, status: r.status });
      ui.getState().pushToast({
        kind: 'social',
        title: r.status === 'accepted' ? `${user.name} is now your friend!` : `Request sent to ${user.name}`,
        icon: '👥',
      });
      if (r.status === 'accepted') void this.refresh();
    } catch (err) {
      this.fail("Couldn't add that friend", err);
    }
  }

  /** Accepts, declines or cancels a pending request. */
  async answer(userId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    try {
      if (action === 'accept') {
        await this.api.acceptFriend(userId);
        this.apply({ type: 'accepted', userId });
        // Presence follows over the gateway; the refresh covers a missed event.
        void this.refresh();
      } else {
        if (action === 'decline') await this.api.declineFriend(userId);
        else await this.api.cancelFriendRequest(userId);
        this.apply({ type: 'friend_request_removed', userId });
      }
    } catch (err) {
      this.fail(action === 'accept' ? "Couldn't accept" : "Couldn't update that request", err);
      void this.refresh();
    }
  }

  /** Removes a friend. */
  async remove(userId: string): Promise<void> {
    const name = this.model.friends.find((f) => f.userId === userId)?.displayName ?? 'Friend';
    try {
      await this.api.removeFriend(userId);
      this.apply({ type: 'friend_removed', userId });
      ui.getState().pushToast({ kind: 'info', title: `${name} removed from friends` });
    } catch (err) {
      this.fail("Couldn't remove that friend", err);
    }
  }

  /** Blocks a player. */
  async block(userId: string, name: string): Promise<void> {
    try {
      await this.api.block(userId);
      const known = [
        ...this.model.friends,
        ...this.model.incoming,
        ...this.model.outgoing,
        ...this.model.recent,
      ];
      const tag = known.find((k) => k.userId === userId)?.tag ?? '';
      this.apply({ type: 'blocked', user: { userId, name, tag } });
      ui.getState().pushToast({
        kind: 'info',
        title: `${name} is blocked`,
        body: 'Unblock any time from Friends.',
      });
    } catch (err) {
      this.fail("Couldn't block", err);
    }
  }

  /** Unblocks a player. */
  async unblock(userId: string): Promise<void> {
    try {
      await this.api.unblock(userId);
      this.apply({ type: 'unblocked', userId });
    } catch (err) {
      this.fail("Couldn't unblock", err);
    }
  }

  /** Files a report. */
  async report(userId: string, reason: ReportReason, details?: string): Promise<void> {
    try {
      await this.api.report({ targetUserId: userId, reason, ...(details ? { details } : {}) });
      ui.getState().pushToast({
        kind: 'success',
        title: 'Report sent',
        body: 'Thanks. Our moderators will take a look.',
      });
    } catch (err) {
      this.fail("Couldn't send the report", err);
    }
  }

  /** Prefix search on display names (latest query wins). */
  async search(query: string): Promise<void> {
    const seq = ++this.searchSeq;
    social.getState().setSearch({ query, loading: true });
    try {
      const r = await this.api.searchPlayers(query);
      if (seq !== this.searchSeq) return;
      const results: PlayerSearchResult[] = r.players.map((p) => ({
        userId: p.userId,
        name: p.displayName,
        tag: p.tag,
        level: p.level,
        relation: p.relation,
      }));
      social.getState().setSearch({ query, results, loading: false });
    } catch (err) {
      if (seq !== this.searchSeq) return;
      social.getState().setSearch({ query, results: [], loading: false });
      this.fail("Search isn't working right now", err);
    }
  }

  /** Joins a friend's party from their row. */
  async joinFriend(userId: string): Promise<boolean> {
    try {
      const { party } = await this.api.joinFriendParty(userId);
      this.host.applyParty(party);
      return true;
    } catch (err) {
      this.fail("Couldn't join", err);
      return false;
    }
  }

  /** Tells the inviter "not now". */
  declineInvite(userId: string): void {
    void this.api.declinePartyInvite(userId).catch(() => undefined);
  }

  /**
   * Whispers a friend (gateway when connected, else HTTP).
   *
   * @param userId - Friend's account id.
   * @param text - Message.
   */
  whisper(userId: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.rt.connected) this.rt.send({ type: 'whisper', to: userId, text: t });
    else void this.api.whisper(userId, t).catch((err) => chatHint(socialErrorText(err)));
  }

  private onWhisper(m: TypedMessage): void {
    const from = m.from as SocialRef | undefined;
    const to = m.to as SocialRef | undefined;
    if (!from || !to || typeof m.text !== 'string') return;
    const self = from.userId === this.host.userId();
    social.getState().pushChat({
      id: String(m.id ?? `w${Date.now()}`),
      channel: 'whisper',
      from: {
        userId: from.userId,
        name: from.name,
        tag: from.tag,
        key: from.userId,
        ...(from.club ? { club: from.club } : {}),
      },
      to: { userId: to.userId, name: to.name, tag: to.tag, key: to.userId },
      text: m.text,
      ...(typeof m.masked === 'string' ? { masked: m.masked } : {}),
      ...(self ? { self: true } : {}),
      at: typeof m.at === 'number' ? m.at : Date.now(),
    });
  }

  /** Sends a party chat line (gateway when connected, else HTTP). */
  sendPartyChat(text: string): void {
    const t = text.trim();
    if (!t || !this.host.partyId()) return;
    if (this.rt.connected) this.rt.send({ type: 'party_chat', text: t });
    else void this.api.partyChat(t).catch((err) => chatHint(socialErrorText(err)));
  }

  /**
   * Says something to everyone in the menu's global room.
   *
   * @param text - Message.
   */
  sendGlobalChat(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.rt.connected) this.rt.send({ type: 'global_chat', text: t });
    else chatHint('Chat needs the online servers');
  }

  private onGlobalChat(m: TypedMessage): void {
    const from = m.from as SocialRef | undefined;
    if (!from?.userId || typeof m.text !== 'string' || typeof m.id !== 'string') return;
    social.getState().pushChat({
      id: `g:${m.id}`,
      room: 'global',
      from: {
        userId: from.userId,
        name: from.name,
        tag: from.tag,
        key: from.userId,
        ...(from.club ? { club: from.club } : {}),
      },
      text: m.text,
      ...(typeof m.masked === 'string' ? { masked: m.masked } : {}),
      ...(from.userId === this.host.userId() ? { self: true } : {}),
      at: typeof m.at === 'number' ? m.at : Date.now(),
    });
  }

  private onPartyChat(m: TypedMessage): void {
    const from = m.from as SocialRef | undefined;
    if (!from || typeof m.text !== 'string') return;
    const self = from.userId === this.host.userId();
    const line: ChatLine = {
      id: String(m.id ?? `p${Date.now()}`),
      channel: 'party',
      from: {
        userId: from.userId,
        name: from.name,
        tag: from.tag,
        key: from.userId,
        ...(from.club ? { club: from.club } : {}),
      },
      text: m.text,
      ...(typeof m.masked === 'string' ? { masked: m.masked } : {}),
      ...(self ? { self: true } : {}),
      at: typeof m.at === 'number' ? m.at : Date.now(),
    };
    social.getState().pushChat(line);
  }

  /** Removes listeners. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    setWhisperRoute(null);
    setChatRoute('party', null);
    setChatRoute('global', null);
    setPartyChat(false);
    setChatRoom('global', 'off');
  }
}
