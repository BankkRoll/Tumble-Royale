/**
 * Show-level sounds: countdown, GO, whistle, finish fanfare, qualified jingle,
 * the (original) sad-brass elimination, confetti, crown shine, team horn and
 * the crowd (cheer, aww, gasp, laugh) built from formant "voices".
 */

import { VoicePriority } from '../../core/voicePool.ts';
import { INSTRUMENTS, phrase, riser, snareRoll } from '../../synth/instruments.ts';
import { filter, gain, noise, panTo, reverb, softClip, sparkle, tone, vocal } from '../../synth/toolkit.ts';
import type { SynthContext, Vowel } from '../../synth/toolkit.ts';
import type { SfxDefs } from '../types.ts';

const P = VoicePriority;

/** Same rng/ctx, different destination. */
function into(s: SynthContext, out: AudioNode): SynthContext {
  return { ctx: s.ctx, out, rng: s.rng };
}

/** Synth context that feeds a reverb send into `s.out`. */
function wet(s: SynthContext, seconds: number, amount: number): SynthContext {
  return into(s, reverb(s, seconds, amount).input);
}

/** A crowd voice panned somewhere across the stereo field. */
function crowdVoice(s: SynthContext, spread: number): SynthContext {
  return into(s, panTo(s.ctx, s.rng.range(-spread, spread), s.out));
}

/** Applause: lots of tiny bandpassed noise claps. */
function applause(s: SynthContext, t: number, dur: number, density: number, level: number): void {
  const n = Math.floor(dur * density);
  for (let i = 0; i < n; i++) {
    const at = t + s.rng.range(0, dur);
    const fade = 1 - Math.max(0, (at - t) / dur - 0.6) / 0.4;
    noise(crowdVoice(s, 0.9), { t: at, dur: s.rng.range(0.008, 0.02), gain: level * s.rng.range(0.4, 1) * fade, filter: { type: 'bandpass', freq: s.rng.range(1200, 3200), q: 1.5 } });
  }
}

const CHEER_VOWELS: readonly Vowel[] = ['a', 'e', 'o', 'aw'];

