/**
 * Profanity filter for display names, in-show and party chat, and report
 * details. Shared so the API, the game server and the client agree on what
 * gets masked.
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
  'fuck',
  'fuk',
  'fck',
  'shit',
  'bitch',
  'cunt',
  'dick',
  'pussy',
  'cock',
  'whore',
  'slut',
  'bastard',
  'asshole',
  'wank',
  'twat',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'rapist',
  'nazi',
  'hitler',
  'porn',
  'penis',
  'vagina',
  'dildo',
  'jizz',
  'boob',
  'tits',
  'molest',
  'killyourself',
  'chink',
  'kike',
  'tranny',
];

/** Matched only as whole words (after normalisation) to avoid false positives. */
const WORD_ONLY = [
  'ass',
  'fag',
  'hoe',
  'sex',
  'anal',
  'cum',
  'rape',
  'pedo',
  'kys',
  'spic',
  'jap',
  'coon',
  'gook',
  'homo',
  'piss',
  'crap',
  'kkk',
];

/** Allow-listed words that contain a strong term by accident. */
const ALLOW = [
  'scunthorpe',
  'cocktail',
  'cockpit',
  'cockatoo',
  'peacock',
  'hancock',
  'dickens',
  'therapist',
  'shitake',
  'swank',
  'titsworth',
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

function stripAllowed(text: string, allow: readonly string[]): string {
  let out = text;
  for (const ok of allow) out = out.split(ok).join('_');
  return out;
}

type Matcher = (text: string) => boolean;

function matcher(strong: readonly string[], wordOnly: readonly string[]): Matcher {
  const strongSingle = strong.filter((t) => !hasDouble(t));
  const strongDouble = strong.filter(hasDouble);
  const wordExact = new Set(wordOnly);
  const wordCollapsed = new Set(wordOnly.filter((w) => !hasDouble(w)));
  const allowCollapsed = ALLOW.map(collapse);
  return (text) => {
    const norm = normalizeForFilter(text);
    if (!norm) return false;
    for (const word of norm.split(' ')) {
      if (wordExact.has(word) || wordExact.has(shrink(word)) || wordCollapsed.has(collapse(word)))
        return true;
    }
    const joined = norm.replace(/ /g, '');
    const shrunk = stripAllowed(shrink(joined), ALLOW);
    const collapsed = stripAllowed(collapse(joined), allowCollapsed);
    return strongDouble.some((t) => shrunk.includes(t)) || strongSingle.some((t) => collapsed.includes(t));
  };
}

/**
 * Slurs and self-harm incitement. Chat masks these even for players who turned
 * the chat filter off: the toggle is for swearing, not for abuse.
 */
const SEVERE_STRONG = ['nigger', 'nigga', 'faggot', 'killyourself', 'chink', 'kike', 'tranny', 'retard'];
const SEVERE_WORD_ONLY = ['fag', 'kys', 'spic', 'coon', 'gook'];

/**
 * True when the text contains a blocked term.
 *
 * @param text - Raw user input.
 * @example
 * containsProfanity('Sh1t_Lord'); // true
 * containsProfanity('Classy Tumbler'); // false
 */
export const containsProfanity: Matcher = matcher(STRONG, WORD_ONLY);

/**
 * True when the text contains a slur or self-harm incitement (a subset of
 * {@link containsProfanity}).
 *
 * @param text - Raw user input.
 */
export const containsAbuse: Matcher = matcher(SEVERE_STRONG, SEVERE_WORD_ONLY);

function maskWith(text: string, test: Matcher): string {
  const parts = text.split(/(\s+)/);
  const out = parts.map((tok) => (tok.trim() && test(tok) ? '*'.repeat(tok.length) : tok));
  // Spaced-out letters ("f u c k") pass token by token; test each run of
  // one-character tokens as a single word. Whole sentences are deliberately not
  // joined: "this hit" would read as a match.
  let i = 0;
  while (i < parts.length) {
    if (!isLetterToken(parts[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 2 < parts.length && isLetterToken(parts[j + 2]!)) j += 2;
    if (j > i) {
      const run = parts.filter((_, k) => k >= i && k <= j && (k - i) % 2 === 0).join('');
      if (test(run)) for (let k = i; k <= j; k += 2) out[k] = '*'.repeat(parts[k]!.length);
    }
    i = j + 1;
  }
  return out.join('');
}

const isLetterToken = (tok: string): boolean => tok.length === 1 && /\S/.test(tok);

/**
 * Masks blocked words for chat ("what the ****").
 *
 * @param text - Raw message.
 * @returns The message with offending whitespace-separated tokens (and spaced-out
 *   single letters spelling a blocked word) replaced by asterisks.
 */
export function maskProfanity(text: string): string {
  return maskWith(text, containsProfanity);
}

/**
 * Masks only slurs and self-harm incitement, leaving ordinary swearing.
 *
 * @param text - Raw message.
 */
export function maskAbuse(text: string): string {
  return maskWith(text, containsAbuse);
}
