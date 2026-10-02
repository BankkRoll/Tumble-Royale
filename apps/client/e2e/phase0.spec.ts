import { expect, test, type Page } from '@playwright/test';

/** Waits for the boot sequence and lets the scene render for a while. */
async function bootAndSettle(page: Page, backend: string): Promise<{ backend: string; fps: number; frames: number }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?backend=${backend}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({
    backend: window.__tumble!.backend,
    fps: window.__tumble!.fps(),
    frames: window.__tumble!.frames,
  }));
  expect(errors, errors.join('\n')).toHaveLength(0);
  return info;
}

for (const backend of ['webgpu', 'webgl'] as const) {
  test(`test scene renders on ${backend}`, async ({ page }, testInfo) => {
    const info = await bootAndSettle(page, backend);
    testInfo.annotations.push({ type: 'render', description: JSON.stringify(info) });
    console.log(`[phase0] requested=${backend}`, info);
    expect(info.frames).toBeGreaterThan(30);
    if (backend === 'webgl') expect(info.backend).toBe('webgl2');
    await page.screenshot({ path: `test-results/phase0-${backend}.png` });
  });
}

test('client and server Rapier agree after 600 steps', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 60_000 });
  const report = await page.evaluate(async () => {
    const r = await window.__tumble!.determinism();
    return { summary: r.summary, identical: r.identical, maxError: r.maxError, client: r.client.hash, server: r.server?.hash };
  });
  console.log('[phase0] determinism', report);
  expect(report.server).toBeDefined();
  expect(report.maxError).not.toBeNull();
  expect(report.maxError!).toBeLessThanOrEqual(1e-4);
});
