/**
 * Friends state as a pure reducer.
 *
 * The account loads `GET /friends` + `GET /friends/recent` once, then keeps the
 * lists current from realtime events (presence, requests, removals) and the
 * results of the player's own actions, without refetching on every change.
 * {@link friendsToUi} projects the model onto the `@tumble/ui` shapes.
 */
import type { BlockedPlayer, Friend, FriendRequest, Presence, Relation, TumblerColors } from '@tumble/ui';
import type { ApiFriend, ApiFriendRequest, ApiFriends, ApiPresenceStatus, ApiRecentPlayer } from '../api.ts';

/** Everything the friends sheet shows. */
export interface FriendsModel {
  friends: ApiFriend[];
  incoming: ApiFriendRequest[];
  outgoing: ApiFriendRequest[];
  blocked: ApiFriendRequest[];
  recent: ApiRecentPlayer[];
}

/** No account / nothing loaded. */
export const EMPTY_FRIENDS: FriendsModel = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  recent: [],
};

/** A player as named by social events. */
export interface SocialRef {
  userId: string;
  name: string;
  tag: string;
  /** Club tag, when they are in a club. */
  club?: string;
}

/** Presence fields carried by realtime `presence` events. */
export interface PresenceEvent {
  userId: string;
  status: ApiPresenceStatus;
  playlistId?: string;
  lobbyCode?: string;
  joinable?: boolean;
}

/** Realtime events and local action results the reducer understands. */
export type FriendsEvent =
  | ({ type: 'presence' } & PresenceEvent)
  | { type: 'presence_snapshot'; friends: PresenceEvent[] }
  | { type: 'friend_request'; from: SocialRef; at?: number }
  | { type: 'friend_accepted'; by: SocialRef }
  | { type: 'friend_removed'; userId: string }
  | { type: 'friend_request_removed'; userId: string }
  /** Local: our request went out (or crossed theirs and auto-accepted). */
  | { type: 'request_sent'; user: SocialRef; status: 'pending' | 'accepted'; at?: number }
  /** Local: we accepted their request. */
  | { type: 'accepted'; userId: string }
  | { type: 'blocked'; user: SocialRef; at?: number }
  | { type: 'unblocked'; userId: string };

const RANK: Record<ApiPresenceStatus, number> = {
  in_menu: 0,
  online: 0,
  in_queue: 1,
  in_match: 2,
  offline: 3,
};

const byAvailability = (a: ApiFriend, b: ApiFriend): number =>
  RANK[a.presence] - RANK[b.presence] ||
  a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' });

const without = <T extends { userId: string }>(list: T[], id: string): T[] =>
  list.some((x) => x.userId === id) ? list.filter((x) => x.userId !== id) : list;

const card = (r: SocialRef, level = 1) => ({ userId: r.userId, displayName: r.name, tag: r.tag, level });

const iso = (ms: number | undefined): string => new Date(ms ?? Date.now()).toISOString();

/**
 * Builds the model from the API's lists.
 *
 * @param f - `GET /friends`.
 * @param recent - `GET /friends/recent` players.
 */
export function friendsFromApi(f: ApiFriends, recent: readonly ApiRecentPlayer[] = []): FriendsModel {
  return {
    friends: [...f.friends].sort(byAvailability),
    incoming: [...f.incoming],
    outgoing: [...f.outgoing],
    blocked: [...(f.blocked ?? [])],
    recent: [...recent],
  };
}

function applyPresence(m: FriendsModel, p: PresenceEvent): FriendsModel {
  const i = m.friends.findIndex((x) => x.userId === p.userId);
  if (i < 0) return m;
  const prev = m.friends[i]!;
  const next: ApiFriend = {
    userId: prev.userId,
    displayName: prev.displayName,
    tag: prev.tag,
    level: prev.level,
    presence: p.status,
    ...(prev.since ? { since: prev.since } : {}),
    ...(p.playlistId ? { playlistId: p.playlistId } : {}),
    ...(p.lobbyCode ? { lobbyCode: p.lobbyCode } : {}),
    ...(p.joinable !== undefined ? { joinable: p.joinable } : {}),
  };
  const friends = m.friends.slice();
  friends[i] = next;
  return { ...m, friends: friends.sort(byAvailability) };
}

function befriend(m: FriendsModel, r: SocialRef): FriendsModel {
  if (m.friends.some((f) => f.userId === r.userId))
    return { ...m, incoming: without(m.incoming, r.userId), outgoing: without(m.outgoing, r.userId) };
  const level = [...m.incoming, ...m.outgoing, ...m.recent].find((x) => x.userId === r.userId)?.level ?? 1;
  // Presence arrives in its own event right after; offline until then.
  const friend: ApiFriend = { ...card(r, level), presence: 'offline' };
  return {
    ...m,
    friends: [...m.friends, friend].sort(byAvailability),
    incoming: without(m.incoming, r.userId),
    outgoing: without(m.outgoing, r.userId),
  };
}

/**
 * Applies one event.
 *
 * @param m - Current model.
 * @param e - Realtime event or local action result.
 * @returns The next model (the same object when nothing changed).
 * @example
 * model = reduceFriends(model, { type: 'friend_removed', userId });
 */
