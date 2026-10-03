/**
 * Fan-out of realtime events to users via KV pub/sub. Any API instance can
 * publish; whichever instance holds the user's WebSocket delivers it.
 */
import type { KV } from '../kv/index.ts';

/** Presence states shown in friends lists. */
export type PresenceStatus = 'online' | 'in_menu' | 'in_queue' | 'in_match' | 'offline';

/** Presence states that a client may report (the gateway derives `offline`). */
export const REPORTABLE_PRESENCE = ['online', 'in_menu', 'in_queue', 'in_match'] as const;

/** What friends see about a user's presence. */
export interface PresenceView {
  status: PresenceStatus;
  /** Playlist being queued for or played (`in_queue` / `in_match`). */
  playlistId?: string;
  /** Code of a private show the user is hosting or sitting in, shared with friends. */
  lobbyCode?: string;
  /** Friends may join this user's party right now (menu, party not full). */
  joinable?: boolean;
}

/** A user as named in social events. */
export interface SocialRef {
  userId: string;
  name: string;
  tag: string;
}

/** A relayed party chat line. */
export interface PartyChatLine {
  /** Unique id (dedupe across reconnects). */
  id: string;
  partyId: string;
  from: SocialRef;
  /** Slurs masked; shown with the chat filter off. */
  text: string;
  /** Fully masked copy, when it differs from `text`. */
  masked?: string;
  /** Epoch ms. */
  at: number;
}

/** Every event the gateway pushes to clients. `type` is the discriminator. */
export type RealtimeEvent =
  | ({ type: 'presence'; userId: string } & PresenceView)
  /** Sent once per connection: the current presence of every friend. */
  | { type: 'presence_snapshot'; friends: ({ userId: string } & PresenceView)[] }
  | { type: 'friend_request'; from: SocialRef }
  | { type: 'friend_accepted'; by: SocialRef }
  | { type: 'friend_removed'; userId: string }
  /** A pending request between you and `userId` is gone (declined, cancelled, blocked). */
  | { type: 'friend_request_removed'; userId: string }
  | { type: 'party_invite_declined'; by: SocialRef }
  | ({ type: 'party_chat' } & PartyChatLine)
  | { type: 'party_update'; party: unknown }
  | {
      type: 'party_invite';
      from: SocialRef;
      code: string;
      partyId: string;
    }
  | { type: 'party_kicked'; partyId: string }
  | { type: 'party_disbanded'; partyId: string }
  | { type: 'notification'; kind: 'info' | 'success' | 'warning' | 'reward'; title: string; body?: string }
  | { type: 'wallet'; gumballs: number; gems: number; crownShards: number };

/** Channel name for a user's personal event stream. */
export const userChannel = (userId: string): string => `user:${userId}`;

/** Publishes {@link RealtimeEvent}s to users. */
export class Notifier {
  constructor(private readonly kv: KV) {}

  /** Sends one event to one user (no-op if they are offline). */
  async notifyUser(userId: string, event: RealtimeEvent): Promise<void> {
    await this.kv.publish(userChannel(userId), JSON.stringify(event));
  }

  /** Sends one event to several users. */
  async notifyMany(userIds: Iterable<string>, event: RealtimeEvent): Promise<void> {
    const payload = JSON.stringify(event);
    await Promise.all([...new Set(userIds)].map((id) => this.kv.publish(userChannel(id), payload)));
  }
}
