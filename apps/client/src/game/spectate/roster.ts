/**
 * The spectator roster: everyone in the round, in the order a viewer wants
 * them (the pinned player, party and club members, then the field by
 * status and place).
 *
 * Streamer Mode masks names here, before the UI (and its search,
 * `searchRoster` in @tumble/ui) sees them, so typing a real name can never
 * reveal who is behind "Tumbler 12".
 */
import { streamerSafeName, type SpectatorRosterEntry } from '@tumble/ui';

/** A round participant as the session knows them. */
export interface RosterPlayer {
  id: number;
  /** Raw display name (masked here when Streamer Mode is on). */
  name: string;
  color: string;
  isBot: boolean;
  isLocal: boolean;
  /** In the local player's party. */
  isParty: boolean;
  /** In the local player's club. */
  isClub: boolean;
  /** Team index, −1 when solo. */
  team: number;
  status: SpectatorRosterEntry['status'];
  /** 1 = first; 0 when unknown. */
  place: number;
}

/** Context for {@link buildRoster}. */
export interface RosterContext {
  streamerMode: boolean;
  pinnedId: number | null;
  followingId: number | null;
}

const STATUS_ORDER: Readonly<Record<SpectatorRosterEntry['status'], number>> = {
  playing: 0,
  qualified: 1,
  eliminated: 2,
};

/**
 * The roster, sorted: pinned, party, club, then playing → qualified →
 * eliminated, each by place (unknown last), ties by id. The local player is
 * left out (spectators watch others).
 *
 * @param players - Round participants.
 * @param ctx - Masking and highlight state.
 * @example
 * ui.getState().patchSpectator({ roster: buildRoster(players, ctx) });
 */
export function buildRoster(players: readonly RosterPlayer[], ctx: RosterContext): SpectatorRosterEntry[] {
  const rows = players
    .filter((p) => !p.isLocal)
    .map((p): SpectatorRosterEntry => ({
      id: p.id,
      name: streamerSafeName(
        { id: p.id, name: p.name, isBot: p.isBot, isLocal: false, isParty: p.isParty },
        ctx.streamerMode,
      ),
      color: p.color,
      isBot: p.isBot,
      isParty: p.isParty,
      isClub: p.isClub,
      team: p.team,
      status: p.status,
      place: p.place,
      pinned: p.id === ctx.pinnedId,
      following: p.id === ctx.followingId,
    }));
  const rank = (e: SpectatorRosterEntry): number => (e.pinned ? 0 : e.isParty ? 1 : e.isClub ? 2 : 3);
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.place || Infinity) - (b.place || Infinity) ||
      a.id - b.id,
  );
  return rows;
}

/**
 * Who to watch first when spectating starts: a party member still playing,
 * else a club member still playing, else the leader of `order`.
 *
 * @param order - Spectate candidates in standings order.
 * @param isParty - Party member test.
 * @param isClub - Club member test.
 * @returns A player id, or undefined when `order` is empty.
 */
export function firstToWatch(
  order: readonly number[],
  isParty: (id: number) => boolean,
  isClub: (id: number) => boolean,
): number | undefined {
  return order.find(isParty) ?? order.find(isClub) ?? order[0];
}
