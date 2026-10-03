import { expect, test, type Page } from '@playwright/test';

/**
 * Practice Island (tutorial.html): with `?autoplay=1` a scripted pilot drives
 * the player through every station — move, jump, dive, grab, ledge climb,
 * bounce pad, falling tiles, checkpoint + fall demo — then the mini race and
 * the "You're ready!" card, with zero page errors. A second run checks the
 * skip flow (Esc → confirm → Esc).
 *
 * GAME_URL=http://localhost:5199 npx playwright test e2e/tutorial.spec.ts
 */
const BACKEND = process.env.BACKEND ?? 'auto';
const TS = Number(process.env.TS ?? 2);
const SHOTS = process.env.SHOTS ?? 'test-results/tutorial';
const STATIONS = ['move', 'jump', 'dive', 'grab', 'climb', 'bounce', 'tiles', 'checkpoint', 'race'];

async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${BACKEND}-${name}.png` });
}

async function waitFor<T>(page: Page, fn: () => T, timeout: number): Promise<T> {
  const handle = await page.waitForFunction(fn, undefined, { timeout, polling: 100 });
  return (await handle.jsonValue()) as T;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) console.log('[console.error]', m.text().slice(0, 300));
  });
  return errors;
}

test('autopilot completes every Practice Island station and the mini race', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${process.env.GAME_URL ?? ''}/tutorial.html?autoplay=1&ts=${TS}&fresh=1&seed=5&tier=high&backend=${BACKEND}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  console.log('[tutorial] backend', await page.evaluate(() => window.__tumble!.backend));

  await waitFor(page, () => window.__tutorial?.stage() === 'intro', 60_000);
  // The intro title sits over the flyover once the loading wipe has lifted.
  await waitFor(page, () => window.__tumble?.screen?.() === 'round', 30_000);
  await page.waitForTimeout(700);
  await snap(page, '00-intro');

  for (const [i, id] of STATIONS.entries()) {
    await page.waitForFunction((sid) => window.__tutorial?.station() === sid || window.__tutorial?.completed().includes(sid), id, { timeout: 90_000, polling: 100 });
    // Mid-demo: the coach is showing the move and the objective card is up.
    await page.waitForTimeout(1800 / Math.min(2, TS));
    await snap(page, `${String(i + 1).padStart(2, '0')}-${id}`);
    await page.waitForFunction((sid) => window.__tutorial?.completed().includes(sid), id, { timeout: 120_000, polling: 100 });
    console.log(`[tutorial] ${id} done at ${(await page.evaluate(() => window.__tutorial!.elapsed())).toFixed(1)} s`);
  }

  await waitFor(page, () => window.__tutorial?.stage() === 'race', 60_000);
  // Let the loading wipe lift off the start line first.
  await page.waitForTimeout(900);
  await snap(page, '10-race-countdown');
  await waitFor(page, () => (window.__tumble?.roundPhase?.() ?? 0) >= 4, 30_000);
  await page.waitForTimeout(4000 / Math.min(2, TS));
  await snap(page, '11-race-running');
  const result = await waitFor(page, () => window.__tutorial?.raceResult() ?? null, 150_000);
  console.log('[tutorial] race result', JSON.stringify(result));
  expect(result, 'the autopilot crosses the finish line').not.toBe('timeUp');
  await page.waitForTimeout(600);
  await snap(page, '12-race-finish');

  await waitFor(page, () => window.__tutorial?.stage() === 'ready', 30_000);
  await page.waitForTimeout(1500);
  await snap(page, '13-ready');
  const ready = await page.locator('.tt-ready-card').textContent();
  expect(ready).toContain("You're ready!");
  expect(ready).toContain('XP');

  const end = await waitFor(page, () => window.__tutorialEnd ?? null, 30_000);
  expect(end).toBe('backToLobby');
  const completed = await page.evaluate(() => window.__tutorial!.completed());
  expect(completed).toEqual(STATIONS);
  expect(errors).toEqual([]);
});

test('Esc opens the skip confirm and a second Esc skips', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${process.env.GAME_URL ?? ''}/tutorial.html?fresh=1&seed=5&tier=high&backend=${BACKEND}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  await waitFor(page, () => window.__tutorial?.stage() === 'intro', 60_000);
  await page.keyboard.press('Space');
  await waitFor(page, () => window.__tutorial?.stage() === 'practice', 10_000);
  await page.waitForTimeout(2500);
  await snap(page, '20-practice-keyboard');
  await expect(page.locator('.tt-prompt')).toContainText('WASD');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tt-modal-card')).toBeVisible();
  await snap(page, '21-skip-confirm');
  await page.keyboard.press('Escape');
  const end = await waitFor(page, () => window.__tutorialEnd ?? null, 10_000);
  expect(end).toBe('backToLobby');
  expect(errors).toEqual([]);
});
