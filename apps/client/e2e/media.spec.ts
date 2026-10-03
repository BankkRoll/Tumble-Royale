import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Captures README media: stills of the main moments of a show, themed level
 * shots, and a screen recording of an autoplayed show for the trailer.
 *
 *   npx playwright test e2e/media.spec.ts --workers=1
 *
 * Output lands in test-results/media/ (stills, video and a timeline of when
 * each screen appeared); tools/media/build.sh turns it into docs/media/.
 */
/** Output dir; other test runs clear test-results/, so long captures can point elsewhere. */
const OUT = process.env.MEDIA_OUT ?? 'test-results/media';
/** Base URL of a private `vite preview` build; the shared dev server hot-reloads mid-capture. */
const BASE = process.env.MEDIA_URL ?? '';
const SIZE = { width: 1600, height: 900 };
const LEVELS = ['gumdrop-gauntlet', 'slip-n-spiral', 'paint-the-plaza', 'wind-tunnel-peaks', 'goo-peak-final', 'tile-panic'];

mkdirSync(OUT, { recursive: true });

async function screenOf(page: Page): Promise<string> {
  return page.evaluate(() => window.__tumble?.screen?.() ?? '');
}

test('show stills and trailer recording', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: `${OUT}/video`, size: SIZE } });
  const page = await context.newPage();
  const t0 = Date.now();
  const timeline: { t: number; screen: string }[] = [];
  const shot = new Set<string>();

  await page.goto(`${BASE}/?autoplay=1&ts=1.5&tier=high&api=0&fresh=1&seed=12`);
  let last = '';
  let roundSeen = 0;
  let roundShotAt = 0;
  for (;;) {
    const s = await screenOf(page);
    const now = Date.now() - t0;
    if (s !== last) {
      timeline.push({ t: now / 1000, screen: s });
      last = s;
      if (s === 'round') {
        roundSeen++;
        roundShotAt = now + 9000;
      }
      // Let entrance animations settle before taking the still.
      const settle: Record<string, number> = { menu: 1500, preShow: 3500, roundIntro: 1200, victory: 2500, winnerCam: 2500, rewards: 2500 };
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
    if (s === 'playerWall' && !shot.has('wall-a')) {
      shot.add('wall-a');
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/playerWall-a.png` });
      await page.waitForTimeout(4500);
      await page.screenshot({ path: `${OUT}/playerWall-b.png` });
    }
    if (s === 'rewards' && shot.has('rewards')) break;
    if (now > 14 * 60_000) break;
    await page.waitForTimeout(150);
  }
  writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 1));
  await context.close();
  expect(shot.has('rewards')).toBe(true);
});

for (const id of LEVELS) {
  test(`level still ${id}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(SIZE);
    await page.goto(`${BASE}/level.html?round=${id}&bots=30&seed=4`);
    await page.waitForFunction(() => window.__level?.ready === true, undefined, { timeout: 60_000 });
    await page.addStyleTag({ content: '#hud, div[style*="position:fixed;left:8px"] { display: none !important; }' });
    await page.evaluate(() => window.__level!.setCamera('flyover', 0.35));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/level-${id}-fly.png` });
    await page.evaluate(() => window.__level!.setCamera('follow'));
    await page.waitForTimeout(14_000);
    await page.screenshot({ path: `${OUT}/level-${id}-follow.png` });
  });
}
