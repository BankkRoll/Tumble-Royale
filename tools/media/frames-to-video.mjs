#!/usr/bin/env node
/**
 * Turns a screencast capture (frames/ + frames.json from e2e/media.spec.ts)
 * into a constant-frame-rate H.264 video at <capture>/video/screencast.mp4,
 * and rewrites timeline.json to seconds from the first frame so build.sh
 * segment times line up with the video.
 *
 *   node tools/media/frames-to-video.mjs <capture-dir> [fps]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const capture = resolve(process.argv[2] ?? '');
const fps = Number(process.argv[3] ?? 30);
const frames = JSON.parse(readFileSync(join(capture, 'frames.json'), 'utf8'));
if (frames.length < 2) throw new Error('need at least two frames');

// Screencast frames arrive only when the compositor draws, so each frame is
// held until the next one's timestamp; the concat demuxer then resamples to CFR.
const start = frames[0].t;
const lines = ['ffconcat version 1.0'];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]?.t ?? frames[i].t + 1 / fps;
  lines.push(`file 'frames/${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].t).toFixed(4)}`);
}
lines.push(`file 'frames/${frames[frames.length - 1].file}'`);
const list = join(capture, 'frames.ffconcat');
writeFileSync(list, lines.join('\n') + '\n');

mkdirSync(join(capture, 'video'), { recursive: true });
const out = join(capture, 'video', 'screencast.mp4');
execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `fps=${fps},format=yuv420p`,
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-preset',
    'medium',
    out,
  ],
  { stdio: 'inherit', cwd: capture },
);

const timelinePath = join(capture, 'timeline.json');
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
writeFileSync(
  join(capture, 'timeline-video.json'),
  JSON.stringify(
    timeline.map((e) => ({ ...e, t: Math.round((e.t - start) * 100) / 100 })),
    null,
    1,
  ),
);
console.log(`${frames.length} frames over ${(frames[frames.length - 1].t - start).toFixed(1)} s → ${out}`);
