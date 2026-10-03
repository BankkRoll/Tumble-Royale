/**
 * Obstacle sounds: one-shots (bounce pads, punch walls, cannons, tiles…) and
 * seamless loop beds for spatial emitters (spinwheel, conveyor, fan, laser,
 * slime, boulder). Loop LFO rates are chosen to complete whole cycles per loop
 * period so the rhythm never hiccups at the seam.
 */

import { VoicePriority } from '../../core/voicePool.ts';
import { bedNoise, bedTone, fm, gain, noise, softClip, sparkle, tone } from '../../synth/toolkit.ts';
import type { SynthContext } from '../../synth/toolkit.ts';
import type { SfxDefs } from '../types.ts';

const P = VoicePriority;

/** Routes a sub-graph through a soft clipper for extra punch. */
function punchy(s: SynthContext, drive: number): SynthContext {
  const bus = gain(s.ctx, 1);
  bus.connect(softClip(s.ctx, drive)).connect(s.out);
  return { ctx: s.ctx, out: bus, rng: s.rng };
}

/** Obstacle sound definitions. */
export const OBSTACLE_SFX: SfxDefs = {
  'bounce.pad': {
    desc: 'Bounce pad sproing',
    duration: 0.6,
    priority: P.Important,
    pitchVar: 1.5,
    gain: 0.75,
    cooldownMs: 30,
    render: (s) => {
      noise(s, { color: 'brown', t: 0, dur: 0.05, gain: 0.45, filter: { type: 'lowpass', freq: 600 } });
      tone(s, {
        freq: 110,
        freqEnd: 640,
        sweepTime: 0.12,
        t: 0,
        dur: 0.5,
        gain: 0.5,
        vibrato: { rate: 22, depth: 70, delay: 0.08 },
      });
      fm(s, { t: 0, freq: 300, ratio: 3.5, index: 3, indexEnd: 0.1, dur: 0.35, gain: 0.1 });
    },
  },
  'bumper.boing': {
    desc: 'Bumper pillar "bwong"',
    duration: 0.5,
    priority: P.Normal,
    pitchVar: 1.5,
    gain: 0.7,
    cooldownMs: 40,
    render: (s) => {
      noise(s, { color: 'brown', t: 0, dur: 0.05, gain: 0.5, filter: { type: 'lowpass', freq: 800 } });
      tone(s, {
        freq: 95,
        freqEnd: 310,
        sweepTime: 0.08,
        t: 0,
        dur: 0.42,
        gain: 0.5,
        vibrato: { rate: 18, depth: 40, delay: 0.05 },
      });
      fm(s, { t: 0, freq: 190, ratio: 1.5, index: 2, indexEnd: 0.1, dur: 0.3, gain: 0.12 });
    },
  },
  'spinwheel.loop': {
    desc: 'Spinwheel whirr (loop)',
    duration: 1.5,
    loop: true,
    priority: P.Ambient,
    pitchVar: 1,
    gain: 0.6,
    refDistance: 5,
    render: (s, len) => {
      bedTone(s, len, 0.14, 'sawtooth', 65, { lowpass: 320 });
      bedTone(s, len, 0.08, 'sine', 130, { am: { rate: 2, depth: 0.5 } });
      bedNoise(s, len, 0.35, 'pink', [{ type: 'bandpass', freq: 900, q: 1.2 }], { rate: 2, depth: 0.8 });
    },
  },
  'hammer.whoosh': {
    desc: 'Pendulum hammer / sweeper swoosh',
    duration: 0.8,
    priority: P.Normal,
    pitchVar: 1.5,
    gain: 0.7,
    cooldownMs: 120,
    refDistance: 5,
    render: (s) => {
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.36,
        gain: 0.5,
        attack: 0.25,
        filter: { type: 'bandpass', freq: 180, freqEnd: 950, q: 3 },
      });
      noise(s, {
        color: 'pink',
        t: 0.3,
        dur: 0.4,
        gain: 0.35,
        attack: 0.02,
        filter: { type: 'bandpass', freq: 950, freqEnd: 240, q: 3 },
      });
      tone(s, {
        freq: 55,
        freqEnd: 80,
        t: 0,
        dur: 0.6,
        gain: 0.22,
        env: { a: 0.25, d: 0.15, s: 0.4, r: 0.2 },
      });
    },
  },
  'punch.thwack': {
    desc: 'Punch wall THWACK',
    duration: 0.35,
    priority: P.Important,
    pitchVar: 1.5,
    gain: 0.8,
    cooldownMs: 60,
    refDistance: 5,
    render: (s) => {
      const p = punchy(s, 3);
      tone(p, { freq: 115, freqEnd: 45, t: 0, dur: 0.2, gain: 0.7 });
      noise(p, { t: 0, dur: 0.04, gain: 0.6, filter: { type: 'bandpass', freq: 1800, q: 1 } });
      noise(p, { color: 'brown', t: 0, dur: 0.15, gain: 0.5, filter: { type: 'lowpass', freq: 600 } });
      tone(p, { type: 'triangle', freq: 520, freqEnd: 410, t: 0, dur: 0.06, gain: 0.25 });
    },
  },
  'conveyor.loop': {
    desc: 'Conveyor hum + rattle (loop)',
    duration: 2,
    loop: true,
    priority: P.Ambient,
    gain: 0.5,
    refDistance: 4,
    render: (s, len) => {
      bedTone(s, len, 0.18, 'sawtooth', 55, { lowpass: 220 });
      bedTone(s, len, 0.05, 'sine', 110, { am: { rate: 4, depth: 0.3 } });
      for (let i = 0; i * 0.125 < len; i++) {
        noise(s, {
          t: i * 0.125,
          dur: 0.012,
          gain: i % 2 === 0 ? 0.14 : 0.07,
          filter: { type: 'highpass', freq: 3000 },
        });
        if (i % 4 === 0) fm(s, { t: i * 0.125, freq: 1200, ratio: 1.41, index: 1.5, dur: 0.06, gain: 0.025 });
      }
    },
  },
  'tile.warn': {
    desc: 'Tile wobble rattle before it drops',
    duration: 0.45,
    priority: P.Normal - 1,
    pitchVar: 2,
    gain: 0.55,
    cooldownMs: 40,
    render: (s) => {
      for (let i = 0; i < 6; i++)
        tone(s, { type: 'triangle', freq: s.rng.range(260, 380), t: i * 0.06, dur: 0.03, gain: 0.2 });
      noise(s, {
        t: 0,
        dur: 0.36,
        gain: 0.08,
        env: { a: 0.05, d: 0.1, s: 0.8, r: 0.1 },
        filter: { type: 'bandpass', freq: 600, q: 8 },
      });
    },
  },
  'tile.crack': {
    desc: 'Sharp crackle of a breaking tile',
    duration: 0.3,
    priority: P.Normal,
    pitchVar: 2,
    gain: 0.65,
    cooldownMs: 30,
    render: (s) => {
      for (let i = 0; i < 5; i++)
        noise(s, {
          t: s.rng.range(0, 0.15),
          dur: s.rng.range(0.015, 0.04),
          gain: 0.45,
          filter: { type: 'highpass', freq: 1500 },
        });
      tone(s, { freq: 210, freqEnd: 80, t: 0, dur: 0.08, gain: 0.3 });
    },
  },
  'tile.fall': {
    desc: 'Tile dropping into the void',
    duration: 0.75,
    priority: P.Normal - 1,
    pitchVar: 2,
    gain: 0.5,
    cooldownMs: 30,
    render: (s) => {
      tone(s, {
        freq: 900,
        freqEnd: 240,
        t: 0,
        dur: 0.5,
        gain: 0.14,
        env: { a: 0.01, d: 0.1, s: 0.7, r: 0.1 },
      });
      noise(s, {
        color: 'pink',
        t: 0,
        dur: 0.4,
        gain: 0.2,
        filter: { type: 'bandpass', freq: 1500, freqEnd: 300, q: 2 },
      });
      tone(s, { freq: 120, freqEnd: 60, t: 0.48, dur: 0.15, gain: 0.25 });
    },
  },
  'slime.loop': {
    desc: 'Bubbling slime (loop)',
    duration: 2,
    loop: true,
    priority: P.Ambient,
    gain: 0.55,
    refDistance: 5,
    render: (s, len) => {
      bedNoise(s, len, 0.45, 'brown', [{ type: 'lowpass', freq: 320 }], { rate: 1, depth: 0.3 });
      for (let i = 0; i < 11; i++) {
        const f = s.rng.range(250, 650);
        tone(s, {
          freq: f,
          freqEnd: f * 2.3,
          t: s.rng.range(0, len - 0.08),
          dur: 0.06,
          gain: s.rng.range(0.07, 0.16),
          attack: 0.004,
        });
      }
    },
  },
  splash: {
    desc: 'Big goo/water splash',
    duration: 0.6,
    priority: P.Important,
    pitchVar: 1.5,
    gain: 0.75,
    cooldownMs: 40,
    render: (s) => {
      noise(s, {
        t: 0,
        dur: 0.45,
        gain: 0.55,
        attack: 0.005,
        filter: { type: 'lowpass', freq: 4500, freqEnd: 500 },
      });
      noise(s, { color: 'brown', t: 0, dur: 0.3, gain: 0.5, filter: { type: 'lowpass', freq: 800 } });
      for (let i = 0; i < 6; i++) {
        const f = s.rng.range(600, 1400);
        tone(s, { freq: f, freqEnd: f * 1.6, t: s.rng.range(0.1, 0.5), dur: 0.04, gain: 0.07 });
      }
    },
  },
  'fan.loop': {
    desc: 'Fan wind (loop)',
    duration: 2.5,
    loop: true,
    priority: P.Ambient,
    gain: 0.55,
    refDistance: 5,
    render: (s, len) => {
      bedNoise(s, len, 0.5, 'pink', [{ type: 'bandpass', freq: 520, q: 0.7 }], { rate: 0.8, depth: 0.25 });
      bedNoise(s, len, 0.05, 'white', [{ type: 'highpass', freq: 3000 }]);
      bedTone(s, len, 0.04, 'sine', 98, { am: { rate: 16, depth: 0.4 } });
    },
  },
  'cannon.thump': {
    desc: 'Foam cannon FOOMP',
    duration: 0.55,
    priority: P.Important,
    pitchVar: 1.5,
    gain: 0.85,
    cooldownMs: 50,
    refDistance: 6,
    render: (s) => {
      const p = punchy(s, 4);
      tone(p, { freq: 85, freqEnd: 32, t: 0, dur: 0.45, gain: 0.8 });
      noise(p, {
        color: 'brown',
        t: 0,
        dur: 0.5,
        gain: 0.7,
        filter: { type: 'lowpass', freq: 900, freqEnd: 150 },
      });
      noise(p, { t: 0, dur: 0.08, gain: 0.35, filter: { type: 'bandpass', freq: 900, q: 0.7 } });
      tone(p, { type: 'triangle', freq: 220, freqEnd: 110, t: 0, dur: 0.12, gain: 0.25 });
    },
  },
  'ball.bonk': {
    desc: 'Foam ball bonk',
    duration: 0.25,
    priority: P.Normal,
    pitchVar: 3,
    gain: 0.65,
    cooldownMs: 30,
    render: (s) => {
      tone(s, { freq: 520, freqEnd: 300, t: 0, dur: 0.18, gain: 0.45 });
      tone(s, { type: 'triangle', freq: 1040, freqEnd: 600, t: 0, dur: 0.08, gain: 0.12 });
      noise(s, { t: 0, dur: 0.03, gain: 0.25, filter: { type: 'bandpass', freq: 1200, q: 3 } });
    },
  },
  'laser.loop': {
    desc: 'Soft laser beam hum (loop)',
    duration: 1,
    loop: true,
    priority: P.Ambient,
    gain: 0.45,
    refDistance: 4,
    render: (s, len) => {
      bedTone(s, len, 0.07, 'sawtooth', 110, { lowpass: 900, am: { rate: 8, depth: 0.3 } });
      bedTone(s, len, 0.07, 'sawtooth', 110, { detune: 9, lowpass: 900 });
      bedTone(s, len, 0.03, 'sine', 1760, { vibrato: { rate: 6, depth: 10 } });
    },
  },
  'laser.zap': {
    desc: 'Laser stun zap',
    duration: 0.4,
    priority: P.Important,
    gain: 0.6,
    cooldownMs: 50,
    render: (s) => {
      fm(s, { t: 0, freq: 1200, freqEnd: 200, ratio: 1.5, index: 6, indexEnd: 0.5, dur: 0.35, gain: 0.25 });
      noise(s, { t: 0, dur: 0.1, gain: 0.2, filter: { type: 'highpass', freq: 3000 } });
    },
  },
  'popup.pop': {
    desc: 'Pop-up foam block pop',
    duration: 0.15,
    priority: P.Normal,
    pitchVar: 2,
    gain: 0.6,
    cooldownMs: 30,
    render: (s) => {
      tone(s, { freq: 380, freqEnd: 1100, sweepTime: 0.04, t: 0, dur: 0.1, gain: 0.45 });
      noise(s, { t: 0, dur: 0.015, gain: 0.35, filter: { type: 'bandpass', freq: 2000, q: 2 } });
      tone(s, { type: 'triangle', freq: 200, t: 0, dur: 0.05, gain: 0.18 });
    },
  },
  'teleport.zap': {
    desc: 'Teleporter zwoop',
    duration: 0.6,
    priority: P.Important,
    gain: 0.6,
    cooldownMs: 40,
    render: (s) => {
      fm(s, { t: 0, freq: 200, freqEnd: 2400, ratio: 2.5, index: 5, indexEnd: 0.5, dur: 0.45, gain: 0.22 });
      noise(s, {
        t: 0,
        dur: 0.4,
        gain: 0.12,
        attack: 0.1,
        filter: { type: 'bandpass', freq: 1000, freqEnd: 6000, q: 3 },
      });
      sparkle(s, 0.1, 0.4, 8, 2000, 5000, 0.05);
    },
  },
  checkpoint: {
    desc: 'Checkpoint ding-ding',
    duration: 1.3,
    priority: P.Important,
    pitchVar: 0,
    volVar: 0.05,
    gain: 0.6,
    render: (s) => {
      fm(s, { t: 0, freq: 1046.5, ratio: 3.01, index: 1.5, indexEnd: 0.05, dur: 1.0, gain: 0.22 });
      fm(s, { t: 0.09, freq: 1568, ratio: 3.01, index: 1.5, indexEnd: 0.05, dur: 1.1, gain: 0.22 });
    },
  },
  'door.bonk': {
    desc: 'Bonking off a solid door',
    duration: 0.25,
    priority: P.Normal,
    pitchVar: 2,
    gain: 0.7,
    cooldownMs: 40,
    render: (s) => {
      tone(s, { freq: 185, freqEnd: 90, t: 0, dur: 0.12, gain: 0.65 });
      tone(s, { type: 'triangle', freq: 420, freqEnd: 380, t: 0, dur: 0.08, gain: 0.22 });
      noise(s, { t: 0, dur: 0.05, gain: 0.35, filter: { type: 'bandpass', freq: 700, q: 2 } });
    },
  },
  'door.break': {
    desc: 'Breakaway door crash',
    duration: 0.7,
    priority: P.Important,
    gain: 0.75,
    cooldownMs: 50,
    render: (s) => {
      noise(s, { t: 0, dur: 0.4, gain: 0.5, filter: { type: 'lowpass', freq: 5000, freqEnd: 800 } });
      tone(s, { freq: 120, freqEnd: 50, t: 0, dur: 0.2, gain: 0.6 });
      for (let i = 0; i < 10; i++)
        tone(s, {
          type: 'triangle',
          freq: s.rng.range(300, 900),
          t: s.rng.range(0.05, 0.5),
          dur: 0.03,
          gain: 0.12,
        });
    },
  },
  'boulder.loop': {
    desc: 'Rolling boulder rumble (loop)',
    duration: 2,
    loop: true,
    priority: P.Ambient,
    gain: 0.6,
    refDistance: 6,
    render: (s, len) => {
      bedNoise(s, len, 0.9, 'brown', [{ type: 'lowpass', freq: 180 }], { rate: 2, depth: 0.4 });
      bedTone(s, len, 0.12, 'sine', 45, { am: { rate: 1, depth: 0.3 } });
    },
  },
  'seesaw.creak': {
    desc: 'Wooden creak of a tipping seesaw',
    duration: 0.55,
    priority: P.Normal - 1,
    pitchVar: 3,
    gain: 0.5,
    cooldownMs: 200,
    render: (s) => {
      noise(s, {
        t: 0,
        dur: 0.5,
        gain: 0.2,
        env: { a: 0.05, d: 0.1, s: 0.8, r: 0.1 },
        filter: { type: 'bandpass', freq: 900, q: 12 },
      });
      tone(s, {
        type: 'sawtooth',
        freq: 70,
        freqEnd: 95,
        t: 0,
        dur: 0.5,
        gain: 0.08,
        env: { a: 0.05, d: 0.1, s: 0.8, r: 0.1 },
        vibrato: { rate: 25, depth: 6 },
      });
    },
  },
  'prop.drop': {
    desc: 'Dropping a carried prop',
    duration: 0.2,
    priority: P.Normal - 1,
    pitchVar: 2,
    gain: 0.55,
    render: (s) => {
      tone(s, { freq: 300, freqEnd: 140, t: 0, dur: 0.1, gain: 0.3 });
      noise(s, { color: 'pink', t: 0, dur: 0.05, gain: 0.3, filter: { type: 'lowpass', freq: 1200 } });
    },
  },
  'egg.pickup': {
    desc: 'Egg/prop pickup plink',
    duration: 0.4,
    priority: P.Normal,
    pitchVar: 1,
    gain: 0.6,
    render: (s) => {
      tone(s, { type: 'triangle', freq: 660, freqEnd: 700, t: 0, dur: 0.06, gain: 0.25 });
      tone(s, { freq: 990, t: 0.06, dur: 0.18, gain: 0.25 });
      sparkle(s, 0.08, 0.2, 3, 3000, 5000, 0.04);
    },
  },
  'ball.kick': {
    desc: 'Kicking a giant ball',
    duration: 0.3,
    priority: P.Normal,
    pitchVar: 2,
    gain: 0.75,
    cooldownMs: 40,
    render: (s) => {
      tone(s, { freq: 150, freqEnd: 60, t: 0, dur: 0.12, gain: 0.65 });
      noise(s, { t: 0, dur: 0.03, gain: 0.4, filter: { type: 'bandpass', freq: 1500, q: 1 } });
      tone(s, { freq: 260, freqEnd: 340, t: 0.01, dur: 0.2, gain: 0.18, vibrato: { rate: 20, depth: 15 } });
    },
  },
};
