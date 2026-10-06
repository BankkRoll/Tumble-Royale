/**
 * Clubs: persistent player groups. The rules every service agrees on live
 * here so the API enforces exactly what the client shows.
 *
 * Responsibilities:
 * - limits (members, name and tag lengths, cooldowns) and the join modes;
 * - roles and the permission matrix ({@link clubCan}, {@link clubOutranks});
 * - name, tag and description validation through the shared profanity filter;
 * - emblems built only from the banner motifs and the Tumbler swatch palette;
 * - the weekly club goals, their member-scaled targets and rewards.
 *
 * Pure: no DOM, no Node APIs.
 */
import { containsProfanity } from '../chat/profanity.ts';
import { sanitizeChatText } from '../chat/chat.ts';

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

/** Most members a club can hold. */
export const CLUB_MAX_MEMBERS = 50;
/** Clubs a player can belong to at once. */
export const CLUB_MAX_PER_PLAYER = 1;
/** Shortest club name. */
export const CLUB_NAME_MIN = 3;
/** Longest club name. */
export const CLUB_NAME_MAX = 24;
/** Shortest club tag. */
export const CLUB_TAG_MIN = 2;
/** Longest club tag. */
export const CLUB_TAG_MAX = 5;
/** Longest club description. */
export const CLUB_DESCRIPTION_MAX = 200;
/** An account must be this old (days) before it can found a club. */
export const CLUB_MIN_ACCOUNT_AGE_DAYS = 3;
/** A kicked player cannot rejoin, request or be invited back to that club for this long. */
export const CLUB_KICK_COOLDOWN_HOURS = 24;
/** Club chat lines replayed when the chat opens. */
export const CLUB_CHAT_HISTORY = 50;

/** How players get into a club. */
export const CLUB_JOIN_MODES = ['open', 'request', 'invite'] as const;
/** `open`: anyone joins; `request`: officers approve; `invite`: officers invite. */
export type ClubJoinMode = (typeof CLUB_JOIN_MODES)[number];

/** What a club can be reported for. */
export const CLUB_REPORT_REASONS = ['name', 'description', 'emblem', 'chat', 'other'] as const;
/** A club report reason. */
export type ClubReportReason = (typeof CLUB_REPORT_REASONS)[number];

// -----------------------------------------------------------------------------
// Roles and permissions
// -----------------------------------------------------------------------------

/** Club roles, least privileged first. */
export const CLUB_ROLES = ['member', 'officer', 'owner'] as const;
/** A club role. */
export type ClubRole = (typeof CLUB_ROLES)[number];

/** Everything a member might try to do. */
export type ClubAction =
  | 'chat'
  | 'partyUp'
  | 'invite'
  | 'acceptRequest'
  | 'kick'
  | 'edit'
  | 'setRole'
  | 'rename'
  | 'transfer'
  | 'disband';

/**
 * The least role allowed each action. Kicking also needs {@link clubOutranks}:
 * officers remove members, only the owner removes officers.
 */
export const CLUB_PERMISSIONS: Readonly<Record<ClubAction, ClubRole>> = {
  chat: 'member',
  partyUp: 'member',
  invite: 'officer',
  acceptRequest: 'officer',
  kick: 'officer',
  edit: 'officer',
  setRole: 'owner',
  rename: 'owner',
  transfer: 'owner',
  disband: 'owner',
};

/**
 * Position of a role in {@link CLUB_ROLES}; unknown strings rank below member.
 *
 * @param role - Stored role.
 * @returns 0 member, 1 officer, 2 owner, -1 unknown.
 */
export function clubRoleRank(role: string): number {
  return (CLUB_ROLES as readonly string[]).indexOf(role);
}

/**
 * Whether a role may perform an action.
 *
 * @param role - The actor's role.
 * @param action - What they want to do.
 * @returns True when the role is at least {@link CLUB_PERMISSIONS}[action].
 * @example
 * clubCan('officer', 'kick'); // true
 * clubCan('officer', 'disband'); // false
 */
export function clubCan(role: string, action: ClubAction): boolean {
  const have = clubRoleRank(role);
  return have >= 0 && have >= clubRoleRank(CLUB_PERMISSIONS[action]);
}

/**
 * Whether `actor` sits strictly above `target`, which kicking requires.
 *
 * @param actor - Acting member's role.
 * @param target - Affected member's role.
 * @example
 * clubOutranks('officer', 'member'); // true
 * clubOutranks('officer', 'officer'); // false
 */
export function clubOutranks(actor: string, target: string): boolean {
  return clubRoleRank(actor) > clubRoleRank(target);
}

