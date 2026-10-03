/**
 * Practice Island script: what the checklist, objective card and Coach Boing
 * say at each station. Text only — the coach talks in speech bubbles, never
 * aloud. `{jump}`-style tokens become chips for the player's real bindings.
 */
import type { PracticeStationId } from '@tumble/content/rounds/practice-island';
import type { PromptPart, TutorialIconName } from '@tumble/ui/tutorial';
import type { PromptAction } from './bindings.ts';

/** Copy for one station. */
export interface StationScript {
  label: string;
  icon: TutorialIconName;
  title: string;
  /** Objective card text; `{action}` tokens become key chips. */
  objective: string;
  /** Coach's opening line, before the demo. */
  intro: string;
  /** Coach's line once he has demonstrated and is waiting. */
  turn: string;
  /** Gentle tip after a couple of misses. */
  hint: string;
  /** Coach's cheer on success. */
  cheer: string;
}

/** Copy per station, in play order. */
export const SCRIPT: Record<PracticeStationId, StationScript> = {
  move: {
    label: 'Move',
    icon: 'move',
    title: 'Follow the arrows',
    objective: 'Use {move} to run, and {camera} to look around. Weave through the candy canes!',
    intro: "Welcome to Practice Island! I'm Coach Boing. Follow me!",
    turn: 'Over here! Follow the yellow arrows.',
    hint: 'Push {move} toward the arrows; the camera follows you.',
    cheer: 'Nice moves!',
  },
  jump: {
    label: 'Jump',
    icon: 'jump',
    title: 'Jump the gaps',
    objective: 'Press {jump} to hop across the islands. Hold it for a higher jump!',
    intro: 'Gaps ahead! Watch me hop.',
    turn: 'Your turn: run up and jump!',
    hint: 'Take off right at the striped edge, and keep running forward in the air.',
    cheer: 'Boing! Lovely hops!',
  },
  dive: {
    label: 'Dive',
    icon: 'dive',
    title: 'Jump + dive',
    objective: 'This gap is too far for a jump. Press {jump}, then {dive} in mid-air to fly further!',
    intro: 'Big gap! Jump, then dive. Belly first!',
    turn: 'Jump, then dive at the top. You got this!',
    hint: 'Run up fast, press {jump} at the edge, then press {dive} right at the top of your jump.',
    cheer: 'What a dive!',
  },
  grab: {
    label: 'Grab',
    icon: 'grab',
    title: 'Grab the coach',
    objective: 'Walk up to Coach Boing and hold {grab} to grab him!',
    intro: "Grabbing time! Come and grab me. I don't bite!",
    turn: 'Get close and hold Grab!',
    hint: 'Face the coach, get really close, then hold {grab}.',
    cheer: 'Oof! Strong grip!',
  },
  climb: {
    label: 'Ledge climb',
    icon: 'climb',
    title: 'Climb the ledge',
    objective: 'Jump at the wall and hold {grab} to hang on the yellow lip, then press {jump} to climb up.',
    intro: 'Walls with a yellow lip can be climbed. Watch!',
    turn: 'Jump at the lip, hang on, then jump to climb!',
    hint: 'Run at the wall, press {jump}, and keep pushing forward: you will catch the lip. Then press {jump} again.',
    cheer: "Up you go! You're a natural!",
  },
  bounce: {
    label: 'Bounce pad',
    icon: 'bounce',
    title: 'Bounce up',
    objective: 'Run onto the bouncy pad to launch up to the high shelf. Keep steering forward in the air!',
    intro: 'See that bouncy pad? Wheee, up we go!',
    turn: 'Hop on the pad and steer forward!',
    hint: 'Run straight across the middle of the pad and keep holding forward.',
    cheer: 'Sky high!',
  },
  tiles: {
    label: 'Falling tiles',
    icon: 'tiles',
    title: 'Cross the tiles',
    objective: 'Tiles shake and drop once you step on them. Keep moving and cross to the other side!',
    intro: "These tiles wobble, then drop! Don't stop moving!",
    turn: 'Quick feet! The tiles come back if they fall.',
    hint: "Don't stand still: run straight across without stopping.",
    cheer: 'Speedy feet!',
  },
  checkpoint: {
    label: 'Checkpoint',
    icon: 'checkpoint',
    title: 'Checkpoints',
    objective: 'Run through the checkpoint gate. If you fall off after that, you pop back here!',
    intro: 'Checkpoints save your spot. Watch me fall... on purpose!',
    turn: 'Your turn: hop off the diving board!',
    hint: 'Walk to the end of the striped diving board on the right and step off.',
    cheer: 'See? Back in one piece!',
  },
  race: {
    label: 'Mini race',
    icon: 'race',
    title: 'Mini race!',
    objective: 'Head through the big arch for a mini race against some bots!',
    intro: 'Last thing: a real race! Through the arch!',
    turn: 'Through the arch! Your rivals are waiting.',
    hint: 'The race arch is straight ahead, past the checkpoint.',
    cheer: 'Race time!',
  },
};

/** The fall-demo step of the checkpoint station, once the gate is passed. */
export const FALL_DEMO = {
  title: 'Fall on purpose',
  objective: 'Checkpoint saved! Now hop off the edge (try the diving board). You will pop right back.',
  saved: 'Checkpoint saved!',
};

/** Fallback when the dive gap is cleared without diving. */
export const DIVE_ON_FLAT = {
  objective: 'Made it without diving? Show-off! Try a dive here: press {dive}.',
  coach: 'Nice leap! Now show me a dive!',
};

/** Coach lines for falls and the race. */
export const LINES = {
  oops: ['Whoops! Back to the checkpoint.', 'Splat! Try again!', 'Happens to the best of us!'],
  slow: 'Take your time. I believe in you!',
  catchUp: 'Wait for me!',
  raceIntro: 'Race the bots to the finish! Ready?',
  raceWin: 'You WON! Incredible!',
  raceFinish: 'You made it! Great race!',
  raceTimeUp: "Time's up! Great effort!",
  raceTitle: 'Mini race',
  raceObjective: 'Beat the bots to the finish line! Use everything you learned.',
} as const;

const TOKEN = /\{(\w+)\}/g;

/**
 * Turns `{action}` tokens into key chips.
 *
 * @param text - Copy with tokens.
 * @param keys - Chips per action.
 * @example
 * renderPrompt('Press {jump}!', (a) => ['Space']) // ['Press ', { keys: ['Space'] }, '!']
 */
export function renderPrompt(text: string, keys: (action: PromptAction) => readonly string[]): PromptPart[] {
  const out: PromptPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ keys: keys(m[1] as PromptAction) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Ordinal for race places ("1st", "2nd"…). */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
