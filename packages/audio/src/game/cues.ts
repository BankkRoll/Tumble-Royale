/**
 * Cue-name resolution: turns the string cues the UI, round rules and obstacles
 * emit into concrete actions (play a sound, change music, fire a stinger,
 * speak a line). Pure, so registry completeness is unit-tested.
 *
 * Resolution order for a name:
 * 1. explicit alias (SCREENS.md / AUDIO.md names that map to a differently named sound)
 * 2. exact bank sound, `music.*`, `stinger.*`, `announcer.*`
 * 3. AUDIO.md snake_case ids (`sfx_land_soft` → `land.soft`, `ui_stamp_qualified` → `ui.stamp.qualified`)
 * 4. hierarchical fallback: drop the last segment (`ui.stamp.timeUp` → `ui.stamp`)
 * 5. archetype by keyword (`*hit*` → thwack, `*warn*` → alarm…) so nothing is ever silent
 */

import { ANNOUNCER_LINES } from '../announcer/lines.ts';
import type { AnnouncerLineId } from '../announcer/lines.ts';
import { STINGERS, STINGER_ALIASES, TRACKS, TRACK_ALIASES } from '../music/tracks.ts';
import type { MusicTrackId, StingerId } from '../music/types.ts';
import { SFX_DEFS } from '../sfx/library/index.ts';
import { RARITIES } from '../sfx/library/ui.ts';

/** What a cue does. */
export type CueAction =
  | { kind: 'sfx'; sound: string }
  | { kind: 'music'; track: MusicTrackId }
  | { kind: 'musicStop' }
  | { kind: 'stinger'; stinger: StingerId }
  | { kind: 'announce'; line: AnnouncerLineId };

/** A resolved cue and how it was found. */
export interface ResolvedCue {
  action: CueAction;
  /** `exact` for direct hits, otherwise which fallback produced it. */
  via: 'exact' | 'alias' | 'normalised' | 'parent' | 'archetype';
}

/**
 * The UI cue contract (SCREENS.md + the brief). Every one of these must
 * resolve to a bespoke sound, not an archetype.
 */
export const UI_CUE_NAMES = [
  'ui.click',
  'ui.hover',
  'ui.confirm',
  'ui.back',
  'ui.whoosh',
  'ui.stamp',
  'ui.stamp.qualified',
  'ui.stamp.eliminated',
  'ui.stamp.roundOver',
  'ui.stamp.go',
  'ui.stamp.timeUp',
  'ui.stamp.final',
  'ui.stamp.victory',
  'ui.reward',
  'ui.levelUp',
  ...RARITIES.map((r) => `ui.rarity.${r}` as const),
  'ui.countdown.tick',
  'ui.countdown.go',
  'ui.error',
  'ui.tab',
  'ui.toggle',
  'ui.slider',
  'ui.toast',
  'ui.matchFound',
  'ui.purchase',
  'ui.claim',
  'ui.confetti',
  'ui.coin',
  'ui.notify',
  'ui.wall.flash',
  'ui.wall.trapdoor',
  'ui.wall.fall',
  'ui.wall.aww',
  'ui.wall.counter',
  'ui.wall.shake',
  'ui.wall.crown',
  'ui.fireworks',
  'ui.joinTick',
  'ui.typeOn',
] as const;

/** A UI cue name. */
export type UiCueName = (typeof UI_CUE_NAMES)[number];

/** `music.<x>` hooks the UI uses (SCREENS.md). */
export const MUSIC_CUE_NAMES = [
  'music.menu',
  'music.matchmaking',
  'music.preshow',
  'music.intro',
  'music.results',
  'music.final',
  'music.victory',
  'music.wall',
  'music.rewards',
  'music.none',
  'music.sting',
] as const;

