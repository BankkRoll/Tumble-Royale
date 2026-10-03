import { describe, expect, it } from 'vitest';
import { ANNOUNCER_LINES, countSyllables, estimateSpeechMs, fillLine } from '../src/announcer/lines.ts';
import { CUE_ALIASES, MUSIC_CUE_NAMES, OBSTACLE_CUES, OBSTACLE_LOOPS, UI_CUE_NAMES, listCueNames, resolveCue, soundForObstacleCue } from '../src/game/cues.ts';
import { FOOTSTEP_SOUNDS } from '../src/game/footsteps.ts';
import { RARITIES, SFX_DEFS, SFX_NAMES } from '../src/sfx/library/index.ts';

const BRIEF_UI_CUES = [
  'ui.click',
  'ui.hover',
  'ui.confirm',
  'ui.back',
  'ui.whoosh',
  'ui.stamp',
  'ui.reward',
  'ui.levelUp',
  'ui.rarity.common',
  'ui.rarity.uncommon',
  'ui.rarity.rare',
  'ui.rarity.epic',
  'ui.rarity.legendary',
  'ui.rarity.mythic',
  'ui.countdown.tick',
  'ui.countdown.go',
  'ui.error',
];

describe('sound bank', () => {
  it('has at least 60 named sounds', () => {
    expect(SFX_NAMES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(SFX_NAMES)('%s is well-formed', (name) => {
    const d = SFX_DEFS[name]!;
    expect(d.duration).toBeGreaterThan(0);
    expect(d.duration).toBeLessThanOrEqual(5);
    expect(d.render).toBeTypeOf('function');
    expect(d.desc && d.desc.length > 3).toBe(true);
    if (d.bus === 'ui') expect(name.startsWith('ui.') || name.startsWith('countdown.')).toBe(true);
  });

  it('covers the brief: surfaces, movement, obstacles, show, crowd', () => {
    const required = [
      'step.normal', 'step.ice', 'step.slime', 'step.metal', 'step.sticky', 'step.bouncy',
      'jump', 'land.soft', 'land.hard', 'dive', 'slide.loop', 'grab', 'stun', 'stun.birds',
      'bounce.pad', 'spinwheel.loop', 'hammer.whoosh', 'punch.thwack', 'conveyor.loop', 'tile.crack', 'tile.fall',
      'slime.loop', 'splash', 'fan.loop', 'cannon.thump', 'ball.bonk', 'laser.loop', 'popup.pop', 'teleport.zap',
      'checkpoint', 'finish.fanfare', 'qualified.jingle', 'eliminated.trombone', 'confetti.pop',
      'crowd.cheer', 'crowd.aww', 'crowd.gasp', 'crowd.laugh', 'crown.shine', 'egg.pickup', 'ball.kick',
      'team.horn', 'countdown.tick', 'countdown.go', 'round.whistle',
    ];
    for (const r of required) expect(SFX_DEFS[r], r).toBeDefined();
    for (const s of Object.values(FOOTSTEP_SOUNDS)) expect(SFX_DEFS[s]).toBeDefined();
  });

  it('loops are flagged as loops', () => {
    for (const n of SFX_NAMES) if (n.endsWith('.loop')) expect(SFX_DEFS[n]!.loop).toBe(true);
    for (const s of Object.values(OBSTACLE_LOOPS)) expect(SFX_DEFS[s]?.loop).toBe(true);
  });
});

describe('cue registry', () => {
  it('lists every brief UI cue', () => {
    for (const c of BRIEF_UI_CUES) expect(UI_CUE_NAMES as readonly string[]).toContain(c);
    for (const r of RARITIES) expect(UI_CUE_NAMES as readonly string[]).toContain(`ui.rarity.${r}`);
  });

  it.each([...UI_CUE_NAMES])('%s resolves to a bespoke sound (no archetype)', (name) => {
    const r = resolveCue(name)!;
    expect(r.via === 'exact' || r.via === 'alias').toBe(true);
    expect(r.action.kind).toBe('sfx');
    if (r.action.kind === 'sfx') expect(SFX_DEFS[r.action.sound]).toBeDefined();
  });

  it.each([...MUSIC_CUE_NAMES])('%s resolves to a music action', (name) => {
    const r = resolveCue(name)!;
    expect(r.via).toBe('exact');
    expect(['music', 'musicStop', 'stinger']).toContain(r.action.kind);
  });

  it('resolves music.<track>, stinger.<id> and announcer.<line>', () => {
    expect(resolveCue('music.candy')!.action).toEqual({ kind: 'music', track: 'candy' });
    expect(resolveCue('music.mus_final_crownfever')!.action).toEqual({ kind: 'music', track: 'final' });
    expect(resolveCue('stinger.qualified')!.action).toEqual({ kind: 'stinger', stinger: 'qualified' });
    expect(resolveCue('stinger.go')!.action).toEqual({ kind: 'stinger', stinger: 'roundStart' });
    expect(resolveCue('announcer.overtime')!.action).toEqual({ kind: 'announce', line: 'overtime' });
  });

  it('accepts AUDIO.md snake_case ids', () => {
    expect(resolveCue('sfx_land_soft')!.action).toEqual({ kind: 'sfx', sound: 'land.soft' });
    expect(resolveCue('crowd_cheer')!.action).toEqual({ kind: 'sfx', sound: 'crowd.cheer' });
    expect(resolveCue('ui_stamp_qualified')!.action).toEqual({ kind: 'sfx', sound: 'ui.stamp.qualified' });
  });

  it('falls back to the parent cue, then to an archetype', () => {
    expect(resolveCue('ui.stamp.somethingNew')).toEqual({ action: { kind: 'sfx', sound: 'ui.stamp' }, via: 'parent' });
    expect(resolveCue('sfx_cannon_telegraph_new')).toEqual({ action: { kind: 'sfx', sound: 'alarm.blip' }, via: 'parent' });
    const warn = resolveCue('sfx_wobbly_warning_thing')!;
    expect(warn.via).toBe('archetype');
    expect(warn.action).toEqual({ kind: 'sfx', sound: 'alarm.blip' });
    const unknown = resolveCue('zzz.qqq')!;
    expect(unknown.via).toBe('archetype');
    expect(unknown.action.kind).toBe('sfx');
  });

  it('every alias and obstacle cue targets a real sound', () => {
    for (const [k, v] of Object.entries(CUE_ALIASES)) expect(SFX_DEFS[v], k).toBeDefined();
    for (const [k, v] of Object.entries(OBSTACLE_CUES)) expect(SFX_DEFS[v], k).toBeDefined();
  });

  it('maps obstacle cues with or without a namespace', () => {
    expect(soundForObstacleCue('cannon.fire')).toBe('cannon.thump');
    expect(soundForObstacleCue('fire', 'cannon')).toBe('cannon.thump');
    expect(soundForObstacleCue('splash')).toBe('splash');
    expect(SFX_DEFS[soundForObstacleCue('mystery.boom')]).toBeDefined();
  });

  it('listCueNames includes the UI contract and every sound', () => {
    const all = listCueNames();
    for (const c of UI_CUE_NAMES) expect(all).toContain(c);
    for (const s of SFX_NAMES) expect(all).toContain(s);
  });
});

describe('announcer lines', () => {
  it('every caption fits the 60-character caption rule', () => {
    for (const variants of Object.values(ANNOUNCER_LINES)) {
      expect(variants.length).toBeGreaterThan(0);
      for (const v of variants) expect(fillLine(v, { n: 3, name: 'Gumdrop Gauntlet', team: 'Pink', count: 26 }).length).toBeLessThanOrEqual(60);
    }
  });

  it('fills placeholders and drops unknown ones', () => {
    expect(fillLine('Round {n}!', { n: 2 })).toBe('Round 2!');
    expect(fillLine('And the Crown goes to… {name}!')).toBe('And the Crown goes to… !');
    expect(fillLine('{team} team wins!', { team: 'Mint' })).toBe('Mint team wins!');
  });

  it('estimates caption duration and syllables', () => {
    expect(estimateSpeechMs('GO!')).toBeGreaterThanOrEqual(900);
    expect(estimateSpeechMs('Half the field is through!')).toBeGreaterThan(estimateSpeechMs('GO!'));
    expect(countSyllables('Tumbler')).toBe(2);
    expect(countSyllables('GO')).toBe(1);
    expect(countSyllables('—')).toBe(1);
  });
});
