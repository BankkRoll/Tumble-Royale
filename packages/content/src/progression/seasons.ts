/**
 * The season schedule: which season is live at any instant, when the next one
 * starts and which pass track it uses.
 *
 * Responsibilities:
 * - Authored seasons (id, number, name, theme, UTC start/end, pass track),
 *   validated to be contiguous and numbered 1..n.
 * - A rolling generator: after the authored list runs out, seasons keep
 *   coming on a fixed {@link SEASON_LENGTH_MONTHS}-month cadence with names
 *   drawn from a theme pool, so there is always a current and a next season.
 * - The rollover rule for unclaimed pass rewards ({@link unclaimedPassRewards}),
 *   shared by the API and the offline profile so both settle a season the
 *   same way.
 *
 * Everything here is a pure function of the date, so every API instance and
 * every offline client agree on the live season without coordination.
 */
import { z } from 'zod';
import { addUtcMonths } from './calendar.ts';
import { PASS_TIERS, SEASON_PASS, passTierForXp, type PassReward, type SeasonPass } from './season-pass.ts';

/** Length of a generated season. Authored seasons may differ. */
export const SEASON_LENGTH_MONTHS = 3;

/**
 * Gumballs paid instead of a pass cosmetic the player already owns. Generated
 * seasons reuse authored pass tracks, so repeats are expected and must still
 * pay out something.
 */
export const PASS_DUPLICATE_GUMBALLS = 100;

/** One scheduled season. */
export const SeasonDefSchema = z.object({
  /** Stable id `s<number>`; pass progress and leaderboards are keyed by it. */
  id: z.string().regex(/^s\d+$/),
  number: z.number().int().positive(),
  /** Full display name, e.g. `Season 1: Sugar Rush`. */
  name: z.string().min(1),
  /** Short theme name shown on the pass header. */
  theme: z.string().min(1),
  /** Inclusive start, ISO-8601 UTC. */
  startsAt: z.iso.datetime(),
  /** Exclusive end, ISO-8601 UTC; equals the next season's start. */
  endsAt: z.iso.datetime(),
  /** Key into {@link PASS_TRACKS}. */
  passTrackId: z.string().min(1),
});

/** An authored season. */
export type SeasonDef = z.output<typeof SeasonDefSchema>;

/** A season from the schedule (authored or generated). */
export interface Season extends SeasonDef {
  /** True when the rolling generator made it rather than an author. */
  generated: boolean;
}

/** Pass tracks seasons can point at. Generated seasons cycle through these in order. */
export const PASS_TRACKS: Readonly<Record<string, SeasonPass>> = { 'sugar-rush': SEASON_PASS };

const TRACK_IDS = Object.keys(PASS_TRACKS);

/** Theme names for generated seasons, used in order and then repeated. */
export const GENERATED_THEMES: readonly string[] = [
  'Gumdrop Galaxy',
  'Jelly Jamboree',
  'Taffy Tides',
  'Cocoa Carnival',
  'Sherbet Summit',
  'Marshmallow Mayhem',
  'Licorice Lagoon',
  'Caramel Comet',
];

/** The authored schedule, oldest first. */
export const AUTHORED_SEASONS: readonly SeasonDef[] = z
  .array(SeasonDefSchema)
  .min(1)
  .superRefine((list, ctx) => {
    list.forEach((s, i) => {
      if (s.number !== i + 1) ctx.addIssue({ code: 'custom', message: `${s.id} must be season ${i + 1}` });
      if (s.id !== `s${s.number}`) ctx.addIssue({ code: 'custom', message: `${s.id} must be s${s.number}` });
      if (Date.parse(s.endsAt) <= Date.parse(s.startsAt))
        ctx.addIssue({ code: 'custom', message: `${s.id} ends before it starts` });
      const prev = list[i - 1];
      if (prev && prev.endsAt !== s.startsAt)
        ctx.addIssue({ code: 'custom', message: `${s.id} must start when ${prev.id} ends` });
      if (!PASS_TRACKS[s.passTrackId])
        ctx.addIssue({ code: 'custom', message: `${s.id}: unknown pass track ${s.passTrackId}` });
    });
  })
  .parse([
    {
      id: 's1',
      number: 1,
      name: 'Season 1: Sugar Rush',
      theme: 'Sugar Rush',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z',
      passTrackId: 'sugar-rush',
    },
    {
      id: 's2',
      number: 2,
      name: 'Season 2: Frosting Frenzy',
      theme: 'Frosting Frenzy',
      startsAt: '2026-12-01T00:00:00.000Z',
      endsAt: '2027-03-01T00:00:00.000Z',
      passTrackId: 'sugar-rush',
    },
  ]);

