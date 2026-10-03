/**
 * Display name rules, `name#tag` parsing and the guest name generator.
 */
import { randomInt } from 'node:crypto';
import { containsProfanity } from './profanity.ts';

/** Minimum display name length. */
export const NAME_MIN = 3;
/** Maximum display name length. */
export const NAME_MAX = 16;

const NAME_RE = /^[A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$/;
const RESERVED = [
  'admin',
  'moderator',
  'mod',
  'staff',
  'official',
  'tumbleroyale',
  'support',
  'system',
  'server',
  'bot',
];

/** Outcome of validating a display name. */
export type NameCheck =
  { ok: true; name: string } | { ok: false; reason: 'length' | 'characters' | 'profanity' | 'reserved' };

/**
 * Validates a requested display name.
 *
 * Rules: 3–16 chars; ASCII letters, digits, underscore and single inner spaces;
 * no profanity (leetspeak-aware); not impersonating staff.
 *
 * @param raw - Requested name.
 * @returns The trimmed name, or the reason it was rejected.
 */
export function checkDisplayName(raw: string): NameCheck {
  const name = raw.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, reason: 'length' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'characters' };
  const squashed = name.toLowerCase().replace(/[\s_0-9]/g, '');
  if (RESERVED.some((r) => squashed === r || (r.length >= 5 && squashed.startsWith(r)))) {
    return { ok: false, reason: 'reserved' };
  }
  if (containsProfanity(name)) return { ok: false, reason: 'profanity' };
  return { ok: true, name };
}

/**
 * Parses `Name#1234`.
 *
 * @param input - Raw `name#tag` string.
 * @returns Name and tag, or null when malformed.
 */
export function parseNameTag(input: string): { name: string; tag: string } | null {
  const m = /^(.{3,16})#(\d{4})$/.exec(input.trim());
  return m ? { name: m[1]!, tag: m[2]! } : null;
}

/** Random four-digit tag, `0001`–`9999`. */
export function randomTag(): string {
  return String(randomInt(1, 10000)).padStart(4, '0');
}

const ADJ = [
  'Bouncy',
  'Wobbly',
  'Zippy',
  'Fizzy',
  'Jolly',
  'Sneaky',
  'Plucky',
  'Giddy',
  'Snappy',
  'Sunny',
  'Dizzy',
  'Peppy',
  'Squishy',
  'Bubbly',
  'Toasty',
  'Sparkly',
];
const NOUN = [
  'Gumdrop',
  'Muffin',
  'Pebble',
  'Noodle',
  'Biscuit',
  'Waffle',
  'Sprout',
  'Marble',
  'Pickle',
  'Dumpling',
  'Jellyroll',
  'Tumbler',
  'Button',
  'Taffy',
  'Sundae',
  'Pretzel',
];

/** Generates a friendly guest display name such as `ZippyNoodle`. */
export function generateGuestName(): string {
  return `${ADJ[randomInt(ADJ.length)]}${NOUN[randomInt(NOUN.length)]}`.slice(0, NAME_MAX);
}
