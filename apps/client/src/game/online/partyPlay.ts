/**
 * What Play means inside a party, and what the party is told about it.
 *
 * Rules:
 * - Vs Bots and Practice Island are always available to anyone. Inside a
 *   party (with others) they are confirmed first, and the party is told the
 *   player is away; a member who goes solo stays in the party.
 * - The online queue is the leader's: members ready up, the leader queues
 *   once everyone is ready and back in the menu.
 */

/** How the player asked to play. */
export type PlayKind = 'online' | 'offline' | 'practice';

/** What a Play press does. */
export type PlayRoute =
  /** Start Vs Bots / Practice now. */
  | { action: 'solo' }
  /** Ask first: this solo show leaves the rest of the party waiting. */
  | { action: 'confirmSolo'; dialog: { title: string; body: string; confirm: string } }
  /** Queue online (leader or solo player). */
  | { action: 'queue' }
  /** A member pressed Play online: the leader starts the show. */
  | { action: 'waitForLeader' };

/** Party facts a Play press depends on. */
export interface PartyContext {
  /** Other people are in the party. */
  inParty: boolean;
  isLeader: boolean;
}

/**
 * Routes a Play press.
 *
 * @example routePlay('offline', { inParty: true, isLeader: false }).action // 'confirmSolo'
 */
export function routePlay(kind: PlayKind, party: PartyContext): PlayRoute {
  if (kind === 'online')
    return party.inParty && !party.isLeader ? { action: 'waitForLeader' } : { action: 'queue' };
  if (!party.inParty) return { action: 'solo' };
  const what = kind === 'practice' ? 'Practice Island' : 'a show vs bots';
  if (party.isLeader)
    return {
      action: 'confirmSolo',
      dialog: {
        title: kind === 'practice' ? 'Visit Practice Island?' : 'Play solo vs bots?',
        body: `Your party stays together and waits in the menu while you play ${what}. They'll see you're playing solo.`,
        confirm: 'Play solo',
      },
    };
  return {
    action: 'confirmSolo',
    dialog: {
      title: kind === 'practice' ? 'Visit Practice Island?' : 'Play solo vs bots?',
      body: "You'll stay in the party but won't queue with them until you're back.",
      confirm: 'Play solo',
    },
  };
}

/** A `party_solo` realtime event. */
export interface PartySoloEvent {
  userId: string;
  name: string;
  leader: boolean;
  playing: boolean;
}

/**
 * The toast a party member sees when someone else goes solo or comes back.
 *
 * @returns Null for the player's own event.
 */
export function soloNotice(e: PartySoloEvent, selfId: string | null): { title: string; body: string } | null {
  if (e.userId === selfId) return null;
  if (e.leader)
    return e.playing
      ? { title: 'Leader is playing solo', body: `${e.name} will start the next show when they're back.` }
      : { title: 'Leader is back', body: `${e.name} is back in the menu.` };
  return e.playing
    ? { title: `${e.name} is playing solo`, body: "They'll need to ready up again before the next show." }
    : { title: `${e.name} is back`, body: 'They can ready up for the next show.' };
}

/**
 * The dialog for a refused party queue ticket.
 *
 * @param code - API error code.
 * @param message - API message (names busy members for `member_busy`).
 */
export function queueRefusal(code: string, message: string): { title: string; body: string } {
  if (code === 'not_ready')
    return { title: 'Not everyone is ready', body: 'Wait for every party member to hit Ready.' };
  if (code === 'member_busy')
    return {
      title: 'Someone is still in a show',
      body: `${message}. Queue again once they're back in the menu.`,
    };
  if (code === 'maintenance')
    return { title: 'Down for maintenance', body: `${message} You can still play Vs Bots.` };
  if (code === 'playlist_unavailable')
    return { title: "That playlist isn't open", body: `${message}. Pick another playlist and try again.` };
  return { title: "Couldn't start matchmaking", body: message };
}
