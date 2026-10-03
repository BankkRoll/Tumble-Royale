/**
 * Tumbler movement sounds: footsteps per surface, jump, land, dive, slide,
 * grab, stun, fall-out and respawn. Rubbery and light — Tumblers are squishy toys.
 */

import { VoicePriority } from '../../core/voicePool.ts';
import { bedNoise, fm, noise, sparkle, tone, vocal } from '../../synth/toolkit.ts';
import type { SfxDefs } from '../types.ts';

const P = VoicePriority;

/** Movement sound definitions. */
export const MOVEMENT_SFX: SfxDefs = {
  'step.normal': {
    desc: 'Rubbery footstep on plastic/foam',
    duration: 0.14,
    priority: P.Footstep,
    pitchVar: 2.5,
    volVar: 0.3,
    gain: 0.55,
    eager: true,
    refDistance: 2,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.07,
        gain: 0.5,
        filter: { type: 'lowpass', freq: 1500, freqEnd: 350, q: 0.8 },
      });
      tone(s, { freq: 150, freqEnd: 70, t: 0, dur: 0.08, gain: 0.5 });
      tone(s, { type: 'triangle', freq: 430, freqEnd: 300, t: 0, dur: 0.03, gain: 0.08 });
    },
  },
  'step.ice': {
    desc: 'Squeaky slip on ice',
    duration: 0.14,
    priority: P.Footstep,
    pitchVar: 3,
    volVar: 0.3,
    gain: 0.5,
    eager: true,
    refDistance: 2,
    render: (s) => {
      tone(s, { freq: 1700, freqEnd: 2350, t: 0.005, dur: 0.05, gain: 0.1, attack: 0.008 });
      noise(s, { t: 0, dur: 0.07, gain: 0.22, filter: { type: 'highpass', freq: 3200 } });
      tone(s, { freq: 140, freqEnd: 80, t: 0, dur: 0.05, gain: 0.3 });
    },
  },
  'step.slime': {
    desc: 'Squelchy goo step',
    duration: 0.22,
    priority: P.Footstep,
    pitchVar: 2,
    volVar: 0.3,
    gain: 0.55,
    eager: true,
    refDistance: 2,
    render: (s) => {
      tone(s, { freq: 380, freqEnd: 130, t: 0, dur: 0.12, gain: 0.32 });
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.13,
        gain: 0.4,
        filter: { type: 'bandpass', freq: 900, freqEnd: 260, q: 4 },
      });
      tone(s, { freq: 600, freqEnd: 1250, t: 0.06, dur: 0.05, gain: 0.12 });
    },
  },
  'step.metal': {
    desc: 'Clanky step on conveyor/metal',
    duration: 0.2,
    priority: P.Footstep,
    pitchVar: 2,
    volVar: 0.3,
    gain: 0.45,
    eager: true,
    refDistance: 2,
    render: (s) => {
      fm(s, { t: 0, freq: 520, ratio: 1.414, index: 3, indexEnd: 0.2, dur: 0.13, gain: 0.13 });
      noise(s, { t: 0, dur: 0.03, gain: 0.2, filter: { type: 'highpass', freq: 2500 } });
      tone(s, { freq: 140, freqEnd: 75, t: 0, dur: 0.06, gain: 0.35 });
    },
  },
  'step.sticky': {
    desc: 'Sticky "schlup" step on goo pads',
    duration: 0.18,
    priority: P.Footstep,
    pitchVar: 2,
    volVar: 0.25,
    gain: 0.55,
    eager: true,
    refDistance: 2,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0.01,
        dur: 0.11,
        gain: 0.45,
        attack: 0.03,
        filter: { type: 'bandpass', freq: 300, freqEnd: 2200, q: 6 },
      });
      tone(s, { freq: 180, freqEnd: 90, t: 0, dur: 0.06, gain: 0.3 });
      noise(s, { t: 0.1, dur: 0.01, gain: 0.25, filter: { type: 'bandpass', freq: 2500, q: 3 } });
    },
  },
  'step.bouncy': {
    desc: 'Rubber "bwip" step on bouncy surfaces',
    duration: 0.14,
    priority: P.Footstep,
    pitchVar: 2.5,
    volVar: 0.25,
    gain: 0.5,
    eager: true,
    refDistance: 2,
    render: (s) => {
      tone(s, { freq: 160, freqEnd: 340, t: 0, dur: 0.09, gain: 0.4 });
      tone(s, { type: 'triangle', freq: 320, freqEnd: 680, t: 0, dur: 0.06, gain: 0.08 });
    },
  },
  'step.slide': {
    desc: 'Soft swish on slide ramps',
    duration: 0.16,
    priority: P.Footstep,
    pitchVar: 2,
    volVar: 0.3,
    gain: 0.4,
    refDistance: 2,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.12,
        gain: 0.3,
        attack: 0.02,
        filter: { type: 'bandpass', freq: 1300, q: 1.5 },
      });
    },
  },
  jump: {
    desc: 'Springy boing with a tiny "hup"',
    duration: 0.3,
    priority: P.Normal,
    pitchVar: 1.5,
    volVar: 0.15,
    gain: 0.7,
    eager: true,
    cooldownMs: 30,
    render: (s) => {
      noise(s, { color: 'pink', t: 0, dur: 0.04, gain: 0.25, filter: { type: 'lowpass', freq: 900 } });
      tone(s, {
        freq: 190,
        freqEnd: 560,
        sweepTime: 0.16,
        t: 0,
        dur: 0.22,
        gain: 0.5,
        vibrato: { rate: 18, depth: 25, delay: 0.06 },
      });
      tone(s, { type: 'triangle', freq: 380, freqEnd: 1120, sweepTime: 0.16, t: 0, dur: 0.14, gain: 0.1 });
      vocal(s, {
        t: 0.005,
        dur: 0.09,
        f0: 330,
        f0End: 430,
        vowel: 'u',
        vowelEnd: 'a',
        gain: 0.16,
        formantShift: 1.3,
        attack: 0.01,
        release: 0.04,
      });
    },
  },
  'land.soft': {
    desc: 'Soft squishy landing',
    duration: 0.2,
    priority: P.Footstep + 1,
    pitchVar: 2,
    volVar: 0.2,
    gain: 0.65,
    eager: true,
    cooldownMs: 25,
    render: (s) => {
      tone(s, { freq: 125, freqEnd: 55, t: 0, dur: 0.12, gain: 0.6 });
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.09,
        gain: 0.45,
        filter: { type: 'lowpass', freq: 950, freqEnd: 300 },
      });
      tone(s, { freq: 310, freqEnd: 200, t: 0.01, dur: 0.05, gain: 0.1 });
    },
  },
  'land.hard': {
    desc: 'Heavy thud with an "oof"',
    duration: 0.35,
    priority: P.Normal,
    pitchVar: 1.5,
    volVar: 0.15,
    gain: 0.8,
    cooldownMs: 40,
    render: (s) => {
      tone(s, { freq: 140, freqEnd: 38, t: 0, dur: 0.25, gain: 0.85 });
      noise(s, {
        color: 'brown',
        t: 0,
        dur: 0.2,
        gain: 0.7,
        filter: { type: 'lowpass', freq: 1200, freqEnd: 200 },
      });
      noise(s, { t: 0, dur: 0.03, gain: 0.25, filter: { type: 'bandpass', freq: 2500, q: 1.2 } });
      vocal(s, {
        t: 0.02,
        dur: 0.14,
        f0: 270,
        f0End: 180,
        vowel: 'o',
        vowelEnd: 'u',
        gain: 0.14,
        formantShift: 1.2,
      });
    },
  },
  dive: {
    desc: 'Whoosh with a determined "hyah!"',
    duration: 0.5,
    priority: P.Normal,
    pitchVar: 1.5,
    volVar: 0.15,
    gain: 0.7,
    cooldownMs: 30,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.2,
        gain: 0.45,
        attack: 0.08,
        filter: { type: 'bandpass', freq: 500, freqEnd: 2600, q: 2.5 },
      });
      noise(s, {
        color: 'pink',
        t: 0.14,
        dur: 0.3,
        gain: 0.3,
        attack: 0.02,
        filter: { type: 'bandpass', freq: 2600, freqEnd: 700, q: 2.5 },
      });
      vocal(s, {
        t: 0.01,
        dur: 0.13,
        f0: 310,
        f0End: 400,
        vowel: 'a',
        gain: 0.15,
        formantShift: 1.25,
        attack: 0.01,
      });
    },
  },
  'slide.loop': {
    desc: 'Belly-slide scrape (loop)',
    duration: 1.2,
    loop: true,
    priority: P.Normal,
    pitchVar: 1,
    volVar: 0.1,
    gain: 0.55,
    render: (s, len) => {
      bedNoise(s, len, 0.45, 'brown', [{ type: 'bandpass', freq: 650, q: 0.8 }], { rate: 2.5, depth: 0.35 });
      bedNoise(s, len, 0.07, 'white', [{ type: 'bandpass', freq: 2200, q: 2.5 }], { rate: 5, depth: 0.5 });
    },
  },
  grab: {
    desc: 'Cartoon "hup!" grab grunt',
    duration: 0.2,
    priority: P.Normal,
    pitchVar: 2,
    volVar: 0.15,
    gain: 0.75,
    cooldownMs: 40,
    render: (s) => {
      vocal(s, {
        t: 0,
        dur: 0.12,
        f0: 240,
        f0End: 310,
        vowel: 'u',
        vowelEnd: 'a',
        gain: 0.3,
        formantShift: 1.2,
        attack: 0.008,
      });
      noise(s, { t: 0, dur: 0.05, gain: 0.14, filter: { type: 'bandpass', freq: 1500, q: 1.5 } });
    },
  },
  'grab.release': {
    desc: 'Breaking free "pff"',
    duration: 0.18,
    priority: P.Normal - 1,
    pitchVar: 2,
    gain: 0.6,
    render: (s) => {
      vocal(s, { t: 0, dur: 0.09, f0: 300, f0End: 210, vowel: 'uh', gain: 0.12, formantShift: 1.2 });
      noise(s, { t: 0.01, dur: 0.08, gain: 0.15, filter: { type: 'highpass', freq: 1500 } });
    },
  },
  stun: {
    desc: 'Dizzy cartoon boi-oi-oing',
    duration: 0.8,
    priority: P.Important,
    pitchVar: 1.5,
    volVar: 0.1,
    gain: 0.7,
    cooldownMs: 50,
    render: (s) => {
      noise(s, { color: 'brown', t: 0, dur: 0.06, gain: 0.5, filter: { type: 'lowpass', freq: 700 } });
      tone(s, { freq: 430, freqEnd: 170, t: 0, dur: 0.7, gain: 0.42, vibrato: { rate: 14, depth: 60 } });
      fm(s, { t: 0, freq: 215, freqEnd: 150, ratio: 2.01, index: 4, indexEnd: 0.2, dur: 0.6, gain: 0.16 });
    },
  },
  'stun.birds': {
    desc: 'Tweeting birds circling a dizzy head',
    duration: 1.15,
    priority: P.Normal - 1,
    pitchVar: 1,
    gain: 0.5,
    render: (s) => {
      for (let i = 0; i < 6; i++) {
        const t = i * 0.17 + s.rng.range(0, 0.03);
        const up = i % 2 === 0;
        tone(s, {
          freq: up ? 2600 : 3500,
          freqEnd: up ? 3600 : 2700,
          sweepTime: 0.06,
          t,
          dur: 0.08,
          gain: 0.1,
          attack: 0.008,
          vibrato: { rate: 30, depth: 180 },
        });
        tone(s, { freq: 3300, freqEnd: 3900, t: t + 0.08, dur: 0.04, gain: 0.06, attack: 0.004 });
      }
    },
  },
  getUp: {
    desc: 'Little "hep" as a Tumbler gets up',
    duration: 0.15,
    priority: P.Footstep,
    gain: 0.4,
    render: (s) => {
      tone(s, { freq: 300, freqEnd: 520, t: 0, dur: 0.1, gain: 0.14 });
      vocal(s, { t: 0, dur: 0.09, f0: 300, f0End: 370, vowel: 'e', gain: 0.1, formantShift: 1.3 });
    },
  },
  fallout: {
    desc: 'Falling-off-the-map "waaaah" + whistle',
    duration: 1.05,
    priority: P.Important,
    pitchVar: 1.5,
    gain: 0.65,
    render: (s) => {
      tone(s, {
        freq: 1600,
        freqEnd: 280,
        t: 0,
        dur: 0.95,
        gain: 0.18,
        env: { a: 0.02, d: 0.2, s: 0.8, r: 0.12 },
        vibrato: { rate: 6, depth: 15 },
      });
      vocal(s, {
        t: 0.02,
        dur: 0.85,
        f0: 430,
        f0End: 190,
        vowel: 'a',
        vowelEnd: 'aw',
        gain: 0.14,
        vibrato: 0.04,
        formantShift: 1.2,
      });
    },
  },
  respawn: {
    desc: 'Magic poof + rising sparkle',
    duration: 0.6,
    priority: P.Normal,
    gain: 0.6,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.25,
        gain: 0.35,
        filter: { type: 'lowpass', freq: 3000, freqEnd: 500 },
      });
      [880, 1108, 1319, 1760].forEach((f, i) =>
        tone(s, { type: 'triangle', freq: f, t: 0.04 + i * 0.065, dur: 0.18, gain: 0.12 }),
      );
      sparkle(s, 0.2, 0.3, 5, 3000, 6000, 0.04);
    },
  },
  emote: {
    desc: 'Tiny "ta-da" for emotes',
    duration: 0.3,
    priority: P.Footstep,
    gain: 0.45,
    cooldownMs: 80,
    render: (s) => {
      tone(s, { type: 'triangle', freq: 660, t: 0, dur: 0.07, gain: 0.2 });
      tone(s, { type: 'triangle', freq: 990, t: 0.07, dur: 0.18, gain: 0.2 });
    },
  },
};
