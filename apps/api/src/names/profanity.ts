/**
 * Profanity filter for display names, party chat and report details.
 *
 * Strategy:
 * 1. Normalise: lowercase, strip accents, map leetspeak (`0→o`, `1→i`, `$→s`…),
 *    collapse runs of the same letter ("fuuuuck" → "fuck").
 * 2. Strong terms match anywhere in the letters-only string, so separators and
 *    padding ("f.u.c.k", "xxfuckxx") do not evade them.
 * 3. Short, ambiguous terms only match whole words, so "class", "Scunthorpe" or
 *    "cocktail"-style false positives stay allowed.
 *
 * The list is original and intentionally compact; extend `STRONG`/`WORD_ONLY`
 * (or load extra terms from feature-flag payloads) as moderation learns.
 */

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  '9': 'g',
  '6': 'g',
  '2': 'z',
};

/** Matched as substrings of the separator-free normalised text. */
const STRONG = [
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'cock', 'whore', 'slut',
  'bastard', 'asshole', 'wank', 'twat', 'nigger', 'nigga', 'faggot', 'retard', 'rapist', 'nazi',
  'hitler', 'porn', 'penis', 'vagina', 'dildo', 'jizz', 'boob', 'tits', 'molest', 'killyourself',
  'chink', 'kike', 'tranny',
];

/** Matched only as whole words (after normalisation) to avoid false positives. */
const WORD_ONLY = [
  'ass', 'fag', 'hoe', 'sex', 'anal', 'cum', 'rape', 'pedo', 'kys', 'spic', 'jap', 'coon', 'gook',
  'homo', 'piss', 'crap', 'kkk',
];

/** Allow-listed words that contain a strong term by accident. */
const ALLOW = [
  'scunthorpe', 'cocktail', 'cockpit', 'cockatoo', 'peacock', 'hancock', 'dickens', 'therapist',
  'shitake', 'swank', 'titsworth',
];

/**
 * Normalises text for matching (see module docs).
 *
 * @param text - Raw user input.
 * @returns Lower-case text with accents stripped and leetspeak mapped; every
 *   other non-letter becomes a single space.
 */
export function normalizeForFilter(text: string): string {
  const lowered = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of lowered) out += LEET[ch] ?? (/[a-z]/.test(ch) ? ch : ' ');
  return out.replace(/\s+/g, ' ').trim();
}

// Elongation ("fuuuck") is defeated by collapsing letter runs. Terms that
// contain a double letter are instead compared after shrinking 3+ runs to 2:
// fully collapsed, "ass" would become "as" and "boob" would become "bob".
const collapse = (w: string): string => w.replace(/(.)\1+/g, '$1');
const shrink = (w: string): string => w.replace(/(.)\1{2,}/g, '$1$1');
const hasDouble = (w: string): boolean => collapse(w) !== w;
const STRONG_SINGLE = STRONG.filter((t) => !hasDouble(t));
const STRONG_DOUBLE = STRONG.filter(hasDouble);
const WORD_EXACT = new Set(WORD_ONLY);
const WORD_COLLAPSED = new Set(WORD_ONLY.filter((w) => !hasDouble(w)));

function stripAllowed(text: string, allow: readonly string[]): string {
  let out = text;
  for (const ok of allow) out = out.split(ok).join('_');
  return out;
}

/**
 * True when the text contains a blocked term.
 *
 * @param text - Raw user input.
 * @example
 * containsProfanity('Sh1t_Lord'); // true
 * containsProfanity('Classy Tumbler'); // false
 */
export function containsProfanity(text: string): boolean {
  const norm = normalizeForFilter(text);
  if (!norm) return false;
  for (const word of norm.split(' ')) {
    if (WORD_EXACT.has(word) || WORD_EXACT.has(shrink(word)) || WORD_COLLAPSED.has(collapse(word))) return true;
  }
  const joined = norm.replace(/ /g, '');
  const shrunk = stripAllowed(shrink(joined), ALLOW);
  const collapsed = stripAllowed(collapse(joined), ALLOW.map(collapse));
  return STRONG_DOUBLE.some((t) => shrunk.includes(t)) || STRONG_SINGLE.some((t) => collapsed.includes(t));
}

/**
 * Masks blocked words for chat ("what the ****").
 *
 * @param text - Raw message.
 * @returns The message with offending whitespace-separated tokens replaced by asterisks.
 */
export function maskProfanity(text: string): string {
  return text
    .split(/(\s+)/)
    .map((tok) => (tok.trim() && containsProfanity(tok) ? '*'.repeat(tok.length) : tok))
    .join('');
}