/** Names whose sound has a different id. */
export const CUE_ALIASES: Readonly<Record<string, string>> = {
  'ui.countdown.tick': 'countdown.tick',
  'ui.countdown.go': 'countdown.go',
  'ui.confetti': 'confetti.pop',
  'ui.wall.aww': 'crowd.aww',
  'ui.qualified': 'qualified.jingle',
  'ui.eliminated': 'eliminated.trombone',
  'ui.crown': 'crown.shine',
  'ui.roundOver': 'round.whistle',
  'crowd.ooh': 'crowd.gasp',
  'crowd.applause': 'crowd.cheer',
};

/**
 * `obstacleCue` strings (`<ObstacleType>.<cue>`, AUDIO.md §7.3) → sounds.
 * Round-rule namespaces (`patternPanic`, `paint`, `ball`, `egg`) live here too.
 */
export const OBSTACLE_CUES: Readonly<Record<string, string>> = {
  'spinwheel.hit': 'bumper.boing',
  'pendulumHammer.apex': 'seesaw.creak',
  'pendulumHammer.swing': 'hammer.whoosh',
  'pendulumHammer.hit': 'punch.thwack',
  'sweeperArm.accel': 'whoosh.up',
  'sweeperArm.hit': 'punch.thwack',
  'sweeperArm.nearMiss': 'crowd.gasp',
  'bumperPillar.hit': 'bumper.boing',
  'bumperPillar.pulse': 'popup.pop',
  'punchWall.telegraph': 'alarm.blip',
  'punchWall.punch': 'punch.thwack',
  'punchWall.retract': 'seesaw.creak',
  'doorGauntlet.burst': 'door.break',
  'doorGauntlet.thud': 'door.bonk',
  'conveyorBelt.reverseWarn': 'alarm.blip',
  'conveyorBelt.reverse': 'whoosh.down',
  'tiltPlatform.limit': 'door.bonk',
  'seesaw.clunk': 'door.bonk',
  'fanZone.warn': 'alarm.blip',
  'fanZone.on': 'whoosh.up',
  'fanZone.off': 'whoosh.down',
  'bouncePad.launch': 'bounce.pad',
  'fallingTiles.crack': 'tile.crack',
  'fallingTiles.respawn': 'popup.pop',
  'fallingTiles.touch': 'step.bouncy',
  'fallingTiles.layerWarn': 'alarm.blip',
  'risingSlime.warn': 'alarm.blip',
  'risingSlime.surge': 'splash',
  'boulderLane.spawn': 'whoosh.up',
  'boulderLane.hit': 'cannon.thump',
  'boulderLane.despawn': 'tile.fall',
  'spinningDisc.reverse': 'whoosh.down',
  'movingPlatform.arrive': 'door.bonk',
  'slideRamp.enter': 'dive',
  'iceFloor.crackle': 'tile.crack',
  'stickyGoo.enter': 'step.sticky',
  'stickyGoo.exit': 'step.sticky',
  'popupBlocks.warn': 'alarm.blip',
  'popupBlocks.up': 'popup.pop',
  'popupBlocks.down': 'prop.drop',
  'laserSweep.charge': 'laser.charge',
  'laserSweep.zap': 'laser.zap',
  'cannon.telegraph': 'alarm.blip',
  'cannon.fire': 'cannon.thump',
  'cannon.bounce': 'ball.bonk',
  'bumperCar.hit': 'bumper.boing',
  'rollingDrum.hit': 'punch.thwack',
  'collapsingBridge.creak': 'seesaw.creak',
  'collapsingBridge.snap': 'door.break',
  'jumpRopeBeam.speedUp': 'alarm.blip',
  'jumpRopeBeam.pass': 'hammer.whoosh',
  'climbWall.grip': 'grab',
  'climbWall.pull': 'getUp',
  'startGate.open': 'whoosh.up',
  'startGate.bump': 'door.bonk',
  'voidTrigger.enter': 'fallout',
  'propSpawner.spawn': 'respawn',
  'patternPanic.revealStart': 'ui.whoosh',
  'patternPanic.symbol': 'ui.confirm',
  'patternPanic.revealEnd': 'ui.whoosh',
  'patternPanic.tick': 'countdown.tick',
  'patternPanic.timerEnd': 'round.whistle',
  'patternPanic.drop': 'tile.fall',
  'patternPanic.safe': 'checkpoint',
  'patternPanic.speedUp': 'alarm.blip',
  'patternPanic.moreSymbols': 'ui.toast',
  'paint.splat': 'splash',
  'paint.overpaint': 'step.slime',
  'ball.kick': 'ball.kick',
  'ball.bounce': 'ball.bonk',
  'ball.post': 'bumper.boing',
  'egg.golden': 'ui.reward',
  'cometField.catch': 'ui.coin',
  'cometField.golden': 'ui.reward',
};

