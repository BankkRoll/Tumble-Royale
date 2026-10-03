import { mkdirSync, statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * News feed hero capture. Renders a still of every round from the level viewer
 * plus two general stills (main menu, an in-round action shot) and saves them
 * as 1280×720 JPEGs under `public/news/`, which `@tumble/content/news` links.
 *
 * Skipped unless CAPTURE_NEWS is set, so normal e2e runs never rewrite assets:
 *
 * CAPTURE_NEWS=1 GAME_URL=http://localhost:5199 npx playwright test e2e/capture-news.spec.ts
 *
 * Optional env: ROUNDS (comma list), NEWS_OUT (output dir), NEWS_SHOTS (comma
 * list of camera shots like `orbit,flyover@0.4`; with more than one, every
 * shot is saved as `<round>-<shot>.jpg` for picking a framing).
 */
test.skip(!process.env.CAPTURE_NEWS, 'set CAPTURE_NEWS=1 to regenerate news images');

const BASE = process.env.GAME_URL ?? '';
const OUT = process.env.NEWS_OUT ?? 'public/news';
const SIZE = { width: 1280, height: 720 };
const QUALITY = 72;
const MAX_BYTES = 150 * 1024;

/**
 * Hand-picked camera per round. `orbit` is the flyover's opening view; tall or
 * round arenas read better from a point further along the flyover path.
 */
const SHOT: Record<string, string> = {
  'gumdrop-gauntlet': 'orbit',
  'conveyor-chaos': 'orbit',
  'tilt-town': 'orbit',
  'slip-n-spiral': 'orbit',
  'hammer-highway': 'orbit',
  'wind-tunnel-peaks': 'orbit',
  'cannonball-canyon': 'orbit',
  'spin-cycle': 'orbit',
  'tile-panic': 'orbit',
  'rising-goo-tower': 'orbit',
  'jump-rope-royale': 'orbit',
  'egg-heist': 'orbit',
  'bounce-ball-blitz': 'orbit',
  'paint-the-plaza': 'orbit',
  'tail-chase': 'orbit',
  'pattern-panic': 'orbit',
  'crown-climb': 'orbit',
  'last-tumbler-standing': 'orbit',
  'spin-cycle-finale': 'orbit',
  'goo-peak-final': 'orbit',
};

const ROUNDS = process.env.ROUNDS ? process.env.ROUNDS.split(',').filter(Boolean) : Object.keys(SHOT);
const VARIANTS = process.env.NEWS_SHOTS?.split(',').filter(Boolean);

/** Hides the viewer HUD and stats overlay so only the canvas is captured. */
const HIDE_OVERLAYS = 'body > *:not(canvas){display:none !important}';

async function openLevel(page: Page, round: string, query = ''): Promise<void> {
  await page.setViewportSize(SIZE);
  await page.goto(`${BASE}/level.html?round=${round}&bots=24&seed=7${query}`);
  await page.waitForFunction(() => window.__level?.ready === true, undefined, { timeout: 120_000 });
  await page.addStyleTag({ content: HIDE_OVERLAYS });
}

/**
 * Applies a shot spec: `orbit`, `flyover@0.4` or `follow`, optionally with
 * `~<wheel>` to dolly the orbit camera (positive = out) via mouse wheel.
 */
async function setShot(page: Page, shot: string): Promise<void> {
  const [cam, zoom] = shot.split('~');
  const [mode, t] = cam!.split('@');
  await page.evaluate(
    ([m, tt]) => window.__level!.setCamera(m as 'orbit' | 'flyover' | 'follow', Number(tt ?? 0)),
    [mode, t] as const,
  );
  if (zoom) {
    await page.mouse.move(SIZE.width / 2, SIZE.height / 2);
    for (
      let left = Number(zoom);
      Math.abs(left) > 0;
      left -= Math.sign(left) * Math.min(Math.abs(left), 100)
    ) {
      await page.mouse.wheel(0, Math.sign(left) * Math.min(Math.abs(left), 100));
    }
  }
  // Orbit damping eases into place; follow needs time to lock onto the leader.
  await page.waitForTimeout(mode === 'follow' ? 2500 : 1200);
}

async function saveJpeg(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, type: 'jpeg', quality: QUALITY });
  const bytes = statSync(path).size;
  console.log(`[news] ${path} ${Math.round(bytes / 1024)} KB`);
  expect(bytes, `${path} is larger than ${MAX_BYTES} bytes`).toBeLessThan(MAX_BYTES);
}

test.beforeAll(() => {
  mkdirSync(`${OUT}/rounds`, { recursive: true });
});

for (const round of ROUNDS) {
  test(`news still ${round}`, async ({ page }) => {
    test.setTimeout(180_000);
    await openLevel(page, round);
    // Shaders compile and bots spread out over the first seconds.
    await page.waitForTimeout(5000);
    const shots = VARIANTS ?? [SHOT[round] ?? 'orbit'];
    for (const shot of shots) {
      await setShot(page, shot);
      const name = shots.length > 1 ? `${round}-${shot.replace(/[@~]/g, '-')}` : round;
      await saveJpeg(page, `${OUT}/rounds/${name}.jpg`);
    }
  });
}

test('news still season (main menu)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(SIZE);
  await page.goto(`${BASE}/?autoplay=1&api=0&fresh=1&tier=high&seed=11`);
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'menu', undefined, {
    timeout: 180_000,
    polling: 100,
  });
  // Let the menu entrance animation settle; autoplay leaves the menu a few seconds later.
  await page.waitForTimeout(1500);
  await saveJpeg(page, `${OUT}/season.jpg`);
});

test('news still how-to (in-round action)', async ({ page }) => {
  test.setTimeout(180_000);
  await openLevel(page, 'gumdrop-gauntlet', '&cam=follow');
  await page.waitForTimeout(9000);
  await setShot(page, 'follow');
  await saveJpeg(page, `${OUT}/howto.jpg`);
});
