/**
 * Fan-out of realtime events to users via KV pub/sub. Any API instance can
 * publish; whichever instance holds the user's WebSocket delivers it.
 */
import type { PartyLobbyEvent } from '@tumble/shared';
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
  /** Club tag, when the user is in a club. */
  club?: string;
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

/** A relayed club chat line. */
export interface ClubChatLine {
  /** Message id (`club_messages.id`), also the history dedupe key. */
  id: string;
  clubId: string;
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
  /** A whisper to or from this user (both sides receive it). */
  | { type: 'whisper'; id: string; from: SocialRef; to: SocialRef; text: string; masked?: string; at: number }
  /** A fellow party member's main-menu Tumbler (see `realtime/partyLobby.ts`). */
  | PartyLobbyEvent
  | { type: 'party_update'; party: unknown }
  | {
      type: 'party_invite';
      from: SocialRef;
      code: string;
      partyId: string;
    }
  | { type: 'party_kicked'; partyId: string }
  /** A party member (or the leader) started or finished a show on their own (Vs Bots, Practice). */
  | {
      type: 'party_solo';
      partyId: string;
      userId: string;
      name: string;
      leader: boolean;
      playing: boolean;
    }
  | { type: 'party_disbanded'; partyId: string }
  | {
      type: 'notification';
      kind: 'info' | 'success' | 'warning' | 'reward';
      title: string;
      body?: string;
      /** Set for achievement unlocks, so the client can refresh its achievements view. */
      achievementId?: string;
    }
  | { type: 'wallet'; gumballs: number; gems: number; crownShards: number }
  /** Something about the member's club changed (roster, roles, settings, goals): refetch it. */
  | { type: 'club_update'; clubId: string }
  | ({ type: 'club_chat' } & ClubChatLine)
  /** The player is no longer in the club: kicked, or the club was disbanded. */
  | { type: 'club_removed'; clubId: string; name: string; reason: 'kicked' | 'disbanded' }
  | { type: 'club_invite'; clubId: string; name: string; tag: string; from: SocialRef }
  /** To officers: someone asked to join. */
  | { type: 'club_request'; clubId: string; from: SocialRef };

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