/**
 * A season by number: authored when one exists, otherwise generated on the
 * fixed cadence after the last authored season.
 *
 * @param n - Season number (1-based).
 * @returns The season.
 * @throws When `n` is not a positive integer.
 */
export function seasonByNumber(n: number): Season {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid season number ${n}`);
  const authored = AUTHORED_SEASONS[n - 1];
  if (authored) return { ...authored, generated: false };
  const last = AUTHORED_SEASONS[AUTHORED_SEASONS.length - 1] as SeasonDef;
  const k = n - AUTHORED_SEASONS.length - 1;
  const start = addUtcMonths(new Date(last.endsAt), k * SEASON_LENGTH_MONTHS);
  const end = addUtcMonths(start, SEASON_LENGTH_MONTHS);
  const theme = GENERATED_THEMES[k % GENERATED_THEMES.length] as string;
  return {
    id: `s${n}`,
    number: n,
    name: `Season ${n}: ${theme}`,
    theme,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    passTrackId: TRACK_IDS[(n - 1) % TRACK_IDS.length] as string,
    generated: true,
  };
}

/**
 * The live season at an instant. Before the first season starts, the first
 * season is reported (pre-launch builds still show its pass).
 *
 * @param at - Instant to resolve.
 * @returns The season whose `[startsAt, endsAt)` contains `at`.
 * @example
 * seasonAt(new Date('2026-10-02T00:00:00Z')).id; // 's1'
 */
export function seasonAt(at: Date): Season {
  const t = at.getTime();
  let n = 1;
  // Bounded walk: four seasons a year, so even far-future clocks finish quickly.
  for (;;) {
    const s = seasonByNumber(n);
    if (t < Date.parse(s.endsAt)) return s;
    n++;
  }
}

/**
 * The season after `s`.
 *
 * @param s - A season.
 */
export function nextSeason(s: Pick<Season, 'number'>): Season {
  return seasonByNumber(s.number + 1);
}

/**
 * A season by id (`s<number>`).
 *
 * @param id - Season id.
 * @returns The season, or undefined for a malformed id.
 */
export function seasonById(id: string): Season | undefined {
  const m = /^s(\d+)$/.exec(id);
  return m ? seasonByNumber(Number(m[1])) : undefined;
}

/**
 * The pass track a season plays.
 *
 * @param s - A season.
 */
export function passForSeason(s: Pick<Season, 'passTrackId'>): SeasonPass {
  return PASS_TRACKS[s.passTrackId] ?? SEASON_PASS;
}

/** One unlocked tier reward that was never claimed. */
export interface UnclaimedPassReward {
  tier: number;
  track: 'free' | 'premium';
  rewards: PassReward[];
}

/**
 * Rollover rule: when a season ends, every tier reward the player had
 * unlocked but not claimed is granted automatically (free track always,
 * premium track only if premium was unlocked that season). Locked tiers are
 * not granted. Nothing is lost that was earned.
 *
 * @param pass - The ending season's pass track.
 * @param seasonXp - XP earned in that season.
 * @param claimed - Tier numbers already claimed per track.
 * @param premium - Whether the premium track was unlocked.
 * @returns Rewards to grant, lowest tier first, free before premium.
 */
export function unclaimedPassRewards(
  pass: SeasonPass,
  seasonXp: number,
  claimed: { free: readonly number[]; premium: readonly number[] },
  premium: boolean,
): UnclaimedPassReward[] {
  const reached = Math.min(PASS_TIERS, passTierForXp(seasonXp, pass).tier);
  const free = new Set(claimed.free);
  const prem = new Set(claimed.premium);
  const out: UnclaimedPassReward[] = [];
  for (const t of pass.tiers) {
    if (t.tier > reached) break;
    if (t.free.length > 0 && !free.has(t.tier)) out.push({ tier: t.tier, track: 'free', rewards: t.free });
    if (premium && t.premium.length > 0 && !prem.has(t.tier))
      out.push({ tier: t.tier, track: 'premium', rewards: t.premium });
  }
  return out;
}