/** Show-level sound definitions. */
export const SHOW_SFX: SfxDefs = {
  'countdown.tick': {
    desc: 'Countdown woodblock tick',
    bus: 'ui',
    duration: 0.15,
    pitchVar: 0,
    volVar: 0,
    eager: true,
    render: (s) => {
      tone(s, { freq: 1250, freqEnd: 1180, t: 0, dur: 0.06, gain: 0.5, attack: 0.001 });
      tone(s, { freq: 2500, t: 0, dur: 0.02, gain: 0.12, attack: 0.001 });
      noise(s, { t: 0, dur: 0.01, gain: 0.2, filter: { type: 'bandpass', freq: 2500, q: 4 } });
    },
  },
  'countdown.go': {
    desc: 'GO! brass stab + crash',
    bus: 'ui',
    duration: 1.3,
    stereo: true,
    pitchVar: 0,
    volVar: 0,
    eager: true,
    render: (s) => {
      const w = wet(s, 1.2, 0.25);
      INSTRUMENTS.kick(s, 0, 0, 0, 1);
      for (const m of [60, 64, 67, 72, 76]) INSTRUMENTS.brass(w, 0, m, 0.35, 1);
      INSTRUMENTS.crash(w, 0, 0, 0, 0.9);
      noise(s, { color: 'pink', t: 0, dur: 0.4, gain: 0.25, attack: 0.01, filter: { type: 'bandpass', freq: 800, freqEnd: 5000, q: 1.5 } });
      sparkle(w, 0.05, 0.4, 8, 2500, 6000, 0.05);
    },
  },
  'round.whistle': {
    desc: 'Referee pea-whistle: short-looong',
    duration: 0.95,
    priority: P.Critical,
    pitchVar: 0.3,
    volVar: 0.05,
    render: (s) => {
      const blast = (t: number, dur: number): void => {
        tone(s, { freq: 2900, t, dur, gain: 0.2, env: { a: 0.01, d: 0.05, s: 0.85, r: 0.05 }, tremolo: { rate: 32, depth: 0.6 }, vibrato: { rate: 32, depth: 80 } });
        noise(s, { t, dur, gain: 0.04, env: { a: 0.01, d: 0.05, s: 0.8, r: 0.05 }, filter: { type: 'bandpass', freq: 2900, q: 6 } });
      };
      blast(0, 0.14);
      blast(0.22, 0.6);
    },
  },
  'finish.fanfare': {
    desc: 'Crossing the finish: ta-ta-TAAA!',
    duration: 1.7,
    stereo: true,
    priority: P.Critical,
    pitchVar: 0,
    volVar: 0.05,
    gain: 0.8,
    render: (s) => {
      const w = wet(s, 1.6, 0.3);
      phrase(w, 'brass', 0, [
        [0, 67, 0.1, 0.8],
        [0.12, 72, 0.1, 0.85],
        [0.24, 76, 0.1, 0.9],
        [0.36, 79, 0.75, 1],
      ]);
      for (const m of [60, 64, 67]) INSTRUMENTS.brass(w, 0.36, m, 0.75, 0.7);
      INSTRUMENTS.crash(w, 0.36, 0, 0, 0.8);
      INSTRUMENTS.kick(s, 0.36, 0, 0, 0.9);
      phrase(w, 'glock', 0.36, [
        [0, 84, 0.2, 0.6],
        [0.08, 88, 0.2, 0.6],
        [0.16, 91, 0.2, 0.6],
        [0.24, 96, 0.4, 0.7],
      ]);
    },
  },
  'qualified.jingle': {
    desc: 'Happy marimba + glock "you made it" run',
    duration: 1.5,
    stereo: true,
    priority: P.Critical,
    pitchVar: 0,
    volVar: 0.05,
    render: (s) => {
      const w = wet(s, 1.4, 0.3);
      const notes: Array<readonly [number, number, number, number]> = [72, 76, 79, 84, 88].map((m, i) => [i * 0.075, m, 0.2, 0.9] as const);
      phrase(w, 'marimba', 0, notes);
      phrase(w, 'glock', 0, notes.map(([t, m, d, v]) => [t, m + 12, d, v * 0.6] as const));
      for (const m of [72, 76, 79, 84]) INSTRUMENTS.kalimba(w, 0.4, m, 0.5, 0.7);
      sparkle(w, 0.4, 0.6, 10, 3000, 7000, 0.04);
    },
  },
  'eliminated.trombone': {
    desc: 'Original sad brass: bwah… bwah… bwoooOOOooo (deflate) …plop',
    duration: 2,
    priority: P.Critical,
    pitchVar: 0,
    volVar: 0,
    gain: 0.85,
    render: (s) => {
      const { ctx } = s;
      // A muted-trombone voice: saw + mild drive into a moving "wah" bandpass (the plunger mute).
      const voice = (t: number, f0: number, f1: number, dur: number, wobble: number): void => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f0 * 0.97, t);
        o.frequency.linearRampToValueAtTime(f0, t + 0.04);
        o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        const lfo = ctx.createOscillator();
        lfo.frequency.setValueAtTime(5, t);
        lfo.frequency.linearRampToValueAtTime(3, t + dur);
        const lfoG = gain(ctx, 0);
        lfoG.gain.setValueAtTime(0, t);
        lfoG.gain.linearRampToValueAtTime(f0 * wobble, t + dur);
        lfo.connect(lfoG).connect(o.frequency);
        const wah = filter(ctx, 'bandpass', 500, 2.2);
        wah.frequency.setValueAtTime(450, t);
        wah.frequency.linearRampToValueAtTime(1300, t + 0.1);
        wah.frequency.exponentialRampToValueAtTime(380, t + dur);
        const lp = filter(ctx, 'lowpass', 2200, 0.7);
        const g = gain(ctx, 0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.6, t + 0.03);
        g.gain.setValueAtTime(0.55, t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(softClip(ctx, 1.8)).connect(wah).connect(lp).connect(g).connect(s.out);
        o.start(t);
        lfo.start(t);
        o.stop(t + dur + 0.05);
        lfo.stop(t + dur + 0.05);
      };
      voice(0, 220, 214, 0.24, 0.005);
      voice(0.28, 185, 180, 0.24, 0.005);
      voice(0.56, 196, 98, 1.05, 0.06);
      tone(s, { freq: 320, freqEnd: 120, t: 1.68, dur: 0.12, gain: 0.35 });
      noise(s, { color: 'pink', t: 1.68, dur: 0.06, gain: 0.2, filter: { type: 'lowpass', freq: 900 } });
    },
  },
  'confetti.pop': {
    desc: 'Party popper + confetti crackle',
    duration: 0.8,
    stereo: true,
    priority: P.Important,
    pitchVar: 1.5,
    render: (s) => {
      tone(s, { freq: 620, freqEnd: 150, t: 0, dur: 0.05, gain: 0.45 });
      noise(s, { t: 0, dur: 0.025, gain: 0.6, filter: { type: 'bandpass', freq: 2500, q: 1 } });
      for (let i = 0; i < 14; i++) noise(crowdVoice(s, 0.8), { t: s.rng.range(0.04, 0.55), dur: 0.006, gain: s.rng.range(0.08, 0.2), filter: { type: 'highpass', freq: 4000 } });
      sparkle(crowdVoice(s, 0.6), 0.05, 0.5, 7, 3000, 7000, 0.04);
    },
  },
  'crown.shine': {
    desc: 'Crown glint / sparkle shimmer',
    duration: 1.4,
    stereo: true,
    priority: P.Important,
    render: (s) => {
      const w = wet(s, 1.5, 0.45);
      sparkle(w, 0, 0.9, 18, 2500, 7500, 0.06);
      tone(w, { freq: 2093, t: 0, dur: 0.9, gain: 0.05, env: { a: 0.1, d: 0.2, s: 0.6, r: 0.4 }, tremolo: { rate: 9, depth: 0.6 } });
      tone(w, { freq: 3136, t: 0.1, dur: 0.8, gain: 0.04, env: { a: 0.1, d: 0.2, s: 0.6, r: 0.4 }, tremolo: { rate: 11, depth: 0.6 } });
    },
  },
  'team.horn': {
    desc: 'Team score air-horn honk',
    duration: 1.1,
    priority: P.Important,
    pitchVar: 0.5,
    render: (s) => {
      const bus = gain(s.ctx, 1);
      bus.connect(softClip(s.ctx, 2)).connect(s.out);
      const b = into(s, bus);
      for (const [f, det] of [
        [220, 0],
        [222.5, 0],
        [277, 5],
      ] as const) {
        const lp = filter(s.ctx, 'lowpass', 1800, 2);
        lp.connect(bus);
        tone(into(b, lp), { type: 'sawtooth', freq: f * 0.98, freqEnd: f, sweepTime: 0.05, detune: det, t: 0, dur: 0.75, gain: 0.12, env: { a: 0.02, d: 0.1, s: 0.8, r: 0.15 } });
      }
    },
  },
  'crowd.cheer': {
    desc: 'Crowd cheer + applause + whistles',
    duration: 2.6,
    stereo: true,
    priority: P.Important,
    pitchVar: 0.8,
    gain: 0.8,
    cooldownMs: 400,
    render: (s) => {
      for (let i = 0; i < 16; i++) {
        const f0 = s.rng.range(180, 400);
        vocal(crowdVoice(s, 0.9), {
          t: s.rng.range(0, 0.3),
          dur: s.rng.range(0.8, 1.9),
          f0,
          f0End: f0 * s.rng.range(1, 1.3),
          vowel: s.rng.pick(CHEER_VOWELS),
          gain: 0.045,
          attack: 0.12,
          release: 0.4,
          vibrato: 0.03,
          formantShift: s.rng.range(0.9, 1.3),
        });
      }
      applause(s, 0.1, 2.3, 70, 0.22);
      for (let i = 0; i < 2; i++) {
        const t = s.rng.range(0.2, 0.9);
        tone(crowdVoice(s, 0.8), { freq: 1900, freqEnd: 2700, sweepTime: 0.25, t, dur: 0.4, gain: 0.06, env: { a: 0.02, d: 0.05, s: 0.9, r: 0.1 } });
      }
    },
  },
  'crowd.aww': {
    desc: 'Sympathetic crowd "awww"',
    duration: 1.5,
    stereo: true,
    priority: P.Important,
    pitchVar: 0.8,
    gain: 0.8,
    cooldownMs: 400,
    render: (s) => {
      for (let i = 0; i < 12; i++) {
        const f0 = s.rng.range(260, 430);
        vocal(crowdVoice(s, 0.9), { t: s.rng.range(0, 0.12), dur: s.rng.range(0.9, 1.3), f0, f0End: f0 * 0.68, vowel: 'aw', vowelEnd: 'o', gain: 0.05, attack: 0.15, release: 0.35, vibrato: 0.02, formantShift: s.rng.range(0.95, 1.25) });
      }
    },
  },
  'crowd.gasp': {
    desc: 'Crowd gasp "oh!"',
    duration: 0.7,
    stereo: true,
    priority: P.Important,
    pitchVar: 0.8,
    gain: 0.8,
    cooldownMs: 400,
    render: (s) => {
      noise(s, { color: 'pink', t: 0, dur: 0.25, gain: 0.2, attack: 0.15, filter: { type: 'bandpass', freq: 1200, freqEnd: 2200, q: 1.2 } });
      for (let i = 0; i < 10; i++) {
        const f0 = s.rng.range(250, 460);
        vocal(crowdVoice(s, 0.9), { t: 0.12 + s.rng.range(0, 0.06), dur: s.rng.range(0.25, 0.4), f0, f0End: f0 * 1.15, vowel: 'o', gain: 0.05, attack: 0.02, release: 0.12, formantShift: s.rng.range(0.95, 1.25) });
      }
    },
  },
  'crowd.laugh': {
    desc: 'Crowd giggles and guffaws',
    duration: 1.7,
    stereo: true,
    priority: P.Important,
    pitchVar: 0.8,
    gain: 0.8,
    cooldownMs: 400,
    render: (s) => {
      for (let v = 0; v < 9; v++) {
        const out = crowdVoice(s, 0.9);
        const base = s.rng.range(200, 420);
        const start = s.rng.range(0, 0.2);
        const n = s.rng.int(4, 7);
        const gap = s.rng.range(0.12, 0.17);
        for (let i = 0; i < n; i++) {
          const f0 = base * (1 - i * 0.03) * s.rng.range(0.97, 1.03);
          vocal(out, { t: start + i * gap, dur: 0.085, f0, f0End: f0 * 0.92, vowel: 'a', gain: 0.05 * (1 - i / (n + 2)), attack: 0.008, release: 0.04, formantShift: s.rng.range(1, 1.3) });
          noise(out, { t: start + i * gap, dur: 0.05, gain: 0.012, filter: { type: 'bandpass', freq: 1800, q: 1 } });
        }
      }
    },
  },
  'show.riser': {
    desc: 'Drum-roll riser into a reveal',
    duration: 2.8,
    stereo: true,
    priority: P.Important,
    render: (s) => {
      snareRoll(s, 0, 1.4, 0.2, 1);
      riser(s, 0, 1.4, 0.25);
      INSTRUMENTS.crash(s, 1.4, 0, 0, 0.6);
    },
  },
};
