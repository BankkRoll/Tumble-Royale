import { expect, test } from '@playwright/test';

/**
 * Level smoke test + screenshot tool for level builders.
 *
 * ROUNDS=gumdrop-gauntlet,spin-cycle SIM_SECONDS=40 npx playwright test e2e/level.spec.ts
 *
 * For each round: loads level.html, fails on page errors or match-sim warnings,
 * runs bots for SIM_SECONDS (time-scaled), prints status + furthest progress,
 * and saves flyover / overview / follow screenshots to test-results/levels/.
 */
const ROUNDS = (process.env.ROUNDS ?? 'test-arena').split(',').filter(Boolean);
const SIM_SECONDS = Number(process.env.SIM_SECONDS ?? 30);
const TIME_SCALE = 3;

for (const round of ROUNDS) {
  test(`level ${round}`, async ({ page }) => {
    test.setTimeout(60_000 + (SIM_SECONDS / TIME_SCALE) * 1000 * 2);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/level.html?round=${round}&ts=${TIME_SCALE}&bots=24`);
    await page.waitForFunction(() => window.__level?.ready === true, undefined, { timeout: 60_000 });

    const dir = `test-results/levels/${round}`;
    for (const t of [0.05, 0.5, 0.95]) {
      await page.evaluate((tt) => window.__level!.setCamera('flyover', tt), t);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}/flyover-${Math.round(t * 100)}.png` });
    }
    await page.evaluate(() => window.__level!.setCamera('follow'));
    await page.waitForTimeout((SIM_SECONDS / TIME_SCALE) * 1000);
    await page.screenshot({ path: `${dir}/follow.png` });

    const report = await page.evaluate(() => ({
      warnings: window.__level!.warnings,
      status: window.__level!.status(),
      furthestZ: window.__level!.furthestZ(),
    }));
    console.log(`[level] ${round}`, JSON.stringify(report, null, 1));
    expect(errors, errors.join('\n')).toHaveLength(0);
    expect(report.warnings, report.warnings.join('\n')).toHaveLength(0);
  });
}
