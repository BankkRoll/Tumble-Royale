import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';

/**
 * Share cards and clips end to end: an offline private show (just a
 * final, 4 players, autoplay) reaches the rewards screen, the Share sheet
 * makes a social card and a 5 s clip, and both files are saved and decoded:
 * the PNG's size from its header and in an <img>, the clip's length from a
 * <video> element.
 *
 * BACKEND=webgl npx playwright test e2e/share.spec.ts   (default: auto → WebGPU)
 */
const BACKEND = process.env.BACKEND ?? 'auto';

async function waitScreen(page: Page, screen: string, timeout: number): Promise<void> {
  await page.waitForFunction((id) => window.__tumble?.screen?.() === id, screen, { timeout, polling: 200 });
}

async function saved(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await (download as Download).path();
  expect(path).toBeTruthy();
  return readFileSync(path as string);
}

test('a share card and a clip are made after an offline show', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/?autoplay=1&shows=0&ts=6&fresh=1&api=0&seed=11&tier=medium&backend=${BACKEND}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  await waitScreen(page, 'menu', 90_000);
  await page.waitForTimeout(1500);
  await page.evaluate(() =>
    window.__tumble!.emit!('playCustomOffline', {
      options: {
        rounds: ['crown-climb'],
        bots: true,
        maxPlayers: 4,
        timerScale: 1,
        spectators: false,
        isPrivate: true,
      },
    }),
  );
  const started = Date.now();
  await waitScreen(page, 'rewards', 8 * 60_000);
  console.log(`[share] show took ${Math.round((Date.now() - started) / 1000)} s`);

  const open = page.getByTestId('share-open');
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  const sheet = page.getByTestId('share-sheet');
  await expect(sheet).toBeVisible();

  // A one-round show makes everyone a finalist, so a card is always earned.
  await sheet.getByRole('tab', { name: 'Card' }).click();
  await page.getByTestId('share-make-card').click();
  await expect(page.getByTestId('share-ready')).toBeVisible({ timeout: 60_000 });
  const img = await page.getByTestId('share-preview-card').evaluate(async (el) => {
    const i = el as HTMLImageElement;
    await i.decode();
    return { w: i.naturalWidth, h: i.naturalHeight };
  });
  expect(img).toEqual({ w: 1200, h: 630 });
  const png = await saved(page, () => page.getByTestId('share-deliver-download').click());
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
  await expect(page.getByTestId('share-status')).toHaveText('Saved to your downloads');

  // Clip: 5 s of the default round.
  await sheet.getByRole('button', { name: 'Make another' }).click();
  await sheet.getByRole('tab', { name: 'Clip' }).click();
  await expect(page.getByTestId('share-make-clip')).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: '5 s', exact: true }).click();
  await page.getByTestId('share-make-clip').click();
  await expect(page.getByTestId('share-progress')).toBeVisible();
  await expect(page.getByTestId('share-ready')).toBeVisible({ timeout: 5 * 60_000 });
  const video = await page.getByTestId('share-preview-clip').evaluate(
    (el) =>
      new Promise<{ duration: number; w: number; h: number; type: string }>((resolve, reject) => {
        const src = (el as HTMLVideoElement).src;
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';
        v.onloadedmetadata = () =>
          resolve({ duration: v.duration, w: v.videoWidth, h: v.videoHeight, type: src });
        v.onerror = () => reject(new Error(`video failed to load: ${v.error?.message ?? v.error?.code}`));
        v.src = src;
      }),
  );
  console.log('[share] clip', JSON.stringify(video));
  expect(video.w).toBe(1280);
  expect(video.h).toBe(720);
  expect(video.duration).toBeGreaterThan(4.5);
  expect(video.duration).toBeLessThan(5.5);
  const clip = await saved(page, () => page.getByTestId('share-deliver-download').click());
  const isWebm = clip.readUInt32BE(0) === 0x1a45dfa3;
  const isMp4 = clip.subarray(4, 8).toString('latin1') === 'ftyp';
  expect(isWebm || isMp4).toBe(true);
  console.log(`[share] card ${png.length} B, clip ${clip.length} B (${isWebm ? 'webm' : 'mp4'})`);

  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  expect(errors, errors.join('\n')).toHaveLength(0);
});