/**
 * Pose-driven loops per obstacle type (AUDIO.md §7.3 "Pose-driven loop").
 * The client creates one emitter per instance and maps speed to `setRate`.
 */
export const OBSTACLE_LOOPS: Readonly<Record<string, string>> = {
  spinwheel: 'spinwheel.loop',
  sweeperArm: 'spinwheel.loop',
  spinningDisc: 'spinwheel.loop',
  conveyorBelt: 'conveyor.loop',
  fanZone: 'fan.loop',
  risingSlime: 'slime.loop',
  laserSweep: 'laser.loop',
  boulderLane: 'boulder.loop',
  rollingDrum: 'boulder.loop',
};

/** Keyword → sound, checked in order. Mirrors AUDIO.md §7.7 archetypes using bespoke bank sounds. */
const ARCHETYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/warn|telegraph|alarm|charge/i, 'alarm.blip'],
  [/elim|error|lost|stolen|fail/i, 'ui.error'],
  [/qualif|finish|checkpoint|rarity|level|fanfare|win/i, 'qualified.jingle'],
  [/crowd|cheer|applause/i, 'crowd.cheer'],
  [/stun|bounce|bumper|boing|spring/i, 'bumper.boing'],
  [/jump|launch|hop/i, 'jump'],
  [/whoosh|dive|swing|spawn|teleport|\.on$/i, 'whoosh.up'],
  [/\.off$|despawn/i, 'whoosh.down'],
  [/fire|burst|snap|firework|explode|boom/i, 'cannon.thump'],
  [/hit|thud|impact|punch|bonk|slam/i, 'punch.thwack'],
  [/land|step|foot/i, 'land.soft'],
  [/splash|slime|goo|paint/i, 'splash'],
  [/pickup|grab|score|coin|currency|claim/i, 'egg.pickup'],
  [/crack|break|shatter/i, 'tile.crack'],
  [/creak/i, 'seesaw.creak'],
  [/zap|laser/i, 'laser.zap'],
  [/pop/i, 'popup.pop'],
  [/tick|count/i, 'countdown.tick'],
  [/loop|hum/i, 'conveyor.loop'],
];

const hasSound = (n: string): boolean => Object.prototype.hasOwnProperty.call(SFX_DEFS, n);
const isTrack = (n: string): n is MusicTrackId => Object.prototype.hasOwnProperty.call(TRACKS, n);
const isStinger = (n: string): n is StingerId => Object.prototype.hasOwnProperty.call(STINGERS, n);
const isLine = (n: string): n is AnnouncerLineId => Object.prototype.hasOwnProperty.call(ANNOUNCER_LINES, n);