// -----------------------------------------------------------------------------
// Names, tags and descriptions
// -----------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
const TAG_RE = /^[A-Z0-9]+$/;
const RESERVED = [
  'admin',
  'moderator',
  'mod',
  'mods',
  'staff',
  'official',
  'tumbleroyale',
  'support',
  'system',
];
const RESERVED_TAGS = new Set(['ADMIN', 'MOD', 'MODS', 'STAFF', 'DEV', 'DEVS', 'GM', 'SYS', 'TR']);

/** Why a name, tag or description was refused. */
export type ClubTextProblem = 'length' | 'characters' | 'profanity' | 'reserved';

/** Outcome of a club text check. */
export type ClubTextCheck = { ok: true; value: string } | { ok: false; reason: ClubTextProblem };

/**
 * Validates a club name: 3–24 ASCII letters and digits with single inner
 * spaces, no profanity (leetspeak-aware), not impersonating staff.
 *
 * @param raw - Requested name.
 * @returns The trimmed name, or why it was refused.
 * @example
 * checkClubName('  Wobble Squad '); // { ok: true, value: 'Wobble Squad' }
 */
export function checkClubName(raw: string): ClubTextCheck {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < CLUB_NAME_MIN || value.length > CLUB_NAME_MAX) return { ok: false, reason: 'length' };
  if (!NAME_RE.test(value)) return { ok: false, reason: 'characters' };
  const squashed = value.toLowerCase().replace(/[\s0-9]/g, '');
  if (RESERVED.some((r) => squashed === r || (r.length >= 5 && squashed.includes(r))))
    return { ok: false, reason: 'reserved' };
  if (containsProfanity(value) || containsProfanity(value.replace(/\s/g, '')))
    return { ok: false, reason: 'profanity' };
  return { ok: true, value };
}

/**
 * Validates a club tag: 2–5 letters or digits, stored upper case.
 *
 * @param raw - Requested tag.
 * @returns The upper-cased tag, or why it was refused.
 * @example
 * checkClubTag('wob'); // { ok: true, value: 'WOB' }
 */
export function checkClubTag(raw: string): ClubTextCheck {
  const value = raw.trim().toUpperCase();
  if (value.length < CLUB_TAG_MIN || value.length > CLUB_TAG_MAX) return { ok: false, reason: 'length' };
  if (!TAG_RE.test(value)) return { ok: false, reason: 'characters' };
  if (RESERVED_TAGS.has(value)) return { ok: false, reason: 'reserved' };
  if (containsProfanity(value)) return { ok: false, reason: 'profanity' };
  return { ok: true, value };
}

/**
 * Validates a club description: control characters stripped, whitespace
 * collapsed, at most {@link CLUB_DESCRIPTION_MAX} characters, no profanity.
 * An empty description is allowed.
 *
 * @param raw - Requested description.
 * @returns The clean description, or why it was refused.
 */
export function checkClubDescription(raw: string): ClubTextCheck {
  if ([...raw.trim()].length > CLUB_DESCRIPTION_MAX) return { ok: false, reason: 'length' };
  const value = sanitizeChatText(raw, CLUB_DESCRIPTION_MAX) ?? '';
  if (value && containsProfanity(value)) return { ok: false, reason: 'profanity' };
  return { ok: true, value };
}

/** Player-facing explanations of {@link ClubTextProblem}s, per field. */
export const CLUB_TEXT_MESSAGES: Readonly<
  Record<'name' | 'tag' | 'description', Record<ClubTextProblem, string>>
> = {
  name: {
    length: `Club names are ${CLUB_NAME_MIN}–${CLUB_NAME_MAX} characters`,
    characters: 'Use letters, numbers and single spaces',
    profanity: 'Pick a friendlier name',
    reserved: 'That name is reserved',
  },
  tag: {
    length: `Tags are ${CLUB_TAG_MIN}–${CLUB_TAG_MAX} characters`,
    characters: 'Tags use letters and numbers only',
    profanity: 'Pick a friendlier tag',
    reserved: 'That tag is reserved',
  },
  description: {
    length: `Descriptions are at most ${CLUB_DESCRIPTION_MAX} characters`,
    characters: 'That description has characters we cannot show',
    profanity: 'Keep the description friendly',
    reserved: 'That description is not allowed',
  },
};

/**
 * A club tag as shown beside a player's name.
 *
 * @param tag - Club tag, or null/undefined when not in a club.
 * @returns `[TAG]`, or an empty string.
 */
export function clubTagLabel(tag: string | null | undefined): string {
  return tag ? `[${tag}]` : '';
}

// -----------------------------------------------------------------------------
// Emblems
// -----------------------------------------------------------------------------

