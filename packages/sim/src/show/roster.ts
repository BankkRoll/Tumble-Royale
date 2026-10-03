/**
 * Seat bookkeeping shared by every show host (offline runner, server room):
 * seeded bot skill tiers from a playlist's skill mix, and party ids for
 * duos/squads so the director can keep parties together and share fates.
 */
import { Rng } from '@tumble/shared';
import { pickSkill } from '../bots/skill.ts';
import type { BotSkill } from '../bots/types.ts';

const SKILL_SALT = 0x5c11_b075;

/** One seat as a host knows it before the show starts. */
export interface RosterSeat {
  id: number;
  isBot: boolean;
  /**
   * Opaque party key for humans who queued together (matchmaker team or party
   * id). Seats with the same key share a party; null/undefined for solos and bots.
   */
  partyKey?: string | null;
}

/**
 * Seeded skill tiers for `count` bots, drawn with {@link pickSkill} from the
 * playlist's mix. The same seed and mix always give the same tiers.
 *
 * @param seed - Show seed.
 * @param count - Bots, in seat order.
 * @param mix - Playlist `botSkillMix` weights.
 * @returns One tier per bot.
 * @example
 * assignBotSkills(show.seed, 30, playlist.botSkillMix); // ['average', 'sharp', …]
 */
export function assignBotSkills(
  seed: number,
  count: number,
  mix: Readonly<Record<BotSkill, number>>,
): BotSkill[] {
  const rng = new Rng((seed ^ SKILL_SALT) >>> 0);
  const out: BotSkill[] = [];
  for (let i = 0; i < count; i++) out.push(pickSkill(rng.next(), mix));
  return out;
}

/**
 * Party ids for a party-mode show (`partySize > 1`), or an empty map for solo
 * shows. Humans sharing a `partyKey` form one party (split if a key somehow
 * holds more than `partySize` seats); parties left short are topped up with
 * bots in seat order, then remaining seats (solo humans first, then bots)
 * fill new parties in seat order, mirroring the offline runner's
 * `floor(id / partySize)` grouping. Deterministic for a given seat list.
 *
 * @param seats - Every seat in the show.
 * @param partySize - Playlist party size (2 duos, 4 squads).
 * @returns Seat id → party id (0-based, dense).
 * @example
 * assignShowParties([{ id: 0, isBot: false, partyKey: 'p1' }, { id: 1, isBot: false, partyKey: 'p1' }], 2);
 */
export function assignShowParties(seats: readonly RosterSeat[], partySize: number): Map<number, number> {
  const out = new Map<number, number>();
  if (partySize <= 1) return out;
  const sorted = [...seats].sort((a, b) => a.id - b.id);
  const parties: number[][] = [];
  const byKey = new Map<string, number[]>();
  for (const s of sorted) {
    if (s.isBot || !s.partyKey) continue;
    let list = byKey.get(s.partyKey);
    if (!list || list.length >= partySize) {
      list = [];
      byKey.set(s.partyKey, list);
      parties.push(list);
    }
    list.push(s.id);
  }
  const loose = sorted.filter((s) => s.isBot || !s.partyKey);
  const solos = loose.filter((s) => !s.isBot).map((s) => s.id);
  const bots = loose.filter((s) => s.isBot).map((s) => s.id);
  // Queued parties are short only when the matchmaker could not fill them; bots complete them.
  for (const p of parties) while (p.length < partySize && bots.length > 0) p.push(bots.shift()!);
  let open: number[] | null = null;
  for (const id of [...solos, ...bots]) {
    if (!open || open.length >= partySize) {
      open = [];
      parties.push(open);
    }
    open.push(id);
  }
  parties.forEach((members, i) => {
    for (const id of members) out.set(id, i);
  });
  return out;
}