export function reduceFriends(m: FriendsModel, e: FriendsEvent): FriendsModel {
  switch (e.type) {
    case 'presence':
      return applyPresence(m, e);
    case 'presence_snapshot':
      return e.friends.reduce(applyPresence, m);
    case 'friend_request': {
      if (m.friends.some((f) => f.userId === e.from.userId)) return m;
      if (m.incoming.some((r) => r.userId === e.from.userId)) return m;
      const level = m.recent.find((x) => x.userId === e.from.userId)?.level ?? 1;
      return { ...m, incoming: [{ ...card(e.from, level), at: iso(e.at) }, ...m.incoming] };
    }
    case 'friend_accepted':
      return befriend(m, e.by);
    case 'accepted': {
      const r = m.incoming.find((x) => x.userId === e.userId);
      return r ? befriend(m, { userId: r.userId, name: r.displayName, tag: r.tag }) : m;
    }
    case 'request_sent':
      if (e.status === 'accepted') return befriend(m, e.user);
      if (m.outgoing.some((r) => r.userId === e.user.userId)) return m;
      return { ...m, outgoing: [{ ...card(e.user), at: iso(e.at) }, ...m.outgoing] };
    case 'friend_removed':
      return m.friends.some((f) => f.userId === e.userId)
        ? { ...m, friends: without(m.friends, e.userId) }
        : m;
    case 'friend_request_removed': {
      const incoming = without(m.incoming, e.userId);
      const outgoing = without(m.outgoing, e.userId);
      return incoming === m.incoming && outgoing === m.outgoing ? m : { ...m, incoming, outgoing };
    }
    case 'blocked':
      return {
        friends: without(m.friends, e.user.userId),
        incoming: without(m.incoming, e.user.userId),
        outgoing: without(m.outgoing, e.user.userId),
        recent: without(m.recent, e.user.userId),
        blocked: m.blocked.some((b) => b.userId === e.user.userId)
          ? m.blocked
          : [{ ...card(e.user), at: iso(e.at) }, ...m.blocked],
      };
    case 'unblocked':
      return m.blocked.some((b) => b.userId === e.userId)
        ? { ...m, blocked: without(m.blocked, e.userId) }
        : m;
  }
}

/**
 * API presence → UI presence.
 *
 * @param p - API status.
 */
export function uiPresence(p: ApiPresenceStatus | string | undefined): Presence {
  switch (p) {
    case 'in_match':
      return 'inShow';
    case 'in_queue':
      return 'inQueue';
    case 'in_menu':
      return 'inMenu';
    case 'online':
      return 'online';
    default:
      return 'offline';
  }
}

/** How the model reaches the UI. */
export interface FriendsUi {
  /** Friends first, then recent players (`recent: true`). */
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: BlockedPlayer[];
}

/** Recent players listed in the sheet. */
export const RECENT_SHOWN = 12;

/**
 * Projects the model onto `@tumble/ui` shapes.
 *
 * @param m - Model.
 * @param colorsOf - A player's avatar colours.
 * @param playlistName - Display name for a playlist id.
 */
export function friendsToUi(
  m: FriendsModel,
  colorsOf: (userId: string) => TumblerColors,
  playlistName: (id: string) => string = (id) => id,
): FriendsUi {
  const friendById = new Map(m.friends.map((f) => [f.userId, f]));
  const toFriend = (f: ApiFriend): Friend => ({
    id: f.userId,
    name: f.displayName,
    tag: f.tag,
    presence: uiPresence(f.presence),
    colors: colorsOf(f.userId),
    relation: 'friend',
    ...(f.playlistId && (f.presence === 'in_match' || f.presence === 'in_queue')
      ? { playlist: playlistName(f.playlistId) }
      : {}),
    ...(f.joinable ? { joinable: true } : {}),
    ...(f.lobbyCode ? { lobbyCode: f.lobbyCode } : {}),
  });
  const relationOf = (id: string, fallback: ApiRecentPlayer['relation']): Relation => {
    if (friendById.has(id)) return 'friend';
    if (m.incoming.some((r) => r.userId === id)) return 'incoming';
    if (m.outgoing.some((r) => r.userId === id)) return 'outgoing';
    // A server-side "friend" that we since removed reads as none.
    return fallback === 'incoming' || fallback === 'outgoing' ? fallback : 'none';
  };
  const blocked = new Set(m.blocked.map((b) => b.userId));
  const recent: Friend[] = m.recent
    .filter((r) => !blocked.has(r.userId))
    .slice(0, RECENT_SHOWN)
    .map((r) => {
      const f = friendById.get(r.userId);
      return f
        ? { ...toFriend(f), recent: true }
        : {
            id: r.userId,
            name: r.displayName,
            tag: r.tag,
            presence: 'offline' as const,
            colors: colorsOf(r.userId),
            recent: true,
            relation: relationOf(r.userId, r.relation),
          };
    });
  const req = (r: ApiFriendRequest): FriendRequest => ({
    userId: r.userId,
    name: r.displayName,
    tag: r.tag,
    at: r.at ? Date.parse(r.at) : 0,
    colors: colorsOf(r.userId),
  });
  return {
    friends: [...m.friends.map(toFriend), ...recent],
    incoming: m.incoming.map(req),
    outgoing: m.outgoing.map(req),
    blocked: m.blocked.map((b) => ({ userId: b.userId, name: b.displayName, tag: b.tag })),
  };
}