/** Emblem backgrounds: the profile banner motifs. */
export const CLUB_EMBLEM_MOTIFS = ['confetti', 'clouds', 'stripes', 'stars', 'candy', 'waves'] as const;
/** An emblem motif. */
export type ClubEmblemMotif = (typeof CLUB_EMBLEM_MOTIFS)[number];

/** Emblem colours: the Tumbler swatch palette, so nothing outside the art direction is possible. */
export const CLUB_EMBLEM_COLORS: readonly string[] = [
  '#ff4f9a',
  '#ff8a3d',
  '#ffd23f',
  '#9be34f',
  '#3ee6b4',
  '#3ec7e6',
  '#5aa9ff',
  '#7b6cff',
  '#b05cff',
  '#ff7ad9',
  '#ffffff',
  '#3a3550',
  '#ff6b6b',
  '#ffb3c7',
  '#c9f27a',
  '#8ff0ff',
  '#c7b8ff',
  '#a0703c',
];

/** A club emblem: a motif in two palette colours. */
export interface ClubEmblem {
  motif: ClubEmblemMotif;
  /** Background colour (one of {@link CLUB_EMBLEM_COLORS}). */
  primary: string;
  /** Motif colour (one of {@link CLUB_EMBLEM_COLORS}). */
  secondary: string;
}

/** The emblem a new club starts with, and what moderators reset to. */
export const DEFAULT_CLUB_EMBLEM: ClubEmblem = { motif: 'stars', primary: '#7b6cff', secondary: '#ffd23f' };

/**
 * Validates an emblem from the network or storage.
 *
 * @param raw - Untrusted value.
 * @returns The emblem with lower-case colours, or null when anything is off-palette.
 */
export function parseClubEmblem(raw: unknown): ClubEmblem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const color = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const c = v.toLowerCase();
    return CLUB_EMBLEM_COLORS.includes(c) ? c : null;
  };
  const motif = (CLUB_EMBLEM_MOTIFS as readonly unknown[]).includes(r.motif)
    ? (r.motif as ClubEmblemMotif)
    : null;
  const primary = color(r.primary);
  const secondary = color(r.secondary);
  return motif && primary && secondary ? { motif, primary, secondary } : null;
}

// -----------------------------------------------------------------------------
// Weekly goals
// -----------------------------------------------------------------------------

/** What a goal counts, per show of a member. */
export type ClubGoalMetric = 'shows' | 'rounds' | 'crowns';

/** One weekly club goal. */
export interface ClubGoal {
  id: 'shows' | 'qualify' | 'crowns';
  /** Title with `{n}` for the target. */
  title: string;
  metric: ClubGoalMetric;
  /** Target per member at the moment the week's goal is first counted. */
  perMember: number;
  /** Smallest target (a club of one still has to play). */
  min: number;
  /** Largest target (a full club is not asked for the impossible). */
  max: number;
  /** XP paid to each eligible member. */
  rewardXp: number;
  /** Gumballs paid to each eligible member. */
  rewardGumballs: number;
}

/**
 * The weekly goals every club gets. Rewards are XP and Gumballs only, so
 * clubs never move the Gem budget (docs/design/ECONOMY.md §6).
 */
export const CLUB_GOALS: readonly ClubGoal[] = [
  {
    id: 'shows',
    title: 'Play {n} shows',
    metric: 'shows',
    perMember: 5,
    min: 10,
    max: 150,
    rewardXp: 2000,
    rewardGumballs: 100,
  },
  {
    id: 'qualify',
    title: 'Qualify from {n} rounds',
    metric: 'rounds',
    perMember: 8,
    min: 15,
    max: 250,
    rewardXp: 2500,
    rewardGumballs: 100,
  },
  {
    id: 'crowns',
    title: 'Win {n} Crowns',
    metric: 'crowns',
    perMember: 0.4,
    min: 2,
    max: 20,
    rewardXp: 3000,
    rewardGumballs: 150,
  },
];

/**
 * A goal's target for a club of `members`, fixed when the week's goal is
 * first counted so joins and leaves mid-week never move the finish line.
 *
 * @param goal - Goal definition.
 * @param members - Member count at that moment.
 * @returns Target clamped to the goal's range.
 * @example
 * clubGoalTarget(CLUB_GOALS[0], 4); // 20
 */
export function clubGoalTarget(goal: ClubGoal, members: number): number {
  return Math.min(goal.max, Math.max(goal.min, Math.ceil(goal.perMember * Math.max(1, members))));
}

/**
 * A goal's title with its target filled in.
 *
 * @param goal - Goal definition.
 * @param target - Target number.
 */
export function clubGoalTitle(goal: Pick<ClubGoal, 'title'>, target: number): string {
  return goal.title.replace('{n}', String(target));
}
