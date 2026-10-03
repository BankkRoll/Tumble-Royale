/**
 * Fan-out of realtime events to users via KV pub/sub. Any API instance can
 * publish; whichever instance holds the user's WebSocket delivers it.
 */
import type { KV } from '../kv/index.ts';

/** Presence states shown in friends lists. */
export type PresenceStatus = 'online' | 'in_menu' | 'in_queue' | 'in_match' | 'offline';

/** Every event the gateway pushes to clients. `type` is the discriminator. */
export type RealtimeEvent =
  | { type: 'presence'; userId: string; status: PresenceStatus }
  | { type: 'friend_request'; from: { userId: string; name: string; tag: string } }
  | { type: 'friend_accepted'; by: { userId: string; name: string; tag: string } }
  | { type: 'friend_removed'; userId: string }
  | { type: 'party_update'; party: unknown }
  | {
      type: 'party_invite';
      from: { userId: string; name: string; tag: string };
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