function exact(name: string): CueAction | null {
  if (hasSound(name)) return { kind: 'sfx', sound: name };
  const alias = CUE_ALIASES[name] ?? OBSTACLE_CUES[name];
  if (alias && hasSound(alias)) return { kind: 'sfx', sound: alias };
  if (name.startsWith('music.')) {
    const rest = name.slice(6);
    if (rest === 'none' || rest === 'stop') return { kind: 'musicStop' };
    if (isTrack(rest)) return { kind: 'music', track: rest };
    const t = TRACK_ALIASES[rest];
    if (t) return { kind: 'music', track: t };
    const st = STINGER_ALIASES[rest] ?? (rest.startsWith('stinger.') ? rest.slice(8) : null);
    if (st && isStinger(st)) return { kind: 'stinger', stinger: st };
  }
  if (name.startsWith('stinger.')) {
    const rest = name.slice(8);
    const st = isStinger(rest) ? rest : STINGER_ALIASES[rest];
    if (st) return { kind: 'stinger', stinger: st };
  }
  if (name.startsWith('announcer.')) {
    const rest = name.slice(10);
    if (isLine(rest)) return { kind: 'announce', line: rest };
  }
  const trackAlias = TRACK_ALIASES[name];
  if (trackAlias) return { kind: 'music', track: trackAlias };
  const stAlias = STINGER_ALIASES[name];
  if (stAlias) return { kind: 'stinger', stinger: stAlias };
  return null;
}

/** `sfx_land_soft` → `land.soft`; `ui_stamp_qualified` → `ui.stamp.qualified`. */
function normalise(name: string): string {
  return name.replace(/^sfx_/, '').replace(/_/g, '.');
}

/**
 * Resolves a cue name.
 *
 * @param name - Cue name.
 * @returns The action and how it was found, or null for an empty name.
 * @example resolveCue('ui.stamp.timeUp') // { action: { kind: 'sfx', sound: 'ui.stamp.timeUp' }, via: 'exact' }
 */
export function resolveCue(name: string): ResolvedCue | null {
  if (!name) return null;
  const direct = exact(name);
  if (direct) return { action: direct, via: CUE_ALIASES[name] || OBSTACLE_CUES[name] ? 'alias' : 'exact' };
  const norm = normalise(name);
  if (norm !== name) {
    const n = exact(norm);
    if (n) return { action: n, via: 'normalised' };
  }
  let parent = norm;
  while (parent.includes('.')) {
    parent = parent.slice(0, parent.lastIndexOf('.'));
    const p = exact(parent);
    if (p && p.kind === 'sfx') return { action: p, via: 'parent' };
  }
  for (const [re, sound] of ARCHETYPES)
    if (re.test(name)) return { action: { kind: 'sfx', sound }, via: 'archetype' };
  return {
    action: { kind: 'sfx', sound: name.startsWith('ui') ? 'ui.click' : 'popup.pop' },
    via: 'archetype',
  };
}

/**
 * Sound for an `obstacleCue` event. Accepts namespaced cues (`cannon.fire`),
 * bare bank names (`splash`) or bare cue names qualified by obstacle type.
 *
 * @param cue - The event's cue string.
 * @param obstacleType - Optional obstacle type when the cue is not namespaced.
 * @returns A bank sound name (never null — unknowns fall back to an archetype).
 */
export function soundForObstacleCue(cue: string, obstacleType?: string): string {
  const qualified = !cue.includes('.') && obstacleType ? `${obstacleType}.${cue}` : cue;
  const r = resolveCue(qualified);
  return r && r.action.kind === 'sfx' ? r.action.sound : 'popup.pop';
}

/** @returns Every cue name with a direct (non-archetype) mapping, for the lab and docs. */
export function listCueNames(): string[] {
  const names = new Set<string>([...UI_CUE_NAMES, ...MUSIC_CUE_NAMES]);
  for (const n of Object.keys(SFX_DEFS)) names.add(n);
  for (const n of Object.keys(CUE_ALIASES)) names.add(n);
  for (const t of Object.keys(TRACKS)) names.add(`music.${t}`);
  for (const st of Object.keys(STINGERS)) names.add(`stinger.${st}`);
  for (const l of Object.keys(ANNOUNCER_LINES)) names.add(`announcer.${l}`);
  return [...names].sort();
}
