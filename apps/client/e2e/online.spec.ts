import { expect, test } from '@playwright/test';

/**
 * Online smoke: `?online=1&autoplay=1` connects to the game server, joins the
 * show the server runs (bots fill the lobby), and plays into a round with
 * predicted local movement and interpolated remotes.
 *
 * Start a server with a short fill wait first, e.g.
 *   cd apps/game-server && PORT=7351 FILL_WAIT_MS=2000 ../../node_modules/.bin/tsx src/main.ts
 *   GS=ws://localhost:7351/ws npx playwright test e2e/online.spec.ts
 */
const GS = process.env.GS ?? '';
const SHOTS = 'test-results/game';

test('online show reaches a live round with moving remotes', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 720 });
  const gs = GS ? `&gs=${encodeURIComponent(GS)}` : '';
  await page.goto(`${process.env.GAME_URL ?? ''}/?online=1&autoplay=1&fresh=1&api=0&tier=medium${gs}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'preShow', undefined, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/online-preshow.png` });

  await page.waitForFunction(() => window.__tumble?.screen?.() === 'round' && (window.__tumble?.roundPhase?.() ?? 0) >= 4, undefined, { timeout: 180_000 });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => ({
    round: window.__tumble!.roundId!(),
    tumblers: window.__tumble!.tumblers!(),
    fps: Math.round(window.__tumble!.fps()),
  }));
  console.log('[online] in round', JSON.stringify(info));
  await page.screenshot({ path: `${SHOTS}/online-round.png` });
  expect(info.tumblers).toBeGreaterThan(1);
  expect(errors, errors.join('\n')).toHaveLength(0);
});
