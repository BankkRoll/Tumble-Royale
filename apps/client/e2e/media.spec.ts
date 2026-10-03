import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Captures README media from an autoplayed show: stills of the main moments
 * and a full-HD frame-by-frame screencast for the trailer.
 *
 *   MEDIA_URL=http://localhost:5173 npx playwright test e2e/media.spec.ts --workers=1
 *
 * Serve a sandbox build (`pnpm build:sandbox`, then `vite preview`): the spec
 * relies on dev URL options, and the shared dev server hot-reloads mid-capture.
 * Output: stills, `frames/` (JPEG per compositor frame), `frames.json` and
 * `timeline.json` (when each screen appeared, on the same clock as the frames).
 * `tools/media/frames-to-video.mjs` then `tools/media/build.sh` turn it into
 * docs/media/.
 */
/** Output dir; other test runs clear test-results/, so long captures can point elsewhere. */
const OUT = process.env.MEDIA_OUT ?? 'test-results/media';
/** Base URL of a private preview of a sandbox build. */
const BASE = process.env.MEDIA_URL ?? '';
const SIZE = { width: 1920, height: 1080 };

mkdirSync(`${OUT}/frames`, { recursive: true });

async function screenOf(page: Page): Promise<string> {
  return page.evaluate(() => window.__tumble?.screen?.() ?? '');
}

test('show stills and HD screencast', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const context = await browser.newContext({ viewport: SIZE });
  const page = await context.newPage();

  // NOTE: Playwright's own video recorder encodes at a low bitrate; the CDP
  // screencast hands over every compositor frame as a high-quality JPEG instead.
  const cdp = await context.newCDPSession(page);
  const frames: { file: string; t: number }[] = [];
  const writes: Promise<void>[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = `${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(`${OUT}/frames/${file}`, Buffer.from(f.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });

  const timeline: { t: number; screen: string }[] = [];
  const shot = new Set<string>();
  await page.goto(`${BASE}/?autoplay=1&ts=1&tier=high&api=0&fresh=1&seed=12`);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: SIZE.width,
    maxHeight: SIZE.height,
  });

  const settle: Record<string, number> = {
    menu: 2000,
    preShow: 3500,
    roundIntro: 1200,
    victory: 2500,
    winnerCam: 2500,
    rewards: 2500,
  };
  let last = '';
  let roundSeen = 0;
  let roundShotAt = 0;
  const t0 = Date.now();
  for (;;) {
    const s = await screenOf(page);
    const now = Date.now();
    if (s !== last) {
      timeline.push({ t: now / 1000, screen: s });
      last = s;
      if (s === 'round') {
        roundSeen++;
        roundShotAt = now + 12_000;
      }
      if (s in settle && !shot.has(s)) {
        shot.add(s);
        await page.waitForTimeout(settle[s]!);
        await page.screenshot({ path: `${OUT}/${s}.png` });
      }
    }
    if (s === 'round' && roundShotAt && now > roundShotAt && !shot.has(`round-${roundSeen}`)) {
      shot.add(`round-${roundSeen}`);
      await page.screenshot({ path: `${OUT}/round-${roundSeen}.png` });
    }
    if (s === 'playerWall' && !shot.has('wall')) {
      shot.add('wall');
      await page.waitForTimeout(7000);
      await page.screenshot({ path: `${OUT}/playerWall.png` });
    }
    if (s === 'rewards' && shot.has('rewards')) break;
    if (now - t0 > 25 * 60_000) break;
    await page.waitForTimeout(150);
  }

  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 1));
  await context.close();
  expect(shot.has('rewards')).toBe(true);
  expect(frames.length).toBeGreaterThan(1000);
});
