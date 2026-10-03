/**
 * Announcer script: original, short, readable lines with variants. `{name}`,
 * `{n}`, `{team}` and `{count}` are filled at speak time. Keep lines punchy —
 * they double as captions.
 */

/** Line ids the game can ask for. */
export type AnnouncerLineId =
  | 'welcome'
  | 'showStart'
  | 'roundNumber'
  | 'roundName'
  | 'finalRound'
  | 'type.race'
  | 'type.survival'
  | 'type.team'
  | 'type.hunt'
  | 'type.logic'
  | 'type.final'
  | 'countdown.3'
  | 'countdown.2'
  | 'countdown.1'
  | 'countdown.go'
  | 'qualified'
  | 'eliminated'
  | 'halfThrough'
  | 'lastSpots'
  | 'thirtySeconds'
  | 'tenSeconds'
  | 'overtime'
  | 'roundOver'
  | 'teamWins'
  | 'winner'
  | 'youWin'
  | 'playersRemaining'
  | 'lobbyFilling'
  | 'levelUp';

/** Line variants. */
export const ANNOUNCER_LINES: Readonly<Record<AnnouncerLineId, readonly string[]>> = {
  welcome: ['Welcome to Tumble Royale!', 'Hello, Tumblers! Welcome to the show!'],
  showStart: ["It's showtime! Forty Tumblers, one Crown!", "Lights, cameras, tumble! Let's go!"],
  roundNumber: ['Round {n}!', 'Here comes round {n}!'],
  roundName: ['{name}!', 'Next up: {name}!'],
  finalRound: ['Final round! The Crown is up for grabs!', "It's the final round! Somebody's leaving with a Crown!"],
  'type.race': ['Race to the finish!', 'First to the finish line, go go go!'],
  'type.survival': ["Don't fall. Seriously. Just don't.", 'Stay on your feet and stay in the game!'],
  'type.team': ['Team up! Teamwork makes the dream work!', 'Stick with your team!'],
  'type.hunt': ['Grab it, hold it, keep it!', 'Snatch it and hang on tight!'],
  'type.logic': ['Use your noggin!', 'Think fast, tumble faster!'],
  'type.final': ['One Crown. One winner. No pressure!', 'Winner takes the Crown!'],
  'countdown.3': ['Three…'],
  'countdown.2': ['Two…'],
  'countdown.1': ['One…'],
  'countdown.go': ['GO!', 'Tumble!'],
  qualified: ['Qualified!', "You're through!", 'Made it!'],
  eliminated: ['Eliminated!', 'Oof! Eliminated!', 'So close! Eliminated!'],
  halfThrough: ['Half the field is through!', 'Halfway full, hurry up!'],
  lastSpots: ['Only a few spots left!', 'Last spots! Move those little legs!'],
  thirtySeconds: ['Thirty seconds!', 'Thirty seconds left!'],
  tenSeconds: ['Ten seconds!'],
  overtime: ['Overtime!', "We're going to overtime!"],
  roundOver: ['Round over!', "And that's the round!"],
  teamWins: ['{team} team wins!', 'Victory for the {team} team!'],
  winner: ['We have a winner!', 'And the Crown goes to… {name}!'],
  youWin: ["You won the Crown! You're a legend!", 'Crowned! Take a bow, champ!'],
  playersRemaining: ['{count} Tumblers remain!', '{count} left in the show!'],
  lobbyFilling: ['Tumblers incoming!', 'The lobby is filling up!'],
  levelUp: ['Level up!', 'Ooh, shiny! Level up!'],
};

/** Every line id. */
export const ANNOUNCER_LINE_IDS: readonly AnnouncerLineId[] = Object.keys(ANNOUNCER_LINES) as AnnouncerLineId[];

/** Values substituted into line templates. */
export type LineVars = Readonly<Record<string, string | number>>;

/**
 * Fills `{placeholders}`; unknown placeholders are removed so a missing name never gets read out as "brace name".
 *
 * @param template - Line template.
 * @param vars - Substitutions.
 * @returns The final text.
 * @example fillLine('Round {n}!', { n: 2 }) // 'Round 2!'
 */
export function fillLine(template: string, vars: LineVars = {}): string {
  return template
    .replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] !== undefined ? String(vars[k]) : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Rough spoken duration, used for caption timing and the blip fallback.
 *
 * @param text - Line text.
 * @param rate - Speech rate multiplier.
 * @returns Milliseconds.
 */
export function estimateSpeechMs(text: string, rate = 1): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const pauses = (text.match(/[.,!?…]/g) ?? []).length;
  return Math.max(900, Math.round(((words * 330 + pauses * 120) / rate) + 400));
}

/**
 * Approximate syllable count for the speech fallback (vowel groups).
 *
 * @param word - One word.
 * @returns ≥ 1.
 */
export function countSyllables(word: string): number {
  const groups = word.toLowerCase().replace(/[^a-z]/g, '').match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}
